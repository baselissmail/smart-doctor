#!/usr/bin/env node
// A guided tour: break the login in a dozen realistic ways against the local
// mock EHR and show what smart-doctor concludes each time. No network access,
// no real credentials, no patient data.
//
//   npm run demo            # summary table
//   npm run demo -- --full  # full report for every scenario

import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { exportJWK } from 'jose';
import { generateKeys } from '../src/keys.js';
import { startMock } from '../src/mock/server.js';
import { runCheck } from '../src/doctor.js';
import { renderHuman, confidenceLabel } from '../src/report.js';

const full = process.argv.includes('--full');
const CLIENT = 'demo-client';
const root = await mkdtemp(path.join(tmpdir(), 'smart-doctor-demo-'));
let n = 0;
const key = async (alg = 'ES384', kid = 'k1') => generateKeys({ alg, kid, outDir: path.join(root, String(n++)) });

const scenarios = [
  { name: 'Everything correct', run: {} },
  { name: 'aud has a trailing slash', check: (m) => ({ aud: m.tokenUrl + '/' }) },
  { name: 'aud is the FHIR base URL', check: (m) => ({ aud: m.fhirBase }) },
  { name: 'kid not published in JWKS', check: () => ({ kid: 'typo-kid' }) },
  { name: 'Signing with a different key', setup: async () => ({ jwksFile: (await key('ES384', 'k1')).jwksPath }) },
  {
    name: 'JWKS leaks the private key',
    setup: async (k) => {
      const d = await exportJWK(createPrivateKey(await readFile(k.pemPath, 'utf8')));
      const f = path.join(root, `leak-${n++}.json`);
      await writeFile(f, JSON.stringify({ keys: [{ ...d, kid: 'k1', alg: 'ES384' }] }));
      return { jwksFile: f };
    },
  },
  { name: 'Server clock 10 min ahead', modes: ['clock-skew'] },
  { name: 'Server only accepts RS384', modes: ['rs384-only'] },
  { name: 'Server wants a client secret', modes: ['secret-only'] },
  { name: 'Client disabled by admin', client: { enabled: false } },
  { name: 'Scope not allowed', check: () => ({ scope: 'system/Patient.write' }) },
  { name: 'v2 scopes on a v1-only server', modes: ['v1-scopes-only'], check: () => ({ scope: 'system/Patient.rs' }) },
  { name: 'Key rotated, server cached old', stale: true, modes: ['stale-jwks'] },
  { name: 'Wrong client_id (Epic profile)', check: () => ({ clientId: 'prod-client-id', vendor: 'epic' }) },
  { name: 'Rate limited', modes: ['rate-limit'] },
];

const rows = [];
for (const s of scenarios) {
  let k = await key();
  let jwksFile = k.jwksPath;
  if (s.setup) ({ jwksFile } = await s.setup(k));
  let rotateTo;
  if (s.stale) {
    const fresh = await key('ES384', 'k2');
    jwksFile = path.join(root, `rot-${n++}.json`);
    await writeFile(jwksFile, await readFile(k.jwksPath, 'utf8'));
    rotateTo = fresh;
  }
  const mock = await startMock({ clients: [{ clientId: CLIENT, jwksFile, ...(s.client || {}) }], modes: s.modes || [] });
  if (rotateTo) {
    await writeFile(jwksFile, await readFile(rotateTo.jwksPath, 'utf8'));
    k = rotateTo;
  }
  const result = await runCheck({
    fhirBase: mock.fhirBase,
    clientId: CLIENT,
    keyPath: k.pemPath,
    kid: k.kid,
    jwksUrl: mock.jwksUrlFor(CLIENT),
    timeoutMs: 5000,
    ...(s.check ? s.check(mock) : {}),
  });
  await mock.close();
  const top = result.diagnosis.causes[0];
  rows.push([s.name, result.diagnosis.verdict, top ? `${top.title} (${confidenceLabel(top.confidence)})` : '—']);
  if (full) {
    console.log(`\n${'='.repeat(80)}\nSCENARIO: ${s.name}\n${'='.repeat(80)}`);
    console.log(renderHuman(result, { color: process.stdout.isTTY }));
  }
}

