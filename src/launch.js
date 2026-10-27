// SMART App Launch (standalone) flow: authorization_code + PKCE.
//
// The hard real-world part is the redirect URI, which belongs to the company
// that registered the app. Two strategies, both driven through adapters so
// the same engine works in the CLI, the local UI and tests:
//
//   loopback  The redirect URI is http://localhost:PORT/path (or 127.0.0.1).
//             We listen on exactly that address and the browser comes back to us.
//   paste     The redirect URI is anything else (https://app.company.com/cb).
//             The user signs in, lands on the company's page (even an error
//             page is fine), copies the full URL from the address bar, and
//             pastes it back. No registration changes needed.

import { randomBytes, createHash } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify, createLocalJWKSet } from 'jose';
import { loadKey } from './keys.js';
import { discover } from './discovery.js';
import { checkClock } from './clock.js';
import { buildAssertion } from './assertion.js';
import { requestToken, probe } from './token.js';
import { detectVendor } from './vendors/index.js';
import { check, STATUS, httpRequest, mask } from './util.js';
import { Run, withRun } from './core/run.js';
import { inferAuth, checkSecret, clientAuthParams, AUTH_METHODS } from './clientauth.js';
import { isLoopbackUrl, startLoopback, LoopbackError } from './loopback.js';
import { finish, UsageError } from './doctor.js';

export const DEFAULT_LAUNCH_SCOPE = 'launch/patient openid fhirUser offline_access patient/*.rs';

const CLIENT_CAPABILITY = {
  none: 'client-public',
  client_secret_basic: 'client-confidential-symmetric',
  client_secret_post: 'client-confidential-symmetric',
  private_key_jwt: 'client-confidential-asymmetric',
};

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Decide loopback vs paste. */
export function resolveRedirectMode(redirectUri, mode = 'auto') {
  if (mode === 'loopback' || mode === 'paste') return mode;
  return isLoopbackUrl(redirectUri) ? 'loopback' : 'paste';
}

/** Static checks on the redirect URI. */
export function checkRedirectUri(redirectUri, mode) {
  const checks = [];
  let u;
  try {
    u = new URL(redirectUri);
  } catch {
    checks.push(
      check(
        'redirect.valid',
        'Redirect URI is a valid URL',
        STATUS.FAIL,
        `"${redirectUri}" is not a URL.`,
        'Use the exact redirect URI registered for this app.',
      ),
    );
    return checks;
  }
  checks.push(check('redirect.valid', 'Redirect URI is a valid URL', STATUS.PASS, redirectUri));
  if (u.hash)
    checks.push(
      check(
        'redirect.fragment',
        'No #fragment',
        STATUS.FAIL,
        'Redirect URIs must not contain a fragment.',
        'Remove the #… part, here and in the registration.',
      ),
    );
  const loop = isLoopbackUrl(redirectUri);
  if (u.protocol !== 'https:' && !loop) {
    checks.push(
      check(
        'redirect.https',
        'HTTPS (or loopback)',
        STATUS.WARN,
        'Non-HTTPS redirect URIs are only acceptable for loopback addresses or custom app schemes.',
      ),
    );
  }
  if (mode === 'loopback') {
    if (!loop) {
      checks.push(
        check(
          'redirect.loopback',
          'Loopback address',
          STATUS.FAIL,
          'Loopback mode needs an http://localhost or http://127.0.0.1 redirect URI.',
          'Use --redirect-mode paste for any other redirect URI.',
        ),
      );
    } else {
      checks.push(
        check(
          'redirect.loopback',
          'Loopback address',
          STATUS.PASS,
          `smart-doctor will listen on ${u.host}${u.pathname}. The registered value must match exactly — localhost vs 127.0.0.1, port and path all count.`,
        ),
      );
      if (!u.port)
        checks.push(
          check(
            'redirect.port',
            'Explicit port',
            STATUS.WARN,
            'No port: this needs port 80, which usually requires admin rights.',
            'Register a redirect with a high port, e.g. http://localhost:9876/callback.',
          ),
        );
    }
  } else {
    checks.push(
      check(
        'redirect.paste',
        'Paste-back mode',
        STATUS.INFO,
        'After signing in, your browser lands on this address. Copy the full URL from the address bar and paste it back here — even if the page shows an error.',
      ),
    );
  }
  return checks;
}

