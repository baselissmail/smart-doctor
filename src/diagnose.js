// Turn check results + the server's (deliberately vague) error into ranked,
// plain-English likely causes with fixes.
//
// OAuth servers intentionally say little more than "invalid_client". The
// approach here: rule out everything we can verify locally, then rank the
// causes we cannot see from the outside.

import { STATUS } from './util.js';
import { CAUSES } from './knowledge/causes.js';
import { TEXT_PATTERNS, normalizeError } from './knowledge/errors.js';

/**
 * @typedef {{ id: string, title: string, why: string, fix: string, confidence: number, evidence?: string }} Cause
 * @typedef {{
 *   checks: import('./util.js').Check[],
 *   token?: { status?: number, error?: string, errorDescription?: string, networkError?: string, token?: any, rawSnippet?: string },
 *   vendor?: import('./vendors/index.js').VendorProfile,
 *   config?: any,
 *   alg?: string,
 *   scope?: string,
 *   jwksUrl?: string,
 *   tokenUrlOverride?: string,
 *   discoveredTokenUrl?: string,
 * }} Facts
 */

const byId = (checks) => {
  const m = new Map();
  for (const c of checks) if (!m.has(c.id) || c.status === STATUS.FAIL) m.set(c.id, c);
  return m;
};
const failed = (m, id) => m.get(id)?.status === STATUS.FAIL;
const warned = (m, id) => m.get(id)?.status === STATUS.WARN;

/** Causes specific to SMART App Launch. */
function launchCauses(m, facts, t, err) {
  const L = facts.launch || {};
  const out = [];
  const add = (id, conf, evidence) => out.push(cause(id, conf, evidence));
  if (L.loopbackError) add('loopback_port', 0.95, L.loopbackError);
  if (L.callbackTimeout) {
    add('redirect_not_registered', 0.7);
    add('signin_not_completed', 0.4);
  }
  if (L.badPaste) add('bad_paste', 0.85);
  if (L.noPaste) {
    // Nothing to paste usually means the browser never got back to the redirect URI.
    add('redirect_not_registered', 0.6);
    add('signin_not_completed', 0.5);
  }
  if (L.stateMismatch) add('state_mismatch', 0.95);
  if (L.issMismatch) add('iss_mismatch', 0.6);
  if (L.s256Unsupported) add('s256_unsupported', L.authorizeError ? 0.8 : 0.5);
  const ae = L.authorizeError;
  if (ae) {
    const ev = `error=${ae.error}${ae.description ? ` "${ae.description}"` : ''}`;
    const aerr = normalizeError(ae.error);
    const d = ae.description || '';
    const map = {
      access_denied: 'access_denied',
      invalid_scope: 'authorize_scope',
      unauthorized_client: 'authorize_client',
      invalid_client: 'client_unknown',
    };
    let id = map[aerr] || 'authorize_request';
    if (aerr !== 'access_denied' && aerr !== 'invalid_scope') {
      if (/redirect/i.test(d)) id = 'authorize_redirect';
      else if (/\baud(ience)?\b/i.test(d)) id = 'authorize_aud';
      else if (/client_?id|unknown client|client not found/i.test(d)) id = 'client_unknown';
    }
    add(id, 0.9, ev);
    if (aerr === 'invalid_request' && /pkce|code_challenge/i.test(d)) add('s256_unsupported', 0.5, ev);
  }
  if (codeRejected(err, t)) {
    const d = t.errorDescription || '';
    const ev = `${t.error}${d ? ` "${d}"` : ''}`;
    if (/redirect/i.test(d)) add('redirect_mismatch_token', 0.9, ev);
    else if (/pkce|verifier|challenge/i.test(d)) add('pkce_failed', 0.9, ev);
    else if (/expired/i.test(d)) add('code_expired', 0.85, ev);
    else if (/used|unknown|invalid code|not found|consumed/i.test(d)) add('code_consumed', 0.85, ev);
    else {
      add('code_consumed', facts.redirectMode === 'paste' ? 0.7 : 0.5, ev);
      add('code_expired', 0.45, ev);
      add('redirect_mismatch_token', 0.35, ev);
    }
  }
  if (L.missingPatient) add('missing_patient', 0.75);
  if (L.idTokenProblem) add('id_token_problem', 0.7, L.idTokenProblem);
  if (L.refreshMissing) add('refresh_problem', 0.5);
  if (L.refreshError) {
    const r = L.refreshError;
    add('refresh_rejected', 0.7, `${r.error || 'HTTP ' + r.status}${r.description ? ` "${r.description}"` : ''}`);
  }
  return out;
}