const w = [Math.max(...rows.map((r) => r[0].length)), 7];
console.log(`\n${'Scenario'.padEnd(w[0])}  ${'Verdict'.padEnd(w[1])}  Top diagnosis`);
console.log(`${'-'.repeat(w[0])}  ${'-'.repeat(w[1])}  ${'-'.repeat(40)}`);
for (const [a, b, c] of rows) console.log(`${a.padEnd(w[0])}  ${b.padEnd(w[1])}  ${c}`);
console.log(`\nAll scenarios ran against a local mock EHR. Run with --full to see each full report.`);

// ---------------------------------------------------------------- client secrets & user sign-in
const { runLaunch } = await import('../src/launch.js');
const { fakeBrowser, pastePrompter } = await import('../src/adapters/scripted-browser.js');
const rows2 = [];
const REDIRECT = 'https://app.example-company.com/smart/callback';
const launchScenarios = [
  { name: 'Secret: correct', secret: true, opts: { secret: 'right' } },
  { name: 'Secret: wrong value', secret: true, opts: { secret: 'wrong' } },
  { name: 'Secret: trailing newline', secret: true, opts: { secret: 'right\n' } },
  { name: 'Sign-in: loopback redirect', redirect: 'http://127.0.0.1:{port}/callback' },
  { name: 'Sign-in: company redirect (paste)' },
  {
    name: 'Sign-in: redirect not registered',
    redirect: 'http://localhost:{port}/callback',
    registered: ['http://127.0.0.1:{port}/callback'],
  },
  { name: 'Sign-in: user denies', browser: { decision: 'deny' } },
  { name: 'Sign-in: pasted an old attempt', paste: (u) => u.replace(/state=[^&]+/, 'state=old') },
  { name: 'Sign-in: code already used', burn: true },
  { name: 'Sign-in: no patient context', modes: ['no-patient-context'] },
];
for (const s of launchScenarios) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const redirect = (s.redirect || REDIRECT).replace('{port}', port);
  const registered = (s.registered || [redirect]).map((r) => r.replace('{port}', port));
  let result;
  if (s.secret) {
    const mock = await startMock({ clients: [{ clientId: 'svc', secret: 'right' }] });
    result = await runCheck({
      fhirBase: mock.fhirBase,
      clientId: 'svc',
      auth: 'client_secret_basic',
      scope: 'system/Patient.rs',
      ...s.opts,
    });
    await mock.close();
  } else {
    const mock = await startMock({
      clients: [{ clientId: 'app', public: true, redirectUris: registered }],
      modes: s.modes || [],
      verboseErrors: true,
    });
    const browser = fakeBrowser({ redirectUri: redirect, ...(s.browser || {}) });
    const prompter = s.burn
      ? {
          async ask() {
            const url = await browser.landed;
            const code = new URL(url).searchParams.get('code');
            await fetch(mock.tokenUrl, {
              method: 'POST',
              body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                client_id: 'app',
                redirect_uri: redirect,
                code_verifier: 'x',
              }),
            });
            return url;
          },
        }
      : pastePrompter(browser, s.paste);
    result = await runLaunch(
      { fhirBase: mock.fhirBase, clientId: 'app', redirectUri: redirect, waitMs: 1500, timeoutMs: 5000 },
      { browser, prompter },
    );
    await mock.close();
  }
  const top = result.diagnosis.causes[0];
  rows2.push([s.name, result.diagnosis.verdict, top ? `${top.title} (${confidenceLabel(top.confidence)})` : '—']);
  if (full) {
    console.log(`\n${'='.repeat(80)}\nSCENARIO: ${s.name}\n${'='.repeat(80)}`);
    console.log(renderHuman(result, { color: process.stdout.isTTY }));
  }
}
const w2 = [Math.max(...rows2.map((r) => r[0].length)), 7];
console.log(`\n${'Client secrets and user sign-in'.padEnd(w2[0])}  ${'Verdict'.padEnd(w2[1])}  Top diagnosis`);
console.log(`${'-'.repeat(w2[0])}  ${'-'.repeat(w2[1])}  ${'-'.repeat(40)}`);
for (const [a, b, c] of rows2) console.log(`${a.padEnd(w2[0])}  ${b.padEnd(w2[1])}  ${c}`);
