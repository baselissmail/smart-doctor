// Guards for the knowledge files (causes, error wording, vendor quirks) so contributions
// can't silently break the engine. To teach smart-doctor a server message, add it to
// src/knowledge/seen.js; every entry there is checked below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAUSES, STAGES } from '../src/knowledge/causes.js';
import { TEXT_PATTERNS, ERROR_ALIASES, ERROR_CODES, normalizeError } from '../src/knowledge/errors.js';
import { SEEN } from '../src/knowledge/seen.js';
import { VENDORS, detectVendor } from '../src/vendors/index.js';
import { explainError, diagnose } from '../src/diagnose.js';

const OAUTH_ERRORS = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
];
const AUTH_METHODS = ['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'none'];
const HINT_KEYS = ['invalid_client', 'unauthorized_client', 'invalid_scope', 'any'];

test('every cause has a stage, title, why and fix', () => {
  const stages = STAGES.map((s) => s.id);
  for (const [id, c] of Object.entries(CAUSES)) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `cause id "${id}" must be snake_case`);
    assert.ok(stages.includes(c.stage), `${id}.stage "${c.stage}" must be one of ${stages.join(', ')}`);
    for (const k of ['title', 'why', 'fix']) assert.ok(typeof c[k] === 'string' && c[k].trim().length > 5, `${id}.${k} is missing`);
  }
});

test('every cause id used by the engine exists in the catalogue', async () => {
  const src = await readFile(new URL('../src/diagnose.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/\b(?:cause|add)\('([a-z_]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/:\s*'([a-z_]+)'/g)) if (CAUSES[m[1]]) used.add(m[1]);
  assert.ok(used.size > 20, 'scan found the engine’s cause ids');
  for (const id of used) assert.ok(CAUSES[id], `diagnose.js uses unknown cause "${id}"`);
});

test('every text pattern points at a real cause', () => {
  for (const p of TEXT_PATTERNS) {
    assert.ok(p.re instanceof RegExp, 'pattern needs a RegExp');
    assert.ok(CAUSES[p.cause], `pattern ${p.re} points at unknown cause "${p.cause}"`);
    if (p.confidence !== undefined) assert.ok(p.confidence > 0 && p.confidence <= 1, `${p.re}: confidence must be in (0, 1]`);
  }
});

test('error aliases map to standard OAuth error codes', () => {
  for (const [alias, code] of Object.entries(ERROR_ALIASES)) {
    assert.ok(OAUTH_ERRORS.includes(code), `${alias} → ${code} is not a standard code`);
    assert.equal(normalizeError(alias), code);
  }
});

test('the error-code guide points at real causes', () => {
  for (const [code, g] of Object.entries(ERROR_CODES)) {
    assert.ok(OAUTH_ERRORS.includes(code), `${code} is not a standard OAuth error code`);
    assert.ok(g.meaning.length > 20, `${code} needs a meaning`);
    for (const id of g.causes) assert.ok(CAUSES[id], `${code} lists unknown cause "${id}"`);
  }
});

test('vendor profiles are well-formed and every hint cites a source', () => {
  const ids = new Set();
  for (const v of VENDORS) {
    assert.ok(!ids.has(v.id), `duplicate vendor id ${v.id}`);
    ids.add(v.id);
    assert.equal(typeof v.match, 'function', `${v.id}.match must be a function`);
    for (const [key, hints] of Object.entries(v.hints)) {
      assert.ok(HINT_KEYS.includes(key), `${v.id}: unknown hint key "${key}"`);
      for (const h of hints) {
        assert.ok(h.id.startsWith(`${v.id.split('-')[0]}.`), `${h.id} should start with "${v.id.split('-')[0]}."`);
        for (const k of ['title', 'why', 'fix', 'source'])
          assert.ok(typeof h[k] === 'string' && h[k].trim().length > 5, `${h.id}.${k} is missing`);
        if (h.weight !== undefined) assert.ok(h.weight >= 0 && h.weight <= 0.3, `${h.id}: weight must be 0–0.3`);
        if (h.flow !== undefined) assert.ok(['backend', 'launch'].includes(h.flow), `${h.id}: flow must be backend or launch`);
        if (h.auth !== undefined) assert.ok(AUTH_METHODS.includes(h.auth), `${h.id}: unknown auth "${h.auth}"`);
      }
    }
  }
});

test('vendor detection picks the right profile', () => {
  assert.equal(detectVendor(['https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4']).id, 'epic');
  assert.equal(detectVendor(['https://fhir-ehr-code.cerner.com/r4/tenant']).id, 'oracle-health');
  assert.equal(detectVendor(['https://ehr.example.org/apis/default/fhir']).id, 'openemr');
  assert.equal(detectVendor(['https://api.preview.platform.athenahealth.com/fhir/r4']).id, 'athena');
  assert.equal(detectVendor(['https://fhir.example.org/r4']).id, 'generic');
});

for (const s of SEEN) {
  test(`seen on ${s.where}: ${JSON.stringify(s.body)} → ${s.expect}`, () => {
    assert.ok(CAUSES[s.expect], `unknown cause ${s.expect}`);
    const facts = { flow: s.expect.startsWith('code_') ? 'launch' : undefined };
    const top = facts.flow ? diagnoseLaunch(s.body) : explainError(JSON.stringify(s.body)).causes[0]?.id;
    assert.equal(top, s.expect);
  });
}

/** Code-exchange errors only make sense in the sign-in flow. */
function diagnoseLaunch(body) {
  return diagnose({
    flow: 'launch',
    auth: 'client_secret_post',
    redirectMode: 'paste',
    checks: [],
    launch: {},
    token: { status: 400, error: body.error, errorDescription: body.error_description },
  }).causes[0]?.id;
}
