import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { loadKey, parseKeyMaterial, inferAlg, KeyError } from '../src/keys.js';
import { lintAssertion, buildAssertion, explainAudMismatch } from '../src/assertion.js';
import { checkClock, serverDateFrom } from '../src/clock.js';
import { explainError, scopeSyntax, diagnose, normalizeError } from '../src/diagnose.js';
import { detectVendor } from '../src/vendors/index.js';
import { tokenUrlFromCapabilityStatement } from '../src/discovery.js';
import { mask, redactId } from '../src/util.js';
import { scopeAllowed } from '../src/mock/server.js';
import { makeKey } from './helpers.js';

const TOKEN_URL = 'https://ehr.example.org/oauth2/token';

// ---------- keys ----------
test('loads PKCS#1 RSA PEM and infers RS384', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const k = await loadKey({ keyText: pem, kid: 'x' });
  assert.equal(k.ok, true);
  assert.equal(k.alg, 'RS384');
});

test('loads SEC1 EC P-384 PEM and infers ES384', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const k = await loadKey({ keyText: privateKey.export({ type: 'sec1', format: 'pem' }), kid: 'x' });
  assert.equal(k.alg, 'ES384');
});

test('P-256 key warns (not one of RS384/ES384)', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const k = await loadKey({ keyText: privateKey.export({ type: 'pkcs8', format: 'pem' }), kid: 'x' });
  assert.equal(k.alg, 'ES256');
  assert.equal(k.checks.find((c) => c.id === 'key.alg').status, 'warn');
});

test('rejects public keys, encrypted keys, and public-only JWKS with clear messages', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => parseKeyMaterial(publicKey.export({ type: 'spki', format: 'pem' })), KeyError);
  assert.throws(
    () => parseKeyMaterial('-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----'),
    /password-protected/,
  );
  assert.throws(() => parseKeyMaterial(JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }] })), /only PUBLIC/);
});

test('alg that does not match the key fails', async () => {
  const key = await makeKey({ alg: 'ES384' });
  const k = await loadKey({ keyPath: key.pemPath, alg: 'RS384', kid: 'k1' });
  assert.equal(k.ok, false);
});

test('small RSA key fails strength check', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const k = await loadKey({ keyText: privateKey.export({ type: 'pkcs8', format: 'pem' }), kid: 'x' });
  assert.equal(k.checks.find((c) => c.id === 'key.strength').status, 'fail');
});

test('missing kid warns', async () => {
  const key = await makeKey();
  const k = await loadKey({ keyPath: key.pemPath });
  assert.equal(k.checks.find((c) => c.id === 'key.kid').status, 'warn');
});

test('inferAlg for unsupported curves returns undefined', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.equal(inferAlg(privateKey), undefined);
});

// ---------- assertion lint ----------
async function signed(claims, header = {}, key) {
  key = key || generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES384', typ: 'JWT', kid: 'k1', ...header }).sign(key);
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: 'c', sub: 'c', aud: TOKEN_URL, exp: now + 240, iat: now, jti: 'j' };
const status = (r, id) => r.checks.find((c) => c.id === id)?.status;

test('lint: a correct assertion passes everything', async () => {
  const r = lintAssertion(await signed(good), { tokenUrl: TOKEN_URL, clientId: 'c' });
  assert.ok(
    r.checks.every((c) => c.status === 'pass'),
    JSON.stringify(r.checks),
  );
});

test('lint: exp > 5 minutes fails', async () => {
  const r = lintAssertion(await signed({ ...good, exp: now + 3600 }), { tokenUrl: TOKEN_URL });
  assert.equal(status(r, 'assertion.exp'), 'fail');
});

test('lint: expired fails', async () => {
  const r = lintAssertion(await signed({ ...good, exp: now - 10 }), { tokenUrl: TOKEN_URL });
  assert.equal(status(r, 'assertion.exp'), 'fail');
});

