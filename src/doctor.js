// Backend-services flow (client_credentials). Orchestrates gatherers and
// checks as a sequence of steps on a Run, so every front-end sees the same
// live progress. Library API: runCheck(options, { run }).

import { loadKey } from './keys.js';
import { discover } from './discovery.js';
import { checkClock } from './clock.js';
import { checkJwks } from './jwks.js';
import { buildAssertion, lintAssertion } from './assertion.js';
import { requestToken, probe } from './token.js';
import { detectVendor } from './vendors/index.js';
import { check, STATUS } from './util.js';
import { Run, withRun } from './core/run.js';
import { inferAuth, checkSecret, clientAuthParams, AUTH_METHODS } from './clientauth.js';
import { finish } from './core/result.js';
import { UsageError } from './core/errors.js';

/**
 * Backend-services check (client_credentials).
 * @param {import('./types.js').RunOptions} opts
 * @param {import('./types.js').RunContext} [ctx]
 */
export async function runCheck(opts, ctx = {}) {
  if (!opts.clientId) throw new UsageError('--client-id is required');
  if (!opts.fhirBase && !opts.tokenUrl) throw new UsageError('Pass --fhir <FHIR base URL> (or --token-url)');
  const auth = inferAuth(opts);
  if (!AUTH_METHODS.includes(auth) || auth === 'none')
    throw new UsageError(`Backend services needs --auth private_key_jwt, client_secret_basic or client_secret_post (got "${auth}")`);
  if (auth === 'private_key_jwt' && !opts.keyPath && !opts.keyText)
    throw new UsageError('--key <path to private key> is required for private_key_jwt');
  opts = { ...opts, auth };
  const run = ctx.run || new Run({ flow: 'backend' });
  return withRun(run, () => backendFlow(opts, run));
}

async function backendFlow(opts, run) {
  const meta = { flow: 'backend', auth: opts.auth, clientId: opts.clientId, fhirBase: opts.fhirBase };
  const useKey = opts.auth === 'private_key_jwt';
  let step;

  // 1. Credentials (local only)
  let key = { ok: false, checks: [] };
  if (useKey) {
    step = run.step('key', 'Key (local only — never sent)');
    key = await loadKey({ keyPath: opts.keyPath, keyText: opts.keyText, alg: opts.alg, kid: opts.kid });
    step.add(key.checks).end();
    if (key.ok) Object.assign(meta, { alg: key.alg, kid: key.kid, thumbprint: key.thumbprint, publicJwk: key.publicJwk });
  } else {
    step = run.step('secret', 'Client secret (local only — never shown)');
    step.add(checkSecret({ secret: opts.secret, secretEnv: opts.secretEnv, auth: opts.auth })).end();
  }
  const credentialsOk = useKey ? key.ok : Boolean(opts.secret);

  // 2. Discovery
  let disc = { checks: [], config: undefined, tokenUrl: undefined };
  if (opts.fhirBase) {
    step = run.step('discovery', 'Server discovery');
    disc = await discover({ fhirBase: opts.fhirBase, timeoutMs: opts.timeoutMs, auth: opts.auth });
    step.add(disc.checks).end();
  }
  const tokenUrl = opts.tokenUrl || disc.tokenUrl;
  meta.tokenUrl = tokenUrl;
  meta.discoveredTokenUrl = disc.tokenUrl;
  meta.vendor = detectVendor([opts.fhirBase, tokenUrl], opts.vendor);

  // 3. Clock (may be completed later from the token response's Date header)
  step = run.step('clock', 'Clock');
  if (disc.serverDate) step.add(checkClock(disc.serverDate).check);
  step.end();

  let assertion;
  let jwks = { checks: [] };
  if (useKey) {
    // 4. JWKS
    step = run.step('jwks', 'JWKS');
    if (key.ok)
      jwks = await checkJwks({
        jwksUrl: opts.jwksUrl,
        kid: key.kid,
        alg: key.alg,
        publicJwk: key.publicJwk,
        thumbprint: key.thumbprint,
        timeoutMs: opts.timeoutMs,
      });
    step.add(jwks.checks).end();

    // 5. Assertion
    step = run.step('assertion', 'Client assertion');
    if (key.ok && tokenUrl) {
      assertion = await buildAssertion({
        clientId: opts.clientId,
        tokenUrl: opts.aud || tokenUrl,
        keyObject: key.keyObject,
        alg: key.alg,
        kid: key.kid,
        jku: opts.jku ? opts.jwksUrl : undefined,
      });
      const lint = lintAssertion(assertion.jwt, { tokenUrl, clientId: opts.clientId, jwksKids: jwks.kids });
      // kid absence is already reported by the key step
      step.add(lint.checks.filter((c) => !(c.id === 'assertion.kid' && !key.kid)));
      if (opts.jku && !opts.jwksUrl) step.add(check('assertion.jku', 'jku header', STATUS.WARN, '--jku needs --jwks-url.'));
    } else if (!tokenUrl) {
      step.add(check('assertion.build', 'Build test assertion', STATUS.SKIP, 'No token endpoint known.'));
    }
    step.end();
  }

  // 6. Token request (+ optional probe)
  let token;
  const canRequest = tokenUrl && credentialsOk && (!useKey || assertion);
  if (canRequest && opts.tokenRequest !== false) {
    step = run.step('token', 'Token request');
    token = await requestToken({
      tokenUrl,
      clientAuth: clientAuthParams({ auth: opts.auth, clientId: opts.clientId, secret: opts.secret, assertion: assertion?.jwt }),
      scope: opts.scope,
      timeoutMs: opts.timeoutMs,
    });
    step.add(token.checks);
    if (token.token && opts.probePath) {
      step.add(
        await probe({ fhirBase: opts.fhirBase, path: opts.probePath, accessToken: token.token.accessToken, timeoutMs: opts.timeoutMs }),
      );
    }
    step.end();
    if ((!disc.serverDate || disc.serverDate.cached) && token.serverDate) run.amend('clock', checkClock(token.serverDate).check);
  }

  return finish(run, meta, token, {
    auth: opts.auth,
    config: disc.config,
    alg: meta.alg,
    scope: opts.scope,
    jwksUrl: opts.jwksUrl,
    tokenUrlOverride: opts.tokenUrl,
    discoveredTokenUrl: disc.tokenUrl,
  });
}

export { finish, publicResult } from './core/result.js';
export { UsageError } from './core/errors.js';
