// Loopback redirect listener (RFC 8252 §7.3): bind exactly the host, port
// and path of the registered redirect URI and wait for the browser to come
// back with ?code=…&state=… (or ?error=…).

import http from 'node:http';
import { listen } from './util.js';

export function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Start listening. Resolves once bound (or rejects with a clear message when
 * the port is busy). `result` resolves with the full callback URL.
 * @param {string} redirectUri
 * @param {{ waitMs?: number }} [o]
 */
export async function startLoopback(redirectUri, { waitMs = 300000 } = {}) {
  const u = new URL(redirectUri);
  const port = Number(u.port || 80);
  // 'localhost' may resolve to IPv4 or IPv6 depending on the OS/browser: listen on both.
  const hosts = u.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [u.hostname.replace(/^\[|\]$/g, '')];
  const servers = [];
  let resolveResult;
  let rejectResult;
  const result = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  result.catch(() => {});

  const handler = (req, res) => {
    const got = new URL(req.url, `${u.protocol}//${u.host}`);
    if (got.pathname !== u.pathname) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not the smart-doctor callback path.');
      return;
    }
    const error = got.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(callbackPage(error, got.searchParams.get('error_description')));
    resolveResult(got.toString());
  };

  for (const host of hosts) {
    const server = http.createServer(handler);
    try {
      await listen(server, port, host);
      servers.push(server);
    } catch (e) {
      // IPv6 may be unavailable: only fail if we could not bind anything.
      if (host === '::1' && servers.length) continue;
      for (const s of servers) s.close();
      const why =
        e.code === 'EADDRINUSE'
          ? `port ${port} is already in use`
          : e.code === 'EACCES'
            ? `no permission to listen on port ${port}`
            : e.message;
      throw new LoopbackError(`Cannot listen on ${u.host} for the redirect: ${why}.`, e.code);
    }
  }

  const timer = setTimeout(() => rejectResult(new LoopbackError('timeout', 'TIMEOUT')), waitMs);
  timer.unref?.();

  return {
    result,
    close() {
      clearTimeout(timer);
      for (const s of servers) {
        s.closeAllConnections?.();
        s.close();
      }
    },
  };
}

export class LoopbackError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function callbackPage(error, description) {
  const ok = !error;
  const esc = (s) =>
    String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Signed in' : 'Sign-in failed'} — smart-doctor</title>
<style>
  :root{color-scheme:light dark;--paper:#fbfcfc;--ink:#1d2b33;--muted:#5a6b70;--rule:#d5e0de;--ok:#0f7c6e;--bad:#b4342a}
  @media (prefers-color-scheme:dark){:root{--paper:#15222a;--ink:#e6eeee;--muted:#9fb1b4;--rule:#2c3d45;--ok:#4cc0ad;--bad:#f07a6e}}
  body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,sans-serif}
  main{max-width:36rem;margin:14vh auto;padding:0 1.25rem}
  h1{font-size:1.5rem;margin:0 0 .5rem;color:${ok ? 'var(--ok)' : 'var(--bad)'}}
  p{margin:.5rem 0;color:var(--muted)} code{color:var(--ink)}
  hr{border:0;border-top:1px solid var(--rule);margin:1.5rem 0}
</style></head><body><main>
<h1>${ok ? 'Signed in' : 'The EHR returned an error'}</h1>
${ok ? '<p>smart-doctor received the authorization code. You can close this tab and go back to your terminal or the smart-doctor window.</p>' : `<p><code>${esc(error)}</code>${description ? ` — ${esc(description)}` : ''}</p><p>Go back to smart-doctor for the diagnosis.</p>`}
<hr><p>This page is served by smart-doctor on your own machine.</p>
</main></body></html>`;
}
