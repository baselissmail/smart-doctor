// Command-line adapter. Parses flags/profiles into engine options, wires the
// terminal browser/prompt adapters, and renders results. No diagnosis logic
// lives here.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCheck, UsageError } from './doctor.js';
import { runLaunch } from './launch.js';
import { Run } from './core/run.js';
import { renderHuman, renderJson, renderMarkdown, confidenceLabel } from './report.js';
import { lintAssertion } from './assertion.js';
import { checkJwks } from './jwks.js';
import { explainError } from './diagnose.js';
import { detectVendor, VENDORS } from './vendors/index.js';
import { generateKeys } from './keys.js';
import { startMock, MODES } from './mock/server.js';
import { STATUS, mask } from './util.js';
import { DEFAULT_SECRET_ENV, isEnvVarName } from './clientauth.js';
import { findConfig, loadProfiles, profileToOptions, saveProfile, ProfileError } from './profiles.js';
import { runWizard } from './wizard.js';
import { systemBrowser } from './adapters/browser.js';
import { terminalPrompter } from './adapters/prompt.js';
import { VERSION } from './version.js';

const HELP = `smart-doctor ${VERSION}
Find out why a SMART on FHIR login fails — backend services or user sign-in.
Your private key and secrets never leave your machine; reports never show tokens.

Getting started
  smart-doctor                 Guided setup the first time, then pick a saved profile
  smart-doctor init            Create a profile (asks a few questions, discovers the rest)
  smart-doctor check <name>    Run a saved profile
  smart-doctor ui              Open the local web view (runs only on your machine)
  smart-doctor mock --write-profiles   Start a practice EHR and save demo profiles

Commands
  check [profile]   Diagnose a login (flow comes from the profile, or --flow)
  launch [profile]  Same as check --flow launch (user sign-in with PKCE)
  profiles          List saved profiles
  inspect [<jwt>|-] Lint a client assertion copied from your app's logs
  explain [<text>]  Explain an error message you already have
  keygen            Generate an RS384/ES384 key pair and public JWKS
  mock              Run a local mock EHR (practice and testing)
  ui                Local web view

check / launch options (override the profile)
  --flow backend|launch
  --fhir <url>               FHIR base URL (discovers everything else)
  --client-id <id>           Client ID for THIS environment
  --auth <method>            private_key_jwt | client_secret_basic | client_secret_post | none
  --key <file>               Private key (PEM, JWK or JWKS) — used locally, never sent
  --kid <kid>                Key ID registered with the server
  --alg <alg>                RS384 or ES384 (default: from the key)
  --jwks-url <url>           Your registered JWKS URL (reachability, kid, key match, leaks)
  --client-secret-env <VAR>  Env var holding the client secret (default ${DEFAULT_SECRET_ENV})
  --scope "<scopes>"         Scopes to request
  --redirect-uri <url>       (launch) The EXACT redirect URI registered for the app
  --redirect-mode <m>        (launch) auto | loopback | paste   (auto: loopback for localhost)
  --wait <seconds>           (launch) How long to wait for sign-in (default 300)
  --no-refresh               (launch) Skip the refresh-token test
  --token-url <url>          Override the discovered token endpoint
  --aud <url>                (backend) Reproduce your app's aud value
  --jku                      (backend) Send the jku header pointing at --jwks-url
  --vendor <id>              Force a vendor profile: ${VENDORS.map((v) => v.id).join(', ')}
  --probe <path>             (backend) After a token, GET <fhir>/<path>; prints the status only
  --offline                  Local checks only; no token request / sign-in
  --save <name>              Save these settings as a profile
  --config <file>            Profiles file (default: nearest smart-doctor.yaml)
  --json | --report          JSON, or a Markdown report safe to paste into a ticket or AI chat
  --verbose, -V              Show every HTTP request and response (secrets masked)
  --redact                   Mask the client_id in the output
  --show-public-jwk          Print the public JWK for your key (safe to share)
  --timeout <ms>             Network timeout per request (default 15000)
  --no-color

Exit codes: 0 = works (or offline checks pass) · 1 = problems found · 2 = usage error
`;

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  const out = (s) => io.stdout.write(s + '\n');
  const errOut = (s) => io.stderr.write(s + '\n');
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'check':
        return await cmdCheck(rest, io, {});
      case 'launch':
        return await cmdCheck(rest, io, { flow: 'launch' });
      case 'init':
        return await cmdInit(rest, io);
      case 'profiles':
        return await cmdProfiles(rest, out);
      case 'inspect':
        return await cmdInspect(rest, out, io.stdin);
      case 'explain':
        return await cmdExplain(rest, out, io.stdin);
      case 'keygen':
        return await cmdKeygen(rest, out);
      case 'mock':
        return await cmdMock(rest, out);
      case 'ui':
        return await cmdUi(rest, out);
      case '-v':
      case '--version':
      case 'version':
        out(VERSION);
        return 0;
      case undefined:
        return await cmdDefault(io);
      case '-h':
      case '--help':
      case 'help':
        out(HELP);
        return 0;
      default:
        errOut(`Unknown command "${cmd}".\n`);
        errOut(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProfileError || /^ERR_PARSE_ARGS/.test(e?.code || '')) {
      errOut(`Usage error: ${e.message}\nRun "smart-doctor --help".`);
      return 2;
    }
    errOut(`smart-doctor crashed: ${e?.stack || e}`);
    return 1;
  }
}

