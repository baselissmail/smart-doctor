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

// ---------------------------------------------------------------- the rhythm strip (same drawing as the tool)
function beatPath(x, y, a = 1) {
  return [
    'L',
    x - 34,
    y,
    'Q',
    x - 29,
    y - 7 * a,
    x - 24,
    y,
    'L',
    x - 10,
    y,
    'L',
    x - 6,
    y + 6 * a,
    'L',
    x - 1,
    y - 44 * a,
    'L',
    x + 4,
    y + 16 * a,
    'L',
    x + 8,
    y,
    'L',
    x + 16,
    y,
    'Q',
    x + 24,
    y - 11 * a,
    x + 32,
    y,
    'L',
    x + 46,
    y,
  ].join(' ');
}
function strip(steps) {
  const W = 960;
  const H = 132;
  const y = 78;
  const slot = W / steps.length;
  let flat = false;
  let cursor = '';
  const paths = steps.map((s, i) => {
    const left = slot * i;
    const right = slot * (i + 1);
    const cx = slot * (i + 0.5);
    let d;
    let cls;
    if (flat) {
      [d, cls] = [`M ${left} ${y} L ${right} ${y}`, 'flat'];
    } else if (s.status === 'fail') {
      d = `M ${left} ${y} L ${cx - 30} ${y} L ${cx - 20} ${y - 30} L ${cx - 12} ${y + 22} L ${cx - 4} ${y} L ${right} ${y}`;
      cls = 'fail';
      cursor = `<circle class="cursor" cx="${cx + 24}" cy="${y}" r="5"/>`;
      flat = true;
    } else {
      [d, cls] = [`M ${left} ${y} L ${cx - 46} ${y} ${beatPath(cx, y)} L ${right} ${y}`, 'pass'];
    }
    return `<path class="line ${cls}" d="${d}"/>`;
  });
  const passed = steps.filter((s) => s.status === 'pass').map((s) => s.label);
  const failed = steps.find((s) => s.status === 'fail');
  const desc = `A heartbeat trace of one login: ${passed.join(', ')} pass; ${failed.label} fails and the trace flatlines.`;
  const beats = steps
    .map((s, i) => {
      const st = steps.slice(0, i).some((x) => x.status === 'fail') ? 'flat' : s.status;
      const mark = { pass: '✔', fail: '✖', flat: '–' }[st];
      const word = { pass: 'passed', fail: 'failed', flat: 'not reached' }[st];
      return `<li data-s="${st}"><span class="st" aria-hidden="true">${mark}</span>${esc(s.label)}<span class="visually-hidden"> ${word}</span></li>`;
    })
    .join('');
  return `<figure class="strip-scroll"><div class="strip">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="strip-desc"><desc id="strip-desc">${esc(desc)}</desc>${paths.join('')}${cursor}</svg>
<ol class="beats">${beats}</ol></div></figure>`;
}

