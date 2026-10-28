// End-to-end: real HTTP against the mock EHR, one scenario per failure mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { exportJWK } from 'jose';
import { scenario, makeKey, topCause, causeIds, checkStatus, writeJson, tmp, CLIENT_ID } from './helpers.js';
import { runCheck } from '../src/doctor.js';
import { renderHuman, renderJson, renderMarkdown } from '../src/report.js';
import { listen } from '../src/util.js';

test('happy path: token obtained, verdict ok', async () => {
  const r = await scenario({ check: { scope: 'system/Patient.rs', probePath: 'Patient' } });
  assert.equal(r.tokenObtained, true);
  assert.equal(r.diagnosis.verdict, 'ok');
  assert.equal(checkStatus(r, 'probe'), 'pass');
  assert.equal(checkStatus(r, 'jwks.key_match'), 'pass');
});

test('happy path with RSA RS384 key', async () => {
  const key = await makeKey({ alg: 'RS384', kid: 'rsa-1' });
  const r = await scenario({ key });
  assert.equal(r.diagnosis.verdict, 'ok');
  assert.equal(r.meta.alg, 'RS384');
});

test('aud with a trailing slash → aud_mismatch', async () => {
  const r = await scenario({ check: (mock) => ({ aud: mock.tokenUrl + '/' }) });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'aud_mismatch');
  assert.match(r.diagnosis.causes[0].evidence, /trailing slash/);
});

test('aud set to the FHIR base instead of the token URL → aud_mismatch', async () => {
  const r = await scenario({ check: (mock) => ({ aud: mock.fhirBase }) });
  assert.equal(topCause(r), 'aud_mismatch');
  assert.match(r.diagnosis.causes[0].evidence, /FHIR base/);
});

test('kid not in JWKS → kid_unknown', async () => {
  const key = await makeKey({ kid: 'k1' });
  const r = await scenario({ key, check: { kid: 'not-registered' } });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'kid_unknown');
  assert.ok(!causeIds(r).includes('kid_missing'));
});

test('signing with a different key than the one published → key_mismatch', async () => {
  const published = await makeKey({ kid: 'k1' });
  const signing = await makeKey({ kid: 'k1' });
  const r = await scenario({ key: signing, jwksFile: published.jwksPath });
  assert.equal(checkStatus(r, 'jwks.key_match'), 'fail');
  assert.equal(topCause(r), 'key_mismatch');
});

test('JWKS that publishes private key material → critical cause first', async () => {
  const key = await makeKey({ kid: 'k1' });
  const priv = await exportJWK(createPrivateKey(await readFile(key.pemPath, 'utf8')));
  const leakFile = path.join(key.dir, 'leaky-jwks.json');
  await writeJson(leakFile, { keys: [{ ...priv, kid: 'k1', alg: 'ES384' }] });
  const r = await scenario({ key, jwksFile: leakFile });
  assert.equal(checkStatus(r, 'jwks.private_leak'), 'fail');
  assert.equal(topCause(r), 'jwks_private_leak');
  assert.equal(r.diagnosis.verdict, 'fail', 'a leaked private key must always fail, even if the token works');
});

test('server clock 10 minutes ahead → clock_skew', async () => {
  const r = await scenario({ modes: ['clock-skew'] });
  assert.equal(checkStatus(r, 'clock.skew'), 'fail');
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'clock_skew');
});

test('discovery served from a cache (stale Date) → no false clock skew', async () => {
  const r = await scenario({ modes: ['cached-discovery'] });
  assert.notEqual(checkStatus(r, 'clock.skew'), 'fail');
  assert.equal(r.diagnosis.verdict, 'ok');
});

test('cached discovery + a real skew → caught from the token response', async () => {
  const r = await scenario({ modes: ['cached-discovery', 'clock-skew'] });
  assert.equal(topCause(r), 'clock_skew');
});

test('server only accepts RS384, client signs ES384 → alg_unsupported', async () => {
  const r = await scenario({ modes: ['rs384-only'] });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'alg_unsupported');
});

test('server only supports client secrets → auth_method', async () => {
  const r = await scenario({ modes: ['secret-only'] });
  assert.equal(checkStatus(r, 'discovery.auth_method'), 'warn');
  assert.equal(topCause(r), 'auth_method');
});

test('client disabled on the server → client_inactive (unauthorized_client)', async () => {
  const r = await scenario({ client: { enabled: false } });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'client_inactive');
});

test('scope not allowed → scope', async () => {
  const r = await scenario({ check: { scope: 'system/Patient.write' } });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'scope');
});

test('v2 scopes against a v1-only server → scope + scope_syntax', async () => {
  const r = await scenario({ modes: ['v1-scopes-only'], check: { scope: 'system/Patient.rs' } });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.ok(['scope', 'scope_syntax'].includes(topCause(r)));
  assert.ok(causeIds(r).includes('scope_syntax'));
});