/** How the user invoked us, so printed commands can be pasted as-is. */
function invocation() {
  const script = process.argv[1] || '';
  if (/smart-doctor\.js$/.test(script)) {
    const rel = path.relative(process.cwd(), script);
    return `node ${rel.includes(' ') ? JSON.stringify(rel) : rel}`;
  }
  return 'smart-doctor';
}

function useColor(values) {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !values['no-color'];
}

// ---------------------------------------------------------------- default

async function cmdDefault(io) {
  const out = (s) => io.stdout.write(s + '\n');
  if (!io.stdin.isTTY) {
    out(HELP);
    return 0;
  }
  const cfg = findConfig();
  const { profiles } = await loadProfiles(cfg.path);
  const names = Object.keys(profiles);
  if (!names.length) return cmdInit([], io);
  out(`Profiles in ${cfg.path}:`);
  names.forEach((n, i) => out(`  ${i + 1}) ${n}  ${profiles[n].flow || 'backend'} · ${profiles[n].fhir || ''}`));
  out(`  ${names.length + 1}) Create a new profile`);
  const prompter = terminalPrompter({ input: io.stdin, output: io.stdout });
  const a = await prompter.ask('Run which one', { defaultValue: '1' });
  prompter.close();
  const n = Number(a);
  if (n === names.length + 1 || a === 'new') return cmdInit([], io);
  const name = names[n - 1] || (profiles[a] ? a : undefined);
  if (!name) throw new UsageError(`No profile "${a}".`);
  return cmdCheck([name], io, {});
}

// ---------------------------------------------------------------- init

async function cmdInit(args, io) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
  const out = (s) => io.stdout.write(s + '\n');
  const prompter = terminalPrompter({ input: io.stdin, output: io.stdout });
  try {
    const r = await runWizard({ prompter, out, configPath: values.config ? findConfig({ explicit: values.config }).path : undefined });
    prompter.close();
    if (r.runNow) {
      out('');
      return cmdCheck([r.name, '--config', r.path], io, {});
    }
    return 0;
  } finally {
    prompter.close();
  }
}

// ---------------------------------------------------------------- profiles

