// Shared helpers: check records, masking, HTTP with timeouts.

import { currentRun } from './core/run.js';
import { redactUrl, redactHeaders, redactBody } from './core/redact.js';

export const STATUS = Object.freeze({
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
  INFO: 'info',
  SKIP: 'skip',
});

/**
 * A single check result.
 * @typedef {{ id: string, title: string, status: string, detail?: string, fix?: string, data?: any }} Check
 */

/** @returns {Check} */
export function check(id, title, status, detail, fix, data) {
  const c = { id, title, status };
  if (detail) c.detail = detail;
  if (fix) c.fix = fix;
  if (data !== undefined) c.data = data;
  return c;
}

/**
 * Mask a secret-ish string (tokens, assertions). Keeps a short prefix so two
 * values can still be told apart, never enough to be useful.
 */
export function mask(value, keep = 8) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= keep) return '[masked]';
  return `${s.slice(0, keep)}…[masked ${s.length} chars]`;
}

/** Partially mask a client id (only used when --redact is set). */
export function redactId(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export function isLocalhost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

/**
 * fetch() with a timeout and a normalised result. Never throws for network
 * errors — it returns { ok:false, networkError } so callers can diagnose.
 */
export async function httpRequest(url, opts = {}) {
  const res = await rawRequest(url, opts);
  const run = currentRun();
  if (run) {
    const reqCt = Object.entries(opts.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    run.http({
      at: new Date(Date.now() - res.durationMs).toISOString(),
      label: opts.label,
      method: opts.method || 'GET',
      url: redactUrl(url),
      request: {
        headers: redactHeaders(opts.headers),
        body: opts.body ? redactBody(opts.body, reqCt) : undefined,
      },
      response: res.networkError
        ? { error: res.networkError }
        : {
            status: res.status,
            headers: pickHeaders(res.headers),
            body: opts.traceBody === false ? '[response body not recorded by design]' : redactBody(res.text, res.headers['content-type']),
          },
      durationMs: res.durationMs,
    });
  }
  return res;
}

function pickHeaders(h = {}) {
  const keep = ['content-type', 'date', 'location', 'retry-after', 'www-authenticate', 'cache-control'];
  const out = {};
  for (const k of keep) if (h[k] !== undefined) out[k] = h[k];
  return redactHeaders(out);
}

/** @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [opts] */
async function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const outHeaders = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    return {
      ok: res.ok,
      status: res.status,
      headers: outHeaders,
      text,
      json,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: {},
      networkError: describeNetworkError(err, timeoutMs),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function describeNetworkError(err, timeoutMs) {
  if (err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  switch (code) {
    case 'ENOTFOUND':
      return `DNS lookup failed (${cause?.hostname || 'host not found'})`;
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ECONNRESET':
      return 'connection reset by peer';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `TLS certificate problem (${code}) — often a corporate proxy or missing CA bundle (try NODE_EXTRA_CA_CERTS)`;
    default:
      return `${code ? code + ': ' : ''}${cause?.message || err?.message || String(err)}`;
  }
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Start an HTTP server and resolve with the port it got (0 = any free port).
 * Rejects (instead of crashing the process) when the port is taken.
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>}
 */
export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
    });
  });
}
