// Profiles: a plain YAML file you can commit and share with your team
// (the Bruno idea). It NEVER holds secrets: keys are referenced by path and
// client secrets by environment-variable name. Writing a secret into it is
// refused.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { DEFAULT_SECRET_ENV } from './clientauth.js';
import { isEnvVarName } from './clientauth.js';

export const CONFIG_NAME = 'smart-doctor.yaml';

const ALLOWED = new Set([
  'flow',
  'fhir',
  'clientId',
  'auth',
  'key',
  'kid',
  'alg',
  'jwksUrl',
  'scope',
  'tokenUrl',
  'vendor',
  'secretEnv',
  'redirectUri',
  'redirectMode',
  'probe',
  'timeout',
  'notes',
]);
const FORBIDDEN = /secret$|^secret|password|privatekey|private_key|token$|^accesstoken|^refreshtoken|assertion/i;

export class ProfileError extends Error {}

export function expandHome(p) {
  if (!p) return p;
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Where profiles live: --config, $SMART_DOCTOR_CONFIG, nearest ./smart-doctor.yaml upward, or ~/.config/smart-doctor/. */
/** @param {{ explicit?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [opts] */
export function findConfig({ explicit, cwd = process.cwd(), env = process.env } = {}) {
  if (explicit) return { path: path.resolve(cwd, expandHome(explicit)), exists: existsSync(path.resolve(cwd, expandHome(explicit))) };
  if (env.SMART_DOCTOR_CONFIG) {
    const p = path.resolve(cwd, expandHome(env.SMART_DOCTOR_CONFIG));
    return { path: p, exists: existsSync(p) };
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return { path: candidate, exists: true };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = path.join(os.homedir(), '.config', 'smart-doctor', CONFIG_NAME);
  if (existsSync(home)) return { path: home, exists: true };
  return { path: path.join(path.resolve(cwd), CONFIG_NAME), exists: false };
}

export function validateProfile(name, p) {
  if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(name))
    throw new ProfileError(`Profile name "${name}" must be letters, numbers, dot, dash or underscore.`);
  if (!p || typeof p !== 'object') throw new ProfileError(`Profile "${name}" must be a mapping.`);
  for (const k of Object.keys(p)) {
    if (k !== 'secretEnv' && FORBIDDEN.test(k)) {
      throw new ProfileError(
        `Profile "${name}" contains "${k}". Secrets never go in ${CONFIG_NAME} — reference them instead (key: <path>, secretEnv: <ENV_VAR_NAME>).`,
      );
    }
    if (!ALLOWED.has(k)) throw new ProfileError(`Profile "${name}": unknown setting "${k}". Allowed: ${[...ALLOWED].join(', ')}.`);
  }
  if (p.flow && !['backend', 'launch'].includes(p.flow)) throw new ProfileError(`Profile "${name}": flow must be "backend" or "launch".`);
  if (p.secretEnv && !isEnvVarName(p.secretEnv))
    throw new ProfileError(`Profile "${name}": secretEnv must be an environment variable NAME (like MY_APP_SECRET), not a secret.`);
  if (p.timeout !== undefined && !(Number.isInteger(Number(p.timeout)) && Number(p.timeout) > 0))
    throw new ProfileError(`Profile "${name}": timeout must be a whole number of milliseconds.`);
  return p;
}

export async function loadProfiles(configPath) {
  if (!existsSync(configPath)) return { path: configPath, profiles: {} };
  const text = await readFile(configPath, 'utf8');
  let doc;
  try {
    doc = YAML.parse(text) || {};
  } catch (e) {
    throw new ProfileError(`${configPath}: invalid YAML — ${e.message}`);
  }
  const profiles = doc.profiles || {};
  for (const [name, p] of Object.entries(profiles)) validateProfile(name, p);
  return { path: configPath, profiles };
}

const HEADER = `# smart-doctor profiles — safe to commit: no secrets live here.
# Keys are referenced by path, client secrets by environment-variable name.
# Run a profile with: smart-doctor check <name>
`;

/** Insert or replace one profile, keeping comments and other profiles intact. */
export async function saveProfile(configPath, name, profile) {
  const clean = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  validateProfile(name, clean);
  let doc;
  if (existsSync(configPath)) doc = YAML.parseDocument(await readFile(configPath, 'utf8'));
  else {
    doc = YAML.parseDocument(`${HEADER}profiles: {}\n`);
    await mkdir(path.dirname(configPath), { recursive: true });
  }
  if (!doc.has('profiles') || doc.get('profiles') == null) doc.set('profiles', doc.createNode({}));
  doc.setIn(['profiles', name], doc.createNode(clean));
  const profilesNode = doc.get('profiles');
  if (profilesNode && 'flow' in profilesNode) profilesNode.flow = false;
  await writeFile(configPath, doc.toString({ lineWidth: 0 }));
  return { path: configPath, name, profile: clean };
}

/**
 * Turn a profile (+ CLI overrides) into engine options. Relative key paths
 * resolve against the config file's folder, so a committed profile works
 * from any checkout.
 */
/**
 * @param {Record<string, any>} [profile]
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {import('./types.js').RunOptions & Record<string, any>}
 */
export function profileToOptions(profile = {}, { configPath, env = process.env } = {}) {
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  const keyPath = profile.key ? path.resolve(baseDir, expandHome(profile.key)) : undefined;
  const secretEnv = profile.secretEnv || DEFAULT_SECRET_ENV;
  return {
    flow: profile.flow || (profile.redirectUri ? 'launch' : 'backend'),
    fhirBase: profile.fhir,
    clientId: profile.clientId,
    auth: profile.auth,
    keyPath,
    kid: profile.kid,
    alg: profile.alg,
    jwksUrl: profile.jwksUrl,
    scope: profile.scope,
    tokenUrl: profile.tokenUrl,
    vendor: profile.vendor,
    secretEnv,
    secret: env[secretEnv],
    redirectUri: profile.redirectUri,
    redirectMode: profile.redirectMode,
    probePath: typeof profile.probe === 'string' ? profile.probe : undefined,
    probe: profile.probe === false ? false : undefined,
    timeoutMs: profile.timeout ? Number(profile.timeout) : undefined,
  };
}

/** Suggest a profile name from a URL and flow, e.g. "fhir-epic-com-backend". */
export function suggestName(fhirBase, flow) {
  let host = 'server';
  try {
    host = new URL(fhirBase).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }
  return `${host
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40)}-${flow}`;
}