async function cmdProfiles(args, out) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, json: { type: 'boolean' } } });
  const cfg = findConfig({ explicit: values.config });
  const { profiles } = await loadProfiles(cfg.path);
  if (values.json) {
    out(JSON.stringify({ path: cfg.path, profiles }, null, 2));
    return 0;
  }
  if (!Object.keys(profiles).length) {
    out(`No profiles yet (looked for ${cfg.path}). Create one with: ${invocation()} init`);
    return 0;
  }
  out(`Profiles in ${cfg.path}:`);
  for (const [n, p] of Object.entries(profiles)) {
    out(`  ${n}`);
    out(`    ${p.flow || 'backend'} · ${p.auth || (p.key ? 'private_key_jwt' : 'auto')} · ${p.fhir || '(no FHIR URL)'}`);
  }
  return 0;
}

// ---------------------------------------------------------------- check / launch

/** @type {import('node:util').ParseArgsConfig['options']} */
const CHECK_OPTIONS = {
  flow: { type: 'string' },
  fhir: { type: 'string' },
  'client-id': { type: 'string' },
  auth: { type: 'string' },
  'client-secret-env': { type: 'string' },
  key: { type: 'string' },
  kid: { type: 'string' },
  alg: { type: 'string' },
  'jwks-url': { type: 'string' },
  jku: { type: 'boolean' },
  scope: { type: 'string' },
  'token-url': { type: 'string' },
  aud: { type: 'string' },
  vendor: { type: 'string' },
  probe: { type: 'string' },
  'redirect-uri': { type: 'string' },
  'redirect-mode': { type: 'string' },
  wait: { type: 'string' },
  'no-refresh': { type: 'boolean' },
  offline: { type: 'boolean' },
  save: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  report: { type: 'boolean' },
  redact: { type: 'boolean' },
  'show-public-jwk': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'V' },
  timeout: { type: 'string' },
  'no-color': { type: 'boolean' },
};

/**
 * Parse a whole-number option. A typo such as "30s" is a usage error rather than a NaN timer
 * that fires at once and looks like a network failure.
 * @param {string} flag
 * @param {unknown} value
 * @param {number} [min]
 */
function wholeNumber(flag, value, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new UsageError(`--${flag} must be a whole number${min ? ` of at least ${min}` : ''} (got "${value}").`);
  return n;
}

/**
 * Build engine options from (profile ⊕ env ⊕ flags). Exported for the UI and tests.
 * @param {{ profileName?: string, values?: Record<string, any>, env?: NodeJS.ProcessEnv, forced?: Partial<import('./types.js').RunOptions> }} p
 * @returns {Promise<import('./types.js').RunOptions & Record<string, any>>}
 */
