// Local web UI adapter. Another front-end on the same engine: it turns Run
// events into Server-Sent Events and turns the page's clicks into the
// browser/prompt adapters.
//
// Security model (it can read key files from disk, so it must be private):
//   - binds 127.0.0.1 only
//   - every API call needs a random per-session token (in the launch URL)
//   - Host header must be 127.0.0.1/localhost:<port> (DNS-rebinding defence)
//   - strict Content-Security-Policy, no third-party requests, no telemetry
//   - secrets typed into the page live only in memory for that one run

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { Run } from '../core/run.js';
import { runCheck, publicResult } from '../doctor.js';
import { runLaunch } from '../launch.js';
import { discover } from '../discovery.js';
import { detectVendor } from '../vendors/index.js';
import { explainError } from '../diagnose.js';
import { renderMarkdown } from '../report.js';
import { loadProfiles, saveProfile, profileToOptions, validateProfile, ProfileError } from '../profiles.js';
import { DEFAULT_SECRET_ENV } from '../clientauth.js';
import { VERSION } from '../version.js';
import { PAGE_HTML, APP_CSS, APP_JS } from './assets.js';
import { listen } from '../util.js';

const require = createRequire(import.meta.url);
const FONT_FILES = {
  'sans.woff2': '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2',
  'mono.woff2': '@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2',
};

async function loadFont(name) {
  try {
    return await readFile(require.resolve(FONT_FILES[name]));
  } catch {
    // Standalone binaries embed fonts at build time (scripts/build-assets.js)
    try {
      // @ts-ignore -- only exists in standalone builds; keep the literal path so the bundler embeds it
      const m = await import('./fonts.generated.js');
      return m.FONTS?.[name] ? Buffer.from(m.FONTS[name], 'base64') : undefined;
    } catch {
      return undefined; // CSS falls back to system fonts
    }
  }
}

/**
 * @param {{ port?: number, configPath: string, demo?: boolean, log?: (s: string) => void, env?: NodeJS.ProcessEnv }} o
 */
