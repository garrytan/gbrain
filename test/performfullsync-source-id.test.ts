/**
 * Regression test for performFullSync source_id threading.
 *
 * Pre-fix bug:
 *   - The engine-layer source_id thread (in this PR's earlier commit) plumbs
 *     source_id through sync's incremental loop (sync.ts), but performFullSync
 *     (the path `--full` invokes) called `runImport(engine, importArgs,
 *     { commit: headCommit })` without threading sourceId.
 *   - Result: `gbrain sync --source X --full` updated `sources.last_sync_at` to
 *     look like binding worked, but actual page rows landed in source_id='default'.
 *   - The existing engine-layer regression tests (test/source-id-tx-regression.test.ts)
 *     validate the transaction surface (putPage / addTag / etc.) but do NOT
 *     exercise performFullSync. Confirmed via:
 *       grep -c 'performFullSync' test/source-id-tx-regression.test.ts → 0.
 *
 * Fix (this PR):
 *   - runImport accepts opts.sourceId (programmatic-only — no CLI flag,
 *     preserves the design intent of `gbrain import` being default-only).
 *   - runImport threads sourceId to importFile + importImageFile.
 *   - performFullSync passes opts.sourceId to runImport.
 *
 * This test verifies the sync-command-layer fix end-to-end on PGLite.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

async function pageCountBySource(): Promise<Record<string, number>> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n FROM pages GROUP BY source_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source_id] = r.n;
  return out;
}

describe('performFullSync threads sourceId end-to-end', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', 'testsrc-pfs', '--no-federated']);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    // resetPgliteState clears pages but doesn't drop the source row; re-add only if missing
    const sources = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = 'testsrc-pfs'`);
    if (sources.length === 0) {
      await runSources(engine, ['add', 'testsrc-pfs', '--no-federated']);
    }

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-pfs-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---',
      'type: concept',
      'title: Foo Topic',
      '---',
      '',
      'Test content for performFullSync source binding.',
    ].join('\n'));
    writeFileSync(join(repoPath, 'topics/bar.md'), [
      '---',
      'type: concept',
      'title: Bar Topic',
      '---',
      '',
      'Second test page to verify multi-page routing.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('performFullSync with --source routes pages to named source (not default)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      full: true,
      sourceId: 'testsrc-pfs',
      noPull: true,
      noEmbed: true,
    });

    // status is 'first_sync' for fresh imports, 'synced' for incremental — accept both
    expect(['first_sync', 'synced']).toContain(result.status);
    expect(result.added).toBeGreaterThan(0);

    const counts = await pageCountBySource();
    // Pre-fix bug: pages would land in 'default' (sources.last_sync_at would still
    // update on testsrc-pfs, making the gap silent at the sources-list level).
    // Post-fix: pages land in 'testsrc-pfs'.
    expect(counts['testsrc-pfs']).toBeGreaterThan(0);
    expect(counts['default'] ?? 0).toBe(0);
  });

  test('performFullSync WITHOUT --source still targets default (back-compat preserved)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      full: true,
      // no sourceId — expect default-source behavior
      noPull: true,
      noEmbed: true,
    });

    // status is 'first_sync' for fresh imports, 'synced' for incremental — accept both
    expect(['first_sync', 'synced']).toContain(result.status);
    expect(result.added).toBeGreaterThan(0);

    const counts = await pageCountBySource();
    // Back-compat: callers that omit sourceId continue to target source 'default'.
    expect(counts['default']).toBeGreaterThan(0);
    expect(counts['testsrc-pfs'] ?? 0).toBe(0);
  });
});