/** The code exchange failed because of the code itself (invalid_grant, or a vendor's invalid_request about the code). */
function codeRejected(err, t) {
  if (err === 'invalid_grant') return true;
  const d = t?.errorDescription || '';
  return err === 'invalid_request' && /\b(authori[sz]ation )?code\b/i.test(d) && !/verifier|challenge|redirect/i.test(d);
}

/** @returns {Cause} */
function cause(id, confidence, evidence, override) {
  const base = CAUSES[id] || override;
  return { id, ...base, ...(override || {}), confidence: Math.max(0, Math.min(1, confidence)), ...(evidence ? { evidence } : {}) };
}

/**
 * @param {Facts} facts
 * @returns {{ verdict: 'ok'|'fail'|'warn'|'offline', causes: Cause[] }}
 */
export function diagnose(facts) {
  const m = byId(facts.checks || []);
  const t = facts.token || {};
  const err = normalizeError(t.error);
  const desc = `${t.errorDescription || ''} ${t.rawSnippet || ''}`;
  const launchFlow = facts.flow === 'launch';
  const isAuthErr =
    err === 'invalid_client' ||
    (err === 'invalid_grant' && !launchFlow) ||
    err === 'unauthorized_client' ||
    /client authentication failed/i.test(desc) ||
    t.status === 401;
  /** @type {Cause[]} */
  const causes = [];
  const add = (c) => causes.push(c);

  // Security first
  if (failed(m, 'jwks.private_leak')) add(cause('jwks_private_leak', 1, m.get('jwks.private_leak').detail));

  // Connectivity
  if (failed(m, 'discovery.reach') || t.networkError) add(cause('network', 0.95, t.networkError || m.get('discovery.reach')?.detail));
  else if (failed(m, 'discovery.capability') && !facts.tokenUrlOverride)
    add(cause('wrong_base', 0.9, m.get('discovery.capability').detail));

  if (t.status === 404 || t.status === 405 || (t.status >= 400 && t.status < 500 && !err && /<html|<!doctype/i.test(t.rawSnippet || ''))) {
    add(cause('wrong_token_url', 0.85, `HTTP ${t.status}`));
  }
  if (facts.tokenUrlOverride && facts.discoveredTokenUrl && facts.tokenUrlOverride !== facts.discoveredTokenUrl) {
    add(
      cause(
        'token_url_differs',
        isAuthErr ? 0.75 : 0.35,
        `--token-url ${facts.tokenUrlOverride} vs advertised ${facts.discoveredTokenUrl}`,
      ),
    );
  }

  // Local, verifiable assertion problems (strongest signals)
  const localWeight = isAuthErr ? 0.9 : t.token ? 0.2 : 0.7;
  if (failed(m, 'assertion.aud')) add(cause('aud_mismatch', localWeight, m.get('assertion.aud').detail));
  if (failed(m, 'assertion.kid') || warned(m, 'key.kid'))
    add(cause('kid_missing', isAuthErr ? 0.7 : 0.25, m.get('assertion.kid')?.detail || m.get('key.kid')?.detail));
  if (failed(m, 'assertion.iss_sub')) add(cause('iss_sub', localWeight, m.get('assertion.iss_sub').detail));
  if (failed(m, 'assertion.exp')) add(cause('assertion_time', localWeight, m.get('assertion.exp').detail));
  if (failed(m, 'assertion.jti')) add(cause('jti_reuse', localWeight * 0.9, m.get('assertion.jti').detail));
  if (failed(m, 'assertion.alg') || failed(m, 'key.alg'))
    add(cause('alg_unsupported', localWeight, (m.get('assertion.alg') || m.get('key.alg')).detail));
  if (failed(m, 'jwks.kid') || failed(m, 'assertion.kid_jwks'))
    add(cause('kid_unknown', localWeight, (m.get('jwks.kid') || m.get('assertion.kid_jwks')).detail));
  if (failed(m, 'jwks.key_match')) add(cause('key_mismatch', localWeight, m.get('jwks.key_match').detail));
  if (failed(m, 'jwks.alg')) add(cause('alg_unsupported', localWeight * 0.8, m.get('jwks.alg').detail));
  if (failed(m, 'jwks.reach') || failed(m, 'jwks.https') || failed(m, 'jwks.format') || warned(m, 'jwks.reach')) {
    add(cause('jwks_fetch', isAuthErr ? 0.85 : 0.5, (m.get('jwks.reach') || m.get('jwks.https') || m.get('jwks.format')).detail));
  }
  if (failed(m, 'secret.present')) add(cause('secret_missing', 0.95, m.get('secret.present').detail));
  if (failed(m, 'secret.whitespace')) add(cause('secret_whitespace', isAuthErr ? 0.85 : 0.6));
  if (warned(m, 'secret.encoding') && isAuthErr) add(cause('secret_method', 0.45, m.get('secret.encoding').detail));
  // Advisory only: some servers accept methods they do not advertise.
  if (failed(m, 'discovery.auth_method') || warned(m, 'discovery.auth_method'))
    add(cause('auth_method', isAuthErr ? 0.85 : 0.2, m.get('discovery.auth_method').detail));
  if (failed(m, 'clock.skew')) add(cause('clock_skew', isAuthErr ? 0.8 : 0.4, m.get('clock.skew').detail));
  else if (warned(m, 'clock.skew') && isAuthErr) add(cause('clock_skew', 0.3, m.get('clock.skew').detail));

  // Server advertised algs
  const algs = facts.config?.token_endpoint_auth_signing_alg_values_supported;
  if (facts.alg && Array.isArray(algs) && !algs.includes(facts.alg)) {
    add(cause('alg_unsupported', isAuthErr ? 0.8 : 0.4, `You sign with ${facts.alg}; server advertises ${algs.join(', ')}`));
  }

  // Scope problems
  if (err === 'invalid_scope' || (err && /scope/i.test(desc))) {
    add(cause('scope', 0.9, t.errorDescription));
  }
  if (facts.scope) {
    const caps = Array.isArray(facts.config?.capabilities) ? facts.config.capabilities : [];
    const { usesV1, usesV2 } = scopeSyntax(facts.scope);
    if (caps.length && usesV2 && !caps.includes('permission-v2'))
      add(cause('scope_syntax', err === 'invalid_scope' ? 0.85 : 0.3, 'v2 scopes requested; server does not advertise permission-v2'));
    if (caps.length && usesV1 && caps.includes('permission-v2') && !caps.includes('permission-v1'))
      add(cause('scope_syntax', err === 'invalid_scope' ? 0.85 : 0.3, 'v1 scopes requested; server advertises only permission-v2'));
  }
  if (m.get('token.scope')?.status === STATUS.WARN) add(cause('scope_partial', 0.5, m.get('token.scope').detail));

  // OAuth error codes
  if (err === 'unsupported_grant_type') add(cause('grant_type', 0.9, t.errorDescription));
  if (err === 'unauthorized_client') add(cause('client_inactive', 0.8, t.errorDescription));
  if (t.status === 429) add(cause('rate_limited', 0.95, t.retryAfter ? `Retry-After: ${t.retryAfter}` : undefined));
  if (t.status >= 500) add(cause('server_error', 0.8, `HTTP ${t.status}`));

  if (failed(m, 'probe')) add(cause('probe_failed', 0.6, m.get('probe').detail));

  // SMART App Launch specifics
  if (launchFlow) for (const c of launchCauses(m, facts, t, err)) add(c);

  // Free-text clues from the server (code-exchange errors are handled by launchCauses)
  const serverSaid = desc.trim() ? `server said: "${(t.errorDescription || t.rawSnippet || '').slice(0, 160)}"` : undefined;
  if (!(launchFlow && codeRejected(err, t))) {
    for (const p of TEXT_PATTERNS) {
      if (!desc.trim() || !p.re.test(desc)) continue;
      add(cause(p.cause, p.confidence ?? 0.75, serverSaid));
      if (p.final) break;
    }
  }

  // When the server says invalid_client and nothing local explains it
  const localExplains = causes.some((c) => c.confidence >= 0.7);
  if (isAuthErr && !localExplains) {
    const secretAuth = facts.auth === 'client_secret_basic' || facts.auth === 'client_secret_post';
    if (secretAuth) {
      add(cause('secret_invalid', 0.65, serverSaid));
      add(cause('client_unknown', 0.5));
      add(cause('secret_method', 0.35));
    } else if (facts.auth !== 'none') {
      add(cause('server_side_registration', 0.6));
      add(cause('client_unknown', 0.45));
      if (!facts.jwksUrl) add(cause('registered_key_unknown', 0.5));
      if (err === 'invalid_client' || /client authentication failed/i.test(desc)) add(cause('jti_reuse', 0.1));
    } else {
      add(cause('client_unknown', 0.6));
    }
  }

  // Vendor hints
  const vendorHints = [...((facts.vendor?.hints || {})[err] || []), ...((facts.vendor?.hints || {}).any || [])].filter(
    (h) => (!h.flow || h.flow === (facts.flow || 'backend')) && (!h.auth || h.auth === facts.auth),
  );
  if (isAuthErr || err === 'invalid_scope') {
    for (const h of vendorHints) {
      add(
        cause(h.id, (localExplains ? 0.15 : 0.4) + (h.weight || 0), undefined, {
          title: `${facts.vendor.name}: ${h.title}`,
          why: h.why,
          fix: h.fix,
        }),
      );
    }
  }

  // Never end a failed request with nothing to say
  if (!causes.length && (err || t.status >= 400) && !t.token) {
    add(
      cause(
        'unrecognised_error',
        0.5,
        `${t.error ? `error=${t.error}` : `HTTP ${t.status}`}${t.errorDescription ? ` "${t.errorDescription}"` : ''}`,
      ),
    );
  }

  // Merge duplicates (keep highest confidence, combine evidence)
  const merged = new Map();
  for (const c of causes) {
    const prev = merged.get(c.id);
    if (!prev || c.confidence > prev.confidence) merged.set(c.id, { ...c, evidence: c.evidence || prev?.evidence });
  }
  const ranked = [...merged.values()].sort((a, b) => b.confidence - a.confidence);

  let verdict;
  if (merged.has('jwks_private_leak')) verdict = 'fail';
  else if (t.token) verdict = ranked.some((c) => c.confidence >= 0.5) ? 'warn' : 'ok';
  else if (!facts.token) verdict = facts.checks.some((c) => c.status === STATUS.FAIL) ? 'fail' : 'offline';
  else verdict = 'fail';
  return { verdict, causes: ranked };
}

