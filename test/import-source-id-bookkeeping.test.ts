/**
 * #3838 — the sync-failures ledger and ingest_log both hard-coded
 * `source_id: 'default'` for a bare `gbrain import <dir>` run, even when
 * the resolver's `sole_non_default` tier (5.5) routed the run to a
 * different source. `recordFailures` was called with
 * `opts.sourceId ?? 'default'` — the unresolved CLI parameter, which stays
 * undefined for a bare invocation — instead of the `sourceId` local
 * variable every `importFile` call in the same run actually used.
 * `engine.logIngest(...)` never passed `source_id` at all.
 *
 * Hermetic PGLite in-memory. Sandboxes the failure ledger under a temp
 * GBRAIN_HOME via `withEnv` so this test never touches the real
 * ~/.gbrain/sync-failures.jsonl on the machine running it (see #2121).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
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
  // Registering the ONLY non-default source with a local_path is what
  // fires resolveSourceWithTier's sole_non_default tier (5.5) — the tier
  // import.ts actually adopts into its local `sourceId` variable for a
  // bare CLI call. (Setting `sources.default`/tier 5 does NOT reach this
  // code path: import.ts's own resolution block only ever adopts
  // `resolved.source_id` when `resolved.tier === 'sole_non_default'`, by
  // design — every other tier falls through and `sourceId` stays
  // undefined, defaulting the actual writes to 'default' regardless of
  // what the resolver reports. The path doesn't need to exist on disk;
  // pickSoleNonDefaultSource only checks the column is non-null.)
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', '/nonexistent/dept-x') ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('import bookkeeping records the resolved source (#3838)', () => {
  test('failure ledger and ingest_log both say dept-x, not default', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-source-bookkeeping-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    execSync('git add seed.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m seed', { cwd: repo, stdio: 'pipe' });

    // Deterministic soft-failure: import-file.ts rejects any file over
    // MAX_FILE_SIZE (5_000_000 bytes) with a real `result.error`, which
    // runImport pushes into `failures[]` without needing a thrown
    // exception — the exact code path recordFailures reads from.
    writeFileSync(join(repo, 'oversized.md'), '---\ntype: note\n---\n' + 'x'.repeat(5_000_001));

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      // No --source-id: the resolver must reach tier 5 on its own.
      await runImport(engine, [repo, '--no-embed', '--json']);

      const failures = loadSyncFailures().filter((f) => f.path === 'oversized.md');
      expect(failures.length).toBe(1);
      expect(failures[0].source_id).toBe('dept-x');
    });

    // Not filtering by source_ref: runImport resolves `dir` to its real,
    // symlink-free path (macOS: /tmp -> /private/tmp) before logging it,
    // so it won't byte-match the pre-realpath `repo` string here. This is
    // the only import in the test, so the latest row is unambiguous.
    const ingestRows = await engine.executeRaw<{ source_id: string; source_ref: string }>(
      `SELECT source_id, source_ref FROM ingest_log ORDER BY id DESC LIMIT 1`,
    );
    expect(ingestRows.length).toBe(1);
    expect(ingestRows[0].source_ref).toContain('gbrain-source-bookkeeping-');
    expect(ingestRows[0].source_id).toBe('dept-x');
  });
});
