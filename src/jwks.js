// Check the JWKS URL registered with the EHR: reachable over HTTPS, valid,
// contains our kid, matches our private key, and leaks no private material.

import { calculateJwkThumbprint } from 'jose';
import { check, STATUS, httpRequest, isLocalhost } from './util.js';
import { hasPrivateMaterial, toPublicJwk } from './keys.js';

/**
 * @param {{ jwksUrl?: string, kid?: string, alg?: string, publicJwk?: any, thumbprint?: string, timeoutMs?: number }} o
 */
export async function checkJwks(o) {
  const checks = [];
  const out = { checks, kids: undefined, matched: undefined };
  if (!o.jwksUrl) {
    checks.push(
      check(
        'jwks.url',
        'JWKS URL',
        STATUS.SKIP,
        'No --jwks-url given. If you uploaded a public key to the vendor portal instead, make sure it is the public half of THIS private key (compare the thumbprint printed below).',
      ),
    );
    return out;
  }
  let u;
  try {
    u = new URL(o.jwksUrl);
  } catch {
    checks.push(check('jwks.url', 'JWKS URL', STATUS.FAIL, `"${o.jwksUrl}" is not a valid URL.`));
    return out;
  }
  if (u.protocol !== 'https:' && !isLocalhost(o.jwksUrl)) {
    checks.push(
      check(
        'jwks.https',
        'JWKS served over HTTPS',
        STATUS.FAIL,
        'JWKS URL is not HTTPS; EHRs will refuse to fetch it.',
        'Host the JWKS on an HTTPS URL with a publicly trusted certificate.',
      ),
    );
  }

  const res = await httpRequest(o.jwksUrl, { headers: { accept: 'application/json' }, timeoutMs: o.timeoutMs });
  if (res.networkError) {
    checks.push(
      check(
        'jwks.reach',
        'JWKS reachable',
        STATUS.FAIL,
        `${res.networkError}`,
        'The EHR fetches this URL from the public internet. It must be reachable without VPN, auth, or IP allow-listing.',
      ),
    );
    return out;
  }
  if (res.status >= 300 && res.status < 400) {
    checks.push(
      check(
        'jwks.reach',
        'JWKS reachable',
        STATUS.WARN,
        `HTTP ${res.status} redirect to ${res.headers.location || '(no location)'}`,
        'Some EHRs do not follow redirects when fetching JWKS. Register the final URL.',
      ),
    );
    return out;
  }
  if (!res.ok) {
    checks.push(
      check(
        'jwks.reach',
        'JWKS reachable',
        STATUS.FAIL,
        `HTTP ${res.status}`,
        'The URL must return 200 with the JWKS JSON, with no authentication.',
      ),
    );
    return out;
  }
  checks.push(check('jwks.reach', 'JWKS reachable', STATUS.PASS, `HTTP 200 in ${res.durationMs} ms`));

  const ct = res.headers['content-type'] || '';
  if (!/json/i.test(ct)) {
    checks.push(
      check(
        'jwks.content_type',
        'JWKS content type',
        STATUS.WARN,
        `Content-Type is "${ct || 'missing'}"`,
        'Serve it as application/json (some servers are strict).',
      ),
    );
  }
  const jwks = res.json;
  if (!jwks || !Array.isArray(jwks.keys)) {
    checks.push(
      check(
        'jwks.format',
        'JWKS format',
        STATUS.FAIL,
        'Response is not a JWKS ({"keys":[...]}).',
        'Publish a JSON Web Key Set: {"keys":[{...public JWK...}]}.',
      ),
    );
    return out;
  }
  checks.push(check('jwks.format', 'JWKS format', STATUS.PASS, `${jwks.keys.length} key(s)`));

  // Private material leaked?
  const leaked = jwks.keys.filter(hasPrivateMaterial);
  if (leaked.length) {
    checks.push(
      check(
        'jwks.private_leak',
        'JWKS contains no private key material',
        STATUS.FAIL,
        `CRITICAL: ${leaked.length} key(s) in your public JWKS include PRIVATE fields (e.g. "d"). Anyone can impersonate your app.`,
        'Remove the key from the JWKS immediately, generate a new key pair, and register the new public key. Treat the old key as compromised.',
      ),
    );
  }

  out.kids = jwks.keys.map((k) => k.kid).filter(Boolean);
  const dupes = out.kids.filter((k, i) => out.kids.indexOf(k) !== i);
  if (dupes.length) {
    checks.push(
      check(
        'jwks.duplicate_kid',
        'kids are unique',
        STATUS.WARN,
        `Duplicate kid(s): ${[...new Set(dupes)].join(', ')}`,
        'Each key needs a unique kid; servers may pick the wrong one.',
      ),
    );
  }

  if (!o.kid) {
    checks.push(
      check('jwks.kid', 'Your kid is in the JWKS', STATUS.SKIP, `No kid to look for. JWKS has: ${out.kids.join(', ') || '(no kids)'}`),
    );
    return out;
  }
  const candidates = jwks.keys.filter((k) => k.kid === o.kid);
  if (candidates.length === 0) {
    checks.push(
      check(
        'jwks.kid',
        'Your kid is in the JWKS',
        STATUS.FAIL,
        `kid "${o.kid}" not found. JWKS has: ${out.kids.join(', ') || '(no kids)'}`,
        'Publish the public key with this kid, or sign with a kid that is in the JWKS.',
        {
          kids: out.kids,
        },
      ),
    );
    return out;
  }
  checks.push(check('jwks.kid', 'Your kid is in the JWKS', STATUS.PASS, o.kid));

  // Does the published key match our private key?
  if (o.thumbprint) {
    let match = false;
    for (const c of candidates) {
      try {
        const tp = await calculateJwkThumbprint(toPublicJwk(c), 'sha256');
        if (tp === o.thumbprint) {
          match = true;
          out.matched = c;
        }
      } catch {
        /* malformed entry */
      }
    }
    if (match) {
      checks.push(
        check('jwks.key_match', 'Published key matches your private key', STATUS.PASS, `thumbprint ${o.thumbprint.slice(0, 12)}…`),
      );
    } else {
      checks.push(
        check(
          'jwks.key_match',
          'Published key matches your private key',
          STATUS.FAIL,
          `The key published under kid "${o.kid}" is NOT the public half of the private key you are signing with.`,
          'Either sign with the matching private key, or publish the public key for this private key (smart-doctor prints it with --show-public-jwk).',
        ),
      );
    }
  }

  // alg / use hints on the published entry
  const entry = out.matched || candidates[0];
  if (entry.alg && o.alg && entry.alg !== o.alg) {
    checks.push(
      check(
        'jwks.alg',
        'Published alg matches',
        STATUS.FAIL,
        `JWKS entry says alg ${entry.alg} but you sign with ${o.alg}.`,
        `Make them consistent (sign with ${entry.alg}, or update the JWKS entry).`,
      ),
    );
  }
  if (entry.use && entry.use !== 'sig') {
    checks.push(check('jwks.use', 'Published key use is "sig"', STATUS.WARN, `use is "${entry.use}".`, 'Set "use":"sig" (or omit it).'));
  }
  if (Array.isArray(entry.key_ops) && !entry.key_ops.includes('verify')) {
    checks.push(
      check(
        'jwks.key_ops',
        'key_ops allows verify',
        STATUS.WARN,
        `key_ops is ${JSON.stringify(entry.key_ops)}.`,
        'Include "verify" or omit key_ops.',
      ),
    );
  }
  return out;
}
