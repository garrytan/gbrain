/**
 * #3056 — sync rename path: a failed `updateSlug` must be surfaced and
 * reconciled instead of silently leaving a duplicate row.
 *
 * Before the fix, the rename loop in src/commands/sync.ts swallowed
 * `updateSlug` failures with an empty catch ("treat as add") and could not
 * see a zero-row UPDATE at all (updateSlug returned void). The run then
 * fell through to importFile, which created/updated the row at the new
 * path — while the old row stayed behind, live, with its slug occupied.
 * Nothing was logged and no counter moved, so the failed rename was
 * indistinguishable from a successful one.
 *
 * Coverage:
 *   - engine contract: updateSlug returns the number of rows moved
 *     (0 = old slug not present, i.e. the silent no-op case).
 *   - collision fallback: destination slug already occupied → updateSlug
 *     throws UNIQUE → run reconciles the stale old row after a successful
 *     import (delete-and-add semantics, same posture as the F-C
 *     rename-to-unsyncable path) and reports it in renameFallbacks.
 *   - unlocatable old row: stored slug diverged from the path-derived one
 *     AND no source_path to find it by → the duplicate cannot be safely
 *     removed, but the fallback is surfaced (warn + counter) instead of
 *     silent.
 *   - happy path: a clean git mv reports renameFallbacks 0 and keeps the
 *     page_id (no regression to the cheap rename).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const repos: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function personMd(title: string, body: string): string {
  return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
}

/** Create a temp git repo seeded with the given files + an initial commit. */
function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-3056-'));
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

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

/** Capture stderr warnings (serr falls through to console.error in tests). */
async function captureErr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, err: lines.join('\n') };
  } finally {
    console.error = origErr;
  }
}

async function countPages(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default'`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('updateSlug engine contract (#3056)', () => {
  test('returns 1 when the old slug row is moved', async () => {
    await engine.putPage('people/old', {
      type: 'person', title: 'Old', compiled_truth: 'body',
    }, { sourceId: 'default' });
    const moved = await engine.updateSlug('people/old', 'people/new', { sourceId: 'default' });
    expect(moved).toBe(1);
    expect(await engine.getPage('people/new')).not.toBeNull();
  });

  test('returns 0 when the old slug has no row (the silent no-op case)', async () => {
    const moved = await engine.updateSlug('people/ghost', 'people/new', { sourceId: 'default' });
    expect(moved).toBe(0);
  });
});

