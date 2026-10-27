// Guided setup (`smart-doctor init`). Asks only what it cannot discover,
// discovers the rest from the FHIR base URL, and saves a profile.
// Driven through the prompt adapter, so it is fully scriptable in tests.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { discover } from './discovery.js';
import { detectVendor } from './vendors/index.js';
import { loadKey, generateKeys } from './keys.js';
import { DEFAULT_SECRET_ENV } from './clientauth.js';
import { DEFAULT_LAUNCH_SCOPE } from './launch.js';
import { saveProfile, suggestName, expandHome, findConfig } from './profiles.js';

/** Ask a numbered multiple-choice question; accepts the number or the value. */
export async function choose(prompter, out, question, options, defaultIndex = 0) {
  out(`\n${question}`);
  options.forEach((o, i) => out(`  ${i + 1}) ${o.label}${o.hint ? `  — ${o.hint}` : ''}`));
  for (;;) {
    const a = (await prompter.ask('Choose', { defaultValue: String(defaultIndex + 1) })).trim();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    const byValue = options.find((o) => o.value === a);
    if (byValue) return byValue.value;
    out(`  Please enter a number from 1 to ${options.length}.`);
  }
}

/**
 * @param {{ prompter: { ask(q: string, o?: object): Promise<string> }, out: (s: string) => void, configPath?: string, cwd?: string, env?: object }} io
 * @returns {Promise<{ name: string, path: string, profile: object, runNow: boolean }>}
 */
