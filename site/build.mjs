#!/usr/bin/env node
// Builds the website from the knowledge files, so the error catalogue can never drift from
// what smart-doctor actually says. No dependencies, no framework.
//
//   node site/build.mjs            → site/dist
//   node site/build.mjs --serve    → build, then serve on http://localhost:4400/smart-doctor/

import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSES, STAGES } from '../src/knowledge/causes.js';
import { TEXT_PATTERNS, ERROR_ALIASES, ERROR_CODES } from '../src/knowledge/errors.js';
import { SEEN } from '../src/knowledge/seen.js';
import { VENDORS } from '../src/vendors/index.js';
import { MODES } from '../src/mock/server.js';
import { VERSION } from '../src/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const SITE = pkg.homepage.replace(/\/?$/, '/'); // https://<user>.github.io/smart-doctor/
const REPO = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const BASE_PATH = new URL(SITE).pathname; // /smart-doctor/
// How many deliberate breakages scripts/sandbox-smoke.mjs checks against the public SMART launcher.
const SANDBOX_SCENARIOS = (readFileSync(path.join(HERE, '../scripts/sandbox-smoke.mjs'), 'utf8').match(/^\s+\['(Sign-in|Backend):/gm) || [])
  .length;

// ---------------------------------------------------------------- helpers
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** Inline `code` in knowledge texts → <code>. Everything else escaped. */
const prose = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\b(--[a-z][a-z-]+)/g, '<code>$1</code>');
const causeUrl = (id) => `errors/${id.replace(/_/g, '-')}/`;
const stageOf = (id) => STAGES.find((s) => s.id === id);
let copyId = 0;
const cmd = (text) => {
  const id = `c${++copyId}`;
  return `<div class="cmd"><code id="${id}">${esc(text)}</code><button class="copy" type="button" data-copy="${id}" hidden>Copy</button></div>`;
};

// ---------------------------------------------------------------- the trace (same drawing as the tool's rhythm strip)
function beatPath(x, y, a = 1) {
  return `L ${x - 34} ${y} Q ${x - 29} ${y - 7 * a} ${x - 24} ${y} L ${x - 10} ${y} L ${x - 6} ${y + 6 * a} L ${x - 1} ${y - 44 * a} L ${x + 4} ${y + 16 * a} L ${x + 8} ${y} L ${x + 16} ${y} Q ${x + 24} ${y - 11 * a} ${x + 32} ${y} L ${x + 46} ${y}`;
}

/** @param {{ label: string, status: string }[]} steps  status: pass | skip | fail */
function trace(steps) {
  const W = 960;
  const H = 128;
  const y = 80;
  const slot = W / steps.length;
  let flat = false;
  let cursor = '';
  const paths = steps.map((s, i) => {
    const left = slot * i;
    const right = slot * (i + 1);
    const cx = slot * (i + 0.5);
    if (flat) return `<path class="line flat" d="M ${left} ${y} L ${right} ${y}"/>`;
    if (s.status === 'fail') {
      flat = true;
      cursor = `<circle class="cursor" cx="${cx + 26}" cy="${y}" r="5"/>`;
      return `<path class="line fail" d="M ${left} ${y} L ${cx - 30} ${y} L ${cx - 20} ${y - 32} L ${cx - 12} ${y + 24} L ${cx - 4} ${y} L ${right} ${y}"/>`;
    }
    const amp = s.status === 'skip' ? 0.35 : 1;
    return `<path class="line ${s.status}" d="M ${left} ${y} L ${cx - 46} ${y} ${beatPath(cx, y, amp)} L ${right} ${y}"/>`;
  });
  const passed = steps.filter((s) => s.status === 'pass').map((s) => s.label);
  const failed = steps.find((s) => s.status === 'fail');
  const desc = `Heartbeat trace of one login: ${passed.join(', ')} pass; ${failed ? `${failed.label} fails and the trace flatlines` : 'every step passes'}.`;
  return `<svg class="trace" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">${paths.join('')}${cursor}</svg>`;
}

/**
 * The bedside monitor: a real run's steps, its readings, and the diagnosis.
 * @param {{ steps: { label: string, status: string }[], vitals: { k: string, v: string, u: string, status: string }[],
 *   alarm?: { likelihood: string, title: string, fix: string }, bar: string, who: string }} o
 */
function monitor({ steps, vitals, alarm, bar, who }) {
  let after = false;
  const stepItems = steps
    .map((s) => {
      const st = after ? 'flat' : s.status;
      if (s.status === 'fail') after = true;
      const mark = { pass: '✔', skip: '–', fail: '✖', flat: '·' }[st];
      const word = { pass: 'passed', skip: 'skipped', fail: 'failed', flat: 'not reached' }[st];
      return `<li data-s="${st}"><span class="st" aria-hidden="true">${mark}</span>${esc(s.label)}<span class="visually-hidden"> ${word}</span></li>`;
    })
    .join('');
  const vitalItems = vitals
    .map(
      (v) =>
        `<li data-s="${v.status}"><span class="k">${esc(v.k)}</span><span class="v">${esc(v.v)}</span><span class="u">${esc(v.u)}</span></li>`,
    )
    .join('');
  return `<figure class="monitor" aria-label="${esc(bar)}">
<div class="mon-bar"><span class="live">Alarm</span><span>${esc(bar)}</span><span class="who">${esc(who)}</span></div>
<div class="mon-body">
<div class="mon-screen"><div class="mon-trace">${trace(steps)}<div class="sweep" aria-hidden="true"></div></div><ol class="mon-steps">${stepItems}</ol></div>
<ul class="vitals" data-n="${vitals.length}" aria-label="Readings">${vitalItems}</ul>
</div>
${
  alarm
    ? `<div class="mon-alarm"><span class="dx">Most likely cause · ${esc(alarm.likelihood)}</span><span class="t">${esc(alarm.title)}</span><span class="fix">${esc(alarm.fix)}</span></div>`
    : ''
}
</figure>`;
}

// ---------------------------------------------------------------- icons (inline, no requests)
const ICON = {
  github:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  theme:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g class="sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g><g class="moon"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></g><g class="auto"><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></g></svg>',
  pulse: '<svg viewBox="0 0 30 18" aria-hidden="true"><path d="M1 11 H9 L11.5 4 L14.5 16 L16.5 11 H29"/></svg>',
};

// ---------------------------------------------------------------- page shell
/**
 * @param {{ depth: number, url: string, title: string, description: string, body: string, nav?: string, jsonld?: string, root?: string }} o
 *   root: link prefix override (the 404 page uses absolute links)
 */
function shell({ depth, url, title, description, body, nav = '', jsonld = '', root }) {
  const r = root ?? '../'.repeat(depth);
  const home = r || './';
  const links = [
    ['errors/', 'Error catalogue', 'errors'],
    ['vendors/', 'Vendor notes', 'vendors'],
    [`${REPO}#readme`, 'Docs', 'docs'],
  ];
  const link = ([href, label, key]) =>
    `<a href="${/^https?:/.test(href) ? href : r + href}"${nav === key ? ' aria-current="page"' : ''}>${label}</a>`;
  const fullTitle = title === 'smart-doctor' ? 'smart-doctor · Why does this SMART on FHIR login fail?' : `${title} · smart-doctor`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${url}">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#142423">
<meta property="og:type" content="website">
<meta property="og:site_name" content="smart-doctor">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${url}">
<meta property="og:image" content="${SITE}assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${r}favicon.svg" type="image/svg+xml">
<link rel="preload" href="${r}assets/fonts/sans.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${r}assets/site.css">
<script src="${r}assets/theme.js"></script>
<script src="${r}assets/site.js" defer></script>${jsonld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
<a class="brand" href="${home}" aria-label="smart-doctor home"><span class="mark">${ICON.pulse}</span>smart-doctor <span class="version">v${esc(VERSION)}</span></a>
<nav class="nav" aria-label="Main">${links.map(link).join('')}</nav>
<a class="gh" href="${REPO}">${ICON.github}GitHub</a>
<button class="icon-btn theme" id="theme" type="button" data-mode="auto" aria-label="Colour theme: automatic" hidden>${ICON.theme}</button>
<details class="menu"><summary class="icon-btn" aria-label="Menu">${ICON.menu}</summary><nav class="menu-panel" aria-label="Main">${links
    .map(link)
    .join('')}<a href="${REPO}">GitHub</a></nav></details>
</div></header>
<main id="main">
${body}
</main>
<footer class="foot"><div class="wrap">
<div class="foot-brand">
<a class="brand" href="${home}"><span class="mark">${ICON.pulse}</span>smart-doctor</a>
<p>Finds out why a SMART on FHIR login fails, on your machine, with your keys never leaving it. Open source under the MIT license.</p>
</div>
<nav aria-label="Product"><h2>Product</h2><ul>
<li><a href="${r}errors/">Error catalogue</a></li>
<li><a href="${r}vendors/">Vendor notes</a></li>
<li><a href="${REPO}/releases">Releases and binaries</a></li>
<li><a href="https://www.npmjs.com/package/smart-doctor">npm package</a></li>
</ul></nav>
<nav aria-label="Community"><h2>Community</h2><ul>
<li><a href="${REPO}/blob/main/CONTRIBUTING.md">Contributing</a></li>
<li><a href="${REPO}/discussions">Discussions</a></li>
<li><a href="${REPO}/blob/main/CODE_OF_CONDUCT.md">Code of conduct</a></li>
<li><a href="${REPO}/blob/main/SECURITY.md">Security policy</a></li>
</ul></nav>
<p class="fine">smart-doctor ${esc(VERSION)} is a diagnostic aid, not a conformance test; for certification use <a href="https://inferno.healthit.gov/">Inferno</a>. It is not affiliated with HL7, SMART Health IT or any EHR vendor; vendor names are trademarks of their owners.</p>
</div></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- landing
/** The real run shown on the monitor: the public SMART launcher, a client assertion signed with a mistyped kid. */
const REAL_RUN = {
  bar: 'Backend services · private_key_jwt',
  who: 'launch.smarthealthit.org',
  steps: [
    { label: 'Key', status: 'pass' },
    { label: 'Discovery', status: 'pass' },
    { label: 'Clock', status: 'pass' },
    { label: 'JWKS', status: 'skip' },
    { label: 'Assertion', status: 'pass' },
    { label: 'Token', status: 'fail' },
    { label: 'FHIR', status: 'pass' },
  ],
  vitals: [
    { k: 'Discovery', v: '596', u: 'ms · SMART config', status: 'pass' },
    { k: 'Clock', v: '−1', u: 's skew', status: 'pass' },
    { k: 'Assertion', v: '240', u: 's until exp · ES384', status: 'pass' },
    { k: 'Token', v: '401', u: 'invalid_client', status: 'fail' },
  ],
};

function landing() {
  const k = CAUSES.kid_unknown;
  const guesses = [
    ['aud_mismatch', 'aud is not exactly the token endpoint'],
    ['kid_unknown', 'kid not in the published JWKS'],
    ['clock_skew', 'your clock and the server’s disagree'],
    ['client_unknown', 'client ID from another environment'],
    ['secret_method_required', 'secret sent the way the server rejects'],
    ['jwks_fetch', 'the server cannot fetch your JWKS'],
  ];
  const ruledOut = ['ES384 key loads, kid set', 'aud = token endpoint', 'iss = sub = client_id', 'exp 240 s, jti unique', 'clock −1 s'];
  const patterns = TEXT_PATTERNS.length + Object.keys(ERROR_ALIASES).length;
  const jsonld = `\n<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'smart-doctor',
    description: pkg.description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    softwareVersion: VERSION,
    license: 'https://opensource.org/licenses/MIT',
    url: SITE,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  })}</script>`;

  const body = `
<section class="hero" aria-labelledby="hero-title"><div class="wrap">
<div class="hero-copy">
<p class="eyebrow">Open source · runs on your machine</p>
<h1 id="hero-title">Why does this SMART on FHIR login <span class="flat">fail?<svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 7 H44 L50 1 L57 11 L62 7 H100"/></svg></span></h1>
<p class="lede">EHRs answer almost every client problem with the same <code>invalid_client</code>. smart-doctor checks everything you can check from your side, runs the real login once, and ranks the likely causes in plain English.</p>
<div class="actions">${cmd('npx smart-doctor init')}<a class="button" href="errors/">Look up an error ${ICON.arrow}</a></div>
<ul class="trust"><li>Keys and secrets stay local</li><li>No account, no telemetry</li><li>Backend services and user sign-in</li></ul>
</div>
<div>
${monitor({ ...REAL_RUN, alarm: { likelihood: 'very likely', title: k.title, fix: k.fix } })}
<p class="mon-caption">A real run against the public SMART launcher, with a mistyped <code>kid</code>.</p>
</div>
</div></section>

<section class="section" aria-labelledby="complaint"><div class="wrap">
<div class="section-head"><p class="eyebrow">Complaint</p><h2 id="complaint">One error, dozens of causes</h2>
<p>Servers say as little as possible on purpose, so an attacker learns nothing. You learn nothing either. smart-doctor works out the rest from your side of the connection.</p></div>
<div class="versus">
<div class="panel"><p class="panel-label">What the server says</p><p class="says">{"error": "invalid_client"}</p>
<p class="muted">That’s all. It could be any of these, and more:</p>
<ul class="guesses">${guesses.map(([id, label]) => `<li><a href="${causeUrl(id)}">${esc(label)}</a></li>`).join('')}</ul></div>
<div class="arrow" aria-hidden="true"><svg viewBox="0 0 44 24"><path d="M2 12h38M30 4l10 8-10 8"/></svg></div>
<div class="panel"><p class="panel-label">What smart-doctor tells you</p>
<ol class="ranked"><li>
<div class="row"><span class="t">${esc(k.title)}</span><span class="meter" data-p="85">very likely <i></i></span></div>
<p class="why">${prose(k.why)}</p>
<p class="evidence">server said “None of the keys found in the JWKS have kid equal to sandbox-typo”</p>
<p class="fix">${prose(k.fix)}</p>
</li></ol>
<p class="panel-label">Ruled out on the way</p>
<ul class="trust">${ruledOut.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</div>
</div>
</div></section>

<section class="section tinted" aria-labelledby="how"><div class="wrap">
<div class="section-head"><p class="eyebrow">How it works</p><h2 id="how">Your side of the login, examined</h2>
<p>smart-doctor sends the server exactly what your app would send, and keeps everything else on your machine.</p></div>
${diagram()}
</div></section>

<section class="section" aria-labelledby="examination"><div class="wrap">
<div class="section-head"><p class="eyebrow">Examination</p><h2 id="examination">Both kinds of login</h2></div>
<div class="flows">
<div class="flow"><div class="flow-head"><h3>Backend services</h3><p class="grant">client_credentials · private_key_jwt or client secret</p></div>
<ul class="checks">
<li>Your key or secret loads, and its algorithm fits</li>
<li>SMART configuration and the token endpoint</li>
<li>Your clock against the server’s</li>
<li>JWKS reachable, has your <code>kid</code>, and the published key is yours</li>
<li>No private key material in the public JWKS</li>
<li>The assertion: <code>aud</code>, <code>exp</code> ≤ 5 min, <code>jti</code>, <code>kid</code>, <code>iss</code> = <code>sub</code></li>
<li>The real token request and the scopes granted</li>
<li>Optional FHIR call, status code only</li>
</ul></div>
<div class="flow"><div class="flow-head"><h3>User sign-in</h3><p class="grant">SMART App Launch · authorization_code + PKCE</p></div>
<ul class="checks">
<li>Authorize endpoint, PKCE S256 and capabilities</li>
<li>Your redirect URI, exactly as registered today</li>
<li>Sign-in, then <code>state</code> and <code>iss</code> on the way back</li>
<li>Code exchange as a public client, with a secret or with a key</li>
<li>Patient context</li>
<li><code>id_token</code> signature, <code>aud</code> and <code>fhirUser</code></li>
<li>Refresh token</li>
<li>Optional FHIR call, status code only</li>
</ul></div>
</div>
<p class="note"><strong>No registration changes.</strong><span>With a <code>http://localhost</code> redirect URI, smart-doctor catches the redirect itself. For anything else you sign in, land on your company’s page, and paste its address back.</span></p>
</div></section>

<section class="section tinted" aria-labelledby="diagnosis"><div class="wrap">
<div class="section-head"><p class="eyebrow">Diagnosis</p><h2 id="diagnosis">Ranked causes, with the evidence</h2>
<p>Every cause comes with why it happens, the evidence smart-doctor found, and the exact next step.</p></div>
<ol class="ladder">
<li><h3>Rule out what can be checked</h3><p>Keys, JWKS, the assertion, your clock and the redirect URI, all verified locally first.</p></li>
<li><h3>Read the server’s own words</h3><p>Including the non-standard spellings vendors really send, like <code>Invalid Grant</code> and <code>invalid_code</code>.</p></li>
<li><h3>Add vendor knowledge</h3><p>Hints for ${VENDORS.map((v) => esc(v.name)).join(', ')}, each from a public source.</p></li>
<li><h3>Name what it can’t see</h3><p>When everything local passes: the server-side causes left, and how to confirm them.</p></li>
</ol>
<dl class="figures">
<div><dt>causes explained</dt><dd>${Object.keys(CAUSES).length}</dd></div>
<div><dt>server messages recognised</dt><dd>${patterns}</dd></div>
<div><dt>practice failure modes</dt><dd>${Object.keys(MODES).length}</dd></div>
<div><dt>breakages checked on a public server</dt><dd>${SANDBOX_SCENARIOS}</dd></div>
</dl>
<a class="more" href="errors/">Browse all ${Object.keys(CAUSES).length} causes in the error catalogue →</a>
</div></section>

<section class="section" aria-labelledby="treatment"><div class="wrap">
<div class="section-head"><p class="eyebrow">Treatment</p><h2 id="treatment">Run it in two minutes</h2></div>
<div class="run">
<ol class="steps">
<li><h3>Practise first</h3><p>A web view with a practice EHR that fails on purpose. No account needed.</p>${cmd('npx smart-doctor ui --demo')}</li>
<li><h3>Point it at your server</h3><p>A few questions, the rest discovered, saved as a profile that never holds a secret.</p>${cmd('npx smart-doctor init')}</li>
<li><h3>Share the result safely</h3><p>The report masks the client ID, patient IDs, tokens and secrets: ready for a ticket, a vendor or an AI.</p>${cmd('npx smart-doctor check my-profile --report')}</li>
</ol>
<div class="ways">
<div class="way"><h3>No Node.js?</h3><p>Standalone binaries for macOS, Linux and Windows on the <a href="${REPO}/releases">releases page</a>, with checksums.</p></div>
<div class="way"><h3>Nightly monitoring</h3><p>A <a href="${REPO}#nightly-monitoring-catch-expiring-keys-before-production-does">GitHub Action</a> catches expiring keys and registration drift before production does.</p></div>
<div class="way"><h3>Docker</h3><p>A small image for CI pipelines: mount the folder with your profile and run <code>check</code>.</p></div>
<div class="way"><h3>AI agents</h3><p>A Claude Code plugin whose skill passes keys by path only and shares <code>--report</code> output.</p></div>
</div>
</div>
</div></section>

<section class="section tinted" aria-labelledby="precautions"><div class="wrap">
<div class="section-head"><p class="eyebrow">Precautions</p><h2 id="precautions">Built to be trusted with keys</h2></div>
<div class="leaves">
<div class="ledger"><table>
<caption class="visually-hidden">What leaves your machine</caption>
<thead><tr><th scope="col">Item</th><th scope="col">Leaves your machine</th><th scope="col">How</th></tr></thead>
<tbody>
<tr><td>Private key</td><td><span class="pill never">never</span></td><td>Signs one test assertion in-process.</td></tr>
<tr><td>Client secret</td><td><span class="pill only">token endpoint only</span></td><td>Read from an environment variable, never a flag.</td></tr>
<tr><td>Tokens and codes</td><td><span class="pill only">where your app sends them</span></td><td>Masked in every trace and report.</td></tr>
<tr><td>Patient data</td><td><span class="pill never">never read</span></td><td>The FHIR call records the status code only.</td></tr>
<tr><td>Usage data</td><td><span class="pill never">none</span></td><td>No account, no cloud, no telemetry.</td></tr>
</tbody></table></div>
<ul class="promises">
<li><strong>Masked at the source</strong><span>Every HTTP exchange is redacted inside the engine before anything can display it, and tests enforce it.</span></li>
<li><strong>A local web view, locked down</strong><span>Binds to 127.0.0.1, needs a per-session token, strict Content-Security-Policy, no third-party requests.</span></li>
<li><strong>Read every line that runs</strong><span>Plain JavaScript with no build step, MIT licensed. <a href="${REPO}/blob/main/SECURITY.md">Security model</a>.</span></li>
</ul>
</div>
</div></section>

<div class="wrap"><section class="cta" aria-labelledby="cta">
<h2 id="cta">Next time it says <span class="alarm">invalid_client</span>, ask smart-doctor.</h2>
<p>Free and open source. Run it once against the practice EHR, then against yours.</p>
<div class="actions">${cmd('npx smart-doctor init')}<a class="button" href="${REPO}">${ICON.github} Star on GitHub</a></div>
</section></div>`;
  return shell({
    depth: 0,
    url: '',
    title: 'smart-doctor',
    description:
      'Find out why a SMART on FHIR login fails: backend services or user sign-in. Ranked causes in plain English, with your keys and secrets never leaving your machine.',
    body,
    jsonld,
  });
}

/** What crosses to the EHR, and what stays on your machine. */
function diagram() {
  const box = (x, y, w, h, title, sub, cls = 'box') =>
    `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text class="strong" x="${x + 16}" y="${y + 25}">${title}</text><text class="small" x="${x + 16}" y="${y + 44}">${sub}</text>`;
  const net = (y, label) =>
    `<path class="wire net" d="M602 ${y} H734" marker-start="url(#dot)" marker-end="url(#arrow-net)"/><text class="small net-text" x="668" y="${y - 9}" text-anchor="middle">${label}</text>`;
  return `<figure class="diagram">
<div class="diagram-scroll">
<svg viewBox="0 0 1000 336" role="img" aria-label="Your private key or secret stays on your machine. smart-doctor gathers, judges and reports locally; only discovery requests, the token request and your own sign-in cross the network to the EHR.">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0 0 L10 5 L0 10 z"/></marker>
<marker id="arrow-net" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head-net" d="M0 0 L10 5 L0 10 z"/></marker>
<marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"><circle class="head-net" cx="5" cy="5" r="4"/></marker>
</defs>
<rect class="zone" x="8" y="20" width="620" height="306" rx="16"/>
<text class="zone-title" x="28" y="46">YOUR MACHINE</text>
<rect class="zone zone-ehr" x="716" y="20" width="276" height="306" rx="16"/>
<text class="zone-title" x="736" y="46">THE EHR</text>
<text class="small" x="672" y="320" text-anchor="middle">network</text>
${box(28, 72, 196, 70, 'Private key or secret', 'read in-process', 'key')}
<text class="small stay-text" x="44" y="160">never leaves this machine</text>
${box(28, 236, 196, 70, 'You, or a ticket', 'masked report')}
<rect class="box" x="300" y="64" width="300" height="250" rx="12"/>
<text class="strong" x="318" y="92">smart-doctor</text>
${box(316, 108, 268, 56, 'Gather', 'discovery · clock · JWKS · assertion', 'zone')}
${box(316, 176, 268, 56, 'Judge', 'local checks, the server’s own words', 'zone')}
${box(316, 244, 268, 56, 'Report', 'ranked causes, evidence, next step', 'zone')}
<path class="wire" d="M224 107 H262 V136 H314" marker-end="url(#arrow)"/>
<text class="small" x="230" y="99">signs locally</text>
<path class="wire" d="M450 164 V176" marker-end="url(#arrow)"/>
<path class="wire" d="M450 232 V244" marker-end="url(#arrow)"/>
<path class="wire" d="M314 272 H226" marker-end="url(#arrow)"/>
<text class="small" x="232" y="264">plain English</text>
${box(736, 72, 236, 62, 'SMART configuration', '.well-known · metadata')}
${box(736, 150, 236, 62, 'Token endpoint', 'what your app would send')}
${box(736, 228, 236, 62, 'Sign-in page', 'you sign in, in your browser')}
${net(103, 'GET discovery')}
${net(181, 'POST assertion')}
${net(259, 'sign-in, code')}
</svg>
</div>
<figcaption>Only what your app would send anyway crosses to the EHR: discovery requests, the token request and your own sign-in. The key or secret is used in-process, and everything shown back to you is masked.</figcaption>
</figure>`;
}

// ---------------------------------------------------------------- error catalogue
function catalogue() {
  const total = Object.keys(CAUSES).length;
  const codes = Object.entries(ERROR_CODES)
    .map(
      ([code, g]) =>
        `<tr id="${code}"><td><code>${code}</code></td><td>${prose(g.meaning)}</td><td><span class="links">${g.causes
          .map((id) => `<a href="../${causeUrl(id)}">${esc(CAUSES[id].title)}</a>`)
          .join('')}</span></td></tr>`,
    )
    .join('');
  const byStage = STAGES.map((s) => ({ s, items: Object.entries(CAUSES).filter(([, c]) => c.stage === s.id) }));
  const index = `<nav class="index" aria-label="Stages"><h2>Login stages</h2><ol>
<li><a href="#codes">By error code <span class="n">${Object.keys(ERROR_CODES).length}</span></a></li>
${byStage.map(({ s, items }) => `<li><a href="#${s.id}">${esc(s.title)} <span class="n">${items.length}</span></a></li>`).join('')}
</ol></nav>`;
  const blocks = byStage
    .map(({ s, items }) => {
      const cards = items
        .map(([id, c]) => {
          const seen = SEEN.filter((x) => x.expect === id)
            .map((x) => `${x.body.error} ${x.body.error_description || ''}`)
            .join(' ');
          const search = `${id} ${c.title} ${c.why} ${seen}`.toLowerCase();
          return `<li data-search="${esc(search)}"><a href="../${causeUrl(id)}"><span class="id">${id}</span><span class="t">${esc(c.title)}</span><span class="w">${esc(c.why)}</span></a></li>`;
        })
        .join('');
      return `<section class="block" id="${s.id}" data-block aria-labelledby="h-${s.id}"><div class="block-head"><h2 id="h-${s.id}">${esc(s.title)}</h2><span class="count">${items.length} causes</span><p>${esc(s.blurb)}</p></div><ul class="cards">${cards}</ul></section>`;
    })
    .join('');
  const body = `<div class="wrap">
<header class="page-head">
<p class="eyebrow">Error catalogue</p>
<h1>Every cause, in the order a login runs</h1>
<p>${total} causes smart-doctor can report: what each means and how to fix it. Search for the error code or the exact message your server sent.</p>
<div class="search" hidden>${ICON.search}<label class="visually-hidden" for="q">Search causes</label><input id="q" type="search" placeholder="invalid_client, kid, redirect URI…" autocomplete="off" spellcheck="false"><kbd>/</kbd></div>
<p class="search-status" id="q-count" aria-live="polite"></p>
</header>
<div class="with-index">
${index}
<div>
<p id="q-none" class="empty-search" hidden>No cause matches. Try the error code alone, like <code>invalid_client</code>, or run <code>npx smart-doctor explain</code> with the full message.</p>
<section class="block" id="codes" aria-labelledby="h-codes"><div class="block-head"><h2 id="h-codes">By error code</h2><p>The standard OAuth codes, and what usually sits behind each.</p></div>
<div class="codes"><div class="codes-scroll"><table><thead><tr><th scope="col">Code</th><th scope="col">What it means</th><th scope="col">Usual causes</th></tr></thead><tbody>${codes}</tbody></table></div></div></section>
${blocks}
</div>
</div>
</div>`;
  return shell({
    depth: 1,
    url: 'errors/',
    title: 'Error catalogue',
    description: `All ${total} causes of SMART on FHIR login failures that smart-doctor can report, from invalid_client to redirect URI mismatches, with plain-English fixes.`,
    body,
    nav: 'errors',
  });
}

function causePage(id) {
  const c = CAUSES[id];
  const stage = stageOf(c.stage) || STAGES[0];
  const seen = SEEN.filter((x) => x.expect === id);
  const codes = Object.entries(ERROR_CODES)
    .filter(([, g]) => g.causes.includes(id))
    .map(([code]) => code);
  const related = Object.entries(CAUSES).filter(([rid, rc]) => rc.stage === c.stage && rid !== id);
  const example = seen[0] ? JSON.stringify(seen[0].body) : codes[0] ? JSON.stringify({ error: codes[0] }) : '';
  const body = `<div class="wrap">
<header class="page-head">
<p class="crumbs"><a href="../">Error catalogue</a><span aria-hidden="true">›</span><a href="../#${stage.id}">${esc(stage.title)}</a></p>
<h1>${esc(c.title)}</h1>
</header>
<div class="article">
<div class="doc">
<section aria-labelledby="what"><h2 id="what">What it means</h2><p>${prose(c.why)}</p></section>
<section class="fixbox" aria-labelledby="fix"><h2 id="fix">Fix</h2><p>${prose(c.fix)}</p></section>
${
  seen.length
    ? `<section aria-labelledby="seen"><h2 id="seen">Seen on real servers</h2><div class="seen">${seen
        .map(
          (x) =>
            `<figure class="response"><figcaption><span>server response</span><span>${esc(x.where)}</span></figcaption><pre><code>${esc(JSON.stringify(x.body, null, 2))}</code></pre></figure>`,
        )
        .join('')}</div></section>`
    : ''
}
<section aria-labelledby="check"><h2 id="check">Check it with smart-doctor</h2>
<p>Run your login and smart-doctor ranks this cause against the others, with the evidence it found.</p>
${cmd('npx smart-doctor check my-profile')}
${example ? `<p>Already have the server’s error? Explain it without running anything.</p>${cmd(`npx smart-doctor explain '${example}'`)}` : ''}
</section>
</div>
<aside class="aside" aria-label="About this cause">
<dl class="facts">
<div><dt>Stage</dt><dd><a href="../#${stage.id}">${esc(stage.title)}</a></dd></div>
<div><dt>Cause id</dt><dd><code>${id}</code></dd></div>
${codes.length ? `<div><dt>Shows up as</dt><dd>${codes.map((x) => `<a href="../#${x}"><code>${x}</code></a>`).join('')}</dd></div>` : ''}
</dl>
${
  related.length
    ? `<nav aria-labelledby="related"><h2 class="panel-label" id="related">More in ${esc(stage.title)}</h2><ul class="related">${related
        .map(([rid, rc]) => `<li><a href="../${rid.replace(/_/g, '-')}/">${esc(rc.title)}</a></li>`)
        .join('')}</ul></nav>`
    : ''
}
</aside>
</div>
</div>`;
  return shell({
    depth: 2,
    url: causeUrl(id),
    title: c.title,
    description: `${c.why} Fix: ${c.fix}`.slice(0, 300),
    body,
    nav: 'errors',
  });
}

// ---------------------------------------------------------------- vendors
function vendorsPage() {
  const tags = (key, h) =>
    [
      key === 'any' ? 'any error' : key,
      h.flow ? (h.flow === 'launch' ? 'user sign-in' : 'backend services') : '',
      h.auth ? `${h.auth} only` : '',
    ]
      .filter(Boolean)
      .map((t) => `<span class="tag">${esc(t)}</span>`)
      .join('');
  const source = (s) => (/^https?:\/\//.test(s) ? `<a href="${esc(s)}">${esc(s)}</a>` : esc(s));
  const sections = VENDORS.map((v) => {
    const seenIds = new Set();
    const hints = Object.entries(v.hints)
      .flatMap(([key, hs]) => hs.map((h) => ({ key, h })))
      .filter(({ h }) => !seenIds.has(h.id) && seenIds.add(h.id));
    const lis = hints
      .map(
        ({ key, h }) =>
          `<li><p class="t">${esc(h.title)}</p><p class="when">${tags(key, h)}</p><p>${prose(h.why)}</p><p class="fix">${prose(h.fix)}</p><p class="source">Source: ${source(h.source)}</p></li>`,
      )
      .join('');
    return `<section class="vendor" id="${v.id}" aria-labelledby="v-${v.id}"><div class="block-head"><h2 id="v-${v.id}">${esc(v.name)}</h2><span class="count">${hints.length} ${hints.length === 1 ? 'hint' : 'hints'}</span></div><ul class="hints">${lis}</ul></section>`;
  }).join('');
  const body = `<div class="wrap">
<header class="page-head">
<p class="eyebrow">Vendor notes</p>
<h1>How each EHR says no</h1>
<p>Each EHR words its failures differently and has its own registration gotchas. smart-doctor adds these hints when it recognises the server. They are possibilities from public sources, not facts about any one installation.</p>
<div class="actions"><a class="button" href="${REPO}/issues/new?template=3-vendor-quirk.yml">Suggest a vendor quirk ${ICON.arrow}</a></div>
</header>
<div class="block">${sections}</div>
</div>`;
  return shell({
    depth: 1,
    url: 'vendors/',
    title: 'Vendor notes',
    description: `SMART on FHIR login quirks for ${VENDORS.map((v) => v.name).join(', ')}, each with a public source.`,
    body,
    nav: 'vendors',
  });
}

function notFound() {
  // Served by GitHub Pages at any depth, so every link is absolute to the site root.
  const body = `<div class="wrap"><div class="lost">
<p class="eyebrow">404</p>
<h1>That page flatlined</h1>
${monitor({
  bar: 'Page · not found',
  who: 'HTTP 404',
  steps: [
    { label: 'DNS', status: 'pass' },
    { label: 'TLS', status: 'pass' },
    { label: 'Page', status: 'fail' },
    { label: '', status: 'pass' },
  ],
  vitals: [
    { k: 'Status', v: '404', u: 'not found', status: 'fail' },
    { k: 'Site', v: 'up', u: 'everything else works', status: 'pass' },
  ],
})}
<p class="muted">Nothing lives at this address. The <a href="${BASE_PATH}errors/">error catalogue</a> lists every cause smart-doctor knows, or start from the <a href="${BASE_PATH}">home page</a>.</p>
</div></div>`;
  return shell({ depth: 0, url: '404.html', title: 'Page not found', description: 'Page not found.', body, root: BASE_PATH });
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>rect{fill:#0b7a6b}path{stroke:#fff}@media (prefers-color-scheme:dark){rect{fill:#45c2ae}path{stroke:#08201c}}</style><rect width="32" height="32" rx="7"/><path d="M3 18 H11 L13.5 9 L17 24 L19.2 18 H29" fill="none" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></svg>
`;

// ---------------------------------------------------------------- build
export async function buildSite(outDir = path.join(HERE, 'dist')) {
  await rm(outDir, { recursive: true, force: true });
  const files = new Map();
  files.set('index.html', landing());
  files.set('errors/index.html', catalogue());
  for (const id of Object.keys(CAUSES)) files.set(`${causeUrl(id)}index.html`, causePage(id));
  files.set('vendors/index.html', vendorsPage());
  files.set('404.html', notFound());
  files.set('favicon.svg', FAVICON);
  const urls = ['', 'errors/', 'vendors/', ...Object.keys(CAUSES).map(causeUrl)];
  files.set(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}\n</urlset>\n`,
  );
  files.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
  files.set('.nojekyll', '');
  for (const [rel, content] of files) {
    const file = path.join(outDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(path.join(outDir, 'assets/fonts'), { recursive: true });
  for (const f of ['site.css', 'site.js', 'theme.js', 'og.png']) {
    try {
      await copyFile(path.join(HERE, 'assets', f), path.join(outDir, 'assets', f));
    } catch (e) {
      if (f !== 'og.png') throw e;
    }
  }
  const fonts = {
    'sans.woff2': '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2',
    'mono.woff2': '@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2',
  };
  for (const [name, mod] of Object.entries(fonts)) await copyFile(require.resolve(mod), path.join(outDir, 'assets/fonts', name));
  return { outDir, pages: [...files.keys()].filter((f) => f.endsWith('.html')) };
}

function serve(outDir, port = 4400) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
  };
  createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(BASE_PATH)) {
      res.writeHead(302, { location: BASE_PATH });
      return res.end();
    }
    let file = path.join(outDir, decodeURIComponent(url.pathname.slice(BASE_PATH.length)));
    if (!file.startsWith(outDir)) return res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { location: `${url.pathname}/` });
          return res.end();
        }
        file = path.join(file, 'index.html');
      }
      statSync(file);
    } catch {
      res.writeHead(404, { 'content-type': types['.html'] });
      return createReadStream(path.join(outDir, '404.html')).pipe(res);
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`Serving the website on http://localhost:${port}${BASE_PATH}  (Ctrl+C to stop)`));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('site/build.mjs')) {
  const { outDir, pages } = await buildSite();
  console.log(`Built ${pages.length} pages into ${path.relative(process.cwd(), outDir) || outDir}`);
  if (process.argv.includes('--serve')) serve(outDir);
}