/**
 * @param {{
 *   fhirBase: string, clientId: string, redirectUri: string, redirectMode?: 'auto'|'loopback'|'paste',
 *   scope?: string, auth?: string, secret?: string, secretEnv?: string,
 *   keyPath?: string, keyText?: string, kid?: string, alg?: string,
 *   vendor?: string, timeoutMs?: number, waitMs?: number, testRefresh?: boolean, probe?: boolean,
 * }} opts
 * @param {{ run?: Run, browser: { open(url: string): Promise<void> }, prompter?: { ask(q: string): Promise<string> }, signal?: AbortSignal }} ctx
 */
export async function runLaunch(opts, ctx = {}) {
  if (!opts.fhirBase) throw new UsageError('--fhir <FHIR base URL> is required');
  if (!opts.clientId) throw new UsageError('--client-id is required');
  if (!opts.redirectUri) throw new UsageError('--redirect-uri is required (the exact redirect URI registered for this app)');
  const auth = inferAuth(opts);
  if (!AUTH_METHODS.includes(auth)) throw new UsageError(`Unknown --auth ${auth}`);
  if (!ctx.browser) throw new UsageError('A browser adapter is required');
  const run = ctx.run || new Run({ flow: 'launch' });
  run.flow = 'launch';
  return withRun(run, () => launchFlow({ ...opts, auth }, run, ctx));
}

