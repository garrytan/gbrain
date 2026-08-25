/**
 * Untracked-gap regression tests — uncommitted working-tree state vs
 * commit-driven incremental sync.
 *
 * Pre-fix bug (observed on a real vault): incremental sync diffs
 * last_commit..HEAD, so files written into the repo but never committed are
 * invisible — sync prints "Already up to date." while the pages sit outside
 * the brain (106 untracked .md files in the wild case). Nothing counted,
 * nothing warned.
 *
 * Fix under test:
 *   1. Attached-HEAD incremental sync COUNTS uncommitted drift through the
 *      same scope/exclude/isSyncable filters imports use, reports it as
 *      `SyncResult.uncommitted`, and warns on stderr — never silently ignores.
 *   2. `workingTree: true` (CLI --working-tree / config
 *      sync.include_working_tree) imports uncommitted state via the same
 *      manifest-merge path detached-HEAD syncs always used.
 *   3. Non-syncable untracked files do not count as drift.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let repoPath: string;
const SOURCE_ID = 'testsrc-wtree';

function commitAll(msg: string): void {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoPath, stdio: 'pipe' });
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, SOURCE_ID],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

const baseOpts = () => ({
  repoPath,
  sourceId: SOURCE_ID,
  noPull: true,
  noEmbed: true,
  noExtract: true,
});

describe('sync working-tree drift (untracked gap)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', SOURCE_ID, '--no-federated']);

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-wtree-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\ncommitted content\n');
    commitAll('base');

    // First sync = full walk; establishes last_commit so later runs are incremental.
    const first = await performSync(engine, baseOpts());
    expect(first.status).toBe('first_sync');
    expect(await pageExists('topics/base')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('default sync counts uncommitted drift and does NOT import it', async () => {
    writeFileSync(join(repoPath, 'topics/untracked.md'), '# Untracked\n\nnever committed\n');
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\nedited but not committed\n');

    const result = await performSync(engine, baseOpts());
    expect(result.status).toBe('up_to_date');
    expect(result.uncommitted).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect(await pageExists('topics/untracked')).toBe(false);
  }, 60_000);

  test('workingTree: true imports uncommitted state (attached HEAD)', async () => {
    const result = await performSync(engine, { ...baseOpts(), workingTree: true });
    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);      // topics/untracked.md
    expect(result.modified).toBe(1);   // topics/base.md uncommitted edit
    expect(result.uncommitted).toBeUndefined();
    expect(await pageExists('topics/untracked')).toBe(true);
  }, 60_000);

  test('non-syncable untracked files do not count as drift', async () => {
    commitAll('commit the working tree'); // clean slate: prior drift now committed
    writeFileSync(join(repoPath, 'topics/junk.xyz'), 'not syncable\n');

    const result = await performSync(engine, baseOpts());
    // The commit advanced HEAD, so this run imports the committed diff —
    // either way the .xyz file must not surface as uncommitted drift.
    expect(result.uncommitted).toBeUndefined();
  }, 60_000);

  test('synced run imports the committed delta AND reports remaining drift (deletes counted, --exclude honored)', async () => {
    // Committed change: HEAD advances, so this run takes the `synced` path,
    // not the `up_to_date` path — `uncommitted` must ride on BOTH.
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\ncommitted edit two\n');
    commitAll('edit base');
    // Working-tree drift left behind:
    //   added   → untracked syncable file
    //   deleted → tracked file removed from disk, deletion not committed
    //   excluded → untracked syncable file matched by --exclude (must NOT count)
    writeFileSync(join(repoPath, 'topics/drift-note.md'), '# Drift\n\nstill uncommitted\n');
    writeFileSync(join(repoPath, 'topics/skipme.md'), '# Skip\n\nexcluded from sync\n');
    rmSync(join(repoPath, 'topics/untracked.md'));

    const result = await performSync(engine, { ...baseOpts(), exclude: ['topics/skipme.md'] });
    expect(result.status).toBe('synced');
    expect(result.modified).toBe(1); // the committed base.md edit imported
    // Drift filtered through the same predicates imports use: skipme.md is
    // excluded, junk.xyz (still on disk from the previous test) is unsyncable.
    expect(result.uncommitted).toEqual({ added: 1, modified: 0, deleted: 1 });
    expect(await pageExists('topics/drift-note')).toBe(false);
    // The uncommitted deletion must NOT have been applied to the brain.
    expect(await pageExists('topics/untracked')).toBe(true);
  }, 60_000);

  test('rename-only dirty tree still reports drift (add + delete decomposition)', async () => {
    // Reviewer-caught gap: a staged `git mv` populates ONLY the manifest's
    // `renamed` bucket — it set hasWorkingTreeChanges but counted zero drift,
    // reproducing the silent "Already up to date." this fix exists to kill.
    commitAll('settle working tree'); // clean slate: prior drift now committed
    await performSync(engine, baseOpts()); // import the settle commit → anchor at HEAD
    execSync('git mv topics/base.md topics/base-renamed.md', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, baseOpts());
    expect(result.status).toBe('up_to_date');
    // Rename decomposes as add(new path) + delete(old path).
    expect(result.uncommitted).toEqual({ added: 1, modified: 0, deleted: 1 });
    // Not imported: the renamed page keeps its old slug until committed.
    expect(await pageExists('topics/base')).toBe(true);
    expect(await pageExists('topics/base-renamed')).toBe(false);
  }, 60_000);

  test('sync.include_working_tree config imports without the flag (resolved in performSync, not the CLI)', async () => {
    // Adversarial-review finding: config resolution lived only in the CLI
    // layer, so the dream cycle's own "set sync.include_working_tree=true"
    // remedy was a no-op for every programmatic caller. Now performSync
    // resolves it when opts.workingTree is undefined.
    commitAll('settle rename'); // finalize test 5's staged rename
    await performSync(engine, baseOpts()); // anchor at HEAD
    writeFileSync(join(repoPath, 'topics/config-driven.md'), '# Config\n\nimported via config\n');

    await engine.setConfig('sync.include_working_tree', 'true');
    try {
      const result = await performSync(engine, baseOpts()); // no workingTree flag
      expect(result.status).toBe('synced');
      expect(await pageExists('topics/config-driven')).toBe(true);
    } finally {
      await engine.unsetConfig('sync.include_working_tree');
    }
  }, 60_000);

  test('working-tree mass-delete valve refuses >50% uncommitted deletions', async () => {
    // Adversarial-review finding: merged working-tree deletes bypassed the
    // #2828 reconcile valve — a transient tree state (mid-rebase, accidental
    // rm -rf) on a scheduled working-tree sync could sweep the source.
    mkdirSync(join(repoPath, 'bulk'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(repoPath, `bulk/page-${i}.md`), `# Bulk ${i}\n\ncontent ${i}\n`);
    }
    commitAll('add bulk pages');
    const settled = await performSync(engine, { ...baseOpts(), workingTree: true });
    expect(settled.status).toBe('synced');
    for (let i = 0; i < 12; i++) rmSync(join(repoPath, `bulk/page-${i}.md`));

    const result = await performSync(engine, { ...baseOpts(), workingTree: true });
    // Valve fires: deletes skipped loudly, nothing swept.
    expect(result.deleted).toBe(0);
    expect(await pageExists('bulk/page-0')).toBe(true);
    expect(await pageExists('bulk/page-11')).toBe(true);
  }, 60_000);
});