describe('#3056: failed updateSlug in the sync rename path', () => {
  test('collision: destination slug occupied → old row reconciled, fallback counted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // A pre-existing row already occupies the rename destination, so
    // updateSlug throws (source_id, slug) UNIQUE and the loop falls back.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result, err } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');

    // The failure is surfaced: counted in the run result + warned on stderr.
    expect(result.renameFallbacks).toBe(1);
    expect(err).toContain('people/carol');
    expect(err).toContain('people/dana');

    // The new path is live with the renamed file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');

    // ...and the old row did NOT stay behind as a live duplicate.
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
  });

  test('unlocatable old row: divergent stored slug with no source_path → surfaced, not silent', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Corrupt the row the way the field report describes: the stored slug no
    // longer matches the path-derived one, and there is no source_path to
    // find it by. resolveSlugsByPaths misses → the loop falls back to the
    // path-derived slug → the UPDATE matches zero rows.
    await engine.executeRaw(
      `UPDATE pages SET slug = 'people/carol-divergent', source_path = NULL
       WHERE source_id = 'default' AND slug = 'people/carol'`,
    );

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result, err } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');

    // The zero-row UPDATE is no longer invisible: counted + warned with both
    // slugs so an operator can self-diagnose (the exact diagnostic the
    // reporter asked for).
    expect(result.renameFallbacks).toBe(1);
    expect(err).toContain('people/carol');
    expect(err).toContain('people/dana');

    // The new path imported; the divergent row cannot be safely located, so
    // it remains — but the run said so instead of looking successful.
    expect(await engine.getPage('people/dana')).not.toBeNull();
    expect(await engine.getPage('people/carol-divergent')).not.toBeNull();
  });

  test('dedup-skip against the old row must NOT reconcile (codex P1): the only copy survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // frontmatter.id gives identity dedup a handle: the import at the new
    // path can skip as "identical to <old row>" — in which case NOTHING
    // landed at the destination and deleting the old row would destroy the
    // only copy of the content.
    const md = ['---', 'type: person', 'title: Carol', 'id: ext-3056', '---', '', 'Carol is a person.'].join('\n');
    const repo = mkRepo({ 'people/carol.md': md });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Destination occupied → updateSlug throws → fallback path.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));

    // The import skipped against the OLD row (identity dedup), so the
    // destination never materialized. That is a rename that never happened:
    // the run must NOT advance the bookmark as if it had (round-2 review) —
    // it lands in failedFiles and blocks, like any other unresolved file.
    expect(result.status).toBe('blocked_by_failures');
    expect(result.renameFallbacks).toBe(1);
    expect(result.failedFiles).toBe(1);

    // ...and the reconcile must not have deleted the old row, which still
    // holds the only copy of the content.
    const carol = await engine.getPage('people/carol');
    expect(carol).not.toBeNull();
    expect(carol!.compiled_truth).toContain('Carol is a person.');
  });

  test('reconcile never deletes by slug guess (codex P1): unrelated manual row survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The file's real row drifts to a divergent slug with no source_path
    // (unlocatable), and an UNRELATED manually-curated page happens to sit at
    // the path-derived slug the fallback resolution will guess.
    await engine.executeRaw(
      `UPDATE pages SET slug = 'people/carol-divergent', source_path = NULL
       WHERE source_id = 'default' AND slug = 'people/carol'`,
    );
    await engine.putPage('people/carol', {
      type: 'person', title: 'Manual Carol', compiled_truth: 'hand-authored, not from the file',
    }, { sourceId: 'default' });
    // Destination occupied → updateSlug throws UNIQUE instead of moving the
    // manual row → fallback path.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');
    expect(result.renameFallbacks).toBe(1);

    // The destination materialized with the file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    // ...but no row had source_path = from, so the reconcile deleted NOTHING:
    // the unrelated manual row at the guessed slug survives.
    const manual = await engine.getPage('people/carol');
    expect(manual).not.toBeNull();
    expect(manual!.compiled_truth).toContain('hand-authored');
  });

  test('happy path: clean git mv rename keeps page_id and reports zero fallbacks', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await engine.getPage('people/carol');
    expect(before).not.toBeNull();

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(result.renameFallbacks ?? 0).toBe(0);

    const after = await engine.getPage('people/dana');
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before!.id); // cheap-path rename preserved the row
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);

    // Round-2 review: the unchanged-file rename skips reimport, so the
    // UPDATE itself must refresh source_path — otherwise every later
    // source_path-based resolution for this row points at the old path.
    const rows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = 'people/dana'`,
    );
    expect(rows[0]?.source_path).toBe('people/dana.md');
  });

  test('reconcile failure blocks the bookmark and the next run retries to convergence', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    // Inject a transient failure into the reconcile delete.
    const origDelete = engine.deletePage.bind(engine);
    engine.deletePage = async () => { throw new Error('injected transient delete failure'); };
    let blocked;
    try {
      blocked = (await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }))).result;
    } finally {
      engine.deletePage = origDelete;
    }

    // The failed reconcile is not checkpointed past: the run blocks, the
    // bookmark stays, and the stale duplicate is still visible.
    expect(blocked.status).toBe('blocked_by_failures');
    expect(blocked.failedFiles).toBe(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Next run (failure gone) retries the same rename diff and converges.
    const { result } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(await countPages()).toBe(1);
  });
});