async function launchFlow(opts, run, { browser, prompter, signal }) {
  const mode = resolveRedirectMode(opts.redirectUri, opts.redirectMode);
  const scope = opts.scope || DEFAULT_LAUNCH_SCOPE;
  const scopes = scope.split(/\s+/).filter(Boolean);
  const meta = {
    flow: 'launch',
    auth: opts.auth,
    clientId: opts.clientId,
    fhirBase: opts.fhirBase,
    redirectUri: opts.redirectUri,
    redirectMode: mode,
    scope,
  };
  const facts = { flow: 'launch', auth: opts.auth, scope, redirectMode: mode, launch: {} };
  const L = facts.launch;
  let step;

  // 1. Credentials
  let key = { ok: true };
  step = run.step('credentials', 'Client credentials (local only)');
  if (opts.auth === 'private_key_jwt') {
    key = await loadKey({ keyPath: opts.keyPath, keyText: opts.keyText, alg: opts.alg, kid: opts.kid });
    step.add(key.checks);
    if (key.ok) Object.assign(meta, { alg: key.alg, kid: key.kid, thumbprint: key.thumbprint, publicJwk: key.publicJwk });
  } else if (opts.auth === 'none') {
    step.add(check('client.public', 'Public client', STATUS.INFO, 'No client secret or key: the app proves itself with PKCE only.'));
  } else {
    step.add(checkSecret({ secret: opts.secret, secretEnv: opts.secretEnv, auth: opts.auth }));
    key = { ok: Boolean(opts.secret) };
  }
  step.end();

  // 2. Discovery
  step = run.step('discovery', 'Server discovery');
  const disc = await discover({ fhirBase: opts.fhirBase, timeoutMs: opts.timeoutMs, auth: opts.auth, grant: 'authorization_code' });
  step.add(disc.checks);
  const cfg = disc.config || {};
  if (disc.config) {
    if (!disc.authorizeUrl) {
      step.add(
        check(
          'discovery.authorize',
          'Authorization endpoint advertised',
          STATUS.FAIL,
          'No authorization_endpoint.',
          'This server may not support user-facing SMART launch at this base URL.',
        ),
      );
    } else {
      step.add(check('discovery.authorize', 'Authorization endpoint advertised', STATUS.PASS, disc.authorizeUrl));
    }
    const pkce = cfg.code_challenge_methods_supported;
    if (Array.isArray(pkce)) {
      if (pkce.includes('S256')) step.add(check('discovery.pkce', 'PKCE S256 supported', STATUS.PASS));
      else {
        L.s256Unsupported = true;
        step.add(
          check(
            'discovery.pkce',
            'PKCE S256 supported',
            STATUS.FAIL,
            `Advertises only: ${pkce.join(', ') || '(none)'}`,
            'SMART App Launch v2 requires S256. The server may only implement SMART v1.',
          ),
        );
      }
    } else if (disc.source === 'smart-configuration') {
      step.add(
        check(
          'discovery.pkce',
          'PKCE S256 supported',
          STATUS.WARN,
          'code_challenge_methods_supported is not advertised.',
          'smart-doctor will still send S256; SMART v2 servers must advertise it.',
        ),
      );
    }
    const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
    if (caps.length) {
      const need = [['launch-standalone', 'Standalone launch supported']];
      need.push([CLIENT_CAPABILITY[opts.auth], `Client type supported (${CLIENT_CAPABILITY[opts.auth]})`]);
      if (scopes.includes('openid')) need.push(['sso-openid-connect', 'OpenID Connect supported']);
      if (scopes.includes('offline_access')) need.push(['permission-offline', 'Offline access (refresh tokens) supported']);
      if (scopes.includes('launch/patient')) need.push(['context-standalone-patient', 'Patient picker for standalone launch']);
      for (const [cap, title] of need) {
        step.add(
          caps.includes(cap)
            ? check(`discovery.cap.${cap}`, title, STATUS.PASS)
            : check(`discovery.cap.${cap}`, title, STATUS.WARN, `"${cap}" is not in the server's capabilities.`),
        );
      }
    }
  }
  step.end();
  meta.tokenUrl = disc.tokenUrl;
  meta.authorizeUrl = disc.authorizeUrl;
  meta.vendor = detectVendor([opts.fhirBase, disc.tokenUrl], opts.vendor);
  facts.config = cfg;
  // A cached Date is skipped here and checked again from the token response.
  if (disc.serverDate) run.step('clock', 'Clock').add(checkClock(disc.serverDate).check).end();

  // 3. Redirect URI
  step = run.step('redirect', 'Redirect URI');
  const redirectChecks = checkRedirectUri(opts.redirectUri, mode);
  step.add(redirectChecks);
  let loop;
  const redirectOk = !redirectChecks.some((c) => c.status === STATUS.FAIL);
  if (redirectOk && mode === 'loopback' && disc.authorizeUrl && key.ok) {
    try {
      loop = await startLoopback(opts.redirectUri, { waitMs: opts.waitMs ?? 300000 });
      step.add(check('redirect.listen', 'Listening for the redirect', STATUS.PASS, `on ${new URL(opts.redirectUri).host}`));
    } catch (e) {
      L.loopbackError = e.message;
      step.add(
        check(
          'redirect.listen',
          'Listening for the redirect',
          STATUS.FAIL,
          e.message,
          'Free the port (close the app using it) or register another loopback port.',
        ),
      );
    }
  }
  step.end();

  const ready = disc.authorizeUrl && disc.tokenUrl && key.ok && redirectOk && (mode === 'paste' || loop);
  let token;
  if (ready) {
    try {
      token = await authorizeAndExchange({ opts, run, mode, scope, scopes, disc, key, loop, browser, prompter, meta, facts, signal });
      if (disc.serverDate?.cached && token?.serverDate) run.amend('clock', checkClock(token.serverDate).check);
    } finally {
      loop?.close();
    }
  } else {
    loop?.close();
  }

  return finish(run, meta, token, facts);
}