export async function runWizard({ prompter, out, configPath, cwd = process.cwd(), env = process.env }) {
  const target = configPath || findConfig({ cwd, env }).path;
  out('smart-doctor setup — a few questions, then everything else is discovered for you.');
  out('Nothing secret is saved: keys are referenced by path, secrets by environment-variable name.');

  const flow = await choose(prompter, out, 'What do you want to test?', [
    { value: 'backend', label: 'Backend service login', hint: 'system-to-system, no user (client_credentials)' },
    { value: 'launch', label: 'User sign-in / app launch', hint: 'a person signs in at the EHR (authorization code + PKCE)' },
  ]);

  // FHIR base + discovery
  let fhir;
  let disc;
  for (;;) {
    fhir = (await prompter.ask('\nFHIR base URL (e.g. https://fhir.example.org/api/FHIR/R4)')).trim();
    if (!fhir) continue;
    out('  Looking it up…');
    disc = await discover({
      fhirBase: fhir,
      auth: 'none',
      grant: flow === 'launch' ? 'authorization_code' : 'client_credentials',
      timeoutMs: 10000,
    });
    const failed = disc.checks.find((c) => c.status === 'fail');
    if (disc.tokenUrl) {
      const v = detectVendor([fhir, disc.tokenUrl]);
      out(`  Found ${v.id === 'generic' ? 'a SMART server' : v.name}.`);
      out(`  Token endpoint: ${disc.tokenUrl}`);
      if (flow === 'launch') out(`  Sign-in endpoint: ${disc.authorizeUrl || '(not advertised)'}`);
      const methods = disc.config?.token_endpoint_auth_methods_supported;
      if (methods) out(`  Client authentication it accepts: ${methods.join(', ')}`);
      break;
    }
    out(`  Could not discover this server: ${failed?.detail || 'no token endpoint found'}`);
    const again = await choose(prompter, out, 'What now?', [
      { value: 'retry', label: 'Enter the URL again' },
      { value: 'keep', label: 'Keep it anyway (I will fix it later)' },
    ]);
    if (again === 'keep') break;
  }
  const cfg = disc?.config || {};
  const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
  const v2 = caps.includes('permission-v2') || !caps.includes('permission-v1');

  const clientId = (await prompter.ask('\nClient ID for this environment')).trim();

  // Client authentication
  const advertised = cfg.token_endpoint_auth_methods_supported || [];
  const mark = (m) => (advertised.includes(m) ? 'server supports this' : advertised.length ? 'not advertised by this server' : undefined);
  const authOptions =
    flow === 'launch'
      ? [
          { value: 'none', label: 'Public app (no secret, PKCE only)', hint: 'browser or mobile apps' },
          { value: 'client_secret_basic', label: 'Client secret', hint: mark('client_secret_basic') },
          { value: 'private_key_jwt', label: 'Private key (signed JWT)', hint: mark('private_key_jwt') },
        ]
      : [
          { value: 'private_key_jwt', label: 'Private key (signed JWT)', hint: mark('private_key_jwt') || 'the SMART standard' },
          { value: 'client_secret_basic', label: 'Client secret (HTTP Basic)', hint: mark('client_secret_basic') },
          { value: 'client_secret_post', label: 'Client secret (in the form body)', hint: mark('client_secret_post') },
        ];
  let defaultAuth = 0;
  if (flow === 'backend' && advertised.length && !advertised.includes('private_key_jwt'))
    defaultAuth = advertised.includes('client_secret_basic') ? 1 : 2;
  const auth = await choose(prompter, out, 'How does the app authenticate?', authOptions, defaultAuth);

  const profile = { flow, fhir, clientId, auth };

  if (auth === 'private_key_jwt') {
    for (;;) {
      const k = (await prompter.ask('\nPath to the PRIVATE key file (or type "new" to generate one)')).trim();
      if (k.toLowerCase() === 'new') {
        const kid = (
          await prompter.ask('Key ID (kid) for the new key', { defaultValue: `${clientId.slice(0, 12) || 'app'}-key-1` })
        ).trim();
        const dir = path.join(path.dirname(target), 'keys');
        const g = await generateKeys({ alg: 'ES384', kid, outDir: dir });
        out(`  Created ${g.pemPath} (keep it secret) and ${g.jwksPath} (register or host this public JWKS).`);
        profile.key = path.relative(path.dirname(target), g.pemPath) || g.pemPath;
        profile.kid = g.kid;
        break;
      }
      const abs = path.resolve(cwd, expandHome(k));
      if (!existsSync(abs)) {
        out(`  No file at ${abs}.`);
        continue;
      }
      const loaded = await loadKey({ keyPath: abs });
      const problem = loaded.checks.find((c) => c.status === 'fail');
      if (problem) {
        out(`  ${problem.detail}`);
        continue;
      }
      out(`  OK: ${loaded.checks[0].detail}. The key file is never copied or uploaded.`);
      profile.key = k;
      profile.kid = (await prompter.ask('Key ID (kid) registered for this key', { defaultValue: loaded.kid })).trim() || undefined;
      break;
    }
    const jwks = (await prompter.ask('Your JWKS URL, if you registered one (Enter to skip)')).trim();
    if (jwks) profile.jwksUrl = jwks;
  } else if (auth !== 'none') {
    const name = (
      await prompter.ask('\nEnvironment variable that will hold the client secret', { defaultValue: DEFAULT_SECRET_ENV })
    ).trim();
    profile.secretEnv = name || DEFAULT_SECRET_ENV;
    out(
      env[profile.secretEnv]
        ? `  ${profile.secretEnv} is set in this shell.`
        : `  Before running: export ${profile.secretEnv}='…'  (smart-doctor never stores it)`,
    );
  }

  // Scopes
  const defaultScope =
    flow === 'launch'
      ? v2
        ? DEFAULT_LAUNCH_SCOPE
        : DEFAULT_LAUNCH_SCOPE.replace('patient/*.rs', 'patient/*.read')
      : v2
        ? 'system/Patient.rs'
        : 'system/Patient.read';
  profile.scope = (await prompter.ask('\nScopes to request', { defaultValue: defaultScope })).trim();

  if (flow === 'launch') {
    out('\nRedirect URI: use EXACTLY what is registered for the app.');
    out('  • http://localhost:PORT/… or http://127.0.0.1:PORT/… → smart-doctor catches the redirect itself.');
    out('  • anything else (https://your.app/callback) → you paste the URL you land on. No registration change needed.');
    profile.redirectUri = (await prompter.ask('Redirect URI', { defaultValue: 'http://localhost:9876/callback' })).trim();
  }

  const name = (await prompter.ask('\nName this profile', { defaultValue: suggestName(fhir, flow) })).trim();
  const saved = await saveProfile(target, name, profile);
  out(`\nSaved profile "${name}" to ${saved.path}`);
  out(`Run it any time with: smart-doctor check ${name}`);
  const run = (await prompter.ask('Run it now? (Y/n)', { defaultValue: 'y' })).trim().toLowerCase();
  return { name, path: saved.path, profile: saved.profile, runNow: run !== 'n' && run !== 'no' };
}
