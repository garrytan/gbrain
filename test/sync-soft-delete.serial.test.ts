/**
 * #4587 — sync soft-deletes on file removal (72h recovery window).
 *
 * Before this, all seven delete sites in src/commands/sync.ts hard-deleted
 * through deletePage/deletePages: a `git rm` (or a full-sync reconcile)
 * destroyed the page + chunks + links immediately, bypassing the soft-delete
 * window every OTHER delete surface honors — and a row the operator had
 * already soft-deleted was wiped early. Now every sync delete lane calls
 * `softDeletePages` (deleted_at = now(), `deleted_at IS NULL` predicate);
 * the autopilot purge phase owns the eventual hard delete and a re-import
 * within the window revives the page via putPage's upsert.
 *
 * Serial-file requirement: the decompose tests write real rows to the
 * sync-failure ledger under the gbrain home — GBRAIN_HOME is isolated per
 * test, mirroring test/sync-rename-reconcile.serial.test.ts.
 *
 * Under test (orchestration-level, real performSync):
 *   1. removed-file drain soft-deletes: the row STAYS with deleted_at set.
 *   2. X3 decompose: a softDeletePages batch failure decomposes to
 *      one-element batches and the run CONTINUES (--skip-failed semantics);
 *      an unrecoverable per-slug failure is recorded to the ledger and the
 *      run still finishes (blocked, not crashed) — then converges on retry.
 *   3. X4 revival: delete → re-add within the window revives via upsert
 *      (deleted_at clears, content updates, chunks replaced not duplicated).
 *   4. T3 residual: a sync-soft-deleted page is absent from query
 *      (searchKeyword arm) and get_links/get_backlinks results — pins that
 *      the closed #1702 class STAYS closed for the new sync path.
 *   5. E1: the rename lane meeting a soft-deleted row (out-of-band
 *      `gbrain delete` between syncs, then git mv) converges with a live
 *      page at the destination and no live duplicate.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { performSync } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
let tmpHome: string;
const originalGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-4587-home-'));
  process.env.GBRAIN_HOME = tmpHome;
  await resetPgliteState(engine);
});

afterEach(() => {
  if (originalGbrainHome !== undefined) process.env.GBRAIN_HOME = originalGbrainHome;
  else delete process.env.GBRAIN_HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-4587-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitAll(dir: string, msg: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

async function rowState(slug: string): Promise<{ exists: boolean; softDeleted: boolean }> {
  const rows = await engine.executeRaw<{ deleted_at: string | Date | null }>(
    `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = $1`,
    [slug],
  );
  return { exists: rows.length > 0, softDeleted: rows.length > 0 && rows[0].deleted_at != null };
}

describe('#4587: removed-file drain soft-deletes (72h recovery)', () => {
  test('git rm → sync sets deleted_at; the row is recoverable, not gone', async () => {
    const repo = mkRepo({
      'notes/keeper.md': '# Keeper\n\nstays put\n',
      'notes/goner.md': '# Goner\n\nleaves the tree\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await rowState('notes/goner')).exists).toBe(true);

    execSync('git rm -q notes/goner.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove goner');

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(result.deleted).toBe(1);

    // The whole fix: the row STAYS, hidden behind deleted_at.
    const goner = await rowState('notes/goner');
    expect(goner.exists).toBe(true);
    expect(goner.softDeleted).toBe(true);
    expect(await engine.getPage('notes/goner', { sourceId: 'default' })).toBeNull();
    // Untouched neighbor stays live.
    expect(await engine.getPage('notes/keeper', { sourceId: 'default' })).not.toBeNull();
  });

  test('an already-soft-deleted row is not re-flipped (purge clock preserved)', async () => {
    const repo = mkRepo({ 'notes/pre-deleted.md': '# Pre\n\noperator removed me already\n' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Operator soft-deletes between syncs (gbrain delete semantics).
    expect(await engine.softDeletePage('notes/pre-deleted', { sourceId: 'default' })).not.toBeNull();
    const before = await engine.executeRaw<{ deleted_at: string | Date }>(
      `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/pre-deleted'`,
    );

    execSync('git rm -q notes/pre-deleted.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove pre-deleted');
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // deleted_at unchanged — the sync delete must not restart the 72h clock
    // (pre-#4587 this row was hard-deleted EARLY, wiping the window).
    const after = await engine.executeRaw<{ deleted_at: string | Date }>(
      `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/pre-deleted'`,
    );
    expect(after).toHaveLength(1);
    expect(String(after[0].deleted_at)).toBe(String(before[0].deleted_at));
  });
});

describe('#4587 X3: decompose-on-batch-failure — run continues, never aborts', () => {
  test('batch throw decomposes to one-element batches; all pages soft-delete and the run banks', async () => {
    const repo = mkRepo({
      'notes/d1.md': '# D1\n\nfirst\n',
      'notes/d2.md': '# D2\n\nsecond\n',
      'notes/survivor.md': '# Survivor\n\nimported either way\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    execSync('git rm -q notes/d1.md notes/d2.md', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'notes/added-after.md'), '# Added\n\nnew file in the same diff\n');
    commitAll(repo, 'remove two, add one');

    // Fail the BATCH call only (slugs.length > 1); the one-element decompose
    // calls succeed — a transient blip must not lose the whole batch.
    const orig = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async (slugs, opts) => {
      if (slugs.length > 1) throw new Error('injected transient batch failure');
      return orig(slugs, opts);
    };
    let result;
    try {
      result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      engine.softDeletePages = orig;
    }

    // The run CONTINUED: decompose recovered every slug, the add imported,
    // and the bookmark banked (no failures left).
    expect(result.status).toBe('synced');
    expect((await rowState('notes/d1')).softDeleted).toBe(true);
    expect((await rowState('notes/d2')).softDeleted).toBe(true);
    expect(await engine.getPage('notes/added-after', { sourceId: 'default' })).not.toBeNull();
  });

  test('unrecoverable per-slug failure lands in the ledger; the run finishes and converges on retry', async () => {
    const repo = mkRepo({
      'notes/wedged.md': '# Wedged\n\ndelete keeps failing\n',
      'notes/bystander.md': '# Bystander\n\nunrelated\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    execSync('git rm -q notes/wedged.md', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'notes/fresh.md'), '# Fresh\n\nimports despite the delete outage\n');
    commitAll(repo, 'remove wedged, add fresh');

    const orig = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async () => { throw new Error('injected permanent delete failure'); };
    let blocked;
    try {
      blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      engine.softDeletePages = orig;
    }

    // NOT abort-the-run: the sync finished, recorded the failure (gating the
    // bookmark), and the rest of the diff still processed.
    expect(blocked.status).toBe('blocked_by_failures');
    expect(blocked.failedFiles).toBe(1);
    expect(await engine.getPage('notes/fresh', { sourceId: 'default' })).not.toBeNull();
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const open = loadSyncFailures().filter(f => f.path === 'notes/wedged.md' && f.state === 'open');
    expect(open).toHaveLength(1);

    // Outage over → the un-advanced bookmark retries the same diff and
    // converges: the page soft-deletes and the failure clears.
    const retry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(retry.status).toBe('synced');
    expect((await rowState('notes/wedged')).softDeleted).toBe(true);
  });
});

describe('#4587 X4: delete → re-add within the window revives via upsert', () => {
  test('re-added file clears deleted_at, updates content, and replaces chunks (not duplicated)', async () => {
    const repo = mkRepo({ 'notes/phoenix.md': '# Phoenix V1\n\noriginal body with marker-alpha\n' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const pageIdRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = 'default' AND slug = 'notes/phoenix'`,
    );
    const originalId = Number(pageIdRows[0].id);

    execSync('git rm -q notes/phoenix.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove phoenix');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await rowState('notes/phoenix')).softDeleted).toBe(true);

    // Re-add within the 72h window, with NEW content. (git rm pruned the
    // now-empty notes/ dir — recreate it.)
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(join(repo, 'notes/phoenix.md'), '# Phoenix V2\n\nrevived body with marker-beta\n');
    commitAll(repo, 're-add phoenix');
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // Same row revived (upsert on (source_id, slug) — not a duplicate).
    const rows = await engine.executeRaw<{ id: number; deleted_at: string | null; compiled_truth: string }>(
      `SELECT id, deleted_at, compiled_truth FROM pages WHERE source_id = 'default' AND slug = 'notes/phoenix'`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(originalId);
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].compiled_truth).toContain('marker-beta');

    // Chunks replaced, not stacked: only V2 chunk text remains.
    const chunks = await engine.getChunks('notes/phoenix', { sourceId: 'default' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => !c.chunk_text.includes('marker-alpha'))).toBe(true);
    expect(chunks.some(c => c.chunk_text.includes('marker-beta'))).toBe(true);
  });
});

describe('#4587 T3 residual: sync-soft-deleted pages stay invisible to query/get_links', () => {
  test('searchKeyword misses and getLinks/getBacklinks drop edges to the soft-deleted page', async () => {
    const repo = mkRepo({
      'notes/holder.md': '# Holder\n\nlinks out to the target\n',
      'notes/target.md': '# Target\n\nzanzibar-unique-token content\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Wire the edge at the engine layer (extraction is off in SYNC_OPTS —
    // the visibility contract under test is read-side, not extraction).
    await engine.addLink('notes/holder', 'notes/target', 'ctx', 'wikilink');

    expect((await engine.searchKeyword('zanzibar-unique-token')).length).toBeGreaterThan(0);
    expect((await engine.getLinks('notes/holder')).length).toBe(1);
    expect((await engine.getBacklinks('notes/target')).length).toBe(1);

    execSync('git rm -q notes/target.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove target');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await rowState('notes/target')).softDeleted).toBe(true);

    // The #1702 class stays closed for the NEW sync path: recoverable rows
    // are invisible to the query arm and the link surfaces.
    expect(await engine.searchKeyword('zanzibar-unique-token')).toEqual([]);
    expect(await engine.getLinks('notes/holder')).toEqual([]);
    expect(await engine.getBacklinks('notes/target')).toEqual([]);
  });
});

describe('#4587 E1: rename lane meeting a soft-deleted row', () => {
  test('out-of-band soft delete + git mv converges: live page at the destination, no live duplicate', async () => {
    // getPage's deleted_at handling (verified): default reads hide
    // soft-deleted rows; activeSlugsBySourcePath and the removed-path
    // resolver filter deleted_at IS NULL; resolveSlugsByPaths does NOT — so
    // the rename lane CAN pick up a soft-deleted row as its cheap-move
    // source. This pins the converged outcome: updateSlug (no deleted_at
    // filter) moves the row, and the destination import's upsert revives it.
    const repo = mkRepo({ 'people/carol.md': '# Carol\n\nCarol is a person.\n' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol', { sourceId: 'default' })).not.toBeNull();

    // Operator soft-deletes the page between syncs; the FILE stays put.
    expect(await engine.softDeletePage('people/carol', { sourceId: 'default' })).not.toBeNull();

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'rename carol to dana');
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // Converged: the destination is LIVE with the file's content (the file
    // exists at people/dana.md, so a live page is the correct end state) and
    // no live row remains at the old slug.
    const dana = await engine.getPage('people/dana', { sourceId: 'default' });
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(await engine.getPage('people/carol', { sourceId: 'default' })).toBeNull();
    const live = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
    );
    expect(Number(live[0].n)).toBe(1);
  });
});

describe('#4587: full-sync reconcile + unsyncable lane are SOFT, purge window is honored end-to-end', () => {
  test('full-sync reconcile: a DB row whose file is gone gets deleted_at set — the row EXISTS, not absent', async () => {
    const repo = mkRepo({
      'topics/keep.md': '# Keep\n\nstays on disk\n',
      'topics/gone.md': '# Gone\n\nfile will disappear\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await rowState('topics/gone')).exists).toBe(true);

    // The file disappears from disk AND from the commit history tip.
    execSync('git rm -q topics/gone.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove gone');

    // Force the RECONCILE lane (not the incremental removed-file drain).
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(result.status).not.toBe('blocked_by_failures');

    // The pin: reconcile soft-deletes. Pre-#4587 this row was HARD-deleted.
    const gone = await rowState('topics/gone');
    expect(gone.exists).toBe(true);
    expect(gone.softDeleted).toBe(true);
    // Recoverable through the includeDeleted read surface.
    const tombstoned = await engine.getPage('topics/gone', { sourceId: 'default', includeDeleted: true });
    expect(tombstoned).not.toBeNull();
    expect(tombstoned!.deleted_at).not.toBeNull();
    // The sibling was not collateral damage.
    const keep = await rowState('topics/keep');
    expect(keep.exists).toBe(true);
    expect(keep.softDeleted).toBe(false);
  });

  test('unsyncable lane: a swept poisoned-filename page is soft-deleted — row exists with a tombstone', async () => {
    const JUNK_NAME = '[foo.md](https-example).md';
    const JUNK_SLUG = 'atoms/foo-md-https-example';
    const repo = mkRepo({ 'notes/base.md': '# Base\n\ncommitted\n' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The junk file lands (skipped from import — malformed path)…
    writeFileSync(join(repo, JUNK_NAME), '# junk\n');
    commitAll(repo, 'junk lands');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // …but a pre-gate gbrain had already ingested it (seed the poisoned row).
    await engine.putPage(JUNK_SLUG, {
      type: 'note',
      title: 'Poisoned page',
      compiled_truth: 'Junk row ingested before the malformed-path gate existed.',
      timeline: '',
      frontmatter: { type: 'note' },
    });
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE slug = $2`, [JUNK_NAME, JUNK_SLUG]);

    // A MODIFIED junk file routes through the unsyncable cleanup lane.
    writeFileSync(join(repo, JUNK_NAME), '# junk edited\n');
    commitAll(repo, 'edit junk');
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).not.toBe('blocked_by_failures');

    // The pin: swept via softDeletePages — EXISTS + tombstone, not absent.
    // (test/sync-malformed-path.serial.test.ts only asserts not-live, which a
    // hard delete would also satisfy.)
    const swept = await rowState(JUNK_SLUG);
    expect(swept.exists).toBe(true);
    expect(swept.softDeleted).toBe(true);
  });

  test('purge after the 72h window: cycle purge hard-deletes a 73h sync tombstone; a 71h one survives', async () => {
    const repo = mkRepo({
      'notes/old.md': '# Old\n\nwill age past the window\n',
      'notes/recent.md': '# Recent\n\nstays inside the window\n',
      'notes/live.md': '# Live\n\nnever deleted\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    execSync('git rm -q notes/old.md notes/recent.md', { cwd: repo, stdio: 'pipe' });
    commitAll(repo, 'remove both');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await rowState('notes/old')).softDeleted).toBe(true);
    expect((await rowState('notes/recent')).softDeleted).toBe(true);

    // Backdate the sync-originated tombstones: one past 72h, one inside it.
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE source_id = 'default' AND slug = 'notes/old'`,
    );
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '71 hours' WHERE source_id = 'default' AND slug = 'notes/recent'`,
    );

    // The CYCLE purge phase owns the eventual hard delete (72h constant).
    const { runCycle } = await import('../src/core/cycle.ts');
    const report = await runCycle(engine, { brainDir: null, phases: ['purge'] });
    const purgePhase = report.phases.find((p) => p.phase === 'purge');
    expect(purgePhase).toBeDefined();
    expect(purgePhase!.status).not.toBe('failed');

    // 73h: HARD-gone — the row no longer exists at all.
    expect((await rowState('notes/old')).exists).toBe(false);
    // 71h: still recoverable — exists, tombstoned, untouched by the purge.
    const recent = await rowState('notes/recent');
    expect(recent.exists).toBe(true);
    expect(recent.softDeleted).toBe(true);
    // Live rows are never purge candidates.
    const live = await rowState('notes/live');
    expect(live.exists).toBe(true);
    expect(live.softDeleted).toBe(false);
  }, 30_000);
});
