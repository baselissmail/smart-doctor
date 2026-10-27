import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { saveProfile, loadProfiles, findConfig, profileToOptions, validateProfile, ProfileError, suggestName } from '../src/profiles.js';
import { runWizard } from '../src/wizard.js';
import { scriptedPrompter } from '../src/adapters/prompt.js';
import { main, startDemoMock, DEMO } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { startMock } from '../src/mock/server.js';
import { tmp, makeKey } from './helpers.js';

async function run(args, env = {}) {
  let stdout = '';
  let stderr = '';
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const stdin = Readable.from([]);
    stdin.isTTY = true;
    const code = await main(args, {
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s), isTTY: false },
      stdin,
    });
    return { code, stdout, stderr };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('VERSION matches package.json and the Claude Code plugin manifest', async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(f, import.meta.url), 'utf8'));
  const pkg = await read('../package.json');
  assert.equal(VERSION, pkg.version);
  assert.equal((await read('../.claude-plugin/plugin.json')).version, pkg.version);
});

test('save/load round-trip keeps comments and other profiles', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  await saveProfile(file, 'one', { flow: 'backend', fhir: 'https://a.example/fhir', clientId: 'c1', key: './k.pem' });
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('profiles:', '# my team note\nprofiles:'));
  await saveProfile(file, 'two', {
    flow: 'launch',
    fhir: 'https://b.example/fhir',
    clientId: 'c2',
    redirectUri: 'http://localhost:9876/callback',
  });
  const after = await readFile(file, 'utf8');
  assert.match(after, /my team note/);
  assert.match(after, /no secrets live here/);
  const { profiles } = await loadProfiles(file);
  assert.deepEqual(Object.keys(profiles), ['one', 'two']);
  assert.equal(profiles.two.redirectUri, 'http://localhost:9876/callback');
});

test('profiles refuse secrets', () => {
  assert.throws(() => validateProfile('x', { clientSecret: 'abc' }), ProfileError);
  assert.throws(() => validateProfile('x', { privateKey: '-----BEGIN' }), ProfileError);
  assert.throws(() => validateProfile('x', { accessToken: 'abc' }), ProfileError);
  assert.throws(() => validateProfile('x', { secretEnv: 'sup3r-s3cret-value!' }), /variable NAME/);
  assert.throws(() => validateProfile('x', { colour: 'blue' }), /unknown setting/);
  assert.doesNotThrow(() => validateProfile('x', { secretEnv: 'MY_APP_SECRET', tokenUrl: 'https://a/t' }));
});

test('findConfig walks up from the current folder', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'smart-doctor.yaml'), 'profiles: {}\n');
  const deep = path.join(dir, 'a', 'b');
  await mkdir(deep, { recursive: true });
  const f = findConfig({ cwd: deep, env: {} });
  assert.equal(f.path, path.join(dir, 'smart-doctor.yaml'));
  assert.equal(f.exists, true);
});

test('relative key paths resolve against the profile file, secrets come from env', () => {
  const o = profileToOptions(
    { fhir: 'https://a/fhir', key: 'keys/k.pem', secretEnv: 'X_SECRET' },
    { configPath: '/team/repo/smart-doctor.yaml', env: { X_SECRET: 'v' } },
  );
  assert.equal(o.keyPath, '/team/repo/keys/k.pem');
  assert.equal(o.secret, 'v');
  assert.equal(o.flow, 'backend');
  assert.equal(profileToOptions({ redirectUri: 'http://localhost:1/cb' }).flow, 'launch');
});

test('suggestName', () => {
  assert.equal(suggestName('https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4', 'backend'), 'fhir-epic-com-backend');
});

