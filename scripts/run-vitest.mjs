#!/usr/bin/env node
// Starts Vitest from the canonically-cased working directory.
//
// On Windows a shell may sit in `c:\repo` while the file system knows it as `C:\repo`. Vitest then
// loads its own modules under both spellings, ends up with two copies of its runner state and
// every suite fails with "Cannot read properties of undefined (reading 'config')".
//
// Usage: node scripts/run-vitest.mjs [vitest arguments…]   (`npm test`, `npm run test:watch`)

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const cwd = realpathSync.native(process.cwd());
const vitest = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