test('lint: missing jti, missing kid, iss≠sub, wrong client fail', async () => {
  const { jti, ...noJti } = good;
  assert.equal(status(lintAssertion(await signed(noJti)), 'assertion.jti'), 'fail');
  assert.equal(status(lintAssertion(await signed(good, { kid: undefined })), 'assertion.kid'), 'fail');
  assert.equal(status(lintAssertion(await signed({ ...good, sub: 'other' })), 'assertion.iss_sub'), 'fail');
  assert.equal(status(lintAssertion(await signed(good), { clientId: 'prod-id' }), 'assertion.iss_sub'), 'fail');
});

test('lint: kid not in provided JWKS kids', async () => {
  const r = lintAssertion(await signed(good), { jwksKids: ['other'] });
  assert.equal(status(r, 'assertion.kid_jwks'), 'fail');
});

test('lint: truncated / non-JWT input', () => {
  assert.equal(status(lintAssertion('abc.def'), 'assertion.format'), 'fail');
  assert.equal(status(lintAssertion('not a jwt'), 'assertion.format'), 'fail');
});

test('aud mismatch explanations', () => {
  assert.equal(explainAudMismatch(TOKEN_URL + '/', TOKEN_URL), 'trailing slash differs');
  assert.equal(explainAudMismatch(TOKEN_URL.replace('https', 'http'), TOKEN_URL), 'http vs https');
  assert.equal(explainAudMismatch(TOKEN_URL.toUpperCase(), TOKEN_URL), 'letter case differs');
  assert.match(explainAudMismatch('https://other.example.org/oauth2/token', TOKEN_URL), /different host/);
  assert.match(explainAudMismatch('https://ehr.example.org/api/FHIR/R4', TOKEN_URL), /FHIR base/);
});

test('buildAssertion produces a lint-clean assertion', async () => {
  const key = await makeKey();
  const k = await loadKey({ keyPath: key.pemPath, kid: key.kid });
  const { jwt } = await buildAssertion({ clientId: 'c', tokenUrl: TOKEN_URL, keyObject: k.keyObject, alg: k.alg, kid: k.kid });
  const r = lintAssertion(jwt, { tokenUrl: TOKEN_URL, clientId: 'c' });
  assert.ok(r.checks.every((c) => c.status === 'pass'));
});

// ---------- clock ----------
test('clock skew thresholds', () => {
  const at = (s) => checkClock({ date: new Date(Date.now() + s * 1000).toUTCString(), receivedAt: Date.now() }).check.status;
  assert.equal(at(0), 'pass');
  assert.equal(at(60), 'warn');
  assert.equal(at(-400), 'fail');
  assert.equal(checkClock(undefined).check.status, 'skip');
});

test('clock: a cached Date header is not the server time', () => {
  const fiveMinAgo = new Date(Date.now() - 307 * 1000).toUTCString();
  // A CDN hit that reports its Age: corrected, so no skew.
  assert.equal(checkClock(serverDateFrom({ date: fiveMinAgo, age: '307', 'x-cache': 'Hit from cloudfront' })).check.status, 'pass');
  // An origin cache hit without Age: skipped instead of a false clock-skew failure.
  const cached = serverDateFrom({ date: fiveMinAgo, 'x-cache-status': 'HIT', 'x-cache': 'Miss from cloudfront' });
  assert.equal(cached.cached, true);
  assert.equal(checkClock(cached).check.status, 'skip');
  // No cache headers: still a real skew.
  assert.equal(checkClock(serverDateFrom({ date: fiveMinAgo })).check.status, 'fail');
  assert.equal(serverDateFrom({}), undefined);
});

// ---------- wording seen on real servers (public sandboxes) ----------
const launchDiag = (facts) =>
  diagnose({ flow: 'launch', auth: 'client_secret_post', redirectMode: 'paste', checks: [], launch: {}, ...facts });
const topId = (d) => d.causes[0]?.id;
const idsOf = (d) => d.causes.map((c) => c.id);

