// What servers say, mapped to smart-doctor's causes (knowledge as data).
//
// Two tables, both safe to extend without touching the engine:
//   ERROR_ALIASES   non-standard spellings of OAuth error codes → the standard code
//   TEXT_PATTERNS   wording in error_description / response bodies → a cause id (see causes.js)
//
// Add the exact wording you saw (and the vendor/sandbox it came from) to a test in
// test/knowledge.test.js, so the mapping keeps working.

/**
 * Map free-text error descriptions to cause ids (vendor wording varies).
 * Specific patterns come first; `final` stops the generic keyword ones from piling on.
 */
export const TEXT_PATTERNS = [
  {
    re: /basic auth(entication)? is required|must use (http )?basic|client_secret_(basic|post) is (required|not (supported|allowed))|unsupported (client )?auth(entication)? method/i,
    cause: 'secret_method_required',
    confidence: 0.85,
    final: true,
  },
  { re: /(none of the|no) keys?\b[^.]{0,40}\bkid\b/i, cause: 'kid_unknown', confidence: 0.85, final: true },
  { re: /(none of the|no) keys?\b[^.]{0,40}\balg\b/i, cause: 'jwks_no_alg', confidence: 0.85, final: true },
  {
    re: /invalid client[_ ]secret|client[_ ]secret[^.]{0,30}(invalid|incorrect|wrong|does not match)|bad client credentials/i,
    cause: 'secret_invalid',
    confidence: 0.8,
    final: true,
  },
  {
    re: /invalid '?client_?id'?|unknown client|client not found|client_?id[^.]{0,30}(not found|unknown|not registered)/i,
    cause: 'client_unknown',
    confidence: 0.8,
    final: true,
  },
  { re: /aud(ience)?\b|invalid audience/i, cause: 'aud_mismatch' },
  { re: /expired|\bexp\b|too far in the future|lifetime|not yet valid|nbf|iat/i, cause: 'assertion_time' },
  { re: /jti|replay|already (been )?used/i, cause: 'jti_reuse' },
  { re: /signature|verify|verification/i, cause: 'signature' },
  { re: /\bkid\b|key id|no (matching|suitable) key|unable to find key/i, cause: 'kid_unknown' },
  {
    re: /(could not|cannot|can't|unable to|failed to) (fetch|retrieve|download|load|get|resolve)[^.]{0,30}(jwks|jwk set|key set|keys)|jwks[^.]{0,30}(unreachable|not reachable|timed? ?out|invalid json)/i,
    cause: 'jwks_fetch',
  },
  { re: /alg(orithm)?\b/i, cause: 'alg_unsupported' },
  { re: /client authentication failed/i, cause: 'generic_client_auth' },
  { re: /scope/i, cause: 'scope' },
  { re: /disabled|inactive|not (enabled|active|activated)/i, cause: 'client_inactive' },
];

/** Vendor spellings of OAuth error codes seen in the wild ("Invalid Grant", "invalid-client", "invalid_code"). */
export const ERROR_ALIASES = { invalid_code: 'invalid_grant', invalid_authorization_code: 'invalid_grant', expired_code: 'invalid_grant' };
export function normalizeError(error) {
  if (typeof error !== 'string' || !error.trim()) return error;
  const e = error
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ERROR_ALIASES[e] || e;
}

/**
 * The standard OAuth error codes in plain words, and the causes most often behind each.
 * Shown on the website's error catalogue; `causes` ids must exist in causes.js.
 */
export const ERROR_CODES = {
  invalid_client: {
    meaning:
      'The server could not authenticate your client. It is deliberately vague: the same answer covers a wrong client ID, key, secret or assertion.',
    causes: [
      'kid_unknown',
      'aud_mismatch',
      'key_mismatch',
      'secret_invalid',
      'client_unknown',
      'clock_skew',
      'jwks_fetch',
      'server_side_registration',
    ],
  },
  invalid_grant: {
    meaning:
      'The grant itself was rejected: in sign-in, usually the authorization code (used, expired, or redirect_uri/PKCE mismatch); in backend services, often the assertion.',
    causes: ['code_consumed', 'code_expired', 'redirect_mismatch_token', 'pkce_failed', 'refresh_rejected', 'assertion_time'],
  },
  invalid_request: {
    meaning: 'A parameter is missing, repeated or malformed. Read error_description: it usually names the parameter.',
    causes: ['authorize_request', 'authorize_aud', 'authorize_redirect', 'secret_method_required', 's256_unsupported'],
  },
  invalid_scope: {
    meaning: 'One or more requested scopes are unknown, malformed or not allowed for this client.',
    causes: ['scope', 'authorize_scope', 'scope_syntax'],
  },
  unauthorized_client: {
    meaning: 'The client is known but not allowed to use this grant or flow here (disabled, not activated, wrong client type).',
    causes: ['client_inactive', 'authorize_client', 'grant_type'],
  },
  access_denied: {
    meaning: 'The user or the organisation declined, or this user may not use the app.',
    causes: ['access_denied'],
  },
  unsupported_grant_type: {
    meaning: 'The token endpoint does not accept this grant type for this client.',
    causes: ['grant_type'],
  },
};
