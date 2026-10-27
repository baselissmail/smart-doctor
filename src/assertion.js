// Build a SMART backend-services client assertion and lint any assertion
// (ours, or one copied from your app's logs) against the spec's rules.

import { randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { check, STATUS, nowSeconds, stripTrailingSlash } from './util.js';
import { SMART_REQUIRED_ALGS } from './keys.js';

export const MAX_LIFETIME_SECONDS = 300;

/**
 * @param {{ clientId: string, tokenUrl: string, keyObject: any, alg: string, kid?: string, jku?: string, lifetimeSeconds?: number, now?: number }} o
 */
export async function buildAssertion(o) {
  const now = o.now ?? nowSeconds();
  const header = { alg: o.alg, typ: 'JWT' };
  if (o.kid) header.kid = o.kid;
  if (o.jku) header.jku = o.jku;
  const jti = randomUUID();
  const jwt = await new SignJWT({ jti })
    .setProtectedHeader(header)
    .setIssuer(o.clientId)
    .setSubject(o.clientId)
    .setAudience(o.tokenUrl)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.lifetimeSeconds ?? MAX_LIFETIME_SECONDS - 60))
    .sign(o.keyObject);
  return { jwt, header, jti };
}

/**
 * Lint a client assertion. Works without any key — it checks structure and
 * claims only (signature validity is something only the server can judge
 * against the key it has on file).
 *
 * @param {string} token
 * @param {{ tokenUrl?: string, clientId?: string, now?: number, jwksKids?: string[] }} ctx
 */
