// End-to-end SMART App Launch: real HTTP against the mock EHR, a scripted
// browser, both redirect strategies, and the failure modes people hit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startMock } from '../src/mock/server.js';
import { runLaunch, parseCallback, resolveRedirectMode, pkcePair } from '../src/launch.js';
import { makeKey } from './helpers.js';
import { fakeBrowser, pastePrompter } from './fake-browser.js';

const APP = 'launch-app';
const COMPANY_REDIRECT = 'https://app.example-company.com/smart/callback';

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Run one launch against a fresh mock.
 * @param {{ client?: object, modes?: string[], opts?: object, browser?: object, paste?: (u:string)=>string, registered?: string[] , redirectUri?: string }} s
 */
async function launch(s = {}) {
  const port = await freePort();
  const redirectUri = s.redirectUri || `http://127.0.0.1:${port}/callback`;
  const registered = s.registered || [redirectUri];
  const mock = await startMock({
    clients: [{ clientId: APP, public: true, redirectUris: registered, ...(s.client || {}) }],
    modes: s.modes || [],
    verboseErrors: true,
  });
  const browser = fakeBrowser({ redirectUri, ...(s.browser || {}) });
  try {
    const r = await runLaunch(
      { fhirBase: mock.fhirBase, clientId: APP, redirectUri, waitMs: 1500, timeoutMs: 5000, ...(s.opts || {}) },
      { browser, prompter: pastePrompter(browser, s.paste) },
    );
    return { r, browser, mock };
  } finally {
    await mock.close();
  }
}
const top = (r) => r.diagnosis.causes[0]?.id;
const ids = (r) => r.diagnosis.causes.map((c) => c.id);
const status = (r, id) => r.sections.flatMap((x) => x.checks).find((c) => c.id === id)?.status;

// ---------- happy paths ----------
test('loopback: public client gets tokens, patient, id_token, refresh', async () => {
  const { r } = await launch();
  assert.equal(r.meta.redirectMode, 'loopback');
  assert.equal(r.diagnosis.verdict, 'ok', JSON.stringify(r.diagnosis.causes));
  for (const id of [
    'authorize.result',
    'authorize.state',
    'authorize.iss',
    'context.patient',
    'context.id_token',
    'context.fhir_user',
    'context.refresh_token',
    'refresh.result',
    'probe',
  ]) {
    assert.equal(status(r, id), 'pass', id);
  }
});

test('paste-back: any company redirect URI works without re-registration', async () => {
  const { r } = await launch({ redirectUri: COMPANY_REDIRECT, registered: [COMPANY_REDIRECT] });
  assert.equal(r.meta.redirectMode, 'paste');
  assert.equal(r.diagnosis.verdict, 'ok', JSON.stringify(r.diagnosis.causes));
  assert.equal(status(r, 'context.patient'), 'pass');
});

test('paste-back accepts just the query string', async () => {
  const { r } = await launch({ redirectUri: COMPANY_REDIRECT, registered: [COMPANY_REDIRECT], paste: (u) => '?' + u.split('?')[1] });
  assert.equal(r.diagnosis.verdict, 'ok');
});

test('confidential symmetric client (client_secret_basic)', async () => {
  const { r } = await launch({
    client: { public: false, secret: 'launch-secret' },
    opts: { auth: 'client_secret_basic', secret: 'launch-secret' },
  });
  assert.equal(r.diagnosis.verdict, 'ok', JSON.stringify(r.diagnosis.causes));
});

test('confidential asymmetric client (private_key_jwt)', async () => {
  const key = await makeKey({ kid: 'launch-k1' });
  const { r } = await launch({
    client: { public: false, jwksFile: key.jwksPath },
    opts: { auth: 'private_key_jwt', keyPath: key.pemPath, kid: 'launch-k1' },
  });
  assert.equal(r.diagnosis.verdict, 'ok', JSON.stringify(r.diagnosis.causes));
});

// ---------- redirect problems ----------
test('redirect URI not registered: EHR shows its own page, never redirects → redirect_not_registered', async () => {
  const port = await freePort();
  const { r, browser } = await launch({
    redirectUri: `http://localhost:${port}/callback`,
    registered: [`http://127.0.0.1:${port}/callback`], // localhost vs 127.0.0.1
  });
  assert.equal(browser.stuckOn?.status, 400);
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(top(r), 'redirect_not_registered');
});

test('loopback port already taken → loopback_port', async () => {
  const port = await freePort();
  const blocker = createServer().listen(port, '127.0.0.1');
  await new Promise((res) => blocker.once('listening', res));
  try {
    const { r } = await launch({ redirectUri: `http://127.0.0.1:${port}/callback` });
    assert.equal(top(r), 'loopback_port');
  } finally {
    blocker.close();
  }
});

test('code reused (already exchanged) → code_consumed', async () => {
  const mock = await startMock({ clients: [{ clientId: APP, public: true, redirectUris: [COMPANY_REDIRECT] }], verboseErrors: true });
  const browser = fakeBrowser({ redirectUri: COMPANY_REDIRECT });
  try {
    const r = await runLaunch(
      { fhirBase: mock.fhirBase, clientId: APP, redirectUri: COMPANY_REDIRECT, timeoutMs: 5000 },
      {
        browser,
        prompter: {
          async ask() {
            // The "company app" exchanges the code first (it has no PKCE verifier, so it burns the code)
            const url = await browser.landed;
            const code = new URL(url).searchParams.get('code');
            await fetch(mock.tokenUrl, {
              method: 'POST',
              body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                client_id: APP,
                redirect_uri: COMPANY_REDIRECT,
                code_verifier: 'x',
              }),
            });
            return url;
          },
        },
      },
    );
    assert.equal(r.diagnosis.verdict, 'fail');
    assert.equal(top(r), 'code_consumed');
  } finally {
    await mock.close();
  }
});

