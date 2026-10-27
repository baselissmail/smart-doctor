// The website is generated from the knowledge files; this keeps it buildable and link-clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSite } from '../site/build.mjs';
import { CAUSES } from '../src/knowledge/causes.js';

test('website: one page per cause, and every internal link resolves', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'sd-site-'));
  const { pages } = await buildSite(out);
  for (const id of Object.keys(CAUSES)) assert.ok(pages.includes(`errors/${id.replace(/_/g, '-')}/index.html`), `no page for ${id}`);
  for (const page of pages.filter((p) => p !== '404.html')) {
    const html = await readFile(path.join(out, page), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/, `${page} has no title`);
    assert.match(html, /<meta name="description" content="[^"]{20,}"/, `${page} has no description`);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"#]*)(?:#[^"]*)?"/g)) {
      if (!href || /^(https?:|mailto:)/.test(href)) continue;
      const target = path.resolve(path.dirname(path.join(out, page)), href);
      await assert.doesNotReject(access(href.endsWith('/') ? path.join(target, 'index.html') : target), `${page} links to missing ${href}`);
    }
  }
});