test('partially granted scopes → verdict warn with scope_partial', async () => {
  const r = await scenario({ check: { scope: 'system/Patient.rs system/Patient.write' } });
  assert.equal(r.tokenObtained, true);
  assert.equal(r.diagnosis.verdict, 'warn');
  assert.ok(causeIds(r).includes('scope_partial'));
});

test('probe refused (403) → probe_failed', async () => {
  const r = await scenario({ client: { scopes: ['system/Patient.rs'] }, check: { scope: 'system/Patient.rs', probePath: 'Observation' } });
  assert.equal(checkStatus(r, 'probe'), 'fail');
  assert.ok(causeIds(r).includes('probe_failed'));
});

test('no .well-known → falls back to CapabilityStatement and still works', async () => {
  const r = await scenario({ modes: ['no-discovery'] });
  assert.equal(checkStatus(r, 'discovery.config'), 'warn');
  assert.equal(checkStatus(r, 'discovery.capability'), 'pass');
  assert.equal(r.tokenObtained, true);
});

test('server cached the old key (rotation not picked up) → server_side_registration', async () => {
  const oldKey = await makeKey({ kid: 'old' });
  const newKey = await makeKey({ kid: 'new' });
  const dir = await tmp();
  const jwksFile = path.join(dir, 'jwks.json');
  await writeJson(jwksFile, oldKey.jwks);
  const r = await scenario({
    key: newKey,
    jwksFile,
    modes: ['stale-jwks'],
    before: async () => writeJson(jwksFile, newKey.jwks), // rotate after the server snapshotted
  });
  // Every local check passes...
  assert.equal(checkStatus(r, 'jwks.kid'), 'pass');
  assert.equal(checkStatus(r, 'jwks.key_match'), 'pass');
  // ...but the server says invalid_client
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'server_side_registration');
});

test('429 → rate_limited', async () => {
  const r = await scenario({ modes: ['rate-limit'] });
  assert.equal(topCause(r), 'rate_limited');
});

test('500 → server_error', async () => {
  const r = await scenario({ modes: ['server-error'] });
  assert.equal(topCause(r), 'server_error');
});

test('unreachable server → network', async () => {
  const key = await makeKey();
  const r = await runCheck({
    fhirBase: 'http://127.0.0.1:9/fhir',
    clientId: CLIENT_ID,
    keyPath: key.pemPath,
    kid: key.kid,
    timeoutMs: 2000,
  });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'network');
});

test('wrong client_id on Epic-looking URL → server-side causes incl. Epic hint', async () => {
  const r = await scenario({ check: { clientId: 'someone-else', vendor: 'epic' } });
  assert.equal(r.diagnosis.verdict, 'fail');
  const ids = causeIds(r);
  assert.ok(ids.includes('server_side_registration'));
  assert.ok(ids.includes('epic.client_id_env'));
});

test('--offline makes no token request', async () => {
  const r = await scenario({ check: { tokenRequest: false } });
  assert.equal(r.tokenRequested, false);
  assert.equal(r.diagnosis.verdict, 'offline');
});

test('reports never contain tokens, assertions or private key material', async () => {
  const key = await makeKey();
  const r = await scenario({ key, check: { scope: 'system/Patient.rs' } });
  assert.ok(r._accessToken);
  const pem = await readFile(key.pemPath, 'utf8');
  const d = (await exportJWK(createPrivateKey(pem))).d;
  for (const text of [renderHuman(r, { showPublicJwk: true }), renderJson(r), renderMarkdown(r)]) {
    assert.ok(!text.includes(r._accessToken), 'access token leaked');
    assert.ok(!text.includes(d), 'private key leaked');
    assert.ok(!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(text), 'a JWT leaked');
  }
});

