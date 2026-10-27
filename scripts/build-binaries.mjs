#!/usr/bin/env node
// Build standalone executables (no Node.js needed) with Bun's compiler.
//   node scripts/build-binaries.mjs            → all platforms into dist/
//   node scripts/build-binaries.mjs linux-x64  → one target
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';

const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
execFileSync(process.execPath, ['scripts/build-assets.mjs'], { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
for (const name of wanted) {
  if (!TARGETS[name]) throw new Error(`Unknown target ${name}. Known: ${Object.keys(TARGETS).join(', ')}`);
  const outfile = `dist/smart-doctor-${name}${name.startsWith('windows') ? '.exe' : ''}`;
  console.log(`Building ${outfile}…`);
  execFileSync(
    'npx',
    ['-y', 'bun@1.2.21', 'build', 'bin/smart-doctor.js', '--compile', '--minify', `--target=${TARGETS[name]}`, `--outfile=${outfile}`],
    { stdio: 'inherit' },
  );
  console.log(`  ${(statSync(outfile).size / 1e6).toFixed(1)} MB`);
}
