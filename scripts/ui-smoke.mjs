#!/usr/bin/env node
// Drive the real UI in a headless browser against the practice EHR and save
// screenshots of every state: backend ok, a broken profile, loopback sign-in,
// paste-back sign-in, phone width and dark mode.
//
//   npm i -D playwright && npx playwright install chromium   (once)
//   node scripts/ui-smoke.mjs            → ./screenshots/*.png

import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startUi } from '../src/ui/server.js';
import { saveProfile } from '../src/profiles.js';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('This script needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const out = path.resolve('screenshots');
await mkdir(out, { recursive: true });
const cfg = path.join(await mkdtemp(path.join(tmpdir(), 'sd-ui-')), 'smart-doctor.yaml');
const ui = await startUi({ configPath: cfg, demo: true });
await saveProfile(cfg, 'broken-kid', { ...ui.demo.profiles['demo-backend'], kid: 'typo-kid' });

const browser = await chromium.launch();
const errors = [];
async function session(opts, fn) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ui.url);
  await page.waitForSelector('#profile option', { state: 'attached' });
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}
const finished = (page) =>
  page.waitForFunction(() => document.querySelector('#verdict').dataset.v, null, { timeout: 20000 }).then(() => page.waitForTimeout(800));
async function runProfile(page, name) {
  await page.selectOption('#profile', name);
  await page.click('#run');
}

const desktop = { viewport: { width: 1360, height: 900 } };
await session(desktop, async (page) => {
  await page.screenshot({ path: path.join(out, '01-idle.png') });
  await runProfile(page, 'demo-backend');
  await finished(page);
  await page.screenshot({ path: path.join(out, '02-backend-ok.png'), fullPage: true });
  await runProfile(page, 'broken-kid');
  await finished(page);
  await page.screenshot({ path: path.join(out, '03-backend-broken.png') });
  await page.click('#new');
  await page.screenshot({ path: path.join(out, '04-profile-editor.png') });
});

await session(desktop, async (page, ctx) => {
  await runProfile(page, 'demo-launch');
  await page.waitForSelector('#action a.button');
  await page.screenshot({ path: path.join(out, '05-launch-waiting.png') });
  const signin = await ctx.newPage();
  await signin.goto(await page.getAttribute('#action a.button', 'href'));
  await signin.screenshot({ path: path.join(out, '06-mock-signin.png') });
  await signin.click('button[value=approve]');
  await signin.waitForLoadState();
  await signin.screenshot({ path: path.join(out, '07-loopback-callback.png') });
  await finished(page);
  await page.screenshot({ path: path.join(out, '08-launch-ok.png'), fullPage: true });
});

await session(desktop, async (page, ctx) => {
  await runProfile(page, 'demo-launch-paste');
  await page.waitForSelector('#paste-url');
  await page.screenshot({ path: path.join(out, '09-paste-waiting.png') });
  const signin = await ctx.newPage();
  let landed;
  signin.on('request', (r) => {
    if (r.url().startsWith('https://app.example.com/')) landed = r.url();
  });
  await signin.goto(await page.getAttribute('#action a.button', 'href'));
  await signin.click('button[value=approve]').catch(() => {});
  await signin.waitForTimeout(500);
  await page.fill('#paste-url', landed);
  await page.click('#paste-form button');
  await finished(page);
  await page.screenshot({ path: path.join(out, '10-paste-ok.png') });
});

await session({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, async (page) => {
  await runProfile(page, 'broken-kid');
  await finished(page);
  await page.screenshot({ path: path.join(out, '11-phone.png') });
});
await session({ ...desktop, colorScheme: 'dark' }, async (page) => {
  await runProfile(page, 'broken-kid');
  await finished(page);
  await page.screenshot({ path: path.join(out, '12-dark.png') });
});

await browser.close();
await ui.close();
if (errors.length) {
  console.error('Page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`Screenshots in ${out}`);