test('HTTP trace records every exchange with secrets masked', async () => {
  const r = await scenario({ check: { scope: 'system/Patient.rs', probePath: 'Patient' } });
  const urls = r.http.map((x) => x.url);
  assert.ok(urls.some((u) => u.endsWith('/.well-known/smart-configuration')));
  assert.ok(urls.some((u) => u.endsWith('/oauth2/token')));
  const tokenX = r.http.find((x) => x.url.endsWith('/oauth2/token'));
  assert.match(tokenX.request.body, /client_assertion=eyJhbGci…\[masked/);
  assert.match(tokenX.response.body, /"access_token": ".{8}…\[masked/);
  const probeX = r.http.find((x) => x.url.endsWith('/Patient'));
  assert.equal(probeX.request.headers.authorization, 'Bearer [masked]');
  assert.match(probeX.response.body, /not recorded by design/);
  const all = JSON.stringify(r.http);
  assert.ok(!all.includes(r._accessToken));
  assert.ok(!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(all), 'no full JWT in trace');
});

test('run emits live step events in execution order, then done', async () => {
  const { Run } = await import('../src/core/run.js');
  const { startMock } = await import('../src/mock/server.js');
  const key = await makeKey();
  const mock = await startMock({ clients: [{ clientId: CLIENT_ID, jwksFile: key.jwksPath }] });
  const run = new Run();
  const seen = [];
  let httpCount = 0;
  let done;
  run.on('step:start', (s) => seen.push(`start:${s.id}`));
  run.on('step:end', (s) => seen.push(`end:${s.id}:${s.status}`));
  run.on('http', () => httpCount++);
  run.on('done', (r) => (done = r));
  try {
    await runCheck(
      { fhirBase: mock.fhirBase, clientId: CLIENT_ID, keyPath: key.pemPath, kid: key.kid, jwksUrl: mock.jwksUrlFor(CLIENT_ID) },
      { run },
    );
  } finally {
    await mock.close();
  }
  assert.deepEqual(
    seen.filter((x) => x.startsWith('end:')).map((x) => x.split(':')[1]),
    ['key', 'discovery', 'clock', 'jwks', 'assertion', 'token'],
  );
  assert.ok(httpCount >= 3);
  assert.equal(done.diagnosis.verdict, 'ok');
  assert.equal(done._accessToken, undefined, 'done event must not carry the token');
});

// ---------- client secrets ----------
async function secretScenario({ secret, auth = 'client_secret_basic', client = {}, modes = [] } = {}) {
  const { startMock } = await import('../src/mock/server.js');
  const mock = await startMock({ clients: [{ clientId: CLIENT_ID, secret: 's3cr3t-value', ...client }], modes });
  try {
    return await runCheck({ fhirBase: mock.fhirBase, clientId: CLIENT_ID, auth, secret, scope: 'system/Patient.rs' });
  } finally {
    await mock.close();
  }
}

test('client_secret_basic works', async () => {
  const r = await secretScenario({ secret: 's3cr3t-value' });
  assert.equal(r.diagnosis.verdict, 'ok');
  assert.ok(!r.sections.some((s) => s.id === 'jwks' || s.id === 'assertion'));
  const tokenX = r.http.find((x) => x.url.endsWith('/oauth2/token'));
  assert.equal(tokenX.request.headers.authorization, 'Basic [masked]');
});

test('client_secret_post works', async () => {
  const r = await secretScenario({ secret: 's3cr3t-value', auth: 'client_secret_post' });
  assert.equal(r.diagnosis.verdict, 'ok');
  const tokenX = r.http.find((x) => x.url.endsWith('/oauth2/token'));
  assert.ok(!tokenX.request.body.includes('s3cr3t-value'), 'secret must be masked in the trace');
});

test('wrong secret → secret_invalid', async () => {
  const r = await secretScenario({ secret: 'nope' });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.equal(topCause(r), 'secret_invalid');
});

test('missing secret → secret_missing, no request made', async () => {
  const r = await secretScenario({ secret: undefined });
  assert.equal(r.tokenRequested, false);
  assert.equal(topCause(r), 'secret_missing');
});

test('secret with trailing newline → secret_whitespace', async () => {
  const r = await secretScenario({ secret: 's3cr3t-value\n' });
  assert.equal(topCause(r), 'secret_whitespace');
});

test('server only accepts post, client uses basic → secret causes incl. basic/post mismatch', async () => {
  const r = await secretScenario({ secret: 's3cr3t-value', client: { secretMethods: ['client_secret_post'] } });
  assert.equal(r.diagnosis.verdict, 'fail');
  assert.ok(causeIds(r).includes('secret_method'));
});

test('a secret the server echoes back reaches no output, not even in part', async () => {
  const SECRET = 'Echoed-Secret-Value-1234';
  for (const auth of ['client_secret_post', 'client_secret_basic']) {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const base = `http://127.0.0.1:${port}`;
        if (req.url.startsWith('/.well-known/smart-configuration')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ issuer: base, token_endpoint: `${base}/token`, token_endpoint_auth_methods_supported: [auth] }));
        }
        const basic = Buffer.from(String(req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
        const sent = new URLSearchParams(body).get('client_secret') || basic.slice(basic.indexOf(':') + 1);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client', error_description: `client_secret ${sent} is not valid` }));
      });
    });
    const port = await listen(server, 0, '127.0.0.1');
    try {
      const r = await runCheck({
        fhirBase: `http://127.0.0.1:${port}`,
        clientId: CLIENT_ID,
        auth,
        secret: SECRET,
        scope: 'system/Patient.rs',
      });
      assert.equal(r.diagnosis.verdict, 'fail');
      const outputs = [renderHuman(r), renderHuman(r, { verbose: true }), renderJson(r), renderJson(r, { redact: true })];
      for (const text of [...outputs, renderMarkdown(r), renderMarkdown(r, { verbose: true })]) {
        assert.ok(!text.includes(SECRET.slice(0, 6)), `${auth}: the secret leaked`);
      }
    } finally {
      server.close();
    }
  }
});