test('pasting a URL from another attempt → state_mismatch', async () => {
  const { r } = await launch({
    redirectUri: COMPANY_REDIRECT,
    registered: [COMPANY_REDIRECT],
    paste: (u) => u.replace(/state=[^&]+/, 'state=old-attempt'),
  });
  assert.equal(top(r), 'state_mismatch');
});

test('server returns wrong state → state_mismatch', async () => {
  const { r } = await launch({ modes: ['wrong-state'] });
  assert.equal(top(r), 'state_mismatch');
});

test('pasting something that is not the callback → bad_paste', async () => {
  const { r } = await launch({
    redirectUri: COMPANY_REDIRECT,
    registered: [COMPANY_REDIRECT],
    paste: () => 'https://app.example-company.com/smart/callback',
  });
  assert.equal(top(r), 'bad_paste');
});

// ---------- authorization errors ----------
test('user denies → access_denied', async () => {
  const { r } = await launch({ browser: { decision: 'deny' } });
  assert.equal(top(r), 'access_denied');
});

test('scope not allowed → authorize_scope', async () => {
  const { r } = await launch({ client: { scopes: ['launch/patient', 'patient/*.rs'] }, opts: { scope: 'openid fhirUser' } });
  assert.equal(top(r), 'authorize_scope');
});

test('disabled client → authorize_client', async () => {
  const { r } = await launch({ client: { enabled: false } });
  assert.equal(top(r), 'authorize_client');
});

test('server only supports PKCE plain → s256_unsupported surfaced', async () => {
  const { r } = await launch({ modes: ['no-s256'] });
  assert.equal(status(r, 'discovery.pkce'), 'fail');
  assert.ok(ids(r).includes('s256_unsupported'));
});

// ---------- token & context problems ----------
test('wrong client secret at code exchange → secret_invalid', async () => {
  const { r } = await launch({
    client: { public: false, secret: 'launch-secret' },
    opts: { auth: 'client_secret_basic', secret: 'wrong' },
  });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(top(r), 'secret_invalid');
});

test('no patient context → missing_patient', async () => {
  const { r } = await launch({ modes: ['no-patient-context'] });
  assert.equal(status(r, 'context.patient'), 'fail');
  assert.ok(ids(r).includes('missing_patient'));
});

test('id_token for another audience → aud fails once, signature still verifies', async () => {
  const { r } = await launch({ modes: ['id-token-wrong-aud'], opts: { scope: 'openid fhirUser launch/patient patient/*.rs' } });
  assert.equal(status(r, 'context.id_token_aud'), 'fail');
  assert.equal(status(r, 'context.id_token'), 'pass', 'a wrong aud is not a bad signature');
  assert.equal(r.diagnosis.causes.find((c) => c.id === 'id_token_problem')?.evidence, 'aud');
});

test('server JWKS down → id_token reported as unverifiable, not as a bad signature', async () => {
  const { r } = await launch({ modes: ['server-jwks-down'], opts: { scope: 'openid fhirUser launch/patient patient/*.rs' } });
  assert.equal(status(r, 'context.id_token'), 'warn');
  assert.match(r.diagnosis.causes.find((c) => c.id === 'id_token_problem')?.evidence || '', /server JWKS unreadable \(HTTP 500\)/);
});

test('no refresh tokens → refresh_problem warning, tokens still work', async () => {
  const { r } = await launch({ modes: ['refresh-disabled'] });
  assert.equal(status(r, 'context.refresh_token'), 'warn');
  assert.equal(r.diagnosis.verdict, 'warn');
  assert.ok(ids(r).includes('refresh_problem'));
});

test('auto-approve server (existing session) still goes through the redirect', async () => {
  const { r, browser } = await launch({ modes: ['auto-approve'] });
  assert.equal(r.diagnosis.verdict, 'ok');
  assert.ok(!browser.stuckOn);
});

// ---------- safety ----------
test('launch trace never contains codes, verifiers or tokens', async () => {
  const { r } = await launch();
  const all = JSON.stringify(r.http);
  assert.ok(!/code_verifier=[A-Za-z0-9_-]{20}/.test(all), 'verifier leaked');
  assert.ok(!/[?&]code=[A-Za-z0-9_-]{20}/.test(all), 'code leaked');
  assert.ok(!/"(access|refresh|id)_token": "[^"…]{20,}"/.test(all), 'token leaked');
  assert.ok(!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(all), 'JWT leaked');
});

// ---------- units ----------
test('parseCallback handles full URLs, query strings, errors and fragments', () => {
  const ru = 'https://a.example/cb';
  assert.equal(parseCallback(`${ru}?code=abc&state=s`, ru).code, 'abc');
  assert.equal(parseCallback('?code=abc&state=s', ru).state, 's');
  assert.equal(parseCallback('code=abc&state=s', ru).code, 'abc');
  assert.equal(parseCallback(`${ru}?error=access_denied`, ru).error, 'access_denied');
  assert.equal(parseCallback(`${ru}#code=abc&state=s`, ru).code, 'abc');
  assert.equal(parseCallback('https://other.example/x?code=1', ru).differentBase, true);
  assert.ok(parseCallback('not a url', ru).parseError);
});

test('redirect mode resolution', () => {
  assert.equal(resolveRedirectMode('http://localhost:9876/callback'), 'loopback');
  assert.equal(resolveRedirectMode('http://127.0.0.1:9876/cb'), 'loopback');
  assert.equal(resolveRedirectMode('https://app.example.com/cb'), 'paste');
  assert.equal(resolveRedirectMode('http://localhost:9876/cb', 'paste'), 'paste');
});

test('PKCE pair is RFC 7636 shaped', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});