export async function resolveOptions({ profileName, values = {}, env = process.env, forced = {} }) {
  const cfg = findConfig({ explicit: values.config, env });
  /** @type {Record<string, any>} */
  let base = {};
  if (profileName) {
    const { profiles } = await loadProfiles(cfg.path);
    if (!profiles[profileName]) {
      const known = Object.keys(profiles);
      throw new UsageError(
        `No profile "${profileName}" in ${cfg.path}.${known.length ? ` Known: ${known.join(', ')}.` : ' Create one with: smart-doctor init'}`,
      );
    }
    base = profileToOptions(profiles[profileName], { configPath: cfg.path, env });
  }
  if (values['client-secret-env'] !== undefined && !isEnvVarName(values['client-secret-env']))
    throw new UsageError('--client-secret-env takes the NAME of an environment variable (like MY_APP_SECRET), not the secret itself.');
  const secretEnv = values['client-secret-env'] || base.secretEnv || DEFAULT_SECRET_ENV;
  // Precedence: command-line flag > profile > environment variable.
  const pick = (flag, envName, fromProfile) => values[flag] ?? fromProfile ?? (envName ? env[envName] : undefined);
  const opts = {
    ...base,
    flow: forced.flow || values.flow || base.flow || (values['redirect-uri'] ? 'launch' : 'backend'),
    fhirBase: pick('fhir', 'SMART_DOCTOR_FHIR', base.fhirBase),
    clientId: pick('client-id', 'SMART_DOCTOR_CLIENT_ID', base.clientId),
    auth: pick('auth', undefined, base.auth),
    keyPath: values.key
      ? path.resolve(values.key)
      : base.keyPath || (env.SMART_DOCTOR_KEY ? path.resolve(env.SMART_DOCTOR_KEY) : undefined),
    kid: pick('kid', 'SMART_DOCTOR_KID', base.kid),
    alg: pick('alg', undefined, base.alg),
    jwksUrl: pick('jwks-url', 'SMART_DOCTOR_JWKS_URL', base.jwksUrl),
    jku: values.jku,
    scope: pick('scope', undefined, base.scope),
    tokenUrl: pick('token-url', undefined, base.tokenUrl),
    aud: values.aud,
    vendor: pick('vendor', undefined, base.vendor),
    probePath: pick('probe', undefined, base.probePath),
    redirectUri: pick('redirect-uri', undefined, base.redirectUri),
    redirectMode: pick('redirect-mode', undefined, base.redirectMode) || 'auto',
    secretEnv,
    secret: env[secretEnv],
    tokenRequest: !values.offline,
    timeoutMs: values.timeout !== undefined ? wholeNumber('timeout', values.timeout, 1) : base.timeoutMs || 15000,
    waitMs: values.wait !== undefined ? wholeNumber('wait', values.wait, 1) * 1000 : 300000,
    testRefresh: !values['no-refresh'],
    configPath: cfg.path,
  };
  if (!['backend', 'launch'].includes(opts.flow)) throw new UsageError(`--flow must be backend or launch`);
  if (opts.keyPath && !existsSync(opts.keyPath)) throw new UsageError(`Key file not found: ${opts.keyPath}`);
  if (opts.alg && !/^(RS|ES|PS)(256|384|512)$/.test(opts.alg)) throw new UsageError(`Unsupported --alg ${opts.alg}`);
  if (opts.redirectMode && !['auto', 'loopback', 'paste'].includes(opts.redirectMode))
    throw new UsageError('--redirect-mode must be auto, loopback or paste');
  return opts;
}

async function cmdCheck(args, io, forced) {
  const out = (s) => io.stdout.write(s + '\n');
  const err = (s) => io.stderr.write(s + '\n');
  const parsed = parseArgs({ args, options: CHECK_OPTIONS, allowPositionals: true, strict: true });
  const values = /** @type {Record<string, any>} */ (parsed.values);
  const positionals = parsed.positionals;
  if (positionals.length > 1) throw new UsageError(`Expected at most one profile name, got: ${positionals.join(' ')}`);
  const opts = await resolveOptions({ profileName: positionals[0], values, forced });

  if (values.save) {
    const saved = await saveProfile(opts.configPath, values.save, optionsToProfile(opts, values));
    err(`Saved profile "${values.save}" to ${saved.path}`);
  }

  const machine = values.json || values.report;
  const run = new Run({ flow: opts.flow });
  const live = !machine && Boolean(io.stderr.isTTY);
  if (live) {
    run.on('step:end', (s) =>
      err(`  ${s.status === 'fail' ? '✖' : s.status === 'warn' ? '!' : s.status === 'running' ? '…' : '✔'} ${s.name}`),
    );
  }

  let result;
  if (opts.flow === 'launch') {
    if (opts.tokenRequest === false) throw new UsageError('--offline is not available for launch yet; it needs a real sign-in.');
    const browser = systemBrowser({
      print: (url) => {
        err('\nSign in at the EHR — your browser should open. If it does not, open this URL:');
        err(`  ${url}\n`);
      },
    });
    run.on('action', (a) => {
      if (a.type === 'open-url' && a.mode === 'loopback')
        err(`Waiting for the EHR to redirect back to ${opts.redirectUri} … (Ctrl+C to cancel)`);
      if (a.type === 'await-paste') {
        err('After signing in your browser lands on your redirect URI — it may show an error page, that is fine.');
        err('Copy the FULL URL from the address bar and paste it below.');
      }
    });
    const prompter = terminalPrompter({ input: io.stdin, output: io.stderr });
    try {
      result = await runLaunch(opts, { run, browser, prompter });
    } finally {
      prompter.close();
    }
  } else {
    result = await runCheck(opts, { run });
  }
  if (live) err('');

  if (values.json) out(renderJson(result, { redact: values.redact }));
  else if (values.report) out(renderMarkdown(result, { redact: values.redact ?? true, verbose: values.verbose }));
  else
    out(
      renderHuman(result, {
        color: useColor(values),
        redact: values.redact,
        showPublicJwk: values['show-public-jwk'],
        verbose: values.verbose,
      }),
    );
  return result.diagnosis.verdict === 'fail' ? 1 : 0;
}

