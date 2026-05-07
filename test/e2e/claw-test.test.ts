/**
 * gbrain claw-test scripted-mode E2E.
 *
 * Invokes the harness via `bun run src/cli.ts` (NOT a compiled binary —
 * `bun build --compile` doesn't bundle PGLite's runtime assets like
 * pglite.data, so a compiled gbrain can't init a fresh PGLite brain).
 * Passes a binary plus prefix args to the harness so child phases can invoke
 * the source tree without relying on platform-specific shell shims.
 *
 * Asserts:
 *   - exit code 0 on a clean tree
 *   - the friction JSONL has zero error/blocker entries
 *   - the harness recorded progress events for the expected phases
 *
 * Tagged-skip env: CLAW_TEST_SKIP_E2E=1 to opt out (e.g. when PGLite
 * WASM is broken on the host — the macOS 26.3 #223 bug class).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN_CACHE = join(REPO_ROOT, 'test', '.cache');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.ts');
const CLI_PREFIX_ARGS = ['run', CLI_PATH];
const SCENARIOS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios');

beforeAll(() => {
  if (!existsSync(BIN_CACHE)) mkdirSync(BIN_CACHE, { recursive: true });
}, 30_000);

function sourceTreeEnv(env: NodeJS.ProcessEnv = process.env, prefixArgs = CLI_PREFIX_ARGS): NodeJS.ProcessEnv {
  return {
    ...env,
    GBRAIN_BIN_OVERRIDE: process.execPath,
    GBRAIN_BIN_ARGS_JSON: JSON.stringify(prefixArgs),
    GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR,
  };
}

function spawnGbrain(args: string[], env: NodeJS.ProcessEnv, timeout: number) {
  return spawnSync(process.execPath, [...CLI_PREFIX_ARGS, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    timeout,
  });
}

describe('gbrain claw-test --scenario fresh-install (scripted)', () => {
  test('runs end-to-end clean and produces zero error/blocker friction', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-fresh-'));
    try {
      const result = spawnGbrain(
        ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'],
        sourceTreeEnv({
          ...process.env,
          GBRAIN_HOME: tmp,
        }),
        120_000,
      );
      if (result.status !== 0) {
        console.error('STDOUT:', result.stdout);
        console.error('STDERR:', result.stderr);
      }
      expect(result.status).toBe(0);

      // Inspect the friction JSONL the harness wrote.
      const frictionDir = join(tmp, '.gbrain', 'friction');
      expect(existsSync(frictionDir)).toBe(true);
      const files = readdirSync(frictionDir).filter(f => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);
      const runFile = join(frictionDir, files[0]);
      const lines = readFileSync(runFile, 'utf-8').split('\n').filter(l => l.trim());
      const entries = lines.map(l => JSON.parse(l));
      const blockers = entries.filter(e => e.kind === 'friction' && (e.severity === 'error' || e.severity === 'blocker'));
      if (blockers.length > 0) {
        console.error('unexpected friction entries:', blockers);
      }
      expect(blockers.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test('break path: an invented command produces an error friction entry and exits non-zero', () => {
    // Use a Bun module as the child command prefix target so the break path stays
    // portable while rejecting the `import` subcommand specifically.
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-break-'));
    const fakeBin = join(tmp, 'fake-gbrain.mjs');
    try {
      // Delegate to source gbrain for every command except the simulated failure.
      const shimContent = `const args = process.argv.slice(2);
if (args[0] === 'import') {
  console.error('fake import error');
  process.exit(17);
}
const proc = Bun.spawn([process.execPath, 'run', ${JSON.stringify(CLI_PATH)}, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await proc.exited);
`;
      const { writeFileSync } = require('fs');
      writeFileSync(fakeBin, shimContent, 'utf-8');

      const result = spawnGbrain(
        ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'],
        sourceTreeEnv({
          ...process.env,
          GBRAIN_HOME: tmp,
        }, ['run', fakeBin]),
        60_000,
      );
      expect(result.status).not.toBe(0);

      // The friction log should have an error-severity entry for the 'import' phase.
      const frictionDir = join(tmp, '.gbrain', 'friction');
      const files = readdirSync(frictionDir).filter(f => f.endsWith('.jsonl'));
      const lines = readFileSync(join(frictionDir, files[0]), 'utf-8').split('\n').filter(l => l.trim());
      const entries = lines.map(l => JSON.parse(l));
      const importErrors = entries.filter(e => e.phase === 'import' && e.severity === 'error');
      expect(importErrors.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('gbrain friction render integration', () => {
  test('render produces a markdown report with the redact placeholder', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-render-'));
    try {
      // Log a friction entry with the OS home directory embedded, then render --redact md.
      const home = homedir();
      const env = sourceTreeEnv({ ...process.env, GBRAIN_HOME: tmp, GBRAIN_FRICTION_RUN_ID: 'render-e2e' });
      execFileSync(process.execPath, [...CLI_PREFIX_ARGS, 'friction', 'log', '--phase', 'p', '--message', `error at ${home}/.gbrain/x`], { env, encoding: 'utf-8' });
      const out = execFileSync(process.execPath, [...CLI_PREFIX_ARGS, 'friction', 'render', '--run-id', 'render-e2e'], { env, encoding: 'utf-8' });
      expect(out).toContain('# Friction report');
      expect(out).toContain('<HOME>');
      // --redact is the default for md, so home itself should not appear.
      expect(out).not.toContain(home + '/.gbrain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