test('real servers: non-standard error codes are normalised', () => {
  assert.equal(normalizeError('Invalid Grant'), 'invalid_grant');
  assert.equal(normalizeError('invalid-client'), 'invalid_client');
  assert.equal(normalizeError('invalid_code'), 'invalid_grant');
  // A bad code reported as "Invalid Grant" or "invalid_code" is still a code problem, not a blank result.
  assert.equal(topId(launchDiag({ token: { status: 400, error: 'Invalid Grant' } })), 'code_consumed');
  assert.equal(topId(launchDiag({ token: { status: 400, error: 'invalid_code' } })), 'code_consumed');
});

test('real servers: invalid_request about the code is a code problem, not the auth method', () => {
  const advertised = {
    id: 'discovery.auth_method',
    title: 'client_secret_post supported',
    status: 'warn',
    detail: 'Server advertises only: client_secret_basic, private_key_jwt',
  };
  const d = launchDiag({
    checks: [advertised],
    token: { status: 400, error: 'invalid_request', errorDescription: 'Authorization code in the request is not valid' },
  });
  assert.ok(['code_consumed', 'code_expired'].includes(topId(d)), topId(d));
  assert.ok(d.causes.find((c) => c.id === 'auth_method').confidence < 0.5);
});

test('real servers: the server naming the auth method beats "secret rejected"', () => {
  const d = launchDiag({
    auth: 'client_secret_post',
    token: { status: 401, error: 'invalid_request', errorDescription: 'Basic authentication is required for confidential clients' },
  });
  assert.equal(topId(d), 'secret_method_required');
  assert.ok(!idsOf(d).includes('secret_invalid'));
});

test('real servers: "none of the keys in the JWKS have kid/alg" means the JWKS was read', () => {
  const kid = explainError(
    '{"error":"invalid_client","error_description":"None of the keys found in the JWKS have kid equal to sandbox-typo"}',
  );
  assert.equal(topId(kid), 'kid_unknown');
  assert.ok(!idsOf(kid).includes('jwks_fetch'));
  const alg = explainError('{"error":"invalid_client","error_description":"None of the keys found in the JWKS have alg equal to RS384"}');
  assert.equal(topId(alg), 'jwks_no_alg');
  assert.ok(!idsOf(alg).includes('jwks_fetch'));
  // A real fetch failure still maps to jwks_fetch.
  assert.equal(topId(explainError('{"error":"invalid_client","error_description":"Unable to fetch JWKS from jwks_uri"}')), 'jwks_fetch');
});

test('real servers: invalid client_id wording → client_unknown', () => {
  assert.equal(
    topId(explainError(`{"error":"invalid_client","error_description":"Invalid 'client_id' (as sub claim of the assertion JWT)"}`)),
    'client_unknown',
  );
});

test('real servers: authorize errors use the description', () => {
  const ae = (error, description) => topId(launchDiag({ launch: { authorizeError: { error, description } } }));
  assert.equal(ae('invalid_client', 'Invalid client_id "app-typo". Expected "app".'), 'client_unknown');
  assert.equal(ae('invalid_request', 'Invalid redirect_uri parameter'), 'authorize_redirect');
  assert.equal(ae('invalid_request', 'Invalid aud parameter'), 'authorize_aud');
  assert.equal(ae('invalid_request', 'Invalid launch type'), 'authorize_request');
  assert.ok(!/invalid_request usually/.test(launchDiag({ launch: { authorizeError: { error: 'invalid_client' } } }).causes[0].why));
});

test('an unknown error never ends with no causes', () => {
  const d = launchDiag({ token: { status: 400, error: 'weird_vendor_error', errorDescription: 'Something odd' } });
  assert.equal(topId(d), 'unrecognised_error');
  assert.match(d.causes[0].evidence, /weird_vendor_error/);
});

test('refresh token issued but rejected → refresh_rejected; nothing pasted → never came back', () => {
  assert.equal(
    topId(
      launchDiag({
        token: { status: 200, token: {} },
        launch: { refreshError: { status: 403, error: 'invalid_grant', description: 'Expired refresh token' } },
      }),
    ),
    'refresh_rejected',
  );
  assert.deepEqual(idsOf(launchDiag({ launch: { noPaste: true } })).slice(0, 2), ['redirect_not_registered', 'signin_not_completed']);
});

