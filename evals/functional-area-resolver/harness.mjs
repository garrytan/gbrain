#!/usr/bin/env node
/**
 * Thin CLI shim for the functional-area-resolver A/B eval harness.
 *
 * Spawns the TypeScript runner via `bun` because the runner imports
 * gbrain's gateway from `src/core/ai/gateway.ts` directly. The runner
 * does the actual work; this file exists so users can invoke `node
 * harness.mjs` without remembering the bun incantation.
 *
 * If `bun` isn't on PATH (or this script is invoked outside the gbrain
 * repo), exit 2 with a clear message — the harness is a gbrain-side
 * proof-of-pattern, not a portable tool.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(__dirname, 'harness-runner.ts');
const gatewayPath = resolve(__dirname, '..', '..', 'src', 'core', 'ai', 'gateway.ts');

function fail(message, code = 2) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

// Missing-binary fallback (F-E2): we need `bun` AND we need to be in
// the gbrain repo so the runner can import the gateway.
try {
  execFileSync('which', ['bun'], { stdio: 'ignore' });
} catch {
  fail(
    'harness.mjs: `bun` is not on PATH.\n' +
    'This harness is a gbrain-maintainer-side tool — run it from a\n' +
    'gbrain repo checkout with `bun` installed (https://bun.sh).',
  );
}

if (!existsSync(gatewayPath)) {
  fail(
    `harness.mjs: cannot find gbrain gateway at ${gatewayPath}.\n` +
    'This harness is the gbrain-side A/B eval surface. Run it from a\n' +
    'gbrain repo checkout, not from an installed skillpack.',
  );
}

if (!existsSync(runnerPath)) {
  fail(`harness.mjs: runner missing at ${runnerPath}`);
}

const args = process.argv.slice(2);
const result = spawnSync('bun', ['run', runnerPath, ...args], {
  stdio: 'inherit',
  cwd: __dirname,
});

process.exit(result.status ?? 1);