export function lintAssertion(token, ctx = {}) {
  const checks = [];
  const now = ctx.now ?? nowSeconds();
  const parts = String(token).trim().split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    checks.push(
      check(
        'assertion.format',
        'JWT structure',
        STATUS.FAIL,
        `Expected 3 non-empty dot-separated parts, got ${parts.length}.`,
        'Make sure the whole token was copied (no truncation, no "Bearer " prefix).',
      ),
    );
    return { checks };
  }
  let header;
  let claims;
  try {
    header = decodeProtectedHeader(token);
    claims = decodeJwt(token);
  } catch (err) {
    checks.push(check('assertion.format', 'JWT structure', STATUS.FAIL, `Could not decode: ${err.message}`));
    return { checks };
  }
  checks.push(check('assertion.format', 'JWT structure', STATUS.PASS));

  // Header
  if (!header.alg || header.alg === 'none' || /^HS/.test(header.alg)) {
    checks.push(
      check(
        'assertion.alg',
        'Header alg',
        STATUS.FAIL,
        `alg "${header.alg}" is not allowed for private_key_jwt.`,
        'Sign with RS384 (RSA key) or ES384 (EC P-384 key).',
      ),
    );
  } else if (!SMART_REQUIRED_ALGS.includes(header.alg)) {
    checks.push(
      check(
        'assertion.alg',
        'Header alg',
        STATUS.WARN,
        `${header.alg} — servers are only required to support RS384 and ES384.`,
        'Prefer RS384 or ES384.',
      ),
    );
  } else {
    checks.push(check('assertion.alg', 'Header alg', STATUS.PASS, header.alg));
  }
  if (!header.kid) {
    checks.push(
      check(
        'assertion.kid',
        'Header kid',
        STATUS.FAIL,
        'No kid in the JWT header. SMART requires it so the server can pick your key.',
        'Add the kid of your registered key to the JWT header.',
      ),
    );
  } else if (Array.isArray(ctx.jwksKids) && !ctx.jwksKids.includes(header.kid)) {
    checks.push(
      check(
        'assertion.kid_jwks',
        'Header kid',
        STATUS.FAIL,
        `kid "${header.kid}" is not in your JWKS (has: ${ctx.jwksKids.join(', ') || 'none'}).`,
      ),
    );
  } else {
    checks.push(check('assertion.kid', 'Header kid', STATUS.PASS, header.kid));
  }
  if (header.typ && header.typ !== 'JWT') {
    checks.push(check('assertion.typ', 'Header typ', STATUS.WARN, `typ is "${header.typ}"; SMART specifies "JWT".`));
  }

  // iss / sub
  if (!claims.iss || !claims.sub) {
    checks.push(
      check(
        'assertion.iss_sub',
        'iss and sub = client_id',
        STATUS.FAIL,
        `iss=${claims.iss ?? '(missing)'}, sub=${claims.sub ?? '(missing)'}`,
        'Both iss and sub must be set to your client_id.',
      ),
    );
  } else if (claims.iss !== claims.sub) {
    checks.push(
      check(
        'assertion.iss_sub',
        'iss and sub = client_id',
        STATUS.FAIL,
        `iss ("${claims.iss}") and sub ("${claims.sub}") differ.`,
        'Both must equal your client_id.',
      ),
    );
  } else if (ctx.clientId && claims.iss !== ctx.clientId) {
    checks.push(
      check(
        'assertion.iss_sub',
        'iss and sub = client_id',
        STATUS.FAIL,
        `iss/sub "${claims.iss}" ≠ expected client_id "${ctx.clientId}".`,
        'Check you are using the client_id for this environment (non-production vs production IDs differ).',
      ),
    );
  } else {
    checks.push(check('assertion.iss_sub', 'iss and sub = client_id', STATUS.PASS, claims.iss));
  }

  // aud
  const audList = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (audList.length === 0) {
    checks.push(
      check('assertion.aud', 'aud = token endpoint', STATUS.FAIL, 'No aud claim.', 'aud must be the token endpoint URL exactly.'),
    );
  } else if (ctx.tokenUrl) {
    const exact = audList.includes(ctx.tokenUrl);
    if (exact) {
      checks.push(check('assertion.aud', 'aud = token endpoint', STATUS.PASS, ctx.tokenUrl));
    } else {
      const why = explainAudMismatch(audList[0], ctx.tokenUrl);
      checks.push(
        check(
          'assertion.aud',
          'aud = token endpoint',
          STATUS.FAIL,
          `aud "${audList[0]}" ≠ token endpoint "${ctx.tokenUrl}"${why ? ' — ' + why : ''}.`,
          `Set aud to exactly ${ctx.tokenUrl}`,
          {
            aud: audList[0],
            tokenUrl: ctx.tokenUrl,
            reason: why,
          },
        ),
      );
    }
  } else {
    checks.push(check('assertion.aud', 'aud = token endpoint', STATUS.INFO, `aud is "${audList[0]}" (pass --token-url to verify it).`));
  }

  // exp / iat / nbf
  if (typeof claims.exp !== 'number') {
    checks.push(
      check(
        'assertion.exp',
        'exp present and ≤ 5 min',
        STATUS.FAIL,
        'No numeric exp claim.',
        'Set exp to at most 5 minutes in the future.',
      ),
    );
  } else {
    const remaining = claims.exp - now;
    const lifetime = typeof claims.iat === 'number' ? claims.exp - claims.iat : undefined;
    if (remaining <= 0) {
      checks.push(
        check(
          'assertion.exp',
          'exp present and ≤ 5 min',
          STATUS.FAIL,
          `Expired ${-remaining}s ago (by this machine's clock).`,
          'Generate a fresh assertion for every token request.',
        ),
      );
    } else if (remaining > MAX_LIFETIME_SECONDS || (lifetime && lifetime > MAX_LIFETIME_SECONDS)) {
      checks.push(
        check(
          'assertion.exp',
          'exp present and ≤ 5 min',
          STATUS.FAIL,
          `exp is ${Math.max(remaining, lifetime || 0)}s out; SMART caps assertion lifetime at 300s.`,
          'Set exp to now + 300 seconds or less (many teams use 240s to allow for clock skew).',
        ),
      );
    } else {
      checks.push(check('assertion.exp', 'exp present and ≤ 5 min', STATUS.PASS, `expires in ${remaining}s`));
    }
  }
  if (typeof claims.iat === 'number' && claims.iat - now > 60) {
    checks.push(
      check('assertion.iat', 'iat not in the future', STATUS.WARN, `iat is ${claims.iat - now}s in the future — your clock may be ahead.`),
    );
  }
  if (typeof claims.nbf === 'number' && claims.nbf - now > 0) {
    checks.push(check('assertion.nbf', 'nbf not in the future', STATUS.WARN, `nbf is ${claims.nbf - now}s in the future.`));
  }

  // jti
  if (!claims.jti) {
    checks.push(
      check(
        'assertion.jti',
        'jti present (unique per request)',
        STATUS.FAIL,
        'No jti claim.',
        'Add a random jti (e.g. a UUID) to every assertion; servers reject reused values.',
      ),
    );
  } else {
    checks.push(check('assertion.jti', 'jti present (unique per request)', STATUS.PASS));
  }

  return { checks, header, claims };
}

/** Explain the most common ways aud ends up not matching. */
export function explainAudMismatch(aud, tokenUrl) {
  if (!aud || !tokenUrl) return undefined;
  if (stripTrailingSlash(aud) === stripTrailingSlash(tokenUrl)) return 'trailing slash differs';
  if (aud.toLowerCase() === tokenUrl.toLowerCase()) return 'letter case differs';
  try {
    const a = new URL(aud);
    const t = new URL(tokenUrl);
    if (a.protocol !== t.protocol && a.host === t.host && a.pathname === t.pathname) return 'http vs https';
    if (a.host !== t.host) return `different host (${a.host} vs ${t.host})`;
    if (t.pathname.startsWith(a.pathname)) return 'aud is a parent path of the token endpoint';
    if (/fhir/i.test(a.pathname) && !/token/i.test(a.pathname)) return 'looks like the FHIR base URL, not the token endpoint';
    if (a.search !== t.search) return 'query string differs';
  } catch {
    return 'aud is not a URL';
  }
  return undefined;
}
