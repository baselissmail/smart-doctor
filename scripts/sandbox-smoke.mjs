#!/usr/bin/env node
// Real-server check: run smart-doctor against the public SMART launcher
// (launch.smarthealthit.org, synthetic data) with deliberate breakages and
// compare the top diagnosis with what it should be. Needs internet; not part
// of `npm test`. Fresh throwaway keys are generated for every run.
//
//   node scripts/sandbox-smoke.mjs          → table; exit 1 if any diagnosis differs
//   node scripts/sandbox-smoke.mjs --full   → also print every report
//
// The launcher skips login and consent when a practitioner and patient are set,
// so the sign-in flow runs end to end without a browser.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeys } from '../src/keys.js';
import { runCheck } from '../src/doctor.js';
import { runLaunch } from '../src/launch.js';
import { fakeBrowser } from '../src/adapters/scripted-browser.js';
import { renderHuman } from '../src/report.js';

const LAUNCHER = process.env.SMART_LAUNCHER_URL || 'https://launch.smarthealthit.org';
const full = process.argv.includes('--full');
const root = await mkdtemp(path.join(tmpdir(), 'sd-sandbox-'));
const es = await generateKeys({ alg: 'ES384', kid: 'sandbox-1', outDir: path.join(root, 'es') });
const rs = await generateKeys({ alg: 'RS384', kid: 'sandbox-1', outDir: path.join(root, 'rs') });
const jwks = await readFile(es.jwksPath, 'utf8');

/** FHIR base for a simulated server (smart-launcher-v2 codec: src/isomorphic/codec.ts). */
function simulated(p) {
  const launchTypes = ['provider-ehr', 'patient-portal', 'provider-standalone', 'patient-standalone', 'backend-service'];
  const clientTypes = ['public', 'confidential-symmetric', 'confidential-asymmetric', 'backend-service'];
  const pkce = ['none', 'auto', 'always'];
  const backend = p.launch_type === 'backend-service';
  const arr = [
    launchTypes.indexOf(p.launch_type),
    backend ? '' : 'ae8a896e-bbd9-4e1a-a732-1568df9d7527', // synthetic patient
    backend ? '' : 'ch-demo-practitioner', // synthetic practitioner
    backend ? '' : 'AUTO',
    backend ? 0 : 1, // skip_login
    backend ? 0 : 1, // skip_auth
    0,
    '',
    p.redirect_uris || '',
    p.client_id || '',
    p.client_secret || '',
    p.auth_error || '',
    '',
    p.jwks || '',
    clientTypes.indexOf(p.client_type || 'public'),
    pkce.indexOf('auto'),
    '',
  ];
  return `${LAUNCHER}/v/r4/sim/${Buffer.from(JSON.stringify(arr)).toString('base64url')}/fhir`;
}

const REDIRECT = 'https://app.example.com/callback';
const SECRET = 'sandbox-secret-1';
const launch = { launch_type: 'provider-standalone' };
const confidential = { ...launch, client_type: 'confidential-symmetric', client_secret: SECRET };
const asymmetric = { ...launch, client_type: 'confidential-asymmetric', jwks };
const backend = { launch_type: 'backend-service', client_type: 'backend-service', client_id: 'sd-backend', jwks };

