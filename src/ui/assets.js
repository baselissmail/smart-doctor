// The local UI as three strings (HTML, CSS, JS) so it ships inside a single
// standalone binary with no build step. No third-party requests: fonts are
// served by the local server; strict CSP forbids everything else.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>smart-doctor</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <div class="brand">
    <span class="wordmark">smart-doctor</span>
    <span class="tagline">Why does this SMART on FHIR login fail?</span>
  </div>
  <div class="controls" id="controls">
    <label class="visually-hidden" for="profile">Profile</label>
    <select id="profile"></select>
    <button id="edit" class="quiet" type="button">Edit</button>
    <button id="new" class="quiet" type="button">New profile</button>
    <button id="run" class="primary" type="button">Run check</button>
  </div>
</header>

<main id="main">
  <section id="empty" class="empty" hidden>
    <h1>Start with a profile</h1>
    <p>A profile holds the FHIR server, client ID and how your app signs in. Keys are referenced by path and secrets by environment-variable name, so the profile file is safe to commit.</p>
    <p><button id="empty-new" class="primary" type="button">Create a profile</button></p>
    <p class="hint" id="empty-demo" hidden>Or run with <code>smart-doctor ui --demo</code> to practise against a built-in mock EHR.</p>
  </section>

  <section id="trace-wrap" class="trace-wrap" aria-label="Login steps">
    <svg id="trace" class="trace" role="img" aria-labelledby="trace-title" preserveAspectRatio="none">
      <title id="trace-title">Steps of the login, drawn as a rhythm strip</title>
    </svg>
    <ol id="beats" class="beats"></ol>
  </section>

  <section id="action" class="action" hidden aria-live="polite"></section>

  <div class="columns">
    <section class="findings" aria-live="polite">
      <p id="profile-line" class="profile-line"></p>
      <h1 id="verdict" class="verdict">Choose a profile and run a check.</h1>
      <p id="verdict-sub" class="verdict-sub"></p>
      <div id="causes"></div>
      <div id="tools" class="tools" hidden>
        <button id="copy" class="quiet" type="button">Copy report for a ticket</button>
        <span id="copied" class="copied" role="status"></span>
      </div>
      <details class="explain">
        <summary>Have an error message instead?</summary>
        <form id="explain-form">
          <label for="explain-text">Paste the error from your app or the server</label>
          <textarea id="explain-text" rows="3" spellcheck="false" placeholder='{"error":"invalid_client"}'></textarea>
          <button class="quiet" type="submit">Explain it</button>
        </form>
        <div id="explain-out"></div>
      </details>
    </section>

    <section class="results">
      <h2>Results</h2>
      <table id="results">
        <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
        <tbody></tbody>
      </table>
      <details id="http" class="http">
        <summary>Requests and responses <span id="http-count"></span></summary>
        <p class="hint">Keys, secrets, codes and tokens are masked inside the engine before anything is shown here.</p>
        <div id="http-list"></div>
      </details>
    </section>
  </div>
</main>

<dialog id="editor" aria-labelledby="editor-title">
  <form id="editor-form" method="dialog">
    <h2 id="editor-title">Profile</h2>
    <p class="hint">Saved to <code id="config-path"></code>. Nothing secret is stored.</p>

    <fieldset class="flow">
      <legend>What do you want to test?</legend>
      <label><input type="radio" name="flow" value="backend" checked> Backend service login <span class="hint">system-to-system</span></label>
      <label><input type="radio" name="flow" value="launch"> User sign-in <span class="hint">a person signs in at the EHR</span></label>
    </fieldset>

    <div class="field">
      <label for="f-fhir">FHIR base URL</label>
      <div class="inline">
        <input id="f-fhir" name="fhir" type="url" required placeholder="https://fhir.example.org/api/FHIR/R4" autocomplete="off" spellcheck="false">
        <button id="lookup" class="quiet" type="button">Look up</button>
      </div>
      <p id="lookup-out" class="lookup" aria-live="polite"></p>
    </div>
    <div class="field"><label for="f-clientId">Client ID for this environment</label><input id="f-clientId" name="clientId" required autocomplete="off" spellcheck="false"></div>
    <div class="field">
      <label for="f-auth">How the app authenticates</label>
      <select id="f-auth" name="auth">
        <option value="private_key_jwt">Private key (signed JWT)</option>
        <option value="client_secret_basic">Client secret (HTTP Basic)</option>
        <option value="client_secret_post">Client secret (form body)</option>
        <option value="none">Public app (PKCE only)</option>
      </select>
    </div>
    <div class="field when-key"><label for="f-key">Private key file path</label><input id="f-key" name="key" placeholder="./keys/private-key.pem" autocomplete="off" spellcheck="false"><p class="hint">Read locally to sign a test assertion. Never uploaded or copied.</p></div>
    <div class="field when-key"><label for="f-kid">Key ID (kid)</label><input id="f-kid" name="kid" autocomplete="off" spellcheck="false"></div>
    <div class="field when-key"><label for="f-jwksUrl">JWKS URL <span class="hint">optional</span></label><input id="f-jwksUrl" name="jwksUrl" type="url" autocomplete="off" spellcheck="false"></div>
    <div class="field when-secret"><label for="f-secretEnv">Environment variable that holds the secret</label><input id="f-secretEnv" name="secretEnv" placeholder="SMART_DOCTOR_CLIENT_SECRET" autocomplete="off" spellcheck="false"></div>
    <div class="field when-launch">
      <label for="f-redirectUri">Redirect URI, exactly as registered</label>
      <input id="f-redirectUri" name="redirectUri" placeholder="http://localhost:9876/callback" autocomplete="off" spellcheck="false">
      <p class="hint">localhost or 127.0.0.1: smart-doctor catches the redirect. Anything else: you paste the address you land on. No registration change needed.</p>
    </div>
    <div class="field"><label for="f-scope">Scopes</label><input id="f-scope" name="scope" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label for="f-name">Profile name</label><input id="f-name" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{0,63}" autocomplete="off" spellcheck="false"></div>
    <p id="editor-error" class="error" role="alert"></p>
    <div class="buttons">
      <button value="cancel" class="quiet" formnovalidate>Cancel</button>
      <button id="save" value="save" class="primary">Save profile</button>
    </div>
  </form>
