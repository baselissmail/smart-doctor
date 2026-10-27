// Load the client's private key locally and derive everything we need to
// compare against what the server sees. The private key never leaves this
// process: we only ever export the PUBLIC half.

import { createPrivateKey, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exportJWK, importJWK, calculateJwkThumbprint, generateKeyPair, exportPKCS8 } from 'jose';
import { check, STATUS } from './util.js';

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export const SMART_REQUIRED_ALGS = ['RS384', 'ES384'];

/** Strip private members from a JWK. */
export function toPublicJwk(jwk) {
  const pub = { ...jwk };
  for (const f of PRIVATE_JWK_FIELDS) delete pub[f];
  delete pub.key_ops;
  return pub;
}

export function hasPrivateMaterial(jwk) {
  return PRIVATE_JWK_FIELDS.some((f) => jwk && jwk[f] !== undefined);
}

/** Pick the JWS alg that matches a key. */
export function inferAlg(keyObject) {
  const type = keyObject.asymmetricKeyType;
  const details = keyObject.asymmetricKeyDetails || {};
  if (type === 'rsa' || type === 'rsa-pss') return 'RS384';
  if (type === 'ec') {
    if (details.namedCurve === 'secp384r1') return 'ES384';
    if (details.namedCurve === 'prime256v1') return 'ES256';
    if (details.namedCurve === 'secp521r1') return 'ES512';
  }
  return undefined;
}

/** Is alg compatible with this key type/curve? */
export function algMatchesKey(alg, keyObject) {
  const type = keyObject.asymmetricKeyType;
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  if (/^RS|^PS/.test(alg)) return type === 'rsa' || type === 'rsa-pss';
  if (alg === 'ES256') return type === 'ec' && curve === 'prime256v1';
  if (alg === 'ES384') return type === 'ec' && curve === 'secp384r1';
  if (alg === 'ES512') return type === 'ec' && curve === 'secp521r1';
  return false;
}

/**
 * Parse key material from a string (PEM, JWK JSON, or JWKS JSON).
 * @returns {{ keyObject: import('node:crypto').KeyObject, jwkKid?: string, jwkAlg?: string, source: string }}
 */
/** @param {string} text @param {{ kid?: string }} [opts] */
export function parseKeyMaterial(text, { kid } = {}) {
  const trimmed = text.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    if (/BEGIN (RSA |EC )?PUBLIC KEY|BEGIN CERTIFICATE/.test(trimmed)) {
      throw new KeyError(
        'This is a PUBLIC key or certificate. smart-doctor needs the PRIVATE key to sign the test assertion (it never leaves your machine).',
      );
    }
    if (/ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(trimmed)) {
      throw new KeyError(
        'This private key is password-protected. Export an unencrypted copy to a temporary file (e.g. `openssl pkcs8 -topk8 -nocrypt`) and delete it afterwards.',
      );
    }
    return { keyObject: createPrivateKey({ key: trimmed, format: 'pem' }), source: 'pem' };
  }
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new KeyError('Could not parse key file: expected a PEM private key, a JWK, or a JWKS (JSON).');
  }
  let jwk = json;
  if (Array.isArray(json.keys)) {
    const privates = json.keys.filter(hasPrivateMaterial);
    if (privates.length === 0) {
      throw new KeyError('This JWKS contains only PUBLIC keys. smart-doctor needs the private key to sign the test assertion.');
    }
    jwk = kid ? privates.find((k) => k.kid === kid) : privates[0];
    if (!jwk) throw new KeyError(`No private key with kid "${kid}" in this JWKS (found: ${privates.map((k) => k.kid).join(', ')}).`);
  }
  if (!hasPrivateMaterial(jwk)) {
    throw new KeyError('This JWK is a PUBLIC key. smart-doctor needs the private key to sign the test assertion.');
  }
  if (jwk.kty === 'oct') throw new KeyError('Symmetric (oct) keys are not valid for SMART backend services; use an RSA or EC key pair.');
  return { keyObject: createPrivateKey({ key: jwk, format: 'jwk' }), jwkKid: jwk.kid, jwkAlg: jwk.alg, source: 'jwk' };
}

export class KeyError extends Error {}

/**
 * Load and assess the private key.
 * @param {{ keyPath?: string, keyText?: string, alg?: string, kid?: string }} opts
 */
