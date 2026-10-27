import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeys } from '../src/keys.js';
import { startMock } from '../src/mock/server.js';
import { runCheck } from '../src/doctor.js';

export const CLIENT_ID = 'test-client';

export async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'smart-doctor-test-'));
}

/** Generate a key pair into its own temp dir. */
export async function makeKey({ alg = 'ES384', kid = 'k1' } = {}) {
  const dir = await tmp();
  const g = await generateKeys({ alg, kid, outDir: dir });
  return { ...g, dir, jwks: JSON.parse(await readFile(g.jwksPath, 'utf8')) };
}

/**
 * Start a mock whose registered JWKS is `jwksFile` (defaults to the key's own),
 * run a full check, close the mock, and return the result.
 */
export async function scenario({ key, jwksFile, modes = [], client = {}, check = {}, before } = {}) {
  key = key || (await makeKey());
  const mock = await startMock({ clients: [{ clientId: CLIENT_ID, jwksFile: jwksFile || key.jwksPath, ...client }], modes });
  try {
    if (before) await before(mock);
    const extra = typeof check === 'function' ? check(mock) : check;
    return await runCheck({
      fhirBase: mock.fhirBase,
      clientId: CLIENT_ID,
      keyPath: key.pemPath,
      kid: key.kid,
      jwksUrl: mock.jwksUrlFor(CLIENT_ID),
      timeoutMs: 5000,
      ...extra,
    });
  } finally {
    await mock.close();
  }
}

export const topCause = (r) => r.diagnosis.causes[0]?.id;
export const causeIds = (r) => r.diagnosis.causes.map((c) => c.id);
export const checkStatus = (r, id) => r.sections.flatMap((s) => s.checks).find((c) => c.id === id)?.status;

export async function writeJson(file, obj) {
  await writeFile(file, JSON.stringify(obj, null, 2));
}
