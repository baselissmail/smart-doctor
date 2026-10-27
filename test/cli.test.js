import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { main } from '../src/cli.js';
import { startMock } from '../src/mock/server.js';
import { loadKey } from '../src/keys.js';
import { buildAssertion } from '../src/assertion.js';
import { makeKey, tmp, CLIENT_ID } from './helpers.js';

async function run(args, stdinText) {
  let stdout = '';
  let stderr = '';
  const stdin = Readable.from(stdinText ? [stdinText] : []);
  stdin.isTTY = !stdinText;
  const code = await main(args, { stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) }, stdin });
  return { code, stdout, stderr };
}

test('help and version', async () => {
  assert.equal((await run(['--help'])).code, 0);
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+/);
  assert.equal((await run(['bogus'])).code, 2);
});

test('check: number options and the secret variable name are validated', async () => {
  const base = ['check', '--fhir', 'http://127.0.0.1:9/fhir', '--client-id', 'c', '--auth', 'client_secret_basic'];
  const t = await run([...base, '--timeout', '30s']);
  assert.equal(t.code, 2);
  assert.match(t.stderr, /--timeout must be a whole number/);
  const leaked = 'Sup3r-secret-value!';
  const s = await run([...base, '--client-secret-env', leaked]);
  assert.equal(s.code, 2);
  assert.ok(!(s.stdout + s.stderr).includes(leaked), 'a secret passed by mistake must not be echoed');
});

test('check: usage errors exit 2', async () => {
  assert.equal((await run(['check', '--fhir', 'http://x'])).code, 2);
  assert.equal((await run(['check', '--fhir', 'http://x', '--client-id', 'c', '--key', '/nope.pem'])).code, 2);
  assert.equal((await run(['check', '--unknown-flag'])).code, 2);
});

test('check: works end to end, --report is paste-safe', async () => {
  const key = await makeKey();
  const mock = await startMock({ clients: [{ clientId: CLIENT_ID, jwksFile: key.jwksPath }] });
  try {
    const base = [
      'check',
      '--fhir',
      mock.fhirBase,
      '--client-id',
      CLIENT_ID,
      '--key',
      key.pemPath,
      '--kid',
      key.kid,
      '--jwks-url',
      mock.jwksUrlFor(CLIENT_ID),
    ];
    const ok = await run(base);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /login works/);
    const rep = await run([...base, '--report']);
    assert.match(rep.stdout, /## smart-doctor report/);
    assert.ok(!rep.stdout.includes(CLIENT_ID), 'client id should be redacted in --report by default');
    const json = JSON.parse((await run([...base, '--json'])).stdout);
    assert.equal(json.verdict, 'ok');
    const bad = await run([...base.slice(0, -2), '--jwks-url', mock.jwksUrlFor(CLIENT_ID), '--kid', 'wrong']);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /Most likely causes/);
  } finally {
    await mock.close();
  }
});

test('inspect: flags a bad aud from an app log', async () => {
  const key = await makeKey();
  const k = await loadKey({ keyPath: key.pemPath, kid: key.kid });
  const tokenUrl = 'https://ehr.example.org/oauth2/token';
  const { jwt } = await buildAssertion({ clientId: 'c', tokenUrl: tokenUrl + '/', keyObject: k.keyObject, alg: k.alg, kid: k.kid });
  const r = await run(['inspect', '--token-url', tokenUrl, '-'], jwt);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /trailing slash/);
  assert.ok(!r.stdout.includes(jwt.split('.')[2]), 'signature must not be printed');
});

test('explain: text from args', async () => {
  const r = await run(['explain', '{"error":"invalid_client","error_description":"Invalid audience"}']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /aud does not exactly match/);
});

test('keygen writes a private PEM and a public JWKS', async () => {
  const dir = await tmp();
  const r = await run(['keygen', '--alg', 'RS384', '--kid', 'mykey', '--out', dir]);
  assert.equal(r.code, 0);
  assert.ok(existsSync(path.join(dir, 'private-key.pem')));
  assert.ok(existsSync(path.join(dir, 'jwks.json')));
});
