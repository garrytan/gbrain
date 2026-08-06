/**
 * #3839 — `clearFailures()` (src/core/sync-failure-ledger.ts) existed and
 * was unit-tested, but no command path ever called it. A path recorded as
 * `open` in the sync-failures ledger stayed `open` forever, even after the
 * exact same file imported cleanly on a later run — the ledger never
 * self-healed short of a manual `gbrain sync --skip-failed`.
 *
 * Two-run scenario: a poison file fails run 1 (recorded), gets fixed, then
 * succeeds run 2 (must clear).
 *
 * Hermetic PGLite in-memory. Sandboxes the failure ledger under a temp
 * GBRAIN_HOME via `withEnv` so this test never touches the real
 * ~/.gbrain/sync-failures.jsonl on the machine running it (see #2121).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('a path that fails then succeeds clears its ledger row (#3839)', () => {
  test('poison.md: open after run 1, gone after run 2', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-clear-failures-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    execSync('git add seed.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m seed', { cwd: repo, stdio: 'pipe' });

    // Run 1: poison.md is oversized (deterministic soft-failure, same
    // MAX_FILE_SIZE trigger as the #3838 test — no thrown exception needed).
    const poisonPath = join(repo, 'poison.md');
    writeFileSync(poisonPath, '---\ntype: note\n---\n' + 'x'.repeat(5_000_001));

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await runImport(engine, [repo, '--fresh', '--no-embed', '--json']);

      const afterRun1 = loadSyncFailures().filter((f) => f.path === 'poison.md');
      expect(afterRun1.length).toBe(1);
      expect(afterRun1[0].state).toBe('open');
    });

    // Fix poison.md: small enough to import cleanly. Different content, so
    // this is a real re-import, not a content_hash 'unchanged' skip.
    writeFileSync(poisonPath, '---\ntype: note\n---\n# Poison, fixed\n\nnow well under the limit.\n');

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await runImport(engine, [repo, '--fresh', '--no-embed', '--json']);

      const afterRun2 = loadSyncFailures().filter((f) => f.path === 'poison.md');
      expect(afterRun2.length).toBe(0);
    });
  });
});
