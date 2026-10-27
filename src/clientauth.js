// Client authentication at the token endpoint — shared by every flow.
//
//   private_key_jwt      signed assertion (SMART "confidential asymmetric")
//   client_secret_basic  HTTP Basic with client_id:secret (SMART "confidential symmetric")
//   client_secret_post   client_id + client_secret in the form body
//   none                 public client: client_id in the body only
//
// Secrets are only ever read from an environment variable (or passed in
// memory by the local UI) — never from argv, where shell history and `ps`
// would capture them — and are never written anywhere.

import { check, STATUS } from './util.js';
import { CLIENT_ASSERTION_TYPE } from './token.js';

export const AUTH_METHODS = ['private_key_jwt', 'client_secret_basic', 'client_secret_post', 'none'];
export const DEFAULT_SECRET_ENV = 'SMART_DOCTOR_CLIENT_SECRET';

export function isSecretAuth(auth) {
  return auth === 'client_secret_basic' || auth === 'client_secret_post';
}

/**
 * Pick an auth method when the user didn't say.
 * @param {{ auth?: string, keyPath?: string, keyText?: string, secret?: string }} opts
 */
export function inferAuth({ auth, keyPath, keyText, secret }) {
  if (auth) return auth;
  if (keyPath || keyText) return 'private_key_jwt';
  if (secret) return 'client_secret_basic';
  return 'none';
}

/** RFC 6749 §2.3.1: id and secret are form-urlencoded before base64. */
export function basicHeader(clientId, secret) {
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  return 'Basic ' + Buffer.from(`${enc(clientId)}:${enc(secret)}`).toString('base64');
}

/** Checks for a client secret (the value itself is never shown). */
export function checkSecret({ secret, secretEnv, auth }) {
  const checks = [];
  if (!secret) {
    checks.push(
      check(
        'secret.present',
        'Client secret available',
        STATUS.FAIL,
        `${auth} needs a client secret, but ${secretEnv || DEFAULT_SECRET_ENV} is not set.`,
        `export ${secretEnv || DEFAULT_SECRET_ENV}='…' in this shell (never pass secrets as command-line flags).`,
      ),
    );
    return checks;
  }
  checks.push(check('secret.present', 'Client secret available', STATUS.PASS, `${secret.length} characters (value never shown)`));
  if (secret !== secret.trim()) {
    checks.push(
      check(
        'secret.whitespace',
        'No stray whitespace',
        STATUS.FAIL,
        'The secret starts or ends with whitespace — usually a copy/paste accident.',
        'Re-copy the secret without leading/trailing spaces or newlines.',
      ),
    );
  }
  if (auth === 'client_secret_basic' && /[^A-Za-z0-9\-._~]/.test(secret)) {
    checks.push(
      check(
        'secret.encoding',
        'Secret is safe for HTTP Basic',
        STATUS.WARN,
        'The secret contains characters that RFC 6749 says must be URL-encoded inside HTTP Basic. Some servers expect that, some do not.',
        'If you get invalid_client, try --auth client_secret_post to rule out an encoding mismatch.',
      ),
    );
  }
  return checks;
}

/**
 * Produce the headers/body params that authenticate the client.
 * @param {{ auth: string, clientId: string, secret?: string, assertion?: string }} o
 */
export function clientAuthParams(o) {
  switch (o.auth) {
    case 'private_key_jwt':
      return { headers: {}, params: { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: o.assertion } };
    case 'client_secret_basic':
      return { headers: { authorization: basicHeader(o.clientId, o.secret) }, params: {} };
    case 'client_secret_post':
      return { headers: {}, params: { client_id: o.clientId, client_secret: o.secret } };
    case 'none':
    default:
      return { headers: {}, params: { client_id: o.clientId } };
  }
}
