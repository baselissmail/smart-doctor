// The practice EHR with three demo apps (backend key, backend secret, user sign-in) and matching
// profiles. Shared by `smart-doctor mock` and `smart-doctor ui --demo`.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { generateKeys } from '../keys.js';
import { startMock } from './server.js';

export const DEMO = {
  secret: 'demo-secret-value',
  redirects: ['http://localhost:9876/callback', 'http://127.0.0.1:9876/callback', 'https://app.example.com/smart/callback'],
};

/**
 * Start the practice EHR with three demo apps. Shared by `mock` and `ui --demo`.
 * @param {{ port?: number, host?: string, modes?: string[], verboseErrors?: boolean, log?: (line: string) => void, keyDir?: string }} [opts]
 */
export async function startDemoMock({
  port = 4013,
  host = '127.0.0.1',
  modes = [],
  verboseErrors,
  log,
  keyDir = path.resolve('.smart-doctor/demo'),
} = {}) {
  const pem = path.join(keyDir, 'private-key.pem');
  const jwks = path.join(keyDir, 'jwks.json');
  if (!existsSync(pem) || !existsSync(jwks)) await generateKeys({ alg: 'ES384', kid: 'demo-key-1', outDir: keyDir });
  const kid = JSON.parse(await readFile(jwks, 'utf8')).keys[0].kid;
  const mock = await startMock({
    port,
    host,
    modes,
    verboseErrors,
    log,
    clients: [
      { clientId: 'demo-backend', jwksFile: jwks },
      { clientId: 'demo-secret', secret: DEMO.secret },
      { clientId: 'demo-launch', public: true, redirectUris: DEMO.redirects },
    ],
  });
  const profiles = {
    'demo-backend': {
      flow: 'backend',
      fhir: mock.fhirBase,
      clientId: 'demo-backend',
      auth: 'private_key_jwt',
      key: pem,
      kid,
      jwksUrl: mock.jwksUrlFor('demo-backend'),
      scope: 'system/Patient.rs',
    },
    'demo-secret': {
      flow: 'backend',
      fhir: mock.fhirBase,
      clientId: 'demo-secret',
      auth: 'client_secret_basic',
      secretEnv: 'SMART_DOCTOR_DEMO_SECRET',
      scope: 'system/Patient.rs',
    },
    'demo-launch': { flow: 'launch', fhir: mock.fhirBase, clientId: 'demo-launch', auth: 'none', redirectUri: DEMO.redirects[0] },
    'demo-launch-paste': { flow: 'launch', fhir: mock.fhirBase, clientId: 'demo-launch', auth: 'none', redirectUri: DEMO.redirects[2] },
  };
  return { mock, profiles, pem, kid };
}
