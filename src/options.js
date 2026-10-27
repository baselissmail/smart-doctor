// Turning a profile + command-line flags + environment variables into the options a run uses.
// Shared by the CLI and the local web UI so both apply the same fallbacks and validation.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { UsageError } from './core/errors.js';
import { DEFAULT_SECRET_ENV, isEnvVarName } from './clientauth.js';
import { findConfig, loadProfiles, profileToOptions } from './profiles.js';

/**
 * Parse a whole-number option. A typo such as "30s" is a usage error rather than a NaN timer
 * that fires at once and looks like a network failure.
 * @param {string} flag
 * @param {unknown} value
 * @param {number} [min]
 */
export function wholeNumber(flag, value, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new UsageError(`--${flag} must be a whole number${min ? ` of at least ${min}` : ''} (got "${value}").`);
  return n;
}

/**
 * Build engine options from a named profile, flags and environment variables (precedence: flag > profile > env).
 * @param {{ profileName?: string, values?: Record<string, any>, env?: NodeJS.ProcessEnv, forced?: Partial<import('./types.js').RunOptions> }} p
 * @returns {Promise<import('./types.js').RunOptions & Record<string, any>>}
 */
export async function resolveOptions({ profileName, values = {}, env = process.env, forced = {} }) {
  const cfg = findConfig({ explicit: values.config, env });
  let profile;
  if (profileName) {
    const { profiles } = await loadProfiles(cfg.path);
    if (!profiles[profileName]) {
      const known = Object.keys(profiles);
      throw new UsageError(
        `No profile "${profileName}" in ${cfg.path}.${known.length ? ` Known: ${known.join(', ')}.` : ' Create one with: smart-doctor init'}`,
      );
    }
    profile = profiles[profileName];
  }
  return buildOptions({ profile, values, env, forced, configPath: cfg.path });
}

/**
 * Merge one profile with flags and environment variables, then validate. The web UI calls this
 * directly with the profile it was given, so both front-ends get the same fallbacks and checks.
 * @param {{ profile?: Record<string, any>, values?: Record<string, any>, env?: NodeJS.ProcessEnv,
 *   forced?: Partial<import('./types.js').RunOptions>, configPath?: string }} p
 * @returns {import('./types.js').RunOptions & Record<string, any>}
 */
export function buildOptions({ profile, values = {}, env = process.env, forced = {}, configPath }) {
  /** @type {Record<string, any>} */
  const base = profile ? profileToOptions(profile, { configPath, env }) : {};
  if (values['client-secret-env'] !== undefined && !isEnvVarName(values['client-secret-env']))
    throw new UsageError('--client-secret-env takes the NAME of an environment variable (like MY_APP_SECRET), not the secret itself.');
  const secretEnv = values['client-secret-env'] || base.secretEnv || DEFAULT_SECRET_ENV;
  // Precedence: command-line flag > profile > environment variable.
  const pick = (flag, envName, fromProfile) => values[flag] ?? fromProfile ?? (envName ? env[envName] : undefined);
  const opts = {
    ...base,
    flow: forced.flow || values.flow || base.flow || (values['redirect-uri'] ? 'launch' : 'backend'),
    fhirBase: pick('fhir', 'SMART_DOCTOR_FHIR', base.fhirBase),
    clientId: pick('client-id', 'SMART_DOCTOR_CLIENT_ID', base.clientId),
    auth: pick('auth', undefined, base.auth),
    keyPath: values.key
      ? path.resolve(values.key)
      : base.keyPath || (env.SMART_DOCTOR_KEY ? path.resolve(env.SMART_DOCTOR_KEY) : undefined),
    kid: pick('kid', 'SMART_DOCTOR_KID', base.kid),
    alg: pick('alg', undefined, base.alg),
    jwksUrl: pick('jwks-url', 'SMART_DOCTOR_JWKS_URL', base.jwksUrl),
    jku: values.jku,
    scope: pick('scope', undefined, base.scope),
    tokenUrl: pick('token-url', undefined, base.tokenUrl),
    aud: values.aud,
    vendor: pick('vendor', undefined, base.vendor),
    probePath: pick('probe', undefined, base.probePath),
    redirectUri: pick('redirect-uri', undefined, base.redirectUri),
    redirectMode: pick('redirect-mode', undefined, base.redirectMode) || 'auto',
    secretEnv,
    secret: env[secretEnv],
    tokenRequest: !values.offline,
    timeoutMs: values.timeout !== undefined ? wholeNumber('timeout', values.timeout, 1) : base.timeoutMs || 15000,
    waitMs: values.wait !== undefined ? wholeNumber('wait', values.wait, 1) * 1000 : 300000,
    testRefresh: !values['no-refresh'],
    configPath,
  };
  if (!['backend', 'launch'].includes(opts.flow)) throw new UsageError(`--flow must be backend or launch`);
  if (opts.keyPath && !existsSync(opts.keyPath)) throw new UsageError(`Key file not found: ${opts.keyPath}`);
  if (opts.alg && !/^(RS|ES|PS)(256|384|512)$/.test(opts.alg)) throw new UsageError(`Unsupported --alg ${opts.alg}`);
  if (opts.redirectMode && !['auto', 'loopback', 'paste'].includes(opts.redirectMode))
    throw new UsageError('--redirect-mode must be auto, loopback or paste');
  return opts;
}