test('wizard: backend with a newly generated key, then the saved profile runs green', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  const mock = await startMock({ clients: [] });
  const lines = [];
  try {
    const prompter = scriptedPrompter([
      '1', // backend
      mock.fhirBase,
      'wiz-client',
      '', // default auth (private_key_jwt)
      'new',
      'wiz-key-1',
      '', // no JWKS URL
      '', // default scope
      'wiz', // profile name
      'n', // don't run now
    ]);
    const r = await runWizard({ prompter, out: (s) => lines.push(s), configPath: file, cwd: dir });
    assert.equal(r.name, 'wiz');
    assert.equal(r.profile.auth, 'private_key_jwt');
    assert.equal(r.profile.kid, 'wiz-key-1');
    assert.equal(r.runNow, false);
    assert.ok(lines.some((l) => /Found a SMART server/.test(l)));
    // Register the generated key with the mock, then run the profile through the CLI
    const { profiles } = await loadProfiles(file);
    mock.setClient({ clientId: 'wiz-client', jwksFile: path.join(dir, 'keys', 'jwks.json') });
    const res = await run(['check', 'wiz', '--config', file]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /login works/);
    assert.equal(profiles.wiz.key, path.join('keys', 'private-key.pem'));
  } finally {
    await mock.close();
  }
});

test('wizard: launch with a public client and a company redirect URI', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  const mock = await startMock({ clients: [] });
  try {
    const prompter = scriptedPrompter(['2', mock.fhirBase, 'my-app', '1', '', 'https://app.example-company.com/cb', '', 'n']);
    const r = await runWizard({ prompter, out: () => {}, configPath: file, cwd: dir });
    assert.equal(r.profile.flow, 'launch');
    assert.equal(r.profile.auth, 'none');
    assert.equal(r.profile.redirectUri, 'https://app.example-company.com/cb');
    assert.match(r.profile.scope, /launch\/patient/);
    assert.match(r.name, /-launch$/);
  } finally {
    await mock.close();
  }
});

test('wizard: secret auth stores the env var NAME only and re-asks bad URLs', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  const mock = await startMock({ clients: [] });
  try {
    const prompter = scriptedPrompter(['1', 'http://127.0.0.1:9/nothing', '1', mock.fhirBase, 'svc', '2', 'SVC_SECRET', '', 'svc', 'n']);
    const r = await runWizard({ prompter, out: () => {}, configPath: file, cwd: dir });
    assert.equal(r.profile.auth, 'client_secret_basic');
    assert.equal(r.profile.secretEnv, 'SVC_SECRET');
    const text = await readFile(file, 'utf8');
    assert.ok(!/secret:/i.test(text.replace(/secretEnv/g, '')));
  } finally {
    await mock.close();
  }
});

test('CLI: demo profiles run by name (private key and client secret)', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  const { mock, profiles } = await startDemoMock({ port: 0, keyDir: path.join(dir, 'demo') });
  try {
    for (const [n, p] of Object.entries(profiles)) await saveProfile(file, n, p);
    const a = await run(['check', 'demo-backend', '--config', file]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const b = await run(['check', 'demo-secret', '--config', file], { SMART_DOCTOR_DEMO_SECRET: DEMO.secret });
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const c = await run(['check', 'demo-secret', '--config', file], { SMART_DOCTOR_DEMO_SECRET: 'wrong' });
    assert.equal(c.code, 1);
    assert.match(c.stdout, /Client secret rejected/);
    const list = await run(['profiles', '--config', file]);
    assert.match(list.stdout, /demo-launch-paste/);
  } finally {
    await mock.close();
  }
});

test('CLI: flags override the profile, --save writes a profile without secrets', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'smart-doctor.yaml');
  const key = await makeKey({ kid: 'k1' });
  const { mock } = await startDemoMock({ port: 0, keyDir: path.join(dir, 'demo') });
  try {
    mock.setClient({ clientId: 'saved-app', jwksFile: key.jwksPath });
    const r = await run([
      'check',
      '--fhir',
      mock.fhirBase,
      '--client-id',
      'saved-app',
      '--key',
      key.pemPath,
      '--kid',
      'k1',
      '--save',
      'saved',
      '--config',
      file,
    ]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /Saved profile "saved"/);
    const { profiles } = await loadProfiles(file);
    assert.equal(profiles.saved.kid, 'k1');
    const override = await run(['check', 'saved', '--config', file, '--kid', 'nope']);
    assert.equal(override.code, 1);
    const missing = await run(['check', 'ghost', '--config', file]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No profile "ghost"/);
  } finally {
    await mock.close();
  }
});