export async function loadKey(opts) {
  const checks = [];
  let parsed;
  try {
    const text = opts.keyText ?? (await readFile(opts.keyPath, 'utf8'));
    parsed = parseKeyMaterial(text, { kid: opts.kid });
  } catch (err) {
    const msg = err instanceof KeyError ? err.message : `Could not load private key: ${err.message}`;
    checks.push(check('key.load', 'Private key loads', STATUS.FAIL, msg));
    return { ok: false, checks };
  }
  const { keyObject } = parsed;
  checks.push(
    check(
      'key.load',
      'Private key loads',
      STATUS.PASS,
      `${keyObject.asymmetricKeyType.toUpperCase()} private key (${parsed.source.toUpperCase()})${
        keyObject.asymmetricKeyDetails?.namedCurve ? ', curve ' + keyObject.asymmetricKeyDetails.namedCurve : ''
      }${keyObject.asymmetricKeyDetails?.modulusLength ? ', ' + keyObject.asymmetricKeyDetails.modulusLength + ' bits' : ''}`,
    ),
  );

  if (keyObject.asymmetricKeyType === 'rsa' && keyObject.asymmetricKeyDetails?.modulusLength < 2048) {
    checks.push(
      check(
        'key.strength',
        'RSA key size',
        STATUS.FAIL,
        `RSA key is ${keyObject.asymmetricKeyDetails.modulusLength} bits.`,
        'Use at least 2048-bit RSA keys; most EHRs reject smaller ones.',
      ),
    );
  }

  // Algorithm
  const alg = opts.alg || parsed.jwkAlg || inferAlg(keyObject);
  if (!alg) {
    checks.push(
      check(
        'key.alg',
        'Signing algorithm',
        STATUS.FAIL,
        `Unsupported key type ${keyObject.asymmetricKeyType}.`,
        'Use an RSA key (RS384) or an EC P-384 key (ES384).',
      ),
    );
    return { ok: false, checks };
  }
  if (!algMatchesKey(alg, keyObject)) {
    checks.push(
      check(
        'key.alg',
        'Signing algorithm',
        STATUS.FAIL,
        `alg ${alg} does not match this ${keyObject.asymmetricKeyType.toUpperCase()} key.`,
        'RSA keys sign with RS384; EC P-384 keys sign with ES384.',
      ),
    );
    return { ok: false, checks };
  }
  if (!SMART_REQUIRED_ALGS.includes(alg)) {
    checks.push(
      check(
        'key.alg',
        'Signing algorithm',
        STATUS.WARN,
        `${alg} is not one of the algorithms SMART servers are required to support (RS384, ES384).`,
        'Generate an RSA key (RS384) or EC P-384 key (ES384): `smart-doctor keygen`.',
      ),
    );
  } else {
    checks.push(check('key.alg', 'Signing algorithm', STATUS.PASS, alg));
  }

  // Public JWK + kid
  // Runtime-neutral: Node's own JWK export, then let jose build whatever key
  // type its current runtime build signs with (KeyObject on Node, CryptoKey on
  // Bun/standalone binaries).
  const privJwk = keyObject.export({ format: 'jwk' });
  const signingKey = await importJWK({ ...privJwk, alg }, alg);
  const publicJwk = toPublicJwk(privJwk);
  const thumbprint = await calculateJwkThumbprint(publicJwk, 'sha256');
  const kid = opts.kid || parsed.jwkKid;
  if (!kid) {
    checks.push(
      check(
        'key.kid',
        'Key ID (kid)',
        STATUS.WARN,
        'No kid given. SMART requires the assertion header to carry the kid of the key registered with the server.',
        'Pass --kid <the kid you registered>. If you registered a JWKS URL, the kid must match an entry there.',
      ),
    );
  } else {
    checks.push(check('key.kid', 'Key ID (kid)', STATUS.PASS, kid));
  }
  publicJwk.alg = alg;
  if (kid) publicJwk.kid = kid;

  return { ok: true, checks, keyObject: signingKey, alg, kid, publicJwk, thumbprint };
}

/**
 * Generate a fresh key pair + JWKS suitable for SMART backend services.
 * Writes <out>/private-key.pem and <out>/jwks.json (public only).
 */
/** @param {{ alg?: 'RS384'|'ES384'|string, kid?: string, outDir?: string }} [opts] */
export async function generateKeys({ alg = 'ES384', kid, outDir = '.' } = {}) {
  if (!SMART_REQUIRED_ALGS.includes(alg)) throw new Error('alg must be RS384 or ES384');
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true, modulusLength: 2048 });
  const pub = await exportJWK(publicKey);
  const keyId = kid || (await calculateJwkThumbprint(pub, 'sha256')).slice(0, 16) || randomUUID();
  const jwk = { ...pub, kid: keyId, alg, use: 'sig', key_ops: ['verify'] };
  const pem = await exportPKCS8(privateKey);
  await mkdir(outDir, { recursive: true });
  const pemPath = path.join(outDir, 'private-key.pem');
  const jwksPath = path.join(outDir, 'jwks.json');
  await writeFile(pemPath, pem, { mode: 0o600 });
  await writeFile(jwksPath, JSON.stringify({ keys: [jwk] }, null, 2) + '\n');
  return { pemPath, jwksPath, kid: keyId, alg, publicJwk: jwk };
}