/** The inverse of profileToOptions, for --save. Only explicit, non-secret settings. */
function optionsToProfile(o, values) {
  const rel = (p) => (p ? path.relative(path.dirname(o.configPath), p) || p : undefined);
  return {
    flow: o.flow,
    fhir: o.fhirBase,
    clientId: o.clientId,
    auth: o.auth,
    key: rel(o.keyPath),
    kid: o.kid,
    alg: values.alg,
    jwksUrl: o.jwksUrl,
    scope: o.scope,
    tokenUrl: values['token-url'],
    vendor: o.vendor,
    secretEnv: o.secretEnv !== DEFAULT_SECRET_ENV ? o.secretEnv : undefined,
    redirectUri: o.redirectUri,
    redirectMode: o.redirectMode !== 'auto' ? o.redirectMode : undefined,
    probe: o.probePath,
  };
}

// ---------------------------------------------------------------- inspect / explain / keygen

async function readInput(positional, stdin) {
  if (positional && positional !== '-') return positional;
  if (stdin.isTTY && positional !== '-') throw new UsageError('Pass the value as an argument, or pipe it in with "-".');
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim();
}

async function cmdInspect(args, out, stdin) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'token-url': { type: 'string' },
      'client-id': { type: 'string' },
      'jwks-url': { type: 'string' },
      json: { type: 'boolean' },
      'no-color': { type: 'boolean' },
    },
  });
  const jwt = (await readInput(positionals[0], stdin)).replace(/^Bearer\s+/i, '').replace(/^client_assertion=/, '');
  let jwksKids;
  const extra = [];
  if (values['jwks-url']) {
    const header = (() => {
      try {
        return JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'));
      } catch {
        return {};
      }
    })();
    const j = await checkJwks({ jwksUrl: values['jwks-url'], kid: header.kid, alg: header.alg });
    jwksKids = j.kids;
    extra.push(...j.checks.filter((c) => c.id !== 'jwks.kid'));
  }
  const lint = lintAssertion(jwt, { tokenUrl: values['token-url'], clientId: values['client-id'], jwksKids });
  const checks = [...extra, ...lint.checks];
  const failedAny = checks.some((c) => c.status === STATUS.FAIL);
  if (values.json) {
    out(JSON.stringify({ header: lint.header, claims: lint.claims, checks, signature: '[not shown]' }, null, 2));
  } else {
    const result = {
      meta: { clientId: lint.claims?.iss, tokenUrl: values['token-url'] },
      sections: [{ name: `Assertion ${mask(jwt, 12)}`, checks }],
      diagnosis: { verdict: failedAny ? 'fail' : 'offline', causes: [] },
    };
    const text = renderHuman(result, { color: useColor(values) }).split('\n');
    out(
      text
        .slice(
          0,
          text.findIndex((l) => /Result:/.test(l)),
        )
        .join('\n'),
    );
    if (lint.header) {
      out('Decoded header: ' + JSON.stringify(lint.header));
      out('Decoded claims: ' + JSON.stringify(lint.claims));
    }
    out(
      failedAny
        ? 'Problems found in this assertion.'
        : 'No structural problems found. (Only the server can verify the signature against the key it has on file.)',
    );
    if (!values['token-url']) out('Tip: add --token-url <token endpoint> to verify aud exactly.');
  }
  return failedAny ? 1 : 0;
}