test('vendor hints are limited to the flow and auth method they apply to', () => {
  const epic = detectVendor(['https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4']);
  const launchIds = idsOf(launchDiag({ vendor: epic, token: { status: 400, error: 'invalid_client' } }));
  assert.ok(launchIds.includes('epic.redirect_token'));
  assert.ok(!launchIds.includes('epic.key_propagation'), 'no JWKS hint for a client-secret app');
  const backendIds = idsOf(
    diagnose({ auth: 'private_key_jwt', vendor: epic, checks: [], token: { status: 400, error: 'invalid_client' } }),
  );
  assert.ok(backendIds.includes('epic.key_propagation'));
  assert.ok(!backendIds.includes('epic.redirect_token'));
});

// ---------- explain ----------
test('explain: bare invalid_client lists server-side causes', () => {
  const ids = explainError('{"error":"invalid_client"}').causes.map((c) => c.id);
  assert.ok(ids.includes('server_side_registration'));
});

test('explain: descriptive errors map to specific causes', () => {
  const top = (t) => explainError(t).causes[0]?.id;
  assert.equal(top('{"error":"invalid_client","error_description":"Invalid audience"}'), 'aud_mismatch');
  assert.equal(top('{"error":"invalid_client","error_description":"JWT expired"}'), 'assertion_time');
  assert.equal(top('{"error":"invalid_client","error_description":"jti already used"}'), 'jti_reuse');
  assert.equal(top('{"error":"invalid_scope"}'), 'scope');
  assert.equal(top('{"error":"unsupported_grant_type"}'), 'grant_type');
  assert.equal(top('HTTP 429 Too Many Requests'), 'rate_limited');
});

test('explain: OpenEMR wording + vendor hint', () => {
  const v = detectVendor(['https://emr.example.org/apis/default/fhir']);
  const ids = explainError('{"error":"invalid_client","error_description":"Client authentication failed"}', { vendor: v }).causes.map(
    (c) => c.id,
  );
  assert.ok(ids.includes('openemr.client_disabled'));
});

// ---------- vendors ----------
test('vendor detection', () => {
  assert.equal(detectVendor(['https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4']).id, 'epic');
  assert.equal(detectVendor(['https://fhir-ehr-code.cerner.com/r4/abc']).id, 'oracle-health');
  assert.equal(detectVendor(['https://emr.example.org/apis/default/fhir']).id, 'openemr');
  assert.equal(detectVendor(['https://api.preview.platform.athenahealth.com/fhir/r4']).id, 'athena');
  assert.equal(detectVendor(['https://hapi.example.org/fhir']).id, 'generic');
  assert.equal(detectVendor(['https://hapi.example.org/fhir'], 'epic').id, 'epic');
});

// ---------- misc ----------
test('scope syntax detection', () => {
  assert.deepEqual(scopeSyntax('system/Patient.read'), { usesV1: true, usesV2: false });
  assert.deepEqual(scopeSyntax('system/Patient.rs system/Observation.cruds'), { usesV1: false, usesV2: true });
  assert.deepEqual(scopeSyntax('system/*.*'), { usesV1: true, usesV2: false });
});

test('mock scope matching with wildcards', () => {
  assert.ok(scopeAllowed('system/Patient.rs', ['system/*.rs']));
  assert.ok(!scopeAllowed('system/Patient.write', ['system/*.read', 'system/*.rs']));
});

test('CapabilityStatement oauth-uris parsing', () => {
  const cs = {
    rest: [
      {
        security: {
          extension: [
            {
              url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
              extension: [{ url: 'token', valueUri: TOKEN_URL }],
            },
          ],
        },
      },
    ],
  };
  assert.equal(tokenUrlFromCapabilityStatement(cs), TOKEN_URL);
  assert.equal(tokenUrlFromCapabilityStatement({}), undefined);
});

test('masking', () => {
  assert.equal(mask('short'), '[masked]');
  assert.match(mask('abcdefghijklmnop'), /^abcdefgh…\[masked 16 chars\]$/);
  assert.equal(redactId('my-client-id-123'), 'my-***123');
});
