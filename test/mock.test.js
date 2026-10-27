// The mock must behave like a strict real server, otherwise the end-to-end
// tests prove nothing. These tests post hand-built assertions directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from '../src/mock/server.js';
import { loadKey } from '../src/keys.js';
import { buildAssertion } from '../src/assertion.js';
import { CLIENT_ASSERTION_TYPE } from '../src/token.js';
import { makeKey, CLIENT_ID } from './helpers.js';

async function setup(opts = {}) {
  const key = await makeKey();
  const k = await loadKey({ keyPath: key.pemPath, kid: key.kid });
  const mock = await startMock({ clients: [{ clientId: CLIENT_ID, jwksFile: key.jwksPath }], verboseErrors: true, ...opts });
  const post = async (assertion, extra = {}) => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
      ...extra,
    });
    const r = await fetch(mock.tokenUrl, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { status: r.status, json: await r.json() };
  };
  const make = (o = {}) =>
    buildAssertion({ clientId: CLIENT_ID, tokenUrl: mock.tokenUrl, keyObject: k.keyObject, alg: k.alg, kid: k.kid, ...o });
  return { mock, post, make };
}

test('mock accepts a valid assertion once and rejects jti replay', async () => {
  const { mock, post, make } = await setup();
  try {
    const { jwt } = await make();
    assert.equal((await post(jwt)).status, 200);
    const again = await post(jwt);
    assert.equal(again.status, 401);
    assert.match(again.json.error_description, /jti/);
  } finally {
    await mock.close();
  }
});

test('mock rejects lifetimes over 5 minutes', async () => {
  const { mock, post, make } = await setup();
  try {
    const { jwt } = await make({ lifetimeSeconds: 900 });
    const r = await post(jwt);
    assert.equal(r.status, 401);
    assert.match(r.json.error_description, /5 minutes/);
  } finally {
    await mock.close();
  }
});

test('mock rejects expired assertions', async () => {
  const { mock, post, make } = await setup();
  try {
    const { jwt } = await make({ now: Math.floor(Date.now() / 1000) - 1000 });
    const r = await post(jwt);
    assert.equal(r.status, 401);
    assert.match(r.json.error_description, /expired/i);
  } finally {
    await mock.close();
  }
});

test('mock rejects wrong grant type and wrong aud', async () => {
  const { mock, post, make } = await setup();
  try {
    const { jwt } = await make();
    assert.equal((await post(jwt, { grant_type: 'password' })).json.error, 'unsupported_grant_type');
    const { jwt: badAud } = await make({ tokenUrl: mock.tokenUrl + '/' });
    const r = await post(badAud);
    assert.equal(r.json.error, 'invalid_client');
    assert.match(r.json.error_description, /audience/i);
  } finally {
    await mock.close();
  }
});

test('mock is vague by default (like real servers)', async () => {
  const { mock, post, make } = await setup({ verboseErrors: false });
  try {
    const { jwt } = await make({ tokenUrl: mock.tokenUrl + '/' });
    const r = await post(jwt);
    assert.deepEqual(r.json, { error: 'invalid_client' });
  } finally {
    await mock.close();
  }
});

test('unknown mode is rejected', async () => {
  await assert.rejects(startMock({ modes: ['nope'] }), /Unknown mock mode/);
});