/** @type {[name: string, server: Record<string, any>, options: Record<string, any>, expected: string][]} */
const scenarios = [
  // name, server, smart-doctor options, expected: 'ok' or the top cause id
  ['Sign-in: public client', launch, { auth: 'none' }, 'ok'],
  ['Sign-in: client secret (Basic)', confidential, { auth: 'client_secret_basic', secret: SECRET }, 'ok'],
  ['Sign-in: wrong client secret', confidential, { auth: 'client_secret_basic', secret: 'not-the-secret' }, 'secret_invalid'],
  ['Sign-in: secret in body, server wants Basic', confidential, { auth: 'client_secret_post', secret: SECRET }, 'secret_method_required'],
  ['Sign-in: wrong client_id', { ...launch, client_id: 'sd-registered' }, { auth: 'none', clientId: 'sd-typo' }, 'client_unknown'],
  ['Sign-in: redirect URI rejected', { ...launch, auth_error: 'auth_invalid_redirect_uri' }, { auth: 'none' }, 'authorize_redirect'],
  ['Sign-in: scope rejected', { ...launch, auth_error: 'auth_invalid_scope' }, { auth: 'none' }, 'authorize_scope'],
  ['Sign-in: refresh token expired', { ...launch, auth_error: 'token_expired_refresh_token' }, { auth: 'none' }, 'refresh_rejected'],
  ['Sign-in: private_key_jwt', asymmetric, { auth: 'private_key_jwt', keyPath: es.pemPath, kid: 'sandbox-1' }, 'ok'],
  ['Sign-in: signing with another key', asymmetric, { auth: 'private_key_jwt', keyPath: rs.pemPath, kid: 'sandbox-1' }, 'jwks_no_alg'],
  ['Backend: correct', backend, {}, 'ok'],
  ['Backend: kid not in JWKS', backend, { kid: 'sandbox-typo' }, 'kid_unknown'],
  ['Backend: aud with trailing slash', backend, { aud: (fhir) => fhir.replace(/\/fhir$/, '/auth/token/') }, 'aud_mismatch'],
  ['Backend: wrong client_id', backend, { clientId: 'sd-backend-typo' }, 'client_unknown'],
  ['Backend: scope rejected', { ...backend, auth_error: 'token_invalid_scope' }, {}, 'scope'],
  ['Backend: jti rejected', { ...backend, auth_error: 'token_invalid_jti' }, {}, 'jti_reuse'],
];

const rows = [];
let mismatches = 0;
for (const [name, server, o, expected] of scenarios) {
  const fhirBase = simulated(server);
  const opts = { fhirBase, timeoutMs: 20000, ...o, ...(typeof o.aud === 'function' ? { aud: o.aud(fhirBase) } : {}) };
  let result;
  if (server.launch_type === 'backend-service') {
    result = await runCheck({ clientId: 'sd-backend', keyPath: es.pemPath, kid: 'sandbox-1', scope: 'system/Patient.read', ...opts });
  } else {
    const browser = fakeBrowser({ redirectUri: REDIRECT, deliver: false });
    let landed = '';
    browser.landed.then((u) => (landed = u));
    const prompter = { ask: async () => (await new Promise((r) => setImmediate(r)), landed) };
    result = await runLaunch(
      {
        clientId: 'sd-app',
        redirectUri: REDIRECT,
        redirectMode: 'paste',
        scope: 'openid fhirUser offline_access launch/patient patient/*.read',
        waitMs: 30000,
        ...opts,
      },
      { browser, prompter },
    );
  }
  const { verdict, causes } = result.diagnosis;
  const got = verdict === 'ok' ? 'ok' : causes[0]?.id || verdict;
  const same = got === expected;
  if (!same) mismatches++;
  rows.push([same ? '✔' : '✖', name, expected, got]);
  if (full) console.log(`\n${'='.repeat(80)}\n${name}\n${'='.repeat(80)}\n${renderHuman(result, { color: process.stdout.isTTY })}`);
}

const w = [1, ...[1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), 8))];
console.log(`\nsmart-doctor against ${LAUNCHER} (synthetic data)\n`);
console.log(['', 'Scenario'.padEnd(w[1]), 'Expected'.padEnd(w[2]), 'Got'].join('  '));
for (const r of rows) console.log([r[0], r[1].padEnd(w[1]), r[2].padEnd(w[2]), r[3]].join('  '));
console.log(mismatches ? `\n${mismatches} diagnosis(es) differ from the expected top cause.` : '\nEvery diagnosis matched.');
process.exitCode = mismatches ? 1 : 0;
