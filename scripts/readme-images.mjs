#!/usr/bin/env node
// Regenerate the README images from real runs, so they never drift from what the tool shows.
//
//   npm i --no-save playwright && npx playwright install chromium   (once)
//   node scripts/readme-images.mjs                                  → docs/images/*.png
//
// banner-light/dark   the website's monitor + headline (also the GitHub social preview)
// terminal            `smart-doctor check` against the practice EHR with a mistyped kid
// web-view            the local web view after the same failing run

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../site/build.mjs';
import { startDemoMock } from '../src/mock/demo.js';
import { runCheck } from '../src/doctor.js';
import { renderHuman } from '../src/report.js';
import { profileToOptions, saveProfile } from '../src/profiles.js';
import { startUi } from '../src/ui/server.js';
import { listen } from '../src/util.js';

/** @type {any} */
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('This script needs Playwright: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
await mkdir(OUT, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), 'sd-readme-'));

// ---------------------------------------------------------------- the built website, served locally
const site = path.join(work, 'site');
await buildSite(site);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const file = path.join(site, decodeURIComponent(new URL(req.url || '/', 'http://x').pathname));
  try {
    statSync(file);
    res.writeHead(200, { 'content-type': types[/** @type {keyof typeof types} */ (path.extname(file))] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
const sitePort = await listen(server, 0, '127.0.0.1');
const home = await readFile(path.join(site, 'index.html'), 'utf8');
const monitor = home.match(/<figure class="monitor"[\s\S]*?<\/figure>/)?.[0] || '';
const mark = home.match(/<span class="mark">[\s\S]*?<\/span>/)?.[0] || '';

const browser = await chromium.launch();
/**
 * @param {string} file
 * @param {{ width: number, height: number, html?: string, url?: string, scheme?: string, scale?: number, fullPage?: boolean }} o
 */
async function shoot(file, { width, height, html, url, scheme = 'light', scale = 2, fullPage = false }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  if (html) {
    await writeFile(path.join(site, '_shot.html'), html);
    await page.goto(`http://127.0.0.1:${sitePort}/_shot.html`, { waitUntil: 'networkidle' });
  } else await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, file), fullPage });
  await ctx.close();
  console.log(`  docs/images/${file}`);
}