</dialog>

<dialog id="secret-dialog" aria-labelledby="secret-title">
  <form id="secret-form" method="dialog">
    <h2 id="secret-title">Client secret needed</h2>
    <p id="secret-why"></p>
    <div class="field"><label for="secret-input">Client secret</label><input id="secret-input" type="password" autocomplete="off"></div>
    <p class="hint">Used for this run only. Kept in memory, never written anywhere.</p>
    <div class="buttons"><button value="cancel" class="quiet" formnovalidate>Cancel</button><button value="ok" class="primary">Run check</button></div>
  </form>
</dialog>

<script src="/app.js"></script>
</body>
</html>`;

export const APP_CSS = `
@font-face { font-family: "Atkinson Next"; src: url(/fonts/sans.woff2) format("woff2"); font-weight: 200 800; font-display: swap; }
@font-face { font-family: "Atkinson Mono"; src: url(/fonts/mono.woff2) format("woff2"); font-weight: 200 800; font-display: swap; }

:root {
  --paper: #f6f9f8;
  --surface: #ffffff;
  --ink: #16252d;
  --muted: #56696e;
  --grid: #d9e5e2;
  --grid-strong: #c3d4d0;
  --pass: #0b7a6b;
  --fail: #b5312a;
  --warn: #9a6510;
  --info: #3f6273;
  --pending: #9fb2b0;
  --focus: #1f5fbf;
  --sans: "Atkinson Next", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Atkinson Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --s-1: 0.8125rem; --s0: 1rem; --s1: 1.25rem; --s2: 1.5625rem; --s3: 1.953rem;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #12201f; --surface: #182a2a; --ink: #e2ecea; --muted: #9db1b0;
    --grid: #233836; --grid-strong: #2f4946; --pass: #45c2ae; --fail: #f07a6e; --warn: #e3a548; --info: #8fb4c6; --pending: #4c6461; --focus: #8ab4ff;
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 var(--s0)/1.55 var(--sans); }
code, .mono, input, textarea, select { font-family: var(--mono); font-size: 0.92em; }
button, select { font-family: var(--sans); }
h1, h2 { font-weight: 650; line-height: 1.2; margin: 0; }
a { color: var(--focus); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.hint { color: var(--muted); font-size: var(--s-1); }
[hidden] { display: none !important; }

/* ---------- bar ---------- */
.bar { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; justify-content: space-between; padding: 0.9rem clamp(1rem, 4vw, 2.5rem); border-bottom: 1px solid var(--grid-strong); background: var(--surface); }
.brand { display: flex; align-items: baseline; gap: 0.9rem; flex-wrap: wrap; }
.wordmark { font-weight: 750; font-size: var(--s1); letter-spacing: -0.01em; }
.tagline { color: var(--muted); font-size: var(--s-1); }
.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
select, input, textarea { color: var(--ink); background: var(--surface); border: 1px solid var(--grid-strong); border-radius: 4px; padding: 0.45rem 0.6rem; min-height: 2.5rem; }
#profile { min-width: 14rem; font-family: var(--sans); font-size: var(--s0); }
button { font-size: var(--s0); border-radius: 4px; padding: 0.5rem 0.95rem; min-height: 2.5rem; cursor: pointer; border: 1px solid var(--grid-strong); background: var(--surface); color: var(--ink); }
button.primary { background: var(--pass); border-color: var(--pass); color: #fff; font-weight: 650; }
button.quiet:hover, button.primary:hover { filter: brightness(0.95); }
button:disabled { opacity: 0.55; cursor: progress; }
@media (prefers-color-scheme: dark) { button.primary { color: #08201c; } }

main { padding: 0 clamp(1rem, 4vw, 2.5rem) 4rem; max-width: 1280px; margin: 0 auto; }

/* ---------- the rhythm strip ---------- */
.trace-wrap {
  margin: 1.75rem 0 0;
  border: 1px solid var(--grid-strong);
  border-radius: 6px;
  background-color: var(--surface);
  background-image:
    linear-gradient(var(--grid-strong) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-strong) 1px, transparent 1px),
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 40px 40px, 40px 40px, 8px 8px, 8px 8px;
  background-position: -1px -1px;
  overflow: hidden;
}
.trace { display: block; width: 100%; height: 132px; }
.trace .line { fill: none; stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; }
.trace .pass { stroke: var(--pass); }
.trace .warn { stroke: var(--warn); }
.trace .fail { stroke: var(--fail); stroke-width: 2.75; }
.trace .info, .trace .skip { stroke: var(--info); }
.trace .pending { stroke: var(--pending); stroke-dasharray: 2 5; }
.trace .flat { stroke: var(--fail); stroke-dasharray: 1 6; opacity: 0.8; }
.trace .draw { stroke-dasharray: var(--len); stroke-dashoffset: var(--len); animation: draw 700ms ease-out forwards; }
.trace .cursor { fill: var(--pass); animation: pulse 1.1s ease-in-out infinite; }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .trace .draw { animation: none; stroke-dashoffset: 0; stroke-dasharray: none; } .trace .cursor { animation: none; } }

.beats { list-style: none; margin: 0; padding: 0 0 0.75rem; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
.beats li { text-align: center; font-size: var(--s-1); color: var(--muted); padding: 0 0.25rem; line-height: 1.3; }
.beats li[data-status="fail"] { color: var(--fail); font-weight: 650; }
.beats li[data-status="warn"] { color: var(--warn); }
.beats li[data-status="pass"] { color: var(--ink); }
.beats li[data-status="running"] { color: var(--ink); font-weight: 650; }

/* ---------- human action (sign-in / paste) ---------- */
.action { margin-top: 1.25rem; border-left: 4px solid var(--focus); background: var(--surface); padding: 1rem 1.25rem; border-radius: 0 6px 6px 0; }
.action h2 { font-size: var(--s1); margin-bottom: 0.35rem; }
.action p { margin: 0.35rem 0; max-width: 70ch; }
.action .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
.action input { flex: 1 1 28rem; }
.action a.button { display: inline-flex; align-items: center; text-decoration: none; background: var(--focus); color: #fff; padding: 0.5rem 0.95rem; border-radius: 4px; font-weight: 650; min-height: 2.5rem; }
@media (prefers-color-scheme: dark) { .action a.button { color: #0b1a33; } }

/* ---------- findings + results ---------- */
.columns { display: grid; gap: 2.5rem; margin-top: 2rem; }
@media (min-width: 980px) { .columns { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); } }
.profile-line { color: var(--muted); font-size: var(--s-1); margin: 0 0 0.5rem; }
.verdict { font-size: var(--s3); letter-spacing: -0.015em; max-width: 22ch; }
.verdict[data-v="ok"] { color: var(--pass); }
.verdict[data-v="fail"] { color: var(--fail); }
.verdict[data-v="warn"] { color: var(--warn); }
.verdict-sub { color: var(--muted); max-width: 60ch; margin: 0.6rem 0 1.5rem; }
.causes h2, .results h2 { font-size: var(--s1); margin: 0 0 0.75rem; }
.causes ol { margin: 0; padding-left: 1.4rem; }
.causes li { margin: 0 0 1.25rem; padding-left: 0.25rem; }
.causes li::marker { font-weight: 700; color: var(--muted); }
.causes .title { font-weight: 650; }
.causes .likelihood { color: var(--muted); font-size: var(--s-1); margin-left: 0.4rem; }
.causes .why { margin: 0.2rem 0; max-width: 62ch; }
.causes .fix { margin: 0.2rem 0; max-width: 62ch; }
.causes .fix::before { content: "Fix: "; font-weight: 650; }
.causes .evidence { color: var(--muted); font-size: var(--s-1); margin: 0.2rem 0; overflow-wrap: anywhere; }
.tools { display: flex; gap: 0.75rem; align-items: center; margin: 0.5rem 0 1.5rem; }
.copied { color: var(--pass); font-size: var(--s-1); }

table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
thead th { text-align: left; font-weight: 650; color: var(--muted); font-size: var(--s-1); padding: 0 0.6rem 0.4rem 0; border-bottom: 2px solid var(--grid-strong); }
tbody tr.group th { text-align: left; font-weight: 700; padding: 1rem 0 0.3rem; border-bottom: 1px solid var(--grid-strong); }
tbody td { padding: 0.45rem 0.6rem 0.45rem 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.detail { color: var(--muted); overflow-wrap: anywhere; }
td.detail .fix { color: var(--ink); margin-top: 0.2rem; }
td.flag { white-space: nowrap; font-weight: 650; }
td.flag[data-s="pass"] { color: var(--pass); }
td.flag[data-s="fail"] { color: var(--fail); }
td.flag[data-s="warn"] { color: var(--warn); }
td.flag[data-s="info"], td.flag[data-s="skip"] { color: var(--muted); font-weight: 400; }

.http { margin-top: 2rem; }
.http summary, .explain summary { cursor: pointer; font-weight: 650; }
.http .x { border-top: 1px solid var(--grid); padding: 0.6rem 0; }
.http .x summary { font-weight: 400; font-family: var(--mono); font-size: 0.85rem; overflow-wrap: anywhere; }
.http pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 0.8rem/1.45 var(--mono); background: var(--paper); border: 1px solid var(--grid); padding: 0.6rem; border-radius: 4px; margin: 0.4rem 0; max-height: 24rem; overflow: auto; }
.st-ok { color: var(--pass); } .st-bad { color: var(--fail); } .st-mid { color: var(--warn); }

.explain { margin-top: 2rem; border-top: 1px solid var(--grid-strong); padding-top: 1rem; }
.explain form { display: grid; gap: 0.5rem; margin-top: 0.75rem; }
.explain textarea { width: 100%; }
.explain button { justify-self: start; }

.empty { margin: 4rem 0; max-width: 40rem; }
.empty h1 { font-size: var(--s3); margin-bottom: 0.75rem; }

/* ---------- dialogs ---------- */
dialog { border: 1px solid var(--grid-strong); border-radius: 8px; padding: 0; width: min(40rem, calc(100vw - 2rem)); background: var(--surface); color: var(--ink); }
dialog::backdrop { background: rgb(10 20 22 / 0.45); }
dialog form { padding: 1.5rem; display: grid; gap: 0.9rem; max-height: 85vh; overflow: auto; }
dialog h2 { font-size: var(--s2); }
fieldset { border: 1px solid var(--grid-strong); border-radius: 6px; padding: 0.6rem 0.9rem; margin: 0; }
fieldset label { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.3rem 0; }
input[type="radio"] { min-height: 0; padding: 0; margin: 0; accent-color: var(--pass); flex: none; }
.field { display: grid; gap: 0.3rem; }
.field label { font-weight: 650; }
.field input, .field select { width: 100%; }
.inline { display: flex; gap: 0.5rem; }
.inline input { flex: 1; }
.lookup { margin: 0; font-size: var(--s-1); color: var(--muted); }
.lookup.ok { color: var(--pass); }
.lookup.bad { color: var(--fail); }
.error { color: var(--fail); margin: 0; min-height: 1em; }
.buttons { display: flex; justify-content: flex-end; gap: 0.5rem; }
`;

export const APP_JS = `(() => {
'use strict';
const qs = new URLSearchParams(location.search);
let token = qs.get('t') || sessionStorage.getItem('sd-token') || '';
if (qs.get('t')) { sessionStorage.setItem('sd-token', token); history.replaceState(null, '', '/'); }

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-smart-doctor-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

// ---------------------------------------------------------------- planned steps
const PLAN = {
  backend: { key: [['key', 'Key'], ['discovery', 'Discovery'], ['clock', 'Clock'], ['jwks', 'JWKS'], ['assertion', 'Assertion'], ['token', 'Token']],
             secret: [['secret', 'Secret'], ['discovery', 'Discovery'], ['clock', 'Clock'], ['token', 'Token']] },
  launch: [['credentials', 'Credentials'], ['discovery', 'Discovery'], ['clock', 'Clock'], ['redirect', 'Redirect'], ['authorize', 'Sign-in'], ['token', 'Token'], ['context', 'Context'], ['refresh', 'Refresh'], ['probe', 'FHIR access']],
};
function planFor(p) {
  if (!p) return [];
  const flow = p.flow || (p.redirectUri ? 'launch' : 'backend');
  if (flow === 'launch') return PLAN.launch.map(([id, label]) => ({ id, label, status: 'pending' }));
  const secret = p.auth === 'client_secret_basic' || p.auth === 'client_secret_post';
  return PLAN.backend[secret ? 'secret' : 'key'].map(([id, label]) => ({ id, label, status: 'pending' }));
}

// ---------------------------------------------------------------- state
const state = { profiles: {}, secrets: {}, configPath: '', demo: false, selected: '', steps: [], drawn: new Set(), run: null, source: null };

// ---------------------------------------------------------------- rhythm strip
const SVGNS = 'http://www.w3.org/2000/svg';
function beatPath(x, y, amp) {
  // P wave, QRS complex, T wave — scaled by amp
  const a = amp;
  return [
    'M', x - 46, y, 'L', x - 34, y,
    'Q', x - 29, y - 7 * a, x - 24, y, 'L', x - 10, y,
    'L', x - 6, y + 6 * a, 'L', x - 1, y - 44 * a, 'L', x + 4, y + 16 * a, 'L', x + 8, y,
    'L', x + 16, y, 'Q', x + 24, y - 11 * a, x + 32, y, 'L', x + 46, y,
  ].join(' ');
}
function drawTrace() {
  const svg = $('trace');
  const w = svg.clientWidth || 900;
  const H = 132, y = 78;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + H);
  [...svg.querySelectorAll('path,circle')].forEach((n) => n.remove());
  const steps = state.steps;
  const n = Math.max(steps.length, 1);
  const slot = w / n;
  let flat = false;
  steps.forEach((s, i) => {
    const cx = slot * (i + 0.5);
    const left = slot * i, right = slot * (i + 1);
    const cls = flat ? 'pending' : s.status === 'running' ? 'pending' : s.status === 'pass' ? 'pass' : s.status === 'fail' ? 'fail' : s.status === 'warn' ? 'warn' : (s.status === 'info' || s.status === 'skip') ? 'info' : 'pending';
    let d;
    if (flat) d = 'M ' + left + ' ' + y + ' L ' + right + ' ' + y;
    else if (s.status === 'fail') d = 'M ' + left + ' ' + y + ' L ' + (cx - 30) + ' ' + y + ' L ' + (cx - 20) + ' ' + (y - 30) + ' L ' + (cx - 12) + ' ' + (y + 22) + ' L ' + (cx - 4) + ' ' + y + ' L ' + right + ' ' + y;
    else if (s.status === 'pending' || s.status === 'running') d = 'M ' + left + ' ' + y + ' L ' + right + ' ' + y;
    else d = 'M ' + left + ' ' + y + ' L ' + (cx - 46) + ' ' + y + ' ' + beatPath(cx, y, s.status === 'warn' ? 0.7 : (s.status === 'info' || s.status === 'skip') ? 0.35 : 1).slice(1) + ' L ' + right + ' ' + y;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'line ' + (flat ? 'flat' : cls));
    svg.append(p);
    const key = s.id + ':' + s.status;
    if (!flat && s.status !== 'pending' && s.status !== 'running' && !state.drawn.has(key)) {
      const len = Math.ceil(p.getTotalLength ? p.getTotalLength() : 400);
      p.style.setProperty('--len', len);
      p.classList.add('draw');
      state.drawn.add(key);
    }
    if (s.status === 'running') {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', y); c.setAttribute('r', 5); c.setAttribute('class', 'cursor');
      svg.append(c);
    }
    if (s.status === 'fail') flat = true;
  });
  const beats = $('beats');
  beats.replaceChildren(...steps.map((s) => h('li', { 'data-status': s.status, title: s.name || s.label }, s.label, h('span', { class: 'visually-hidden', text: ' — ' + statusWord(s.status) }))));
}
window.addEventListener('resize', () => drawTrace());

function statusWord(s) { return { pass: 'passed', fail: 'failed', warn: 'warning', info: 'info', skip: 'skipped', running: 'running', pending: 'not run yet' }[s] || s; }
const FLAG = { pass: 'Pass ✓', fail: 'Fail ✗', warn: 'Warn !', info: 'Info', skip: 'Skipped' };
const LABELS = Object.fromEntries([...PLAN.backend.key, ...PLAN.backend.secret, ...PLAN.launch]);

function upsertStep(s) {
  let i = state.steps.findIndex((x) => x.id === s.id);
  if (i < 0) {
    state.steps.push({ id: s.id, label: LABELS[s.id] || s.name, name: s.name, status: s.status || 'running' });
  } else Object.assign(state.steps[i], { name: s.name, status: s.status || 'running' });
  drawTrace();
}

// ---------------------------------------------------------------- results table
function renderStepRows(s) {
  const tbody = $('results').tBodies[0];
  tbody.querySelectorAll('[data-step="' + s.id + '"]').forEach((r) => r.remove());
  const rows = [h('tr', { class: 'group', 'data-step': s.id }, h('th', { colspan: 3, scope: 'colgroup' }, s.name))];
  for (const c of s.checks || []) {
    rows.push(h('tr', { 'data-step': s.id },
      h('td', {}, c.title),
      h('td', { class: 'flag', 'data-s': c.status }, FLAG[c.status] || c.status),
      h('td', { class: 'detail' }, c.detail || '', c.fix && (c.status === 'fail' || c.status === 'warn') ? h('div', { class: 'fix' }, 'Fix: ' + c.fix) : null)));
  }
  // keep execution order: insert before the first group of a later step
  const order = state.steps.map((x) => x.id);
  const later = [...tbody.querySelectorAll('tr.group')].find((g) => order.indexOf(g.dataset.step) > order.indexOf(s.id));
  rows.forEach((r) => tbody.insertBefore(r, later || null));
}

// ---------------------------------------------------------------- verdict + causes
const LIKELY = (x) => (x >= 0.8 ? 'very likely' : x >= 0.6 ? 'likely' : x >= 0.4 ? 'possible' : 'less likely');
function renderDone(r) {
  const v = r.diagnosis.verdict;
  const firstFail = (r.sections || []).find((s) => s.status === 'fail');
  const launch = r.flow === 'launch';
  const text = {
    ok: launch ? 'Sign-in and token exchange work.' : 'Login works — a token was issued.',
    warn: 'It works, with warnings.',
    offline: launch ? 'Sign-in was not completed.' : 'Local checks pass. No token was requested.',
    fail: firstFail ? 'The login breaks at ' + (LABELS[firstFail.id] || firstFail.name) + '.' : 'The login fails.',
  }[v];
  $('verdict').textContent = text;
  $('verdict').dataset.v = v;
  $('verdict-sub').textContent = v === 'fail' ? 'Servers keep these errors vague on purpose. Below is what the checks point to, most likely first.' : v === 'ok' ? 'Everything that can be checked from your side passed.' : '';
  const causes = r.diagnosis.causes.slice(0, 5);
  const box = $('causes');
  box.replaceChildren();
  if (causes.length) {
    box.append(h('div', { class: 'causes' },
      h('h2', {}, v === 'fail' ? 'Most likely causes' : 'Worth a look'),
      h('ol', {}, causes.map((c) => h('li', {},
        h('span', { class: 'title' }, c.title), h('span', { class: 'likelihood' }, LIKELY(c.confidence)),
        h('p', { class: 'why' }, c.why),
        c.evidence ? h('p', { class: 'evidence mono' }, c.evidence) : null,
        h('p', { class: 'fix' }, c.fix))))));
  }
  $('tools').hidden = false;
  $('action').hidden = true;
  setRunning(false);
}

// ---------------------------------------------------------------- http log
function renderHttp(x) {
  const list = $('http-list');
  const st = x.response && x.response.status;
  const cls = !st ? 'st-bad' : st >= 400 ? 'st-bad' : st >= 300 ? 'st-mid' : 'st-ok';
  const head = (x.method + ' ' + x.url);
  const reqText = Object.entries((x.request && x.request.headers) || {}).map(([k, v]) => k + ': ' + v).join('\\n') + (x.request && x.request.body ? '\\n\\n' + x.request.body : '');
  const resText = x.response && x.response.error ? 'Network error: ' + x.response.error : Object.entries(x.response.headers || {}).map(([k, v]) => k + ': ' + v).join('\\n') + (x.response.body ? '\\n\\n' + x.response.body : '');
  list.append(h('details', { class: 'x' },
    h('summary', {}, h('span', { class: cls }, st ? String(st) : 'ERR'), ' ', head, x.label ? ' (' + x.label + ')' : '', ' · ' + x.durationMs + ' ms'),
    h('pre', { 'aria-label': 'Request' }, reqText || '(no body)'),
    h('pre', { 'aria-label': 'Response' }, resText)));
  $('http-count').textContent = '(' + list.children.length + ')';
}

// ---------------------------------------------------------------- human actions (launch)
function renderAction(a, runId) {
  const box = $('action');
  if (a.type === 'open-url') {
    box.hidden = false;
    const paste = a.mode === 'paste';
    box.replaceChildren(...[
      h('h2', {}, 'Sign in at the EHR'),
      h('p', {}, 'Open the sign-in page, sign in, and approve the app.'),
      h('div', { class: 'row' },
        h('a', { class: 'button', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page'),
        h('button', { class: 'quiet', type: 'button', id: 'cancel-run' }, 'Cancel')),
      paste ? null : h('p', { class: 'hint' }, 'smart-doctor is listening on ' + (state.meta && state.meta.redirectUri) + ' and will continue on its own when the EHR sends you back.'),
    ].filter(Boolean));
    $('cancel-run').addEventListener('click', () => api('/api/runs/' + runId + '/cancel', {}).catch(() => {}));
  }
  if (a.type === 'await-paste') {
    box.hidden = false;
    const form = h('form', { id: 'paste-form' },
      h('p', {}, 'After signing in, your browser lands on ', h('code', {}, a.redirectUri), '. It may show an error page — that is fine. Copy the full address from the address bar and paste it here.'),
      h('div', { class: 'row' },
        h('label', { class: 'visually-hidden', for: 'paste-url' }, 'Address you landed on'),
        h('input', { id: 'paste-url', type: 'url', required: true, placeholder: a.redirectUri + '?code=…&state=…', autocomplete: 'off', spellcheck: 'false' }),
        h('button', { class: 'primary', type: 'submit' }, 'Continue')));
    box.append(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.querySelector('button').disabled = true;
      await api('/api/runs/' + runId + '/paste', { url: $('paste-url').value }).catch((err) => alertInline(err.message));
    });
    setTimeout(() => $('paste-url') && $('paste-url').focus(), 50);
  }
}
function alertInline(msg) { $('verdict-sub').textContent = msg; }

// ---------------------------------------------------------------- running a check
function setRunning(on) {
  $('run').disabled = on;
  $('run').textContent = on ? 'Running…' : 'Run check';
  $('profile').disabled = on;
}
function resetView(p) {
  state.steps = planFor(p);
  state.drawn = new Set();
  $('results').tBodies[0].replaceChildren();
  $('http-list').replaceChildren();
  $('http-count').textContent = '';
  $('causes').replaceChildren();
  $('tools').hidden = true;
  $('copied').textContent = '';
  $('action').hidden = true;
  $('action').replaceChildren();
  drawTrace();
}
async function startRun(secret) {
  const name = state.selected;
  const p = state.profiles[name];
  if (!p) return;
  const sec = state.secrets[name];
  if (sec && !sec.set && secret === undefined) return askSecret(sec);
  resetView(p);
  setRunning(true);
  $('verdict').textContent = 'Checking…';
  $('verdict').dataset.v = '';
  $('verdict-sub').textContent = '';
  try {
    const { runId } = await api('/api/runs', { profile: name, secret });
    state.run = runId;
    if (state.source) state.source.close();
    const src = new EventSource('/api/runs/' + runId + '/events?t=' + encodeURIComponent(token));
    state.source = src;
    const on = (ev, fn) => src.addEventListener(ev, (e) => fn(JSON.parse(e.data)));
    on('meta', (m) => { state.meta = m; });
    on('step:start', (s) => upsertStep({ ...s, status: 'running' }));
    on('step:end', (s) => { upsertStep(s); renderStepRows(s); });
    on('step:update', (s) => { upsertStep(s); renderStepRows(s); });
    on('http', renderHttp);
    on('action', (a) => { renderAction(a, runId); if (a.type === 'open-url') $('verdict').textContent = 'Waiting for you to sign in…'; });
    on('done', (r) => {
      // steps that never ran stay grey
      state.steps = state.steps.filter((s) => s.status !== 'pending' || (r.sections || []).every((x) => x.id !== s.id));
      drawTrace();
      renderDone(r);
    });
    on('run-error', (e) => { $('verdict').textContent = 'smart-doctor could not run this profile.'; $('verdict-sub').textContent = e.message; $('verdict').dataset.v = 'fail'; setRunning(false); });
    on('end', () => { src.close(); setRunning(false); });
    // The connection itself failed (smart-doctor stopped, laptop slept): say so instead of waiting forever.
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED || state.source !== src) return;
      src.close();
      $('verdict').textContent = 'Lost the connection to smart-doctor.';
      $('verdict-sub').textContent = 'Is it still running in your terminal? Start it again and re-run the check.';
      $('verdict').dataset.v = 'fail';
      setRunning(false);
    };
  } catch (e) {
    $('verdict').textContent = 'smart-doctor could not start the check.';
    $('verdict-sub').textContent = e.message;
    setRunning(false);
  }
}
function askSecret(sec) {
  $('secret-why').textContent = 'This profile reads the secret from ' + sec.env + ', which is not set where smart-doctor is running. Enter it here for this run, or set the variable and restart.';
  $('secret-input').value = '';
  $('secret-dialog').showModal();
}
$('secret-form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'ok') { const v = $('secret-input').value; $('secret-input').value = ''; startRun(v); }
});

$('copy').addEventListener('click', async () => {
  if (!state.run) return;
  const md = await api('/api/runs/' + state.run + '/report');
  try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied. Client ID, patient IDs and secrets are masked.'; }
  catch { $('copied').textContent = 'Copy failed — your browser blocked clipboard access.'; }
});

// ---------------------------------------------------------------- profiles
function fillSelect() {
  const sel = $('profile');
  const names = Object.keys(state.profiles);
  sel.replaceChildren(...names.map((n) => h('option', { value: n }, n + (state.profiles[n].source === 'demo' ? ' (practice EHR)' : ''))));
  if (!names.includes(state.selected)) state.selected = names[0] || '';
  sel.value = state.selected;
  const empty = names.length === 0;
  $('empty').hidden = !empty;
  $('empty-demo').hidden = state.demo;
  document.querySelector('.columns').hidden = empty;
  $('trace-wrap').hidden = empty;
  $('run').hidden = empty;
  $('edit').hidden = empty;
  $('profile').hidden = empty;
  showProfileLine();
}
function showProfileLine() {
  const p = state.profiles[state.selected];
  if (!p) return;
  const flow = (p.flow || 'backend') === 'launch' ? 'User sign-in' : 'Backend service';
  $('profile-line').textContent = flow + ' · ' + (p.fhir || 'no FHIR URL') + ' · client ' + (p.clientId || '?');
  if (!state.run) { resetView(p); }
}
$('profile').addEventListener('change', (e) => { state.selected = e.target.value; state.run = null; showProfileLine(); $('verdict').textContent = 'Ready when you are.'; $('verdict').dataset.v = ''; $('verdict-sub').textContent = ''; });
$('run').addEventListener('click', () => startRun());

const F = (n) => $('f-' + n);
function syncEditor() {
  const flow = document.querySelector('input[name=flow]:checked').value;
  const auth = F('auth').value;
  document.querySelectorAll('.when-key').forEach((el) => (el.hidden = auth !== 'private_key_jwt'));
  document.querySelectorAll('.when-secret').forEach((el) => (el.hidden = !auth.startsWith('client_secret')));
  document.querySelectorAll('.when-launch').forEach((el) => (el.hidden = flow !== 'launch'));
  F('auth').querySelector('option[value=none]').disabled = flow !== 'launch';
  if (flow !== 'launch' && auth === 'none') F('auth').value = 'private_key_jwt';
  if (!F('scope').dataset.touched) F('scope').value = flow === 'launch' ? 'launch/patient openid fhirUser offline_access patient/*.rs' : 'system/Patient.rs';
}
document.querySelectorAll('input[name=flow]').forEach((r) => r.addEventListener('change', syncEditor));
F('auth').addEventListener('change', syncEditor);
F('scope').addEventListener('input', () => (F('scope').dataset.touched = '1'));

function openEditor(name) {
  const p = name ? state.profiles[name] : {};
  $('editor-error').textContent = '';
  $('lookup-out').textContent = '';
  $('config-path').textContent = state.configPath;
  document.querySelector('input[name=flow][value=' + (p.flow || 'backend') + ']').checked = true;
  for (const k of ['fhir', 'clientId', 'key', 'kid', 'jwksUrl', 'secretEnv', 'redirectUri', 'scope']) F(k).value = p[k] || '';
  F('auth').value = p.auth || (p.key ? 'private_key_jwt' : (p.flow === 'launch' ? 'none' : 'private_key_jwt'));
  F('scope').dataset.touched = p.scope ? '1' : '';
  F('name').value = name && p.source !== 'demo' ? name : '';
  syncEditor();
  if (p.scope) F('scope').value = p.scope;
  $('editor').showModal();
}
$('new').addEventListener('click', () => openEditor());
$('empty-new').addEventListener('click', () => openEditor());
$('edit').addEventListener('click', () => openEditor(state.selected));

$('lookup').addEventListener('click', async () => {
  const out = $('lookup-out');
  out.className = 'lookup';
  out.textContent = 'Looking it up…';
  try {
    const flow = document.querySelector('input[name=flow]:checked').value;
    const d = await api('/api/discover', { fhir: F('fhir').value, flow });
    if (!d.ok) { out.className = 'lookup bad'; out.textContent = d.problem || 'No SMART configuration found at this URL.'; return; }
    out.className = 'lookup ok';
    out.textContent = 'Found ' + (d.vendor || 'a SMART server') + '. Token endpoint ' + d.tokenUrl + (d.authMethods ? '. Accepts: ' + d.authMethods.join(', ') : '') + '.';
    if (!F('name').value) { try { F('name').value = new URL(F('fhir').value).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + flow; } catch {} }
  } catch (e) { out.className = 'lookup bad'; out.textContent = e.message; }
});

$('editor-form').addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'save') return;
  e.preventDefault();
  const flow = document.querySelector('input[name=flow]:checked').value;
  const auth = F('auth').value;
  const profile = { flow, fhir: F('fhir').value.trim(), clientId: F('clientId').value.trim(), auth, scope: F('scope').value.trim() };
  if (auth === 'private_key_jwt') Object.assign(profile, { key: F('key').value.trim(), kid: F('kid').value.trim(), jwksUrl: F('jwksUrl').value.trim() });
  if (auth.startsWith('client_secret')) profile.secretEnv = F('secretEnv').value.trim() || undefined;
  if (flow === 'launch') profile.redirectUri = F('redirectUri').value.trim();
  for (const k of Object.keys(profile)) if (!profile[k]) delete profile[k];
  const name = F('name').value.trim();
  try {
    const r = await api('/api/profiles', { name, profile });
    $('editor').close();
    await loadState(name);
    if (r.warnings && r.warnings.length) $('verdict-sub').textContent = r.warnings.join(' ');
  } catch (err) { $('editor-error').textContent = err.message; }
});

// ---------------------------------------------------------------- explain
$('explain-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = state.profiles[state.selected] || {};
  const d = await api('/api/explain', { text: $('explain-text').value, url: p.fhir });
  const out = $('explain-out');
  out.replaceChildren(d.causes.length
    ? h('div', { class: 'causes' }, h('ol', {}, d.causes.slice(0, 5).map((c) => h('li', {}, h('span', { class: 'title' }, c.title), h('span', { class: 'likelihood' }, LIKELY(c.confidence)), h('p', { class: 'why' }, c.why), h('p', { class: 'fix' }, c.fix)))))
    : h('p', { class: 'hint' }, 'No known pattern matched. Run a full check for a definitive answer.'));
});

// ---------------------------------------------------------------- boot
async function loadState(select) {
  const s = await api('/api/state');
  Object.assign(state, { profiles: s.profiles, secrets: s.secrets, configPath: s.configPath, demo: s.demo });
  if (select) state.selected = select;
  fillSelect();
}
loadState().catch((e) => { $('verdict').textContent = 'This page needs the session link printed by smart-doctor ui.'; $('verdict-sub').textContent = e.message; });
})();`;
