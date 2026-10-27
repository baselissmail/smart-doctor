// A small, strict mock of an EHR's SMART endpoints with switchable failure
// modes. It powers the test-suite and demos: you (or an AI agent) can exercise
// every failure path with zero real credentials and zero patient data.
//
// Supports:
//   - discovery (.well-known/smart-configuration, CapabilityStatement)
//   - backend services: client_credentials with private_key_jwt or client secrets
//   - SMART App Launch (standalone): /oauth2/authorize with a synthetic sign-in
//     page, PKCE (S256), state, exact redirect_uri matching, iss parameter,
//     patient context, id_token (openid fhirUser), refresh tokens
//   - public, confidential-symmetric and confidential-asymmetric clients
//
// Like real servers, it answers most client-auth problems with a bare
// {"error":"invalid_client"} unless verboseErrors is on, and it does NOT
// redirect when the redirect_uri is unknown — it shows its own error page.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, generateKeyPair, exportJWK, SignJWT } from 'jose';

export const MODES = {
  'no-discovery': 'No .well-known/smart-configuration (404); token URL only in CapabilityStatement',
  'clock-skew': 'Server clock runs 10 minutes ahead',
  'cached-discovery': 'Discovery documents come from a cache: their Date header is 10 minutes old (X-Cache-Status: HIT, no Age)',
  'stale-jwks': 'Server caches each client JWKS at startup and never refreshes it (key rotation not picked up)',
  'rate-limit': 'Token endpoint always answers 429 with Retry-After',
  'server-error': 'Token endpoint always answers 500',
  'secret-only': 'Only client_secret_basic advertised; signed JWT assertions rejected',
  'rs384-only': 'Only RS384 accepted for assertions',
  'es384-only': 'Only ES384 accepted for assertions',
  'v1-scopes-only': 'Only SMART v1 scopes (system/*.read) understood; v2 syntax rejected',
  'auto-approve': 'Sign-in page is skipped: /authorize redirects straight back with a code (for automation)',
  'user-denies': 'The (simulated) user denies access: redirect with error=access_denied',
  'wrong-state': 'Server returns a different state value than it was sent',
  'no-s256': 'Server advertises only PKCE "plain" (SMART requires S256)',
  'refresh-disabled': 'No refresh tokens are issued even if offline_access is granted',
  'no-patient-context': 'No patient is returned even when launch/patient is granted',
};

const CLOCK_SKEW_SECONDS = 600;
const CODE_TTL_SECONDS = 60;
const SYSTEM_SCOPES = ['system/*.read', 'system/*.rs'];
const LAUNCH_SCOPES = [
  'launch',
  'launch/patient',
  'openid',
  'fhirUser',
  'profile',
  'offline_access',
  'online_access',
  'patient/*.read',
  'patient/*.rs',
  'user/*.read',
  'user/*.rs',
];
const SYNTHETIC_PATIENTS = [
  { id: 'synthetic-pat-1', name: 'Test, Alex (synthetic)' },
  { id: 'synthetic-pat-2', name: 'Sample, Jordan (synthetic)' },
];

/**
 * @typedef {{
 *   clientId: string,
 *   jwks?: any, jwksFile?: string, jwksUrl?: string,        // confidential asymmetric
 *   secret?: string, secretMethods?: string[],               // confidential symmetric
 *   public?: boolean,                                        // public client (PKCE only)
 *   redirectUris?: string[], scopes?: string[], enabled?: boolean,
 * }} MockClient
 * @param {{ port?: number, host?: string, clients?: MockClient[], modes?: string[], verboseErrors?: boolean, log?: (line: string) => void }} opts
 */