async function authorizeAndExchange({ opts, run, mode, scope, scopes, disc, key, loop, browser, prompter, facts, signal }) {
  const L = facts.launch;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const authUrl = new URL(disc.authorizeUrl);
  const params = {
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope,
    state,
    aud: opts.fhirBase,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) authUrl.searchParams.set(k, v);

  // 4. Sign-in (human step)
  let step = run.step('authorize', 'Sign-in at the EHR');
  step.add(
    check(
      'authorize.url',
      'Authorization request',
      STATUS.INFO,
      `${authUrl.origin}${authUrl.pathname} with PKCE (S256), state, aud and ${scopes.length} scope(s)`,
    ),
  );
  run.action({ type: 'open-url', url: authUrl.toString(), mode });

  let callbackUrl;
  try {
    const cancelled = abortPromise(signal);
    if (mode === 'loopback') {
      await browser.open(authUrl.toString());
      callbackUrl = await Promise.race([loop.result, cancelled]);
    } else {
      await browser.open(authUrl.toString());
      run.action({ type: 'await-paste', redirectUri: opts.redirectUri });
      if (!prompter) throw new UsageError('Paste mode needs a prompt adapter');
      callbackUrl = String(
        await Promise.race([
          prompter.ask(`After signing in, paste the full URL your browser landed on (starts with ${opts.redirectUri})`),
          cancelled,
        ]),
      ).trim();
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      L.cancelled = true;
      step.add(check('authorize.callback', 'Sign-in', STATUS.SKIP, 'Cancelled before the sign-in finished.')).end();
      return undefined;
    }
    if (e instanceof LoopbackError && e.code === 'TIMEOUT') {
      L.callbackTimeout = true;
      step.add(
        check(
          'authorize.callback',
          'Browser came back to the redirect URI',
          STATUS.FAIL,
          `Nothing arrived at ${opts.redirectUri} within ${Math.round((opts.waitMs ?? 300000) / 1000)}s.`,
          'If the EHR showed its own error page, the redirect URI is not registered exactly as sent.',
        ),
      );
      step.end();
      return undefined;
    }
    throw e;
  }
  if (!callbackUrl) {
    L.noPaste = true;
    step.add(check('authorize.callback', 'Callback URL received', STATUS.FAIL, 'Nothing was pasted.')).end();
    return undefined;
  }

  // 5. Inspect the callback
  const cb = parseCallback(callbackUrl, opts.redirectUri);
  if (cb.parseError) {
    L.badPaste = true;
    step
      .add(
        check(
          'authorize.callback',
          'Callback URL received',
          STATUS.FAIL,
          cb.parseError,
          'Paste the complete address-bar URL, including everything after "?".',
        ),
      )
      .end();
    return undefined;
  }
  if (cb.differentBase) {
    step.add(
      check(
        'authorize.callback_base',
        'Callback is the registered redirect URI',
        STATUS.WARN,
        `Got ${cb.base}, expected ${opts.redirectUri}.`,
        'Make sure you pasted the URL from the redirect, not another page.',
      ),
    );
  }
  if (cb.error) {
    L.authorizeError = { error: cb.error, description: cb.errorDescription };
    step
      .add(
        check(
          'authorize.result',
          'EHR approved the sign-in',
          STATUS.FAIL,
          `error=${cb.error}${cb.errorDescription ? ` — "${cb.errorDescription}"` : ''}`,
        ),
      )
      .end();
    return undefined;
  }
  if (!cb.code) {
    L.badPaste = true;
    step
      .add(
        check(
          'authorize.result',
          'Authorization code received',
          STATUS.FAIL,
          'No code= parameter in the callback URL.',
          'Paste the URL exactly as it appeared right after the redirect.',
        ),
      )
      .end();
    return undefined;
  }
  step.add(check('authorize.result', 'Authorization code received', STATUS.PASS, `code ${mask(cb.code, 4)}`));
  if (cb.state !== state) {
    L.stateMismatch = true;
    step
      .add(
        check(
          'authorize.state',
          'state matches',
          STATUS.FAIL,
          cb.state ? 'The state in the callback is not the one smart-doctor sent.' : 'No state in the callback.',
          'Paste the URL from THIS sign-in attempt (one tab, latest attempt).',
        ),
      )
      .end();
    return undefined;
  }
  step.add(check('authorize.state', 'state matches', STATUS.PASS));
  if (cb.iss) {
    const expected = [disc.config?.issuer, opts.fhirBase].filter(Boolean).map((x) => x.replace(/\/+$/, ''));
    if (expected.includes(cb.iss.replace(/\/+$/, ''))) step.add(check('authorize.iss', 'iss matches the server', STATUS.PASS, cb.iss));
    else {
      L.issMismatch = true;
      step.add(
        check(
          'authorize.iss',
          'iss matches the server',
          STATUS.WARN,
          `Callback iss "${cb.iss}" is not this server.`,
          'The code may come from a different authorization server (mix-up). Do not use it.',
        ),
      );
    }
  }
  step.end();

  // 6. Exchange the code
  step = run.step('token', 'Token exchange');
  let assertion;
  if (opts.auth === 'private_key_jwt') {
    assertion = await buildAssertion({
      clientId: opts.clientId,
      tokenUrl: disc.tokenUrl,
      keyObject: key.keyObject,
      alg: key.alg,
      kid: key.kid,
    });
  }
  const token = await requestToken({
    tokenUrl: disc.tokenUrl,
    grantType: 'authorization_code',
    form: { code: cb.code, redirect_uri: opts.redirectUri, code_verifier: verifier },
    clientAuth: clientAuthParams({ auth: opts.auth, clientId: opts.clientId, secret: opts.secret, assertion: assertion?.jwt }),
    scope,
    sendScope: false,
    timeoutMs: opts.timeoutMs,
    label: 'token (authorization_code)',
  });
  step.add(token.checks.map((c) => (c.id === 'token.request' ? { ...c, title: 'Code exchanged for tokens' } : c)));
  step.end();
  if (!token.token) return token;

  // 7. Launch context & identity
  step = run.step('context', 'Launch context and identity');
  const t = token.token;
  if (scopes.includes('launch/patient')) {
    if (t.context?.patient) step.add(check('context.patient', 'Patient context returned', STATUS.PASS, `patient ${t.context.patient}`));
    else {
      L.missingPatient = true;
      step.add(
        check(
          'context.patient',
          'Patient context returned',
          STATUS.FAIL,
          'launch/patient was requested but the token response has no "patient".',
          'Check that launch/patient was granted and the server shows a patient picker.',
        ),
      );
    }
  }
  if (t.context?.need_patient_banner !== undefined)
    step.add(check('context.banner', 'need_patient_banner', STATUS.INFO, String(t.context.need_patient_banner)));
  if (scopes.includes('openid')) step.add(await checkIdToken(t.idToken, { clientId: opts.clientId, disc, opts, scopes, facts }));
  if (scopes.includes('offline_access') || scopes.includes('online_access')) {
    if (t.refreshToken) step.add(check('context.refresh_token', 'Refresh token issued', STATUS.PASS));
    else {
      L.refreshMissing = true;
      step.add(
        check(
          'context.refresh_token',
          'Refresh token issued',
          STATUS.WARN,
          'offline_access/online_access was requested but no refresh_token came back.',
          'The scope may not have been granted, or the server does not issue refresh tokens to this client type.',
        ),
      );
    }
  }
  step.end();

  // 8. Refresh
  if (t.refreshToken && opts.testRefresh !== false) {
    step = run.step('refresh', 'Refresh token works');
    let a2;
    if (opts.auth === 'private_key_jwt')
      a2 = await buildAssertion({ clientId: opts.clientId, tokenUrl: disc.tokenUrl, keyObject: key.keyObject, alg: key.alg, kid: key.kid });
    const r = await requestToken({
      tokenUrl: disc.tokenUrl,
      grantType: 'refresh_token',
      form: { refresh_token: t.refreshToken },
      clientAuth: clientAuthParams({ auth: opts.auth, clientId: opts.clientId, secret: opts.secret, assertion: a2?.jwt }),
      timeoutMs: opts.timeoutMs,
      label: 'token (refresh_token)',
    });
    if (r.token) step.add(check('refresh.result', 'Refreshed access token', STATUS.PASS, `HTTP ${r.status}`));
    else {
      L.refreshError = { error: r.error, description: r.errorDescription, status: r.status };
      step.add(
        check(
          'refresh.result',
          'Refreshed access token',
          STATUS.FAIL,
          `HTTP ${r.status}${r.error ? ` error=${r.error}` : ''}${r.errorDescription ? ` "${r.errorDescription}"` : ''}`,
        ),
      );
    }
    step.end();
  }

  // 9. Probe (status only, never the body)
  if (opts.probe !== false) {
    step = run.step('probe', 'FHIR access');
    const path = t.context?.patient ? `Patient/${encodeURIComponent(t.context.patient)}` : 'metadata';
    step.add(await probe({ fhirBase: opts.fhirBase, path, accessToken: t.accessToken, timeoutMs: opts.timeoutMs }));
    step.end();
  }
  return token;
}

