#!/usr/bin/env node
import { main } from '../src/cli.js';

const args = process.argv.slice(2);
// Standalone (Bun-compiled) binaries may pass runtime flags through argv.
if (process.versions.bun) while (/^--(smol|bun)\b/.test(args[0] || '')) args.shift();

const code = await main(args);
process.exitCode = code;