/** Detect SMART v1 (.read/.write/.*) vs v2 (.cruds) resource scopes. */
export function scopeSyntax(scope) {
  const parts = String(scope || '')
    .split(/\s+/)
    .filter((s) => /^(system|user|patient)\//.test(s));
  let usesV1 = false;
  let usesV2 = false;
  for (const s of parts) {
    const perm = s.split('?')[0].split('.').pop();
    if (perm === 'read' || perm === 'write' || perm === '*') usesV1 = true;
    else if (/^c?r?u?d?s?$/.test(perm) && perm.length > 0) usesV2 = true;
  }
  return { usesV1, usesV2 };
}

/**
 * Diagnose from an error message alone (the `explain` command).
 * Accepts the raw JSON body or any text a server/vendor log printed.
 */
export function explainError(text, { vendor, status } = {}) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const error =
    json?.error ||
    (text.match(/\b(invalid_client|invalid_grant|invalid_scope|invalid_request|unauthorized_client|unsupported_grant_type)\b/i) || [])[1];
  const token = {
    status: status ?? (/\b429\b/.test(text) ? 429 : /\b5\d\d\b/.test(text) && !error ? 500 : undefined),
    error,
    errorDescription: json?.error_description || (json ? undefined : text),
  };
  return diagnose({ checks: [], token, vendor, jwksUrl: 'unknown' });
}

export { CAUSES, normalizeError };
