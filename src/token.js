// Perform the real client_credentials token request and record the outcome.
// Only the signed, short-lived, single-use assertion is sent — exactly what
// your app sends anyway. The private key never leaves this process.

import { check, STATUS, httpRequest, mask, stripTrailingSlash } from './util.js';
import { serverDateFrom } from './clock.js';
import { redactText, SENSITIVE_KEYS } from './core/redact.js';

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * POST to the token endpoint. Works for every grant: pass `grantType`, the
 * client-auth headers/params from clientauth.js, and any grant-specific form
 * fields. (Back-compat: `assertion` alone means private_key_jwt.)
 *
 * @param {{ tokenUrl: string, grantType?: string, clientAuth?: { headers: object, params: object },
 *   assertion?: string, form?: Record<string,string>, scope?: string, timeoutMs?: number,
 *   extraParams?: Record<string,string>, label?: string, sendScope?: boolean }} o
 */
export async function requestToken(o) {
  const auth = o.clientAuth || { headers: {}, params: { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: o.assertion } };
  const body = new URLSearchParams({
    grant_type: o.grantType || 'client_credentials',
    ...(o.form || {}),
    ...auth.params,
    ...(o.scope && o.sendScope !== false ? { scope: o.scope } : {}),
    ...(o.extraParams || {}),
  });
  const res = await httpRequest(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...auth.headers },
    body: body.toString(),
    timeoutMs: o.timeoutMs,
    label: o.label || `token (${o.grantType || 'client_credentials'})`,
  });

  const checks = [];
  const outcome = {
    checks,
    status: res.status,
    durationMs: res.durationMs,
    networkError: res.networkError,
    error: undefined,
    errorDescription: undefined,
    rawSnippet: undefined,
    token: undefined,
    retryAfter: res.headers?.['retry-after'],
    serverDate: serverDateFrom(res.headers),
  };

  if (res.networkError) {
    checks.push(check('token.request', 'Token request', STATUS.FAIL, `${o.tokenUrl}: ${res.networkError}`));
    return outcome;
  }

  if (res.ok && res.json?.access_token) {
    const t = res.json;
    outcome.token = {
      accessToken: t.access_token,
      tokenType: t.token_type,
      expiresIn: t.expires_in,
      scope: t.scope,
      refreshToken: t.refresh_token,
      idToken: t.id_token,
      // SMART launch context (not secrets)
      context: Object.fromEntries(
        Object.entries(t).filter(([k]) => !['access_token', 'refresh_token', 'id_token', 'token_type', 'expires_in', 'scope'].includes(k)),
      ),
    };
    checks.push(
      check(
        'token.request',
        'Token request',
        STATUS.PASS,
        `HTTP ${res.status} in ${res.durationMs} ms — access token ${mask(t.access_token)}`,
      ),
    );
    if (t.token_type && String(t.token_type).toLowerCase() !== 'bearer') {
      checks.push(check('token.type', 'token_type is Bearer', STATUS.WARN, `token_type is "${t.token_type}".`));
    }
    if (typeof t.expires_in === 'number') {
      checks.push(
        check(
          'token.expires',
          'Token lifetime',
          STATUS.INFO,
          `expires_in ${t.expires_in}s — cache and reuse it; don't request a new token per API call.`,
        ),
      );
    }
    if (o.scope && t.scope) {
      const asked = new Set(o.scope.split(/\s+/).filter(Boolean));
      const got = new Set(String(t.scope).split(/\s+/).filter(Boolean));
      const missing = [...asked].filter((s) => !got.has(s));
      if (missing.length) {
        checks.push(
          check(
            'token.scope',
            'Granted scopes',
            STATUS.WARN,
            `Granted fewer scopes than requested. Missing: ${missing.join(' ')}`,
            'Your client registration may not include these scopes; API calls needing them will fail with 403.',
            {
              missing,
            },
          ),
        );
      } else {
        checks.push(check('token.scope', 'Granted scopes', STATUS.PASS, String(t.scope)));
      }
    }
    return outcome;
  }

  // Failure. Server text goes into checks and reports, so mask anything of ours it echoes back.
  const known = [...body].filter(([k]) => SENSITIVE_KEYS.has(k)).map(([, v]) => v);
  const basic = /^Basic\s+(\S+)/i.exec(/** @type {Record<string, string>} */ (auth.headers || {}).authorization || '')?.[1];
  if (basic) {
    known.push(basic);
    const pair = Buffer.from(basic, 'base64').toString('utf8');
    known.push(pair.slice(pair.indexOf(':') + 1)); // the secret; the client id stays readable
  }
  outcome.error = res.json?.error;
  outcome.errorDescription = redactText(res.json?.error_description, known);
  if (!res.json) outcome.rawSnippet = redactText((res.text || '').slice(0, 300), known);
  const detailParts = [`HTTP ${res.status}`];
  if (outcome.error) detailParts.push(`error=${outcome.error}`);
  if (outcome.errorDescription) detailParts.push(`"${outcome.errorDescription}"`);
  if (!res.json && res.text) detailParts.push(`body: ${outcome.rawSnippet.replace(/\s+/g, ' ')}`);
  checks.push(check('token.request', 'Token request', STATUS.FAIL, detailParts.join(' · ')));
  return outcome;
}

/**
 * Optional probe: call one FHIR path with the token and report ONLY the
 * status code and content type. The body is never printed or stored, so no
 * patient data can leak into reports even if pointed at a clinical resource.
 */
export async function probe({ fhirBase, path = 'metadata', accessToken, timeoutMs }) {
  const url = `${stripTrailingSlash(fhirBase)}/${path.replace(/^\/+/, '')}`;
  const res = await httpRequest(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/fhir+json' },
    traceBody: false,
    timeoutMs,
  });
  if (res.networkError) return check('probe', `Probe GET ${path}`, STATUS.FAIL, res.networkError);
  const ct = res.headers['content-type'] || '';
  if (res.ok) return check('probe', `Probe GET ${path}`, STATUS.PASS, `HTTP ${res.status} (${ct}) — body not shown by design`);
  if (res.status === 401)
    return check(
      'probe',
      `Probe GET ${path}`,
      STATUS.FAIL,
      'HTTP 401 — the server did not accept the access token for this endpoint.',
      'Check the token audience/FHIR base pairing (non-prod token on prod base, or vice versa).',
    );
  if (res.status === 403)
    return check(
      'probe',
      `Probe GET ${path}`,
      STATUS.FAIL,
      'HTTP 403 — token accepted but not allowed for this resource.',
      'The client is missing the scope for this resource, or the app is not authorised for it at this organisation.',
    );
  return check('probe', `Probe GET ${path}`, STATUS.WARN, `HTTP ${res.status} (${ct})`);
}