export async function startUi({ port = 0, configPath, demo = false, log = () => {}, env = process.env }) {
  const token = randomBytes(24).toString('hex');
  let boundPort = 0; // set once listening; requests only arrive after that
  const runs = new Map();
  let demoState;
  if (demo) {
    const { startDemoMock } = await import('../cli.js');
    demoState = await startDemoMock({ port: 0 });
    log(`Practice EHR running at ${demoState.mock.fhirBase} (synthetic data only)`);
  }
  const demoEnv = demo ? { SMART_DOCTOR_DEMO_SECRET: (await import('../cli.js')).DEMO.secret } : {};

  async function allProfiles() {
    const { profiles } = await loadProfiles(configPath);
    const out = {};
    for (const [n, p] of Object.entries(profiles)) out[n] = { ...p, source: 'file' };
    if (demoState) for (const [n, p] of Object.entries(demoState.profiles)) out[n] ||= { ...p, source: 'demo' };
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const hdr = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    };
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...hdr, 'content-type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // DNS-rebinding defence
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return send(403, { error: 'Forbidden host' });

    try {
      // ---- static ----
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          ...hdr,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        return res.end(PAGE_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/app.css') return send(200, APP_CSS, 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return send(200, APP_JS, 'text/javascript; charset=utf-8');
      const font = url.pathname.match(/^\/fonts\/(sans|mono)\.woff2$/);
      if (req.method === 'GET' && font) {
        const buf = await loadFont(`${font[1]}.woff2`);
        if (!buf) return send(404, 'no font');
        res.writeHead(200, { ...hdr, 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
        return res.end(buf);
      }

      // ---- API: token required ----
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
      const given = req.headers['x-smart-doctor-token'] || url.searchParams.get('t') || '';
      if (!safeEqual(String(given), token))
        return send(401, { error: 'Missing or wrong session token. Reopen the URL printed by `smart-doctor ui`.' });
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json'))
        return send(415, { error: 'JSON only' });

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const profiles = await allProfiles();
        const secrets = {};
        for (const [n, p] of Object.entries(profiles)) {
          if (p.auth === 'client_secret_basic' || p.auth === 'client_secret_post') {
            const name = p.secretEnv || DEFAULT_SECRET_ENV;
            secrets[n] = { env: name, set: Boolean(env[name] || demoEnv[name]) };
          }
        }
        return send(200, { version: VERSION, configPath, profiles, secrets, demo: Boolean(demoState) });
      }

      if (req.method === 'POST' && url.pathname === '/api/profiles') {
        const { name, profile } = await readJson(req);
        try {
          validateProfile(name, profile);
        } catch (e) {
          return send(400, { error: e.message });
        }
        const warnings = [];
        const opts = profileToOptions(profile, { configPath, env });
        if (opts.keyPath && !existsSync(opts.keyPath)) warnings.push(`No key file at ${opts.keyPath} yet.`);
        await saveProfile(configPath, name, profile);
        return send(200, { profiles: await allProfiles(), warnings });
      }

      if (req.method === 'POST' && url.pathname === '/api/discover') {
        const { fhir, flow } = await readJson(req);
        const d = await discover({
          fhirBase: fhir,
          auth: 'none',
          grant: flow === 'launch' ? 'authorization_code' : 'client_credentials',
          timeoutMs: 10000,
        });
        const v = detectVendor([fhir, d.tokenUrl]);
        return send(200, {
          ok: Boolean(d.tokenUrl),
          vendor: v.id === 'generic' ? undefined : v.name,
          tokenUrl: d.tokenUrl,
          authorizeUrl: d.authorizeUrl,
          authMethods: d.config?.token_endpoint_auth_methods_supported,
          capabilities: d.config?.capabilities,
          problem: d.checks.find((c) => c.status === 'fail')?.detail,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/explain') {
        const { text, url: target } = await readJson(req);
        return send(200, explainError(String(text || ''), { vendor: detectVendor([target]) }));
      }

      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const { profile: name, secret } = await readJson(req);
        const profiles = await allProfiles();
        const p = profiles[name];
        if (!p) return send(404, { error: `No profile "${name}"` });
        const { source, ...clean } = p;
        const opts = profileToOptions(clean, { configPath, env: { ...env, ...demoEnv } });
        if (secret) opts.secret = String(secret);
        const r = startRun(opts);
        return send(202, { runId: r.id, flow: opts.flow });
      }

      const m = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(events|paste|cancel|report)$/);
      if (m) {
        const r = runs.get(m[1]);
        if (!r) return send(404, { error: 'No such run' });
        if (m[2] === 'events' && req.method === 'GET') return streamEvents(r, req, res, hdr);
        if (m[2] === 'paste' && req.method === 'POST') {
          const { url: pasted } = await readJson(req);
          if (!r.pasteResolve) return send(409, { error: 'This run is not waiting for a URL.' });
          r.pasteResolve(String(pasted || ''));
          r.pasteResolve = undefined;
          return send(200, { ok: true });
        }
        if (m[2] === 'cancel' && req.method === 'POST') {
          r.abort.abort();
          return send(200, { ok: true });
        }
        if (m[2] === 'report' && req.method === 'GET') {
          if (!r.result) return send(409, { error: 'Run not finished' });
          return send(
            200,
            renderMarkdown(r.result, { redact: url.searchParams.get('redact') !== '0', verbose: url.searchParams.get('verbose') === '1' }),
            'text/markdown; charset=utf-8',
          );
        }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof ProfileError || e instanceof SyntaxError ? 400 : 500;
      return send(status, { error: e.message });
    }
  });

  function startRun(opts) {
    const run = new Run({ flow: opts.flow });
    const record = {
      id: run.id,
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
      result: undefined,
      pasteResolve: undefined,
    };
    runs.set(run.id, record);
    const push = (event, data) => {
      record.events.push({ event, data });
      for (const l of record.listeners) l(event, data);
    };
    for (const ev of ['step:start', 'step:end', 'step:update', 'http', 'action', 'log']) run.on(ev, (d) => push(ev, d));
    run.on('done', (d) => push('done', d));
    push('meta', { flow: opts.flow, redirectUri: opts.redirectUri, auth: opts.auth });

    const browser = { async open() {} }; // the page opens the URL on a click (popup blockers)
    const prompter = {
      ask: () =>
        new Promise((resolve) => {
          record.pasteResolve = resolve;
        }),
    };
    const exec =
      opts.flow === 'launch' ? runLaunch(opts, { run, browser, prompter, signal: record.abort.signal }) : runCheck(opts, { run });
    exec
      .then((result) => {
        record.result = result;
      })
      // Not 'error': EventSource uses that name for its own connection errors.
      .catch((e) => push('run-error', { message: e.message }))
      .finally(() => {
        push('end', {});
        // forget old runs after 30 minutes
        setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref?.();
      });
    return record;
  }

  function streamEvents(r, req, res, hdr) {
    res.writeHead(200, { ...hdr, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    let ended = false;
    const write = (event, data) => {
      if (ended) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(event === 'done' ? publicResult(data) : data)}\n\n`);
      // Close the stream once the run is over, so the browser does not reconnect and replay it.
      if (event === 'end') {
        ended = true;
        r.listeners.delete(write);
        res.end();
      }
    };
    for (const e of r.events) write(e.event, e.data);
    if (!ended) r.listeners.add(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      r.listeners.delete(write);
    });
  }

  boundPort = await listen(server, port, '127.0.0.1');
  const base = `http://127.0.0.1:${boundPort}`;
  return {
    url: `${base}/?t=${token}`,
    baseUrl: base,
    token,
    demo: demoState,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      if (demoState) await demoState.mock.close();
    },
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
