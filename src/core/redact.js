// Redaction for the HTTP trace. Everything that can authenticate someone or
// carries clinical data is masked before it leaves the HTTP helper, so no
// front-end (terminal, UI, JSON, report) can ever show it.

import { mask } from '../util.js';

export const SENSITIVE_KEYS = new Set([
  'client_assertion',
  'client_secret',
  'code',
  'code_verifier',
  'refresh_token',
  'access_token',
  'id_token',
  'password',
  'assertion',
  'launch',
]);
const PRIVATE_JWK = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
const MAX_BODY = 4000;

export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(k)) u.searchParams.set(k, mask(u.searchParams.get(k), 4));
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(lk)) {
      const scheme = String(v).split(' ')[0];
      out[lk] = /^(basic|bearer|dpop)$/i.test(scheme) ? `${scheme} [masked]` : '[masked]';
    } else out[lk] = v;
  }
  return out;
}

function redactDeep(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    const isJwk = typeof value.kty === 'string';
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k) && typeof v === 'string') out[k] = mask(v, 8);
      else if (isJwk && PRIVATE_JWK.has(k)) out[k] = '[private key material masked]';
      else out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact a request/response body given its content type. */
export function redactBody(body, contentType = '') {
  if (body == null || body === '') return body;
  const text = String(body);
  if (/x-www-form-urlencoded/i.test(contentType) || (/^[\w.%-]+=/.test(text) && !text.trim().startsWith('{'))) {
    const p = new URLSearchParams(text);
    for (const k of [...p.keys()]) if (SENSITIVE_KEYS.has(k)) p.set(k, mask(p.get(k), 8));
    return decodeURIComponent(p.toString().replace(/\+/g, ' '));
  }
  try {
    const json = JSON.parse(text);
    return JSON.stringify(redactDeep(json), null, 2).slice(0, MAX_BODY);
  } catch {
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + `… [${text.length - MAX_BODY} more chars]` : text;
  }
}