async function checkIdToken(idToken, { clientId, disc, opts, scopes, facts }) {
  const checks = [];
  if (!idToken) {
    facts.launch.idTokenProblem = 'missing';
    checks.push(
      check(
        'context.id_token',
        'id_token returned',
        STATUS.FAIL,
        'openid was requested but no id_token came back.',
        'Check that openid (and fhirUser) were granted to this app.',
      ),
    );
    return checks;
  }
  let claims;
  try {
    claims = decodeJwt(idToken);
    decodeProtectedHeader(idToken);
  } catch {
    facts.launch.idTokenProblem = 'malformed';
    checks.push(check('context.id_token', 'id_token is a valid JWT', STATUS.FAIL, 'Could not decode the id_token.'));
    return checks;
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) {
    facts.launch.idTokenProblem = 'aud';
    checks.push(check('context.id_token_aud', 'id_token aud is your client_id', STATUS.FAIL, `aud ${JSON.stringify(claims.aud)}`));
  }
  // Verify the signature against the server's jwks_uri when advertised.
  const jwksUri = disc.config?.jwks_uri;
  if (jwksUri) {
    const res = await httpRequest(jwksUri, {
      headers: { accept: 'application/json' },
      timeoutMs: opts.timeoutMs,
      label: 'server JWKS (id_token)',
    });
    try {
      await jwtVerify(idToken, createLocalJWKSet(res.json), { audience: clientId, clockTolerance: 60 });
      checks.push(check('context.id_token', 'id_token signature valid', STATUS.PASS, `iss ${claims.iss}`));
    } catch (e) {
      facts.launch.idTokenProblem = 'signature';
      checks.push(
        check(
          'context.id_token',
          'id_token signature valid',
          STATUS.FAIL,
          `${e.code || e.message}`,
          'The id_token does not verify against the server’s jwks_uri.',
        ),
      );
    }
  } else {
    checks.push(
      check('context.id_token', 'id_token returned', STATUS.PASS, `iss ${claims.iss} (signature not verified: no jwks_uri advertised)`),
    );
  }
  if (scopes.includes('fhirUser')) {
    checks.push(
      claims.fhirUser
        ? check('context.fhir_user', 'fhirUser claim', STATUS.PASS, claims.fhirUser)
        : check('context.fhir_user', 'fhirUser claim', STATUS.WARN, 'fhirUser was requested but the id_token has no fhirUser claim.'),
    );
  }
  return checks;
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fire = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
}

/** Parse a pasted/received callback URL (also accepts a bare "?code=…&state=…"). */
export function parseCallback(text, redirectUri) {
  let raw = String(text)
    .trim()
    .replace(/^["']|["']$/g, '');
  if (raw.startsWith('?') || /^code=|^error=/.test(raw)) raw = `${redirectUri.split('?')[0]}${raw.startsWith('?') ? '' : '?'}${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { parseError: 'That is not a URL.' };
  }
  // Some apps put the result in the fragment
  const params = new URLSearchParams(u.search || (u.hash ? u.hash.slice(1) : ''));
  const base = `${u.origin}${u.pathname}`;
  let expectedBase;
  try {
    const r = new URL(redirectUri);
    expectedBase = `${r.origin}${r.pathname}`;
  } catch {
    expectedBase = redirectUri;
  }
  return {
    base,
    differentBase: base !== expectedBase,
    code: params.get('code') || undefined,
    state: params.get('state') || undefined,
    iss: params.get('iss') || undefined,
    error: params.get('error') || undefined,
    errorDescription: params.get('error_description') || undefined,
  };
}
