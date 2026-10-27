// Discover the server's token endpoint and capabilities from the public
// SMART configuration document (falling back to the CapabilityStatement).

import { check, STATUS, httpRequest, stripTrailingSlash, isLocalhost } from './util.js';
import { serverDateFrom } from './clock.js';

const OAUTH_URIS_EXT = 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris';

/**
 * @param {{ fhirBase: string, timeoutMs?: number }} opts
 */
export async function discover({ fhirBase, timeoutMs, auth = 'private_key_jwt', grant = 'client_credentials' }) {
  const checks = [];
  const result = { checks, config: undefined, tokenUrl: undefined, authorizeUrl: undefined, source: undefined, serverDate: undefined };

  let base;
  try {
    base = new URL(fhirBase);
  } catch {
    checks.push(
      check(
        'discovery.base',
        'FHIR base URL',
        STATUS.FAIL,
        `"${fhirBase}" is not a valid URL.`,
        'Pass the FHIR base URL, e.g. https://fhir.example.org/api/FHIR/R4',
      ),
    );
    return result;
  }
  if (base.protocol !== 'https:' && !isLocalhost(fhirBase)) {
    checks.push(check('discovery.base', 'FHIR base URL', STATUS.WARN, 'FHIR base is not HTTPS. Production EHRs will not accept this.'));
  }
  const root = stripTrailingSlash(fhirBase);

  // 1. .well-known/smart-configuration
  const wkUrl = `${root}/.well-known/smart-configuration`;
  const wk = await httpRequest(wkUrl, { headers: { accept: 'application/json' }, timeoutMs });
  result.serverDate = serverDateFrom(wk.headers);

  if (wk.networkError) {
    checks.push(
      check(
        'discovery.reach',
        'FHIR server reachable',
        STATUS.FAIL,
        `${wkUrl}: ${wk.networkError}`,
        'Check the URL, VPN/firewall, and any corporate proxy (HTTPS_PROXY).',
      ),
    );
    return result;
  }
  checks.push(check('discovery.reach', 'FHIR server reachable', STATUS.PASS, `${new URL(wkUrl).host} responded in ${wk.durationMs} ms`));

  if (wk.ok && wk.json && typeof wk.json === 'object') {
    result.config = wk.json;
    result.source = 'smart-configuration';
    checks.push(check('discovery.config', 'SMART configuration (.well-known)', STATUS.PASS, wkUrl));
  } else {
    checks.push(
      check(
        'discovery.config',
        'SMART configuration (.well-known)',
        STATUS.WARN,
        `${wkUrl} returned HTTP ${wk.status}${wk.json ? '' : ' (not JSON)'}; falling back to CapabilityStatement.`,
      ),
    );
    // 2. CapabilityStatement fallback
    const mdUrl = `${root}/metadata`;
    const md = await httpRequest(mdUrl, { headers: { accept: 'application/fhir+json, application/json' }, timeoutMs });
    if ((!result.serverDate || result.serverDate.cached) && md.headers?.date) result.serverDate = serverDateFrom(md.headers);
    const tokenFromCs = md.json ? tokenUrlFromCapabilityStatement(md.json) : undefined;
    if (tokenFromCs) {
      result.config = { token_endpoint: tokenFromCs, authorization_endpoint: oauthUrisFromCapabilityStatement(md.json).authorize };
      result.source = 'capability-statement';
      checks.push(check('discovery.capability', 'CapabilityStatement oauth-uris', STATUS.PASS, `token endpoint found in ${mdUrl}`));
    } else {
      checks.push(
        check(
          'discovery.capability',
          'CapabilityStatement oauth-uris',
          STATUS.FAIL,
          md.networkError ? `${mdUrl}: ${md.networkError}` : `${mdUrl} returned HTTP ${md.status} with no oauth-uris token endpoint.`,
          'Check that the FHIR base URL is right (it usually ends in /R4 or /api/FHIR/R4). You can also pass --token-url directly.',
        ),
      );
      return result;
    }
  }

  const cfg = result.config;
  result.tokenUrl = cfg.token_endpoint;
  result.authorizeUrl = cfg.authorization_endpoint;
  if (!cfg.token_endpoint) {
    checks.push(
      check(
        'discovery.token_endpoint',
        'Token endpoint advertised',
        STATUS.FAIL,
        'No token_endpoint in the SMART configuration.',
        'Pass --token-url explicitly.',
      ),
    );
  } else {
    checks.push(check('discovery.token_endpoint', 'Token endpoint advertised', STATUS.PASS, cfg.token_endpoint));
  }

  // Capabilities relevant to backend services (only judge what is advertised)
  const authMethods = cfg.token_endpoint_auth_methods_supported;
  if (Array.isArray(authMethods) && auth !== 'none') {
    if (authMethods.includes(auth)) {
      checks.push(check('discovery.auth_method', `${auth} supported`, STATUS.PASS, authMethods.join(', ')));
    } else {
      checks.push(
        check(
          'discovery.auth_method',
          `${auth} supported`,
          // Advisory: some servers accept methods they do not advertise, so the token request decides.
          STATUS.WARN,
          `Server advertises only: ${authMethods.join(', ') || '(none)'}`,
          auth === 'private_key_jwt'
            ? 'This server may expect a client secret (client_secret_basic/post) instead of a signed JWT. Check how your client was registered (--auth).'
            : `Use one of the advertised methods with --auth (${authMethods.join(', ')}).`,
          { advertised: authMethods },
        ),
      );
    }
  }
  const grants = cfg.grant_types_supported;
  if (Array.isArray(grants)) {
    checks.push(
      grants.includes(grant)
        ? check('discovery.grant', `${grant} grant supported`, STATUS.PASS)
        : check(
            'discovery.grant',
            `${grant} grant supported`,
            STATUS.WARN,
            `Advertised grants: ${grants.join(', ')}`,
            'The server may not support this flow on this endpoint (or simply does not advertise it).',
          ),
    );
  }
  return result;
}

/** All oauth-uris from a CapabilityStatement ({ token, authorize, ... }). */
export function oauthUrisFromCapabilityStatement(cs) {
  const out = {};
  for (const rest of cs?.rest || []) {
    for (const ext of rest?.security?.extension || []) {
      if (ext.url === OAUTH_URIS_EXT) for (const e of ext.extension || []) if (e.valueUri) out[e.url] = e.valueUri;
    }
  }
  return out;
}

export function tokenUrlFromCapabilityStatement(cs) {
  for (const rest of cs?.rest || []) {
    for (const ext of rest?.security?.extension || []) {
      if (ext.url === OAUTH_URIS_EXT) {
        const tok = (ext.extension || []).find((e) => e.url === 'token');
        if (tok?.valueUri) return tok.valueUri;
      }
    }
  }
  return undefined;
}

/** Algorithms the server says it accepts for client assertions (if advertised). */
export function advertisedAlgs(config) {
  const v = config?.token_endpoint_auth_signing_alg_values_supported;
  return Array.isArray(v) ? v : undefined;
}

/** Whether the server advertises SMART v2 scopes (permission-v2) and/or v1. */
export function scopeVersions(config) {
  const caps = Array.isArray(config?.capabilities) ? config.capabilities : [];
  return { v1: caps.includes('permission-v1'), v2: caps.includes('permission-v2'), advertised: caps.length > 0 };
}