async function cmdExplain(args, out, stdin) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      vendor: { type: 'string' },
      url: { type: 'string' },
      status: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const text = await readInput(positionals.join(' ') || undefined, stdin);
  if (!text) throw new UsageError('Nothing to explain.');
  const vendor = detectVendor([values.url], values.vendor);
  const d = explainError(text, { vendor, status: values.status !== undefined ? wholeNumber('status', values.status, 100) : undefined });
  if (values.json) {
    out(JSON.stringify(d.causes, null, 2));
    return 0;
  }
  out(`Error explained${vendor.id !== 'generic' ? ` (${vendor.name} profile)` : ''}:`);
  if (!d.causes.length) out('  No known pattern matched. Run `smart-doctor check` for a full diagnosis.');
  d.causes.slice(0, 6).forEach((c, i) => {
    out(`  ${i + 1}. ${c.title} (${confidenceLabel(c.confidence)})`);
    out(`     ${c.why}`);
    out(`     fix: ${c.fix}`);
  });
  out('\nOAuth servers keep these errors vague on purpose. For a definitive answer, run `smart-doctor check` with your key.');
  return 0;
}

async function cmdKeygen(args, out) {
  const { values } = parseArgs({
    args,
    options: { alg: { type: 'string', default: 'ES384' }, kid: { type: 'string' }, out: { type: 'string', default: '.smart-doctor/keys' } },
  });
  const g = await generateKeys({ alg: values.alg, kid: values.kid, outDir: values.out });
  out(`Generated ${g.alg} key pair (kid ${g.kid})`);
  out(`  private key (keep secret, chmod 600): ${g.pemPath}`);
  out(`  public JWKS (host this / upload it):  ${g.jwksPath}`);
  return 0;
}

// ---------------------------------------------------------------- mock

export const DEMO = {
  secret: 'demo-secret-value',
  redirects: ['http://localhost:9876/callback', 'http://127.0.0.1:9876/callback', 'https://app.example.com/smart/callback'],
};

/**
 * Start the practice EHR with three demo apps. Shared by `mock` and `ui --demo`.
 * @param {{ port?: number, host?: string, modes?: string[], verboseErrors?: boolean, log?: (line: string) => void, keyDir?: string }} [opts]
 */
export async function startDemoMock({
  port = 4013,
  host = '127.0.0.1',
  modes = [],
  verboseErrors,
  log,
  keyDir = path.resolve('.smart-doctor/demo'),
} = {}) {
  const pem = path.join(keyDir, 'private-key.pem');
  const jwks = path.join(keyDir, 'jwks.json');
  if (!existsSync(pem) || !existsSync(jwks)) await generateKeys({ alg: 'ES384', kid: 'demo-key-1', outDir: keyDir });
  const kid = JSON.parse(await readFile(jwks, 'utf8')).keys[0].kid;
  const mock = await startMock({
    port,
    host,
    modes,
    verboseErrors,
    log,
    clients: [
      { clientId: 'demo-backend', jwksFile: jwks },
      { clientId: 'demo-secret', secret: DEMO.secret },
      { clientId: 'demo-launch', public: true, redirectUris: DEMO.redirects },
    ],
  });
  const profiles = {
    'demo-backend': {
      flow: 'backend',
      fhir: mock.fhirBase,
      clientId: 'demo-backend',
      auth: 'private_key_jwt',
      key: pem,
      kid,
      jwksUrl: mock.jwksUrlFor('demo-backend'),
      scope: 'system/Patient.rs',
    },
    'demo-secret': {
      flow: 'backend',
      fhir: mock.fhirBase,
      clientId: 'demo-secret',
      auth: 'client_secret_basic',
      secretEnv: 'SMART_DOCTOR_DEMO_SECRET',
      scope: 'system/Patient.rs',
    },
    'demo-launch': { flow: 'launch', fhir: mock.fhirBase, clientId: 'demo-launch', auth: 'none', redirectUri: DEMO.redirects[0] },
    'demo-launch-paste': { flow: 'launch', fhir: mock.fhirBase, clientId: 'demo-launch', auth: 'none', redirectUri: DEMO.redirects[2] },
  };
  return { mock, profiles, pem, kid };
}

