/**
 * v0.41.13 (#1433) — re-sync preserves previously-indexed metafile pages.
 *
 * Bug class (infiniteGameExp): a domain `log.md` page that was indexed by
 * an older gbrain version (back when isSyncable() didn't filter `log.md`)
 * or via a direct put_page was being deleted on every subsequent
 * `gbrain sync --skip-failed` because the cleanup loop at
 * commands/sync.ts:772 treated all unsyncable-modified paths the same.
 *
 * Fix: the cleanup loop skips the delete when `unsyncableReason(path)`
 * returns `'metafile'`. Pages stay in the index for the lifetime they
 * were originally indexed.
 *
 * This is the IRON-RULE regression test for #1433. Marked `.serial.test.ts`
 * because it spawns git subprocesses and shares a single PGLite engine
 * across tests for cold-start amortization.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

describe('#1433 — re-sync preserves previously-indexed metafile pages', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-metafile-'));
    gitInit(repoPath);
    // Seed a non-metafile page that DOES get synced — this exercises the
    // happy path so we know sync ran at all.
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---',
      'type: concept',
      'title: Foo',
      '---',
      '',
      'Baseline content.',
    ].join('\n'));
    // The metafile we care about: log.md is filtered by isSyncable.
    mkdirSync(join(repoPath, 'learning'), { recursive: true });
    writeFileSync(join(repoPath, 'learning/log.md'), '## [2026-05-25] domain log entry\n');
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('log.md indexed via direct putPage survives re-sync after edit', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // First sync: log.md is filtered, only topics/foo.md lands.
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(first.status);

    // Seed the log page directly — simulate it being indexed by an older
    // gbrain version or via a hand-rolled put_page call. This is the
    // exact pre-condition that triggered infiniteGameExp's bug.
    await engine.putPage('learning/log', {
      type: 'concept',
      title: 'Learning log',
      compiled_truth: 'Pre-existing page that should survive re-sync.',
      timeline: '',
      frontmatter: { type: 'concept', id: 'learning-log' },
    });

    // Confirm seed worked.
    const seeded = await engine.getPage('learning/log');
    expect(seeded).not.toBeNull();

    // Edit log.md so it appears in manifest.modified on the next sync.
    writeFileSync(join(repoPath, 'learning/log.md'), '## [2026-05-25] entry\n## [2026-05-26] another\n');
    execSync('git add -A && git commit -m "edit log"', { cwd: repoPath, stdio: 'pipe' });

    // Second sync: pre-fix would have deleted the learning/log page.
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // 'up_to_date' is the most common outcome here — log.md is the only edit,
    // and filtered.modified excludes metafiles, so from the syncable-view
    // nothing changed. But the cleanup loop on unsyncableModified DOES still
    // run and that's the codepath we're testing.
    expect(['synced', 'first_sync', 'blocked_by_failures', 'up_to_date']).toContain(second.status);

    // IRON RULE: page survives. This is the regression.
    const survivor = await engine.getPage('learning/log');
    expect(survivor).not.toBeNull();
    expect(survivor?.compiled_truth).toContain('Pre-existing page');
  }, 60_000);

  test('schema.md indexed via direct putPage also survives (covers full SYNC_SKIP_FILES set)', async () => {
    // Write + commit schema.md so it has a path entry in git.
    writeFileSync(join(repoPath, 'topics/schema.md'), '# schema\n');
    execSync('git add -A && git commit -m "add schema"', { cwd: repoPath, stdio: 'pipe' });

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    await engine.putPage('topics/schema', {
      type: 'concept',
      title: 'Schema',
      compiled_truth: 'Pre-existing schema page.',
      timeline: '',
      frontmatter: { type: 'concept' },
    });

    writeFileSync(join(repoPath, 'topics/schema.md'), '# schema (edited)\n');
    execSync('git add -A && git commit -m "edit schema"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    const survivor = await engine.getPage('topics/schema');
    expect(survivor).not.toBeNull();
  }, 60_000);

  test('non-metafile that becomes un-syncable (renamed .md → .txt) IS still cleaned up', async () => {
    // Negative case: prove the guard is narrow — it only protects
    // metafile classification, not the broader "this page used to be
    // sync-eligible but isn't anymore" case.
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    // topics/foo was indexed by the first sync; confirm.
    const before = await engine.getPage('topics/foo');
    expect(before).not.toBeNull();

    // Rename foo.md → foo.txt so it fails isSyncable with reason='strategy'.
    execSync('git mv topics/foo.md topics/foo.txt', { cwd: repoPath, stdio: 'pipe' });
    // Also edit so it appears in manifest.modified (not just .deleted).
    writeFileSync(join(repoPath, 'topics/foo.txt'), 'now a .txt file');
    execSync('git add -A && git commit -m "rename + edit"', { cwd: repoPath, stdio: 'pipe' });

    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    // Pre-fix AND post-fix: the page should be cleaned up because the
    // reason is 'strategy' (not 'metafile'), so the guard doesn't fire.
    const after = await engine.getPage('topics/foo');
    expect(after).toBeNull();
  }, 60_000);
});
