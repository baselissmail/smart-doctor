// UI server: security rules and full runs over its HTTP API (no browser needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startUi } from '../src/ui/server.js';
import { tmp } from './helpers.js';
import { fakeBrowser } from './fake-browser.js';

async function withUi(fn) {
  const dir = await tmp();
  const ui = await startUi({ configPath: path.join(dir, 'smart-doctor.yaml'), demo: true });
  try {
    await fn(ui, dir);
  } finally {
    await ui.close();
  }
}
const api = (ui, p, body, token = ui.token) =>
  fetch(ui.baseUrl + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-smart-doctor-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Collect SSE events until "end"; `onEvent` may react (e.g. paste). */
async function events(ui, runId, onEvent = () => {}) {
  const res = await fetch(`${ui.baseUrl}/api/runs/${runId}/events?t=${ui.token}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const out = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (!ev) continue;
      const parsed = JSON.parse(data);
      out.push({ ev, data: parsed });
      await onEvent(ev, parsed);
      if (ev === 'end') {
        reader.cancel();
        return out;
      }
    }
  }
  return out;
}

test('page is served with a strict CSP; API needs the session token', async () => {
  await withUi(async (ui) => {
    const page = await fetch(ui.baseUrl + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await api(ui, '/api/state', null, 'wrong')).status, 401);
    assert.equal((await api(ui, '/api/state')).status, 200);
  });
});

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  await withUi(async (ui) => {
    const { port } = new URL(ui.baseUrl);
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example:' + port } }, (r) => resolve(r.statusCode));
    });
    assert.equal(status, 403);
  });
});

test('state lists demo profiles; saving a profile with a secret is refused', async () => {
  await withUi(async (ui) => {
    const s = await (await api(ui, '/api/state')).json();
    assert.ok(s.profiles['demo-backend']);
    assert.equal(s.secrets['demo-secret'].set, true);
    const bad = await api(ui, '/api/profiles', { name: 'x', profile: { fhir: 'https://a/fhir', clientSecret: 'oops' } });
    assert.equal(bad.status, 400);
    const good = await api(ui, '/api/profiles', {
      name: 'mine',
      profile: { flow: 'backend', fhir: 'https://a/fhir', clientId: 'c', key: './nope.pem' },
    });
    assert.equal(good.status, 200);
    const body = await good.json();
    assert.ok(body.profiles.mine);
    assert.match(body.warnings[0], /No key file/);
  });
});

test('backend run streams steps and finishes ok', async () => {
  await withUi(async (ui) => {
    const { runId } = await (await api(ui, '/api/runs', { profile: 'demo-backend' })).json();
    const evs = await events(ui, runId);
    const names = evs.map((e) => e.ev);
    assert.ok(names.includes('step:start'));
    assert.ok(names.includes('http'));
    const done = evs.find((e) => e.ev === 'done').data;
    assert.equal(done.diagnosis.verdict, 'ok');
    assert.ok(!JSON.stringify(evs).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/), 'no JWT in the stream');
    const report = await (await api(ui, `/api/runs/${runId}/report`)).text();
    assert.match(report, /## smart-doctor report/);
  });
});

test('the event stream closes after the run ends, so a reconnect does not hang or replay twice', async () => {
  await withUi(async (ui) => {
    const { runId } = await (await api(ui, '/api/runs', { profile: 'demo-backend' })).json();
    await events(ui, runId);
    // Reconnect after the run is over: the server replays the log once and closes the stream.
    const res = await fetch(`${ui.baseUrl}/api/runs/${runId}/events?t=${ui.token}`);
    const text = await Promise.race([res.text(), new Promise((_, no) => setTimeout(() => no(new Error('stream stayed open')), 3000))]);
    assert.equal(text.match(/^event: end$/gm)?.length, 1);
    assert.ok(!/^event: error$/m.test(text), "run failures use 'run-error', never EventSource's own 'error'");
  });
});

test('secret supplied in the page is used for one run only', async () => {
  await withUi(async (ui) => {
    // demo-secret normally reads SMART_DOCTOR_DEMO_SECRET; a wrong in-memory secret must override it and fail
    const { runId } = await (await api(ui, '/api/runs', { profile: 'demo-secret', secret: 'wrong' })).json();
    const done = (await events(ui, runId)).find((e) => e.ev === 'done').data;
    assert.equal(done.diagnosis.verdict, 'fail');
    assert.equal(done.diagnosis.causes[0].id, 'secret_invalid');
  });
});

test('launch with paste-back through the UI API', async () => {
  await withUi(async (ui) => {
    const { runId } = await (await api(ui, '/api/runs', { profile: 'demo-launch-paste' })).json();
    const evs = await events(ui, runId, async (ev, data) => {
      if (ev === 'action' && data.type === 'open-url') {
        // a "person" signs in; the company redirect page is not reachable, they copy the URL
        const b = fakeBrowser({ redirectUri: 'https://app.example.com/smart/callback', deliver: false });
        await b.open(data.url);
        const landed = await b.landed;
        // wait until the run is ready for the paste
        for (let i = 0; i < 50; i++) {
          const r = await api(ui, `/api/runs/${runId}/paste`, { url: landed });
          if (r.status === 200) break;
          await new Promise((res) => setTimeout(res, 20));
        }
      }
    });
    const done = evs.find((e) => e.ev === 'done').data;
    assert.equal(done.diagnosis.verdict, 'ok', JSON.stringify(done.diagnosis.causes));
  });
});

test('a waiting launch can be cancelled', async () => {
  await withUi(async (ui) => {
    const { runId } = await (await api(ui, '/api/runs', { profile: 'demo-launch-paste' })).json();
    const evs = await events(ui, runId, async (ev, data) => {
      if (ev === 'action' && data.type === 'await-paste') await api(ui, `/api/runs/${runId}/cancel`, {});
    });
    const done = evs.find((e) => e.ev === 'done').data;
    assert.notEqual(done.diagnosis.verdict, 'ok');
    const signin = done.sections.find((s) => s.id === 'authorize');
    assert.match(signin.checks.at(-1).detail, /Cancelled/);
  });
});