// ---------------------------------------------------------------- page shell
function shell({ depth, url, title, description, body, nav = '', jsonld = '' }) {
  const r = '../'.repeat(depth);
  const navLink = (href, label, key) => `<a href="${r}${href}"${nav === key ? ' aria-current="page"' : ''}>${label}</a>`;
  const fullTitle = title === 'smart-doctor' ? 'smart-doctor' : `${title} · smart-doctor`;
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
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#182a2a">
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
<a class="wordmark" href="${r || './'}"><svg viewBox="0 0 30 18" aria-hidden="true"><path d="M1 11 H9 L11.5 4 L14.5 16 L16.5 11 H29"/></svg>smart-doctor</a>
<nav class="nav" aria-label="Main">${navLink('errors/', 'Error catalogue', 'errors')}${navLink('vendors/', 'Vendor notes', 'vendors')}<a href="${REPO}">GitHub</a></nav><button class="theme" id="theme" type="button" hidden>Theme: auto</button>
</div></header>
<main id="main"><div class="wrap">
${body}
</div></main>
<footer class="foot"><div class="wrap">
<nav aria-label="Project">
<a href="${REPO}">Source on GitHub</a>
<a href="${REPO}/blob/main/CONTRIBUTING.md">Contributing</a>
<a href="${REPO}/blob/main/CODE_OF_CONDUCT.md">Code of conduct</a>
<a href="${REPO}/blob/main/SECURITY.md">Security</a>
<a href="${REPO}/releases">Releases</a>
<a href="${REPO}/blob/main/LICENSE">MIT license</a>
</nav>
<p>smart-doctor ${esc(VERSION)} is a diagnostic aid, not a conformance test; for certification use <a href="https://inferno.healthit.gov/">Inferno</a>. It is not affiliated with HL7, SMART Health IT or any EHR vendor; vendor names are trademarks of their owners.</p>
</div></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- pages
function landing() {
  const steps = [
    { label: 'Discovery', status: 'pass' },
    { label: 'Clock', status: 'pass' },
    { label: 'Key', status: 'pass' },
    { label: 'JWKS', status: 'pass' },
    { label: 'Assertion', status: 'pass' },
    { label: 'Token request', status: 'fail' },
    { label: 'FHIR call', status: 'pass' },
  ];
  const k = CAUSES.kid_unknown;
  const culprits = [
    ['aud_mismatch', 'aud is not exactly the token endpoint'],
    ['kid_unknown', 'kid not in the published JWKS'],
    ['jwks_fetch', 'the server cannot fetch your JWKS'],
    ['clock_skew', 'your clock and the server’s disagree'],
    ['client_unknown', 'client ID from the wrong environment'],
    ['secret_method_required', 'secret sent in the body, server wants Basic'],
    ['redirect_not_registered', 'redirect URI not registered exactly'],
    ['code_consumed', 'authorization code already used'],
    ['scope', 'scopes the registration does not allow'],
    ['jwks_private_leak', 'public JWKS leaking your private key'],
  ];
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
<section class="hero" aria-labelledby="hero-title">
<p class="label">Open source · runs on your machine</p>
<h1 id="hero-title">Why does this SMART on FHIR login fail?</h1>
<p class="lede">EHR token endpoints answer almost every client problem with <code>invalid_client</code>. smart-doctor checks everything you can check from your side, runs the real login once, and ranks the likely causes in plain English. Your keys and secrets never leave your machine.</p>
<div class="actions">${cmd('npx smart-doctor init')}<a class="button" href="errors/">Look up an error</a></div>
</section>

${strip(steps)}
<div class="report" aria-label="Example report">
<p class="failed">✖ Token request — HTTP 401 · error=invalid_client</p>
<h2>Most likely causes</h2>
<div class="cause">
<p><span class="title">1. ${esc(k.title)}</span><span class="likely">very likely</span></p>
<p>${prose(k.why)}</p>
<p class="evidence">evidence: server said “None of the keys found in the JWKS have kid equal to sandbox-typo”</p>
<p class="fix">${prose(k.fix)}</p>
</div>
<p class="caption">A real run against the public SMART launcher with a mistyped <code>kid</code>.</p>
</div>

<div class="chart">
<section class="entry" aria-labelledby="complaint">
<p class="label">Complaint</p>
<div class="entry-body">
<h2 id="complaint">One error, dozens of causes</h2>
<p>Servers say as little as possible on purpose, so an attacker learns nothing. That leaves you guessing between causes that all look the same from outside:</p>
<ul class="culprits">${culprits.map(([id, label]) => `<li><a href="${causeUrl(id)}">${esc(label)}</a></li>`).join('')}</ul>
</div>
</section>

<section class="entry" aria-labelledby="examination">
<p class="label">Examination</p>
<div class="entry-body">
<h2 id="examination">It checks both kinds of login</h2>
<div class="flows">
<div class="flow">
<h3>Backend services</h3>
<p class="grant">client_credentials · private_key_jwt or client secret</p>
<ul class="checks">
<li>Your key or secret loads, and its algorithm fits</li>
<li>SMART configuration and the token endpoint</li>
<li>Your clock against the server’s</li>
<li>JWKS reachable, has your <code>kid</code>, and the published key is yours</li>
<li>No private key material in the public JWKS</li>
<li>The assertion: <code>aud</code>, <code>exp</code> ≤ 5 min, <code>jti</code>, <code>kid</code>, <code>iss</code> = <code>sub</code></li>
<li>The real token request and the scopes granted</li>
<li>Optional FHIR call, status code only</li>
</ul>
</div>
<div class="flow">
<h3>User sign-in</h3>
<p class="grant">SMART App Launch · authorization_code + PKCE</p>
<ul class="checks">
<li>Authorize endpoint, PKCE S256 and capabilities</li>
<li>Your redirect URI, as registered today</li>
<li>Sign-in, then <code>state</code> and <code>iss</code> on the way back</li>
<li>Code exchange with a public client, secret or key</li>
<li>Patient context</li>
<li><code>id_token</code> signature, <code>aud</code> and <code>fhirUser</code></li>
<li>Refresh token</li>
<li>Optional FHIR call, status code only</li>
</ul>
</div>
</div>
<p>No registration changes: if your redirect URI is <code>http://localhost:PORT</code>, smart-doctor catches the redirect itself; for anything else you sign in, land on your company’s page and paste its address back.</p>
</div>
</section>

<section class="entry" aria-labelledby="diagnosis">
<p class="label">Diagnosis</p>
<div class="entry-body">
<h2 id="diagnosis">Ranked causes, with the evidence</h2>
<ol class="plain">
<li>It rules out everything it can verify locally: keys, JWKS, assertion, clock, redirect URI.</li>
<li>It reads the server’s own words, including non-standard spellings that vendors really send.</li>
<li>It adds vendor hints for ${VENDORS.map((v) => esc(v.name)).join(', ')}, each from a public source.</li>
<li>When all that passes, it names the server-side causes it cannot see, and how to confirm them.</li>
</ol>
<dl class="figures">
<div><dt>causes explained</dt><dd>${Object.keys(CAUSES).length}</dd></div>
<div><dt>server messages recognised</dt><dd>${patterns}</dd></div>
<div><dt>practice failure modes</dt><dd>${Object.keys(MODES).length}</dd></div>
<div><dt>breakages checked on a public server</dt><dd>${SANDBOX_SCENARIOS}</dd></div>
</dl>
<p><a href="errors/">Browse the error catalogue</a> to see every cause, what it means and how to fix it.</p>
</div>
</section>

<section class="entry" aria-labelledby="treatment">
<p class="label">Treatment</p>
<div class="entry-body">
<h2 id="treatment">Run it</h2>
<ol class="steps">
<li><p>Practise first, no account needed: the web view with a practice EHR that fails on purpose.</p>${cmd('npx smart-doctor ui --demo')}</li>
<li><p>Point it at your own server. It asks a few questions, discovers the rest and saves a profile without secrets.</p>${cmd('npx smart-doctor init')}${cmd('npx smart-doctor check my-profile')}</li>
<li><p>Share the result with a colleague, a vendor or an AI: the report masks the client ID, tokens and secrets.</p>${cmd('npx smart-doctor check my-profile --report')}</li>
</ol>
<div class="ways">
<div><h3>No Node.js</h3><p>Standalone binaries for macOS, Linux and Windows on the <a href="${REPO}/releases">releases page</a>.</p></div>
<div><h3>Nightly monitoring</h3><p>A <a href="${REPO}#nightly-monitoring-catch-expiring-keys-before-production-does">GitHub Action</a> catches expiring keys and registration drift before production does.</p></div>
<div><h3>Docker</h3><p>A small image for CI pipelines: mount the folder with your profile and run <code>check</code>.</p></div>
<div><h3>AI agents</h3><p>A Claude Code plugin whose skill passes keys by path only and shares <code>--report</code> output.</p></div>
</div>
</div>
</section>

<section class="entry" aria-labelledby="precautions">
<p class="label">Precautions</p>
<div class="entry-body">
<h2 id="precautions">Built to be trusted with keys</h2>
<ul class="plain">
<li>Your private key signs one test assertion in-process and is never sent, written, logged or printed.</li>
<li>Secrets come from environment variables or a password field, never from command-line flags.</li>
<li>Every HTTP exchange is masked inside the engine before anything can display it, and tests enforce it.</li>
<li>The FHIR call records the status code only, so no patient data can reach a report.</li>
<li>The local web view binds to 127.0.0.1, needs a per-session token and makes no third-party requests.</li>
<li>No telemetry, no account, no cloud.</li>
</ul>
<p>Read the full <a href="${REPO}/blob/main/SECURITY.md">security model</a>.</p>
</div>
</section>
</div>`;
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

function catalogue() {
  const codes = Object.entries(ERROR_CODES)
    .map(
      ([code, g]) =>
        `<tr id="${code}"><td><code>${code}</code></td><td>${prose(g.meaning)}</td><td><span class="links">${g.causes
          .map((id) => `<a href="../${causeUrl(id)}">${esc(CAUSES[id].title)}</a>`)
          .join('')}</span></td></tr>`,
    )
    .join('');
  const stages = STAGES.map((s) => {
    const items = Object.entries(CAUSES).filter(([, c]) => c.stage === s.id);
    const lis = items
      .map(([id, c]) => {
        const search = `${id} ${c.title} ${c.why} ${SEEN.filter((x) => x.expect === id)
          .map((x) => `${x.body.error} ${x.body.error_description || ''}`)
          .join(' ')}`.toLowerCase();
        return `<li data-search="${esc(search)}"><a href="../${causeUrl(id)}"><span class="t">${esc(c.title)}</span><span class="w">${esc(c.why)}</span></a></li>`;
      })
      .join('');
    return `<section class="stage" id="${s.id}" aria-labelledby="h-${s.id}"><div class="stage-intro"><h2 id="h-${s.id}">${esc(s.title)}</h2><p>${esc(s.blurb)}</p></div><ul class="items">${lis}</ul></section>`;
  }).join('');
  const body = `
<header class="page-head">
<h1>Error catalogue</h1>
<p>Every cause smart-doctor can report, in the order a login runs: what it means and how to fix it. Search for the error code or the exact message your server sent.</p>
<div class="search" hidden><label for="q">Search causes</label><input id="q" type="search" placeholder="e.g. invalid_client, kid, redirect" autocomplete="off" spellcheck="false"><output id="q-count" for="q" aria-live="polite"></output></div>
</header>
<p id="q-none" class="empty-search" hidden>No cause matches. Try the error code alone, like <code>invalid_client</code>, or run <code>npx smart-doctor explain</code> with the full message.</p>
<section aria-labelledby="by-code" class="stage" id="codes"><div class="stage-intro"><h2 id="by-code">By error code</h2><p>The standard OAuth codes, and what usually sits behind each.</p></div>
<div class="table-scroll"><table><thead><tr><th scope="col">Code</th><th scope="col">What it means</th><th scope="col">Usual causes</th></tr></thead><tbody>${codes}</tbody></table></div></section>
${stages}`;
  return shell({
    depth: 1,
    url: 'errors/',
    title: 'Error catalogue',
    description: `All ${Object.keys(CAUSES).length} causes of SMART on FHIR login failures that smart-doctor can report, from invalid_client to redirect URI mismatches, with plain-English fixes.`,
    body,
    nav: 'errors',
  });
}

function causePage(id) {
  const c = CAUSES[id];
  const stage = stageOf(c.stage);
  const seen = SEEN.filter((x) => x.expect === id);
  const codes = Object.entries(ERROR_CODES)
    .filter(([, g]) => g.causes.includes(id))
    .map(([code]) => code);
  const related = Object.entries(CAUSES).filter(([rid, rc]) => rc.stage === c.stage && rid !== id);
  const example = seen[0] ? JSON.stringify(seen[0].body) : codes[0] ? JSON.stringify({ error: codes[0] }) : '';
  const body = `
<header class="page-head">
<p class="crumbs"><a href="../">Error catalogue</a> › <a href="../#${stage.id}">${esc(stage.title)}</a></p>
<h1>${esc(c.title)}</h1>
<p class="idline"><span>Cause id <code>${id}</code></span>${codes.length ? `<span>Shows up as ${codes.map((x) => `<code>${x}</code>`).join(' ')}</span>` : ''}</p>
</header>
<div class="doc">
<section aria-labelledby="what"><h2 id="what">What it means</h2><p>${prose(c.why)}</p></section>
<section class="fixbox" aria-labelledby="fix"><h2 id="fix">Fix</h2><p>${prose(c.fix)}</p></section>
${
  seen.length
    ? `<section aria-labelledby="seen"><h2 id="seen">Seen on real servers</h2><div class="seen">${seen
        .map(
          (x) => `<figure><pre><code>${esc(JSON.stringify(x.body, null, 2))}</code></pre><figcaption>${esc(x.where)}</figcaption></figure>`,
        )
        .join('')}</div></section>`
    : ''
}
<section aria-labelledby="check"><h2 id="check">Check it with smart-doctor</h2>
<p>Run your login and smart-doctor ranks this cause against the others, with the evidence it found:</p>
${cmd('npx smart-doctor check my-profile')}
${example ? `<p>Already have the server’s error? Explain it without running anything:</p>${cmd(`npx smart-doctor explain '${example}'`)}` : ''}
</section>
${
  related.length
    ? `<section aria-labelledby="related"><h2 id="related">More in ${esc(stage.title)}</h2><ul class="related">${related
        .map(([rid, rc]) => `<li><a href="../${rid.replace(/_/g, '-')}/">${esc(rc.title)}</a></li>`)
        .join('')}</ul></section>`
    : ''
}
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

function vendorsPage() {
  const when = (key, h) =>
    [
      key === 'any' ? 'any error' : key,
      h.flow ? (h.flow === 'launch' ? 'user sign-in only' : 'backend services only') : '',
      h.auth ? `${h.auth} only` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const source = (s) => (/^https?:\/\//.test(s) ? `<a href="${esc(s)}">${esc(s)}</a>` : esc(s));
  const sections = VENDORS.map((v) => {
    const hints = Object.entries(v.hints).flatMap(([key, hs]) => hs.map((h) => ({ key, h })));
    const seenIds = new Set();
    const lis = hints
      .filter(({ h }) => !seenIds.has(h.id) && seenIds.add(h.id))
      .map(
        ({ key, h }) =>
          `<li><p class="t">${esc(h.title)}</p><p class="when">when: ${esc(when(key, h))}</p><p>${prose(h.why)}</p><p class="fix">${prose(h.fix)}</p><p class="source">Source: ${source(h.source)}</p></li>`,
      )
      .join('');
    return `<section class="vendor" id="${v.id}" aria-labelledby="v-${v.id}"><div class="stage-intro"><h2 id="v-${v.id}">${esc(v.name)}</h2></div><ul class="hints">${lis}</ul></section>`;
  }).join('');
  const body = `
<header class="page-head">
<h1>Vendor notes</h1>
<p>Each EHR words its failures differently and has its own registration gotchas. smart-doctor adds these hints when it recognises the server. They are possibilities from public sources, not facts about any particular installation.</p>
<p>Know one we’re missing? <a href="${REPO}/issues/new?template=3-vendor-quirk.yml">Suggest a vendor quirk</a> with a public source.</p>
</header>
${sections}`;
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
  // Served by GitHub Pages at any depth, so links are absolute to the site root.
  const body = `
<header class="page-head">
<h1>That page flatlined</h1>
<p>Nothing lives at this address. The <a href="${BASE_PATH}errors/">error catalogue</a> lists every cause smart-doctor knows, or start from the <a href="${BASE_PATH}">home page</a>.</p>
</header>`;
  return shell({ depth: 0, url: '404.html', title: 'Page not found', description: 'Page not found.', body })
    .replaceAll('href="favicon.svg"', `href="${BASE_PATH}favicon.svg"`)
    .replaceAll('"assets/', `"${BASE_PATH}assets/`)
    .replaceAll('href="errors/', `href="${BASE_PATH}errors/`)
    .replaceAll('href="vendors/', `href="${BASE_PATH}vendors/`)
    .replace('href="./"', `href="${BASE_PATH}"`);
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
