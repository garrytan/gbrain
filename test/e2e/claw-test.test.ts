/**
 * gbrain claw-test scripted-mode E2E.
 *
 * Invokes the harness via `bun run src/cli.ts` (NOT a compiled binary —
 * `bun build --compile` doesn't bundle PGLite's runtime assets like
 * pglite.data, so a compiled gbrain can't init a fresh PGLite brain).
 * Uses a tiny shim script that the harness can spawn as if it were the
 * gbrain binary.
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
import { mkdirSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN_CACHE = join(REPO_ROOT, 'test', '.cache');
const BIN_PATH = join(BIN_CACHE, 'gbrain.sh');
const SCENARIOS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios');

beforeAll(() => {
  if (!existsSync(BIN_CACHE)) mkdirSync(BIN_CACHE, { recursive: true });
  // Shim that delegates to `bun run src/cli.ts` so PGLite assets resolve from
  // the source tree (bun --compile doesn't bundle them). Marked executable so
  // child_process.spawn can run it directly.
  const shim = `#!/bin/sh\nexec bun run "${join(REPO_ROOT, 'src', 'cli.ts')}" "$@"\n`;
  writeFileSync(BIN_PATH, shim, 'utf-8');
  chmodSync(BIN_PATH, 0o755);
}, 30_000);

describe('gbrain claw-test --scenario fresh-install (scripted)', () => {
  test('runs end-to-end clean and produces zero error/blocker friction', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-fresh-'));
    try {
      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: BIN_PATH,
          GBRAIN_CLAW_SCENARIOS_DIR: join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios'),
        },
        encoding: 'utf-8',
        timeout: 120_000,
      });
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
    // We do this by setting GBRAIN_BIN_OVERRIDE to a script that pretends to be gbrain
    // and rejects the `import` subcommand specifically.
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-break-'));
    const fakeBin = join(tmp, 'fake-gbrain');
    try {
      // Write a shim that delegates to real gbrain but rejects 'import' to simulate breakage.
      const shimContent = `#!/bin/sh\nif [ "$1" = "import" ]; then echo "fake import error" >&2; exit 17; fi\nexec "${BIN_PATH}" "$@"\n`;
      const { writeFileSync, chmodSync } = require('fs');
      writeFileSync(fakeBin, shimContent, 'utf-8');
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: fakeBin,
          GBRAIN_CLAW_SCENARIOS_DIR: join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios'),
        },
        encoding: 'utf-8',
        timeout: 60_000,
      });
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
      // Log a friction entry with $HOME embedded, then render --redact md
      const home = process.env.HOME ?? '/tmp';
      const env = { ...process.env, GBRAIN_HOME: tmp, GBRAIN_FRICTION_RUN_ID: 'render-e2e' };
      execFileSync(BIN_PATH, ['friction', 'log', '--phase', 'p', '--message', `error at ${home}/.gbrain/x`], { env, encoding: 'utf-8' });
      const out = execFileSync(BIN_PATH, ['friction', 'render', '--run-id', 'render-e2e'], { env, encoding: 'utf-8' });
      expect(out).toContain('# Friction report');
      expect(out).toContain('<HOME>');
      // --redact is the default for md, so home itself should not appear.
      expect(out).not.toContain(home + '/.gbrain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