export async function startMock(opts = {}) {
  const modes = new Set(opts.modes || []);
  for (const m of modes) if (!MODES[m]) throw new Error(`Unknown mock mode "${m}". Known: ${Object.keys(MODES).join(', ')}`);
  const log = opts.log || (() => {});
  const normalise = (c) => ({
    enabled: true,
    scopes: [...SYSTEM_SCOPES, ...LAUNCH_SCOPES],
    secretMethods: ['client_secret_basic', 'client_secret_post'],
    redirectUris: [],
    ...c,
  });
  const clients = new Map((opts.clients || []).map((c) => [c.clientId, normalise(c)]));
  const seenJti = new Set();
  const tokens = new Map(); // access tokens
  const refreshTokens = new Map();
  const codes = new Map();
  const pending = new Map(); // authorize requests awaiting the sign-in page decision
  const staleJwks = new Map();

  let algs = ['RS384', 'ES384'];
  if (modes.has('rs384-only')) algs = ['RS384'];
  if (modes.has('es384-only')) algs = ['ES384'];

  const serverKeys = await generateKeyPair('ES384', { extractable: true });
  const serverJwk = { ...(await exportJWK(serverKeys.publicKey)), kid: 'mock-ehr-1', alg: 'ES384', use: 'sig' };

  const serverNow = () => Math.floor(Date.now() / 1000) + (modes.has('clock-skew') ? CLOCK_SKEW_SECONDS : 0);

  let base;
  const urls = () => ({
    fhirBase: `${base}/fhir`,
    tokenUrl: `${base}/oauth2/token`,
    authorizeUrl: `${base}/oauth2/authorize`,
    jwksUri: `${base}/oauth2/jwks`,
  });

  async function loadClientJwks(client, { forServer }) {
    if (forServer && modes.has('stale-jwks') && staleJwks.has(client.clientId)) return staleJwks.get(client.clientId);
    let jwks;
    if (client.jwks) jwks = client.jwks;
    else if (client.jwksFile) jwks = JSON.parse(readFileSync(client.jwksFile, 'utf8'));
    else if (client.jwksUrl) {
      const r = await fetch(client.jwksUrl);
      if (!r.ok) throw new Error(`JWKS fetch HTTP ${r.status}`);
      jwks = await r.json();
    }
    return jwks;
  }

  const hasJwks = (c) => Boolean(c.jwks || c.jwksFile || c.jwksUrl);

  /** Authenticate the client at the token endpoint. Returns { client } or { error:[status, code, description] }. */
  async function authenticateClient(req, body) {
    const authz = req.headers.authorization || '';
    if (/^Basic /i.test(authz)) {
      const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const dec = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
      let id;
      let secret;
      try {
        id = dec(decoded.slice(0, i));
        secret = dec(decoded.slice(i + 1));
      } catch {
        return { error: [401, 'invalid_client', 'Malformed Basic credentials'] };
      }
      const client = clients.get(id);
      if (!client) return { error: [401, 'invalid_client', 'Unknown client'] };
      if (!client.secret || !client.secretMethods.includes('client_secret_basic'))
        return { error: [401, 'invalid_client', 'client_secret_basic not allowed for this client'] };
      if (!safeEqual(secret, client.secret)) return { error: [401, 'invalid_client', 'Invalid client secret'] };
      return { client, method: 'client_secret_basic' };
    }
    if (body.get('client_assertion') || body.get('client_assertion_type')) {
      if (modes.has('secret-only')) return { error: [401, 'invalid_client', 'Client authentication method not allowed'] };
      return verifyAssertion(body);
    }
    if (body.get('client_secret') != null) {
      const client = clients.get(body.get('client_id'));
      if (!client) return { error: [401, 'invalid_client', 'Unknown client'] };
      if (!client.secret || !client.secretMethods.includes('client_secret_post'))
        return { error: [401, 'invalid_client', 'client_secret_post not allowed for this client'] };
      if (!safeEqual(body.get('client_secret'), client.secret)) return { error: [401, 'invalid_client', 'Invalid client secret'] };
      return { client, method: 'client_secret_post' };
    }
    const client = clients.get(body.get('client_id'));
    if (!client) return { error: [401, 'invalid_client', body.get('client_id') ? 'Unknown client' : 'No client authentication'] };
    if (!client.public) return { error: [401, 'invalid_client', 'Confidential client must authenticate'] };
    return { client, method: 'none' };
  }

  async function verifyAssertion(body) {
    if (body.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
      return { error: [400, 'invalid_client', 'Missing or wrong client_assertion_type'] };
    const assertion = body.get('client_assertion');
    if (!assertion) return { error: [400, 'invalid_client', 'Missing client_assertion'] };
    let header;
    let claims;
    try {
      header = decodeProtectedHeader(assertion);
      claims = decodeJwt(assertion);
    } catch {
      return { error: [401, 'invalid_client', 'Malformed client assertion'] };
    }
    const client = clients.get(claims.iss);
    if (!client) return { error: [401, 'invalid_client', 'Unknown client'] };
    if (!hasJwks(client)) return { error: [401, 'invalid_client', 'private_key_jwt not allowed for this client'] };
    if (claims.iss !== claims.sub) return { error: [401, 'invalid_client', 'iss and sub must both be the client_id'] };
    if (!algs.includes(header.alg)) return { error: [401, 'invalid_client', `Unsupported signing algorithm ${header.alg}`] };
    if (!header.kid) return { error: [401, 'invalid_client', 'Missing kid'] };
    let jwks;
    try {
      jwks = await loadClientJwks(client, { forServer: true });
    } catch (e) {
      return { error: [401, 'invalid_client', `Unable to fetch client JWKS: ${e.message}`] };
    }
    const jwk = (jwks?.keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return { error: [401, 'invalid_client', `No key with kid ${header.kid}`] };
    const now = serverNow();
    try {
      const keyLike = await importJWK(jwk, header.alg);
      await jwtVerify(assertion, keyLike, {
        audience: urls().tokenUrl,
        issuer: client.clientId,
        subject: client.clientId,
        algorithms: algs,
        currentDate: new Date(now * 1000),
        clockTolerance: 5,
      });
    } catch (e) {
      const why =
        e.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && e.claim === 'aud'
          ? 'Invalid audience'
          : e.code === 'ERR_JWT_EXPIRED'
            ? 'Assertion expired'
            : e.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'
              ? 'Signature verification failed'
              : `Assertion rejected (${e.code || e.message})`;
      return { error: [401, 'invalid_client', why] };
    }
    if (typeof claims.exp !== 'number' || claims.exp - now > 300 + 5)
      return { error: [401, 'invalid_client', 'Assertion lifetime exceeds 5 minutes'] };
    if (!claims.jti) return { error: [401, 'invalid_client', 'Missing jti'] };
    if (seenJti.has(claims.jti)) return { error: [401, 'invalid_client', 'jti already used'] };
    seenJti.add(claims.jti);
    return { client, method: 'private_key_jwt' };
  }

  function grantScopes(requested, client, { system }) {
    let granted = requested.filter((s) => scopeAllowed(s, client.scopes));
    if (modes.has('v1-scopes-only'))
      granted = granted.filter((s) => !/^(system|user|patient)\//.test(s) || /\.(read|write|\*)$/.test(s.split('?')[0]));
    if (!requested.length) granted = system ? client.scopes.filter((s) => s.startsWith('system/')) : [];
    return granted;
  }

  async function issueTokens({ client, scope, patient, user = 'synthetic-practitioner-1' }) {
    const now = serverNow();
    const accessToken = randomBytes(24).toString('base64url');
    tokens.set(accessToken, { clientId: client.clientId, scope, exp: now + 300, patient });
    const out = { access_token: accessToken, token_type: 'Bearer', expires_in: 300, scope: scope.join(' ') };
    if (patient) {
      out.patient = patient;
      out.need_patient_banner = true;
      out.smart_style_url = `${base}/smart-style.json`;
    }
    if ((scope.includes('offline_access') || scope.includes('online_access')) && !modes.has('refresh-disabled')) {
      const rt = randomBytes(24).toString('base64url');
      refreshTokens.set(rt, { clientId: client.clientId, scope, patient });
      out.refresh_token = rt;
    }
    if (scope.includes('openid')) {
      const claims = { aud: client.clientId };
      if (scope.includes('fhirUser')) claims.fhirUser = `${urls().fhirBase}/Practitioner/${user}`;
      out.id_token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES384', kid: serverJwk.kid, typ: 'JWT' })
        .setIssuer(urls().fhirBase)
        .setSubject(user)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(serverKeys.privateKey);
    }
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const send = (status, body, headers = {}) => {
      const h = { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers };
      if (modes.has('clock-skew')) h.date = new Date(serverNow() * 1000).toUTCString();
      if (modes.has('cached-discovery') && req.method === 'GET' && /\/(\.well-known\/|metadata$)/.test(url.pathname)) {
        Object.assign(h, {
          date: new Date(Date.now() - CLOCK_SKEW_SECONDS * 1000).toUTCString(),
          'x-cache-status': 'HIT',
          'cache-control': 'public, max-age=28800',
        });
      }
      res.writeHead(status, h);
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      log(`${req.method} ${url.pathname} -> ${status}`);
    };
    const html = (status, title, inner) => send(status, page(title, inner), { 'content-type': 'text/html; charset=utf-8' });
    const oauthError = (status, error, description) =>
      send(status, opts.verboseErrors && description ? { error, error_description: description } : { error });
    const redirectBack = (redirectUri, params) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
      res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
      res.end();
      log(`${req.method} ${url.pathname} -> 302 ${u.origin}${u.pathname}`);
    };
    const backTo = (redirectUri, state) => (params) =>
      redirectBack(redirectUri, { ...params, state: modes.has('wrong-state') ? 'not-your-state' : state, iss: urls().fhirBase });

    try {
      // --- Discovery -------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/fhir/.well-known/smart-configuration') {
        if (modes.has('no-discovery'))
          return send(404, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
        const caps = [
          'launch-standalone',
          'client-public',
          'client-confidential-symmetric',
          'client-confidential-asymmetric',
          'context-standalone-patient',
          'permission-offline',
          'permission-patient',
          'permission-user',
          'sso-openid-connect',
          'permission-v1',
        ];
        if (!modes.has('v1-scopes-only')) caps.push('permission-v2');
        const grants = ['authorization_code', 'client_credentials'];
        if (!modes.has('refresh-disabled')) grants.push('refresh_token');
        return send(200, {
          issuer: urls().fhirBase,
          jwks_uri: urls().jwksUri,
          authorization_endpoint: urls().authorizeUrl,
          token_endpoint: urls().tokenUrl,
          token_endpoint_auth_methods_supported: modes.has('secret-only')
            ? ['client_secret_basic']
            : ['private_key_jwt', 'client_secret_basic', 'client_secret_post'],
          token_endpoint_auth_signing_alg_values_supported: algs,
          grant_types_supported: grants,
          response_types_supported: ['code'],
          code_challenge_methods_supported: modes.has('no-s256') ? ['plain'] : ['S256'],
          scopes_supported: [...SYSTEM_SCOPES, ...LAUNCH_SCOPES],
          capabilities: caps,
        });
      }
      if (req.method === 'GET' && url.pathname === '/fhir/metadata') {
        return send(
          200,
          {
            resourceType: 'CapabilityStatement',
            status: 'active',
            kind: 'instance',
            fhirVersion: '4.0.1',
            format: ['json'],
            rest: [
              {
                mode: 'server',
                security: {
                  extension: [
                    {
                      url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
                      extension: [
                        { url: 'token', valueUri: urls().tokenUrl },
                        { url: 'authorize', valueUri: urls().authorizeUrl },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          { 'content-type': 'application/fhir+json' },
        );
      }
      if (req.method === 'GET' && url.pathname === '/oauth2/jwks') return send(200, { keys: [serverJwk] });
      if (req.method === 'GET' && url.pathname === '/smart-style.json') return send(200, { color_background: '#f6f7f7' });

      // --- Hosted client JWKS (convenience for demos/tests) --------------
      const jwksMatch = url.pathname.match(/^\/client-jwks\/([^/]+)\.json$/);
      if (req.method === 'GET' && jwksMatch) {
        const client = clients.get(decodeURIComponent(jwksMatch[1]));
        if (!client || !hasJwks(client)) return send(404, { error: 'not found' });
        return send(200, await loadClientJwks(client, { forServer: false }));
      }

      // --- Authorization endpoint (SMART App Launch) ---------------------
      if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
        const q = url.searchParams;
        const client = clients.get(q.get('client_id') || '');
        if (!client)
          return html(
            400,
            'Sign-in error',
            `<p>Unknown application (client_id <code>${esc(q.get('client_id') || '(missing)')}</code>).</p>`,
          );
        const redirectUri = q.get('redirect_uri');
        if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
          return html(
            400,
            'Sign-in error',
            `<p>The redirect URI <code>${esc(redirectUri || '(missing)')}</code> is not registered for this application, so you cannot be sent back to it.</p><p>Registered: ${client.redirectUris.map((u) => `<code>${esc(u)}</code>`).join(', ') || '(none)'}</p>`,
          );
        }
        const state = q.get('state');
        const back = backTo(redirectUri, state);
        if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
        if (!client.enabled) return back({ error: 'unauthorized_client', error_description: 'Client is disabled' });
        if (q.get('aud') !== urls().fhirBase) return back({ error: 'invalid_request', error_description: 'aud must be the FHIR base URL' });
        const method = q.get('code_challenge_method');
        if (!q.get('code_challenge') || (method !== 'S256' && !(modes.has('no-s256') && method === 'plain'))) {
          return back({ error: 'invalid_request', error_description: 'PKCE code_challenge with S256 is required' });
        }
        const requested = (q.get('scope') || '').split(/\s+/).filter(Boolean);
        const granted = grantScopes(requested, client, { system: false });
        if (requested.length && granted.length === 0)
          return back({ error: 'invalid_scope', error_description: `Requested scopes not allowed: ${requested.join(' ')}` });
        if (modes.has('user-denies')) return back({ error: 'access_denied', error_description: 'The user denied access' });

        const request = {
          client,
          redirectUri,
          state,
          granted,
          challenge: q.get('code_challenge'),
          method,
          wantsPatient: granted.includes('launch/patient'),
        };
        if (modes.has('auto-approve')) return back({ code: makeCode(request, SYNTHETIC_PATIENTS[0].id) });
        const id = randomBytes(12).toString('base64url');
        pending.set(id, { request, redirectUri, state });
        return html(
          200,
          'Sign in to Mock EHR',
          `<p>This is a <strong>mock EHR</strong> run by smart-doctor. No real accounts or patient data exist here.</p>
           <p><strong>${esc(client.clientId)}</strong> is asking for: ${granted.map((s) => `<code>${esc(s)}</code>`).join(' ') || '(no scopes)'}</p>
           <form method="post" action="/oauth2/decision">
             <input type="hidden" name="id" value="${id}">
             <p>Signed in as <strong>Dr. Synthetic Practitioner</strong></p>
             ${
               request.wantsPatient
                 ? `<fieldset><legend>Choose a synthetic patient</legend>${SYNTHETIC_PATIENTS.map(
                     (p, i) =>
                       `<label><input type="radio" name="patient" value="${p.id}" ${i === 0 ? 'checked' : ''}> ${esc(p.name)}</label>`,
                   ).join('')}</fieldset>`
                 : ''
             }
             <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
           </form>`,
        );
      }
      if (req.method === 'POST' && url.pathname === '/oauth2/decision') {
        const form = new URLSearchParams(await readBody(req));
        const p = pending.get(form.get('id') || '');
        if (!p) return html(400, 'Sign-in error', '<p>This sign-in request has expired. Start again from your app.</p>');
        pending.delete(form.get('id'));
        const back = backTo(p.redirectUri, p.state);
        if (form.get('decision') !== 'approve') return back({ error: 'access_denied', error_description: 'The user denied access' });
        return back({ code: makeCode(p.request, form.get('patient') || SYNTHETIC_PATIENTS[0].id) });
      }

      // --- Token endpoint -------------------------------------------------
      if (url.pathname === '/oauth2/token') {
        if (req.method !== 'POST') return send(405, { error: 'invalid_request' });
        if (modes.has('rate-limit')) return send(429, { error: 'rate_limited' }, { 'retry-after': '30' });
        if (modes.has('server-error')) return send(500, { error: 'server_error' });
        const body = new URLSearchParams(await readBody(req));
        const grant = body.get('grant_type');
        if (
          !['client_credentials', 'authorization_code', 'refresh_token'].includes(grant) ||
          (grant === 'refresh_token' && modes.has('refresh-disabled'))
        ) {
          return oauthError(400, 'unsupported_grant_type', `Unsupported grant_type ${grant}`);
        }
        const auth = await authenticateClient(req, body);
        if (auth.error) return oauthError(...auth.error);
        const { client } = auth;

        if (grant === 'client_credentials') {
          if (auth.method === 'none') return oauthError(401, 'invalid_client', 'Public clients cannot use client_credentials');
          if (!client.enabled) return oauthError(400, 'unauthorized_client', 'Client is disabled');
          const requested = (body.get('scope') || '').split(/\s+/).filter(Boolean);
          const granted = grantScopes(requested, client, { system: true });
          if (requested.length && granted.length === 0)
            return oauthError(400, 'invalid_scope', `Requested scopes not allowed: ${requested.join(' ')}`);
          return send(200, await issueTokens({ client, scope: granted }));
        }

        if (grant === 'authorization_code') {
          const code = codes.get(body.get('code') || '');
          if (!code) return oauthError(400, 'invalid_grant', 'Unknown or already-used authorization code');
          if (code.used) {
            codes.delete(body.get('code'));
            return oauthError(400, 'invalid_grant', 'Authorization code already used');
          }
          code.used = true;
          if (code.exp < serverNow()) return oauthError(400, 'invalid_grant', 'Authorization code expired');
          if (code.clientId !== client.clientId) return oauthError(400, 'invalid_grant', 'Code was issued to another client');
          if (body.get('redirect_uri') !== code.redirectUri)
            return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
          const verifier = body.get('code_verifier') || '';
          const expected = code.method === 'plain' ? verifier : createHash('sha256').update(verifier).digest('base64url');
          if (!verifier || expected !== code.challenge) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
          return send(200, await issueTokens({ client, scope: code.granted, patient: code.patient }));
        }

        // refresh_token
        const rt = refreshTokens.get(body.get('refresh_token') || '');
        if (!rt || rt.clientId !== client.clientId) return oauthError(400, 'invalid_grant', 'Unknown refresh token');
        refreshTokens.delete(body.get('refresh_token'));
        return send(200, await issueTokens({ client, scope: rt.scope, patient: rt.patient }));
      }

      // --- Synthetic FHIR resources (no real data) ------------------------
      if (req.method === 'GET' && url.pathname.startsWith('/fhir/')) {
        const authz = req.headers.authorization || '';
        const t = tokens.get(authz.replace(/^Bearer\s+/i, ''));
        if (!t || t.exp < serverNow())
          return send(401, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login' }] });
        const [, , type, id] = url.pathname.split('/');
        const ok = t.scope.some((s) =>
          ['system', 'user', 'patient'].some((ctx) => scopeAllowed(`${ctx}/${type}.read`, [s]) || scopeAllowed(`${ctx}/${type}.rs`, [s])),
        );
        if (!ok) return send(403, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] });
        if (id)
          return send(200, { resourceType: type, id, meta: { tag: [{ code: 'synthetic' }] } }, { 'content-type': 'application/fhir+json' });
        return send(200, { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] }, { 'content-type': 'application/fhir+json' });
      }

      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: 'server_error', error_description: String(e?.message || e) });
    }
  });

  function makeCode(request, patientId) {
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      challenge: request.challenge,
      method: request.method,
      granted: request.granted,
      patient: request.wantsPatient && !modes.has('no-patient-context') ? patientId : undefined,
      exp: serverNow() + CODE_TTL_SECONDS,
      used: false,
    });
    return code;
  }

  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host || '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${addr.port}`;

  // Snapshot JWKS now for stale-jwks mode
  if (modes.has('stale-jwks')) {
    for (const c of clients.values()) {
      if (!hasJwks(c)) continue;
      try {
        staleJwks.set(c.clientId, await loadClientJwks(c, { forServer: false }));
      } catch {
        /* ignore */
      }
    }
  }

  return {
    ...urls(),
    baseUrl: base,
    port: addr.port,
    jwksUrlFor: (clientId) => `${base}/client-jwks/${encodeURIComponent(clientId)}.json`,
    setClient: (c) => clients.set(c.clientId, normalise(c)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#eef2f1;color:#1d2b33}
  main{max-width:34rem;margin:8vh auto;background:#fff;border:1px solid #cfdad7;border-radius:6px;padding:2rem}
  h1{font-size:1.35rem;margin:0 0 1rem}
  code{font-size:.9em;background:#f1f4f4;padding:.1em .3em;border-radius:3px;word-break:break-all}
  fieldset{border:1px solid #cfdad7;border-radius:4px;margin:1rem 0}
  label{display:block;padding:.25rem 0}
  button{font:inherit;padding:.5rem 1.1rem;border-radius:4px;border:1px solid #0f6b60;background:#0f6b60;color:#fff;cursor:pointer}
  button[value=deny]{background:#fff;color:#0f6b60}
  .note{color:#5a6b70;font-size:.875rem;margin-top:1.5rem}
</style></head><body><main><h1>${esc(title)}</h1>${inner}<p class="note">Mock EHR from smart-doctor — synthetic data only.</p></main></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Does an allowed scope (possibly with *) cover a requested one? */
export function scopeAllowed(requested, allowedList) {
  const [rCtx, rRest] = requested.split('/');
  if (!rRest) return allowedList.includes(requested);
  const [rType, rPerm] = rRest.split('.');
  return allowedList.some((a) => {
    const [aCtx, aRest] = a.split('/');
    if (!aRest || aCtx !== rCtx) return a === requested;
    const [aType, aPerm] = aRest.split('.');
    return (aType === '*' || aType === rType) && aPerm === rPerm;
  });
}