// ---------------------------------------------------------------- banner (+ social preview)
const banner = (theme, height) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<link rel="stylesheet" href="assets/site.css"><style>
body{margin:0;width:1280px;height:${height}px;overflow:hidden;background:var(--paper)}
.b{box-sizing:border-box;width:1280px;height:${height}px;display:grid;grid-template-columns:1fr 1.08fr;gap:56px;align-items:center;padding:0 64px;
background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:40px 40px;background-position:-1px -1px}
.c{display:grid;gap:22px}
.n{display:flex;align-items:center;gap:14px;font-weight:780;font-size:30px;letter-spacing:-.02em}
.n .mark{width:46px;height:46px;border-radius:12px}.n .mark svg{width:30px;height:20px}
h1{font-size:56px;font-weight:800;letter-spacing:-.032em;line-height:1.03}
h1 em{font-style:normal;color:var(--fail)}
p{font-size:21px;line-height:1.45;color:var(--muted);max-width:30ch}
.cmd{font-family:var(--mono);font-size:19px;background:var(--surface);border:1px solid var(--grid-strong);border-radius:999px;padding:12px 22px;justify-self:start}
.cmd::before{content:'$\\00a0';color:var(--pass);font-weight:700}
.monitor{box-shadow:0 30px 60px -30px rgb(6 22 20 / .55)}.sweep{display:none}
</style></head><body><div class="b"><div class="c"><div class="n">${mark}smart-doctor</div>
<h1>Why does this SMART on FHIR login <em>fail?</em></h1>
<p>Ranked causes in plain English. Your keys and secrets never leave your machine.</p>
<span class="cmd">npx smart-doctor init</span></div>${monitor}</div></body></html>`;

console.log('Writing README images:');
await shoot('banner-light.png', { width: 1280, height: 560, html: banner('light', 560) });
await shoot('banner-dark.png', { width: 1280, height: 560, html: banner('dark', 560), scheme: 'dark' });
await shoot('social-preview.png', { width: 1280, height: 640, html: banner('light', 640), scale: 1 });

// ---------------------------------------------------------------- terminal: a real failing check
const demo = await startDemoMock({ port: 0, keyDir: path.join(work, 'demo') });
const configPath = path.join(work, 'smart-doctor.yaml');
const opts = { ...profileToOptions(demo.profiles['demo-backend'], { configPath }), kid: 'typo-kid', timeoutMs: 5000 };
const result = await runCheck(opts);
const full = renderHuman(result, { color: true, maxCauses: 1 })
  .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'https://ehr.example.org')
  .replace(/127\.0\.0\.1:\d+/g, 'ehr.example.org');
// An excerpt: everything up to and including the first cause (the key thumbprint and hints follow it).
// eslint-disable-next-line no-control-regex -- matching terminal colour codes on purpose
const plain = full.replace(/\x1b\[\d+m/g, '');
const cut = plain.indexOf('\n\n', plain.indexOf('fix:', plain.indexOf('Most likely causes')));
let ansi = full;
if (cut > 0) {
  let seen = 0;
  for (let i = 0; i < full.length; i++) {
    if (full[i] === '\x1b') i = full.indexOf('m', i);
    else if (++seen === cut) {
      ansi = full.slice(0, i + 1);
      break;
    }
  }
}
/** @type {Record<string, string>} */
const COLORS = { 1: 'b', 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan', 90: 'dim' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Turn SGR codes into nested spans; code 0 closes everything that is open.
let open = 0;
const html =
  ansi
    // eslint-disable-next-line no-control-regex -- matching terminal colour codes on purpose
    .split(/\x1b\[(\d+)m/)
    .map((part, i) => {
      if (i % 2 === 0) return esc(part);
      if (part === '0') {
        const closing = '</span>'.repeat(open);
        open = 0;
        return closing;
      }
      open++;
      return `<span class="${COLORS[part] || ''}">`;
    })
    .join('') + '</span>'.repeat(open);
const terminal = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@font-face{font-family:'Atkinson Mono';src:url(assets/fonts/mono.woff2) format('woff2');font-weight:200 800}
body{margin:0;background:#0a1615;color:#d3e6e2;font:15px/1.6 'Atkinson Mono',ui-monospace,Menlo,monospace}
.t{padding:18px 26px 22px}.bar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid #1f3835;color:#87a7a1;font-size:13px}
.bar i{width:11px;height:11px;border-radius:50%;background:#1f3835;display:inline-block}
pre{margin:0;padding:0;background:none;border:0;font:inherit;color:inherit;white-space:pre-wrap}.p{color:#5be0c6;font-weight:700}
.b{font-weight:700}.red{color:#ff6f62}.green{color:#5be0c6}.yellow{color:#f2b84b}.cyan{color:#7cc7e8}.dim{color:#7f9e99}
</style></head><body><div class="bar"><i></i><i></i><i></i><span>smart-doctor</span></div><div class="t"><pre><span class="p">$</span> npx smart-doctor check demo-backend --kid typo-kid

${html}</pre></div></body></html>`;
await shoot('terminal.png', { width: 980, height: 400, html: terminal, scale: 2, fullPage: true });
await demo.mock.close();

// ---------------------------------------------------------------- the local web view, same failure
const ui = await startUi({ configPath: path.join(work, 'ui', 'smart-doctor.yaml'), demo: true });
await saveProfile(path.join(work, 'ui', 'smart-doctor.yaml'), 'broken-kid', { ...ui.demo.profiles['demo-backend'], kid: 'typo-kid' });
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.goto(ui.url);
  await page.waitForSelector('#profile option', { state: 'attached' });
  await page.selectOption('#profile', 'broken-kid');
  await page.click('#run');
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector('#verdict')).dataset.v, null, { timeout: 20000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'web-view.png') });
  await ctx.close();
  console.log('  docs/images/web-view.png');
}
await ui.close();
await browser.close();
server.close();