async function cmdMock(args, out) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: '4013' },
      host: { type: 'string', default: '127.0.0.1' },
      mode: { type: 'string', multiple: true },
      'verbose-errors': { type: 'boolean' },
      'list-modes': { type: 'boolean' },
      'write-profiles': { type: 'boolean' },
      config: { type: 'string' },
      quiet: { type: 'boolean' },
    },
  });
  if (values['list-modes']) {
    for (const [k, v] of Object.entries(MODES)) out(`  ${k.padEnd(20)} ${v}`);
    return 0;
  }
  const modes = (values.mode || [])
    .flatMap((m) => m.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const { mock, profiles } = await startDemoMock({
    port: wholeNumber('port', values.port),
    host: values.host,
    modes,
    verboseErrors: values['verbose-errors'],
    log: values.quiet ? undefined : (l) => out(`  [mock] ${l}`),
  });
  out(`Mock EHR running${modes.length ? ` with modes: ${modes.join(', ')}` : ''} — synthetic data only`);
  out(`  FHIR base:  ${mock.fhirBase}`);
  out('  Demo apps:  demo-backend (private key) · demo-secret (client secret) · demo-launch (public, user sign-in)');
  const me = invocation();
  if (values['write-profiles']) {
    const cfg = findConfig({ explicit: values.config });
    for (const [n, p] of Object.entries(profiles)) await saveProfile(cfg.path, n, p);
    out(`\nSaved demo profiles to ${cfg.path}. In another terminal, in this folder:`);
    out(`  ${me} check demo-backend`);
    out(`  SMART_DOCTOR_DEMO_SECRET=${DEMO.secret} ${me} check demo-secret`);
    out(`  ${me} check demo-launch          (sign-in; smart-doctor catches the redirect)`);
    out(`  ${me} check demo-launch-paste    (sign-in; you paste the URL you land on)`);
    out(`  ${me} ui                         (the same, in your browser)`);
  } else {
    const p = profiles['demo-backend'];
    out('\nTry it in another terminal (or re-run with --write-profiles for one-word commands):');
    out(
      `  ${me} check --fhir ${mock.fhirBase} --client-id demo-backend --key ${path.relative(process.cwd(), p.key)} --kid ${p.kid} --jwks-url ${p.jwksUrl} --scope "system/Patient.rs"`,
    );
    out(`  ${me} launch --fhir ${mock.fhirBase} --client-id demo-launch --auth none --redirect-uri ${DEMO.redirects[0]}`);
  }
  out('\nCtrl+C to stop.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await mock.close();
  return 0;
}

// ---------------------------------------------------------------- ui

async function cmdUi(args, out) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: '0' },
      config: { type: 'string' },
      'no-open': { type: 'boolean' },
      demo: { type: 'boolean' },
    },
  });
  const { startUi } = await import('./ui/server.js');
  const ui = await startUi({
    port: wholeNumber('port', values.port),
    configPath: findConfig({ explicit: values.config }).path,
    demo: values.demo,
    log: out,
  });
  out(`smart-doctor UI: ${ui.url}`);
  out('Only reachable from this machine. Ctrl+C to stop.');
  if (!values['no-open']) await systemBrowser().open(ui.url);
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await ui.close();
  return 0;
}
