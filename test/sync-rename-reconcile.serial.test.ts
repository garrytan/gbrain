/**
 * #3056 — sync rename path: a failed `updateSlug` must not leave a live
 * duplicate of the renamed page behind.
 *
 * Before the fix, the rename loop swallowed `updateSlug` failures with an
 * empty catch ("treat as add") and could not see a zero-row UPDATE at all
 * (updateSlug returned void). The run then fell through to importFile,
 * which created/updated the row at the new path — while the old row stayed
 * behind, live, with its slug occupied. Nothing was logged, no counter
 * moved, and the duplicate was permanent.
 *
 * The fix reconciles: when the cheap rename didn't move a row AND the
 * destination demonstrably materialized, the stale old row is located
 * positively by `source_path = from` and deleted. Two safety rails:
 *
 *   - dedup-skip protection: identity dedup can skip the import against
 *     the OLD row, in which case nothing landed at the destination and
 *     deleting the old row would destroy the only copy — no reconcile.
 *   - no slug-guess deletes: the stale row is found by source_path only;
 *     an unrelated row that happens to sit at the guessed slug survives.
 *
 * A failed reconcile delete lands in failedFiles so the existing failure
 * gate blocks the bookmark and the next run retries the same rename diff.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
// Serial-file requirement: blocked runs write real rows to the sync-failure
// ledger under the gbrain home — isolate it per test so the operator's
// actual ledger is never touched (GBRAIN_HOME is the isolation lever;
// process.env.HOME does not redirect Bun's os.homedir()).
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
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-3056-home-'));
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

// LIVE rows only: the assertions using this pin "no live duplicate", and
// since #4587 the reconcile SOFT-deletes the stale row (72h recovery window)
// — the row stays in the table with deleted_at set until the purge phase.
async function countPages(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`,
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

describe('#3056: rename fallback reconciles the stale old row', () => {
  test('collision: destination slug occupied → stale old row deleted after import lands', async () => {
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

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination carries the renamed file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');

    // ...and the stale old row is no longer live — no live duplicate.
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
    // #4587: the reconcile SOFT-deletes — the row is recoverable for 72h
    // (deleted_at set), not hard-deleted.
    const staleRows = await engine.executeRaw<{ deleted_at: string | Date | null }>(
      `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = 'people/carol'`,
    );
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0].deleted_at).not.toBeNull();
  });

  test('dedup-skip against the old row must NOT reconcile: the only copy survives', async () => {
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

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The import skipped against the OLD row (identity dedup), so the
    // destination never materialized with the renamed content — the
    // reconcile must not have deleted the old row, which still holds the
    // only copy.
    const carol = await engine.getPage('people/carol');
    expect(carol).not.toBeNull();
    expect(carol!.compiled_truth).toContain('Carol is a person.');
  });

  test('reconcile never deletes by slug guess: unrelated manual row survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The file's real row drifts to a divergent slug with no source_path
    // (unlocatable), and an UNRELATED manually-curated page happens to sit
    // at the path-derived slug a naive reconcile would guess.
    await engine.executeRaw(
      `UPDATE pages SET slug = 'people/carol-divergent', source_path = NULL
       WHERE source_id = 'default' AND slug = 'people/carol'`,
    );
    await engine.putPage('people/carol', {
      type: 'person', title: 'Manual Carol', compiled_truth: 'hand-authored, not from the file',
    }, { sourceId: 'default' });
    // Destination occupied → updateSlug throws UNIQUE → fallback path.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination materialized with the file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    // ...but no row had source_path = from, so the reconcile deleted
    // NOTHING: the unrelated manual row at the guessed slug survives.
    const manual = await engine.getPage('people/carol');
    expect(manual).not.toBeNull();
    expect(manual!.compiled_truth).toContain('hand-authored');
  });

  test('happy path: clean git mv rename keeps page_id and touches nothing else', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await engine.getPage('people/carol');
    expect(before).not.toBeNull();

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    const after = await engine.getPage('people/dana');
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before!.id); // cheap-path rename preserved the row
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
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

    // Inject a transient failure into the reconcile delete (#4587: the
    // reconcile soft-deletes via softDeletePages now).
    const origDelete = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async () => { throw new Error('injected transient delete failure'); };
    let blocked;
    try {
      blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      engine.softDeletePages = origDelete;
    }

    // The failed reconcile is not checkpointed past: the run blocks and the
    // stale duplicate is still visible. The failure is recorded as a
    // `<rename:…>` SENTINEL, which the auto-skip valve can never
    // chronic-skip — an outage lasting longer than the threshold must not
    // quietly bank the duplicate.
    expect(blocked.status).toBe('blocked_by_failures');
    expect(blocked.failedFiles).toBe(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openSentinels = loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(openSentinels).toHaveLength(1);

    // Next run (failure gone) retries the same rename diff and converges.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(await countPages()).toBe(1);

    // The convergence also clears the sentinel row — doctor must not keep
    // warning about a rename that has since reconciled.
    const remaining = loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(remaining).toHaveLength(0);
  });

  test('#3479: an errorless unchanged-skip AT the new slug counts as materialized — the stale row reconciles without any write', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // The destination row pre-exists AND its content_hash matches what the
    // renamed file would import to (forged via SQL to construct the shape;
    // in reality equal hashes mean byte-identical parsed content). The
    // import at the new path is then an errorless unchanged-skip at the NEW
    // slug — the one destMaterialized path where NOTHING is written.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana occupier', compiled_truth: 'occupier body, untouched by the skip',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET content_hash =
         (SELECT content_hash FROM pages WHERE source_id = 'default' AND slug = 'people/carol')
       WHERE source_id = 'default' AND slug = 'people/dana'`,
    );

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The stale old row reconciled away even though the skip wrote nothing...
    expect(await engine.getPage('people/carol')).toBeNull();
    // ...and the destination row is genuinely untouched (the skip was real).
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('occupier body');
    expect(await countPages()).toBe(1);
  });
});

describe('#3479 blocker 1: a permanent reconcile failure has a documented operator exit', () => {
  test('hard-blocks every --skip-failed run, names the gbrain delete remedy, and the remedy converges it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    // A PERMANENT delete failure (RLS denying DELETE, FK RESTRICT — an
    // environment where UPDATE still works but this DELETE never will):
    // every retry fails the same way. Capture stderr to pin that the
    // blocked message documents the operator exit, not just the retry.
    const origDelete = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async () => { throw new Error('permission denied for table pages (injected permanent failure)'); };
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const origConsoleError = console.error;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => { stderrChunks.push(args.map(String).join(' ')); origConsoleError(...args); };
    let result;
    try {
      for (let i = 0; i < 3; i++) {
        const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, skipFailed: true });
        // Structural: the sentinel hard-blocks EVEN with --skip-failed —
        // acknowledgeFailures explicitly skips sentinels, so without a
        // documented remedy this is a total sync outage.
        expect(blocked.status).toBe('blocked_by_failures');
      }
      const open = loadSyncFailures().filter(
        f => f.path === '<rename:people/dana.md>' && f.state === 'open',
      );
      expect(open).toHaveLength(1);
      expect(open[0].attempts).toBeGreaterThanOrEqual(3);

      // The documented remedy — exercised faithfully: `gbrain delete` is a
      // SOFT-delete (the row keeps its source_path until the purge phase),
      // and the environment's DELETE is STILL denied (the mock stays
      // active). Convergence therefore requires the reconcile to treat a
      // soft-deleted stale row as "nothing left to delete" instead of
      // re-attempting the hard delete that keeps failing here.
      expect(await engine.softDeletePage('people/carol', { sourceId: 'default' })).not.toBeNull();
      result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      process.stderr.write = origWrite;
      console.error = origConsoleError;
      engine.softDeletePages = origDelete;
    }
    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain("'gbrain delete <stale-slug>'");
    // The error names the exact stale slug the remedy should target
    // (JSON-quoted — the format is machine-parsed by the orphan probe).
    expect(stderrText).toContain('stale row "people/carol" for "people/carol.md" not removed');
    expect(result.status).toBe('synced');
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    )).toHaveLength(0);
  });
});

describe('#3479 blocker 2: an orphaned rename sentinel self-clears; a real duplicate never does', () => {
  test('force-push invalidates the pin: sentinel clears once the stale row is gone, stays open while it is real', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openRenameRows = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );

    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    const preRenameCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Rename with a failing reconcile → open sentinel, bookmark blocked.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });
    const origDelete = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async () => { throw new Error('injected transient delete failure'); };
    try {
      const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(blocked.status).toBe('blocked_by_failures');
    } finally {
      engine.softDeletePages = origDelete;
    }
    expect(openRenameRows()).toHaveLength(1);

    // FORCE-PUSH: history is rewritten to BEFORE the rename (carol.md is
    // back in the tree, the rename commit is gone) and moves on with an
    // unrelated add — the rename never re-enters any diff, so the ordinary
    // convergence path can now never fire for it, and the banked pin is
    // invalidated. This is the reviewer's orphaning shape.
    execSync(`git reset --hard ${preRenameCommit}`, { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'people/dana.md'), personMd('Dana', 'A fresh, unrelated dana file.'));
    execSync('git add -A && git commit -m "fresh dana on rewritten history"', { cwd: repo, stdio: 'pipe' });

    // FAIL-CLOSED CONTROL: the stale duplicate row still resolves (carol.md
    // is untouched by the new diff), so the sentinel must survive however
    // many syncs run — auto-clearing here would silently drop the only
    // signal that a real duplicate exists.
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(openRenameRows()).toHaveLength(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // The duplicate disappears — via the operator's actual tool, `gbrain
    // delete` (a SOFT-delete: the row keeps its source_path). The sentinel
    // now guards nothing live: the next run — even a quiet up_to_date one,
    // the reviewer's exact probe shape — self-clears it.
    expect(await engine.softDeletePage('people/carol', { sourceId: 'default' })).not.toBeNull();
    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(openRenameRows()).toHaveLength(0);
  });
});

describe('#3479: rename sentinel error format round-trips', () => {
  test('parseRenameReconcileFrom inverts renameReconcileErrorMessage for awkward paths', async () => {
    const { renameReconcileErrorMessage, parseRenameReconcileFrom } =
      await import('../src/core/sync-failure-ledger.ts');
    const awkward = [
      'people/carol.md',
      'dir with spaces/x y.md',
      'a(b)/weird):.md',
      // The delimiter-collision counterexample (#3479 codex review): a raw
      // interpolation would truncate this at its embedded ' not removed): '
      // and hand the orphan probe a WRONG path — JSON-quoting makes the
      // span self-delimiting.
      'dir/a not removed): b.md',
      'quotes "inside" and \\backslash\\.md',
      'ユニコード/パス.md',
    ];
    for (const from of awkward) {
      for (const slug of ['people/carol', undefined]) {
        const err = renameReconcileErrorMessage(from, slug, 'boom: nested (cause) text not removed): decoy');
        expect(parseRenameReconcileFrom(err)).toBe(from);
      }
    }
  });

  test('anything else parses to undefined (fail-closed: never auto-clear on a misread)', async () => {
    const { parseRenameReconcileFrom } = await import('../src/core/sync-failure-ledger.ts');
    expect(parseRenameReconcileFrom('some legacy error text')).toBeUndefined();
    expect(parseRenameReconcileFrom('')).toBeUndefined();
    expect(parseRenameReconcileFrom('rename reconcile failed (stale row "x" for "unterminated): boom')).toBeUndefined();
  });

  test('the PRE-#3479 unquoted shape parses when unambiguous, and only then', async () => {
    const { renameReconcileErrorMessage, parseRenameReconcileFrom } =
      await import('../src/core/sync-failure-ledger.ts');
    // Anyone wedged by #3056 before upgrading carries this shape. Refusing to
    // read it leaves exactly those operators wedged forever (review: the fix
    // is incomplete for them).
    expect(parseRenameReconcileFrom(
      'rename reconcile failed (stale row for people/x.md not removed): boom',
    )).toBe('people/x.md');
    // Ambiguity is the reason #3479 started JSON-encoding the slot: a raw
    // interpolation is undecidable once the delimiter appears twice, whether
    // it came from the path or from the cause. Both still fail closed.
    expect(parseRenameReconcileFrom(
      'rename reconcile failed (stale row for weird not removed): path.md not removed): boom',
    )).toBeUndefined();
    expect(parseRenameReconcileFrom(
      'rename reconcile failed (stale row for people/x.md not removed): cause not removed): tail',
    )).toBeUndefined();
    // An empty path slot names nothing to probe.
    expect(parseRenameReconcileFrom(
      'rename reconcile failed (stale row for  not removed): boom',
    )).toBeUndefined();
    // The current format is never read as legacy — the slug slot is in the way.
    const current = renameReconcileErrorMessage('people/y.md', 'people/y', 'boom');
    expect(parseRenameReconcileFrom(current)).toBe('people/y.md');
    const noSlug = renameReconcileErrorMessage('people/z.md', undefined, 'boom');
    expect(parseRenameReconcileFrom(noSlug)).toBe('people/z.md');
  });
});

describe('#3479: non-unique source_path — a soft-deleted row must not mask a live duplicate', () => {
  test('sentinel survives while ANY active row still carries the old path; reconcile removes every stale active one and spares the live row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openRenameRows = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    const repo = mkRepo({
      'people/carol.md': personMd('Carol', 'Carol is a person.'),
      'people/erin.md': personMd('Erin', 'Erin is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A SECOND row sharing source_path=people/carol.md (non-unique index):
    // one active, plus a soft-deleted decoy that a one-row resolve could
    // hand back first — masking the live duplicate behind a null getPage.
    await engine.putPage('people/carol-duplicate', {
      type: 'person', title: 'Carol (dup)', compiled_truth: 'second row for the same file',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/carol-duplicate'`,
    );
    // A LIVE row also sharing the old path — the bookkeeping a prior cheap
    // rename leaves behind (updateSlug never rewrites source_path). Its
    // backing file people/erin.md is in the working tree, so the widened
    // delete must NOT touch it (#3583 review, the data-loss blocker).
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/erin'`,
    );
    await engine.putPage('people/carol-decoy', {
      type: 'person', title: 'Carol (decoy)', compiled_truth: 'soft-deleted decoy sharing the path',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/carol-decoy'`,
    );
    expect(await engine.softDeletePage('people/carol-decoy', { sourceId: 'default' })).not.toBeNull();

    // Rename with a failing delete → open sentinel.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });
    const origDelete = engine.softDeletePages.bind(engine);
    engine.softDeletePages = async () => { throw new Error('injected transient delete failure'); };
    try {
      const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(blocked.status).toBe('blocked_by_failures');
    } finally {
      engine.softDeletePages = origDelete;
    }
    expect(openRenameRows()).toHaveLength(1);

    // Convergence must remove BOTH genuinely-stale active rows carrying the
    // old path — a single-row reconcile would leave one behind with the
    // rename already checkpointed, never to be retried. The LIVE erin row
    // (backed by people/erin.md in the working tree) must survive.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await engine.getPage('people/carol-duplicate')).toBeNull();
    const erin = await engine.getPage('people/erin');
    expect(erin).not.toBeNull();
    expect(erin!.compiled_truth).toContain('Erin is a person.');
    expect(openRenameRows()).toHaveLength(0);
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
  });
});

describe('#3583 review: a live page sharing the stale source_path survives the reconcile', () => {
  test('a LEGACY row still carrying an old source_path is not deleted by a later occupied-destination rename', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha original body.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();

    // Ordinary cheap rename alpha -> beta. The cheap rename now repairs
    // source_path at the moment it lands (GATE13), so recreate the LEGACY
    // bookkeeping a pre-fix brain still carries: the live beta row naming
    // the OLD path. That legacy shape is the precondition that made the
    // widened source_path delete a data-loss bug (#3583 review).
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "cheap rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/beta'`,
    );
    const betaRows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
        WHERE source_id = 'default' AND slug = 'people/beta' AND deleted_at IS NULL`,
    );
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0].source_path).toBe('people/alpha.md');

    // An unrelated NEW file appears at the old path — two active rows now
    // share source_path=people/alpha.md.
    writeFileSync(join(repo, 'people/alpha.md'), personMd('Alpha II', 'A fresh, unrelated alpha.'));
    execSync('git add -A && git commit -m "new unrelated alpha"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();
    expect(await engine.getPage('people/beta')).not.toBeNull();

    // Rename the recreated alpha into an OCCUPIED destination (the #3056
    // fallback this reconcile exists for). Only the recreated-alpha row is
    // genuinely stale; beta is a live page whose backing file is present in
    // the working tree.
    await engine.putPage('people/gamma', {
      type: 'person', title: 'Gamma occupier', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/gamma.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha into occupied gamma"', { cwd: repo, stdio: 'pipe' });
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination carries the recreated file's content...
    const gamma = await engine.getPage('people/gamma');
    expect(gamma).not.toBeNull();
    expect(gamma!.compiled_truth).toContain('A fresh, unrelated alpha.');
    // ...the genuinely-stale row (recreated alpha, file gone) is removed...
    expect(await engine.getPage('people/alpha')).toBeNull();
    // ...and the LIVE beta page survives with its content intact.
    const beta = await engine.getPage('people/beta');
    expect(beta).not.toBeNull();
    expect(beta!.compiled_truth).toContain('Alpha original body.');

    // The very next sync is quiet and beta is still alive — the review's
    // loss was permanent precisely because no incremental sync healed it.
    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(await engine.getPage('people/beta')).not.toBeNull();
  });
});

const openDanaRows = async () => {
  const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
  return loadSyncFailures().filter(
    f => f.path === '<rename:people/dana.md>' && f.state === 'open',
  );
};

/** Plant one open, ORPHANED `<rename:…>` sentinel (its old path has no
 * active row) — exactly what the self-heal sweep would clear, which is
 * why a preview must not run the sweep. */
async function plantOrphanedSentinel(): Promise<void> {
  const { recordFailures, renameSentinelPath, renameReconcileErrorMessage } =
    await import('../src/core/sync-failure-ledger.ts');
  recordFailures('default', [{
    path: renameSentinelPath('people/dana.md'),
    error: renameReconcileErrorMessage('people/dana-old.md', 'people/dana-old', 'injected wedge'),
  }], 'deadbeef');
}

describe('#3583 review: --dry-run must not rewrite the failure ledger', () => {

  test('quiet-repo dry run reports up_to_date and leaves the open sentinel untouched; the real run still self-heals it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Byte-identical, not just semantically-open: a preview must not touch
    // the ledger file at all (a rewrite that happened to preserve the open
    // row would still pass a rows-only assertion).
    const { syncFailuresPath } = await import('../src/core/sync-failure-ledger.ts');
    const { readFileSync: readLedger } = await import('node:fs');
    const ledgerBefore = readLedger(syncFailuresPath(), 'utf-8');

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('up_to_date');
    // The operator's only wedge signal survives the preview.
    expect(await openDanaRows()).toHaveLength(1);
    expect(readLedger(syncFailuresPath(), 'utf-8')).toBe(ledgerBefore);

    // Control: the same quiet run WITHOUT --dry-run self-heals the orphan.
    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await openDanaRows()).toHaveLength(0);
  });

  test('totalChanges==0 sweep site: git advanced with no syncable changes — dry run preserves the row, the real run clears it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Advance git HEAD with a change the markdown strategy filters out, so
    // the run reaches the totalChanges==0 early return (not the
    // HEAD-equality one).
    writeFileSync(join(repo, 'notes.txt'), 'not syncable under the markdown strategy');
    execSync('git add -A && git commit -m "non-syncable change"', { cwd: repo, stdio: 'pipe' });

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(await openDanaRows()).toHaveLength(1);

    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await openDanaRows()).toHaveLength(0);
  });

  test('performFullSync pre-gate probe: a full sync self-heals an orphaned sentinel', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/carol')).not.toBeNull();
    expect(await openDanaRows()).toHaveLength(0);
  });
});

// A markdown file whose PATH derives no slug (emoji filename) imports
// under its frontmatter `slug:` (#598). Such a live row's slug is NOT
// path-derivable, so a tracked-file index built from resolveSlugForPath
// alone would miss it and misclassify the row as stale — the same
// data-loss shape as the ordinary cheap-rename case, one regime deeper.
// Mixed-case on purpose: importFromContent normalizes through
// validateSlug (lowercase), so the row is stored as `party-notes` — an
// index that carried the raw frontmatter casing would miss it and
// delete the live row all the same.
const exoticMd = [
  '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
  '', 'Party notes live here.',
].join('\n');

async function setupExoticScenario(): Promise<string> {
  const { performSync } = await import('../src/commands/sync.ts');
  const repo = mkRepo({
    '\u{1F389}.md': exoticMd,
    'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
  });
  await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
  const party = await engine.getPage('party-notes');
  expect(party).not.toBeNull();
  expect(party!.compiled_truth).toContain('Party notes live here.');

  // Manufacture the stale bookkeeping a prior cheap rename leaves behind:
  // the LIVE party-notes row (backed by the tracked emoji file) carries
  // the old path of the rename below. A genuinely-stale ghost row shares
  // the same path as the inverse control — it has no backing file and
  // MUST still be deleted.
  await engine.executeRaw(
    `UPDATE pages SET source_path = 'people/alpha.md'
     WHERE source_id = 'default' AND slug = 'party-notes'`,
  );
  await engine.putPage('people/ghost', {
    type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
  }, { sourceId: 'default' });
  await engine.executeRaw(
    `UPDATE pages SET source_path = 'people/alpha.md'
     WHERE source_id = 'default' AND slug = 'people/ghost'`,
  );

  // Occupied destination forces the fallback-to-add reconcile with
  // from=people/alpha.md.
  await engine.putPage('people/beta', {
    type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
  }, { sourceId: 'default' });
  execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
  return repo;
}

describe('#3583 review: frontmatter-fallback (CJK-wave) live rows survive the reconcile', () => {
  test('emoji-filename row with a frontmatter slug is spared; the stale ghost sharing the path is still deleted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The frontmatter-fallback row is LIVE (its emoji file is tracked and
    // still derives to party-notes through the import path) — it survives.
    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');

    // Inverse control: the ghost row sharing the same stale path has no
    // backing file — the widened reconcile still removes it.
    expect(await engine.getPage('people/ghost')).toBeNull();

    // And the rename itself converged.
    const beta = await engine.getPage('people/beta');
    expect(beta).not.toBeNull();
    expect(beta!.compiled_truth).toContain('Alpha is a person.');
  });

  test('sparse-checkout shape: the emoji file absent from the working tree still resolves through the git index blob', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    // Simulate a sparse/partial checkout: the file is tracked (in the git
    // index) but its working-tree copy is absent. The uncommitted disk
    // deletion never enters the commit diff, so sync does not see it as a
    // delete — but a naive on-disk read would now fail, and liveness must
    // fall through to the index blob.
    rmSync(join(repo, '\u{1F389}.md'));

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');
    expect(await engine.getPage('people/ghost')).toBeNull();
  });
});

// Post-review fix: trackedSlugIndex must enumerate the SAME set of files as
// collectSyncableFiles (tracked + untracked-not-ignored via
// `git ls-files --cached --others --exclude-standard`), not tracked-only
// (`git ls-files`). Before the fix, a fallback-regime file that was on disk
// and already imported by full sync — but never `git add`-ed — had a slug
// full sync knew about and trackedSlugIndex did not. Any rename reconcile
// running afterward would treat the missing index entry as proof of
// staleness and hard-delete the file's LIVE page.
describe('#3583 follow-up: an untracked (unstaged) fallback-regime file survives the reconcile', () => {
  async function setupUntrackedExoticScenario(): Promise<string> {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });

    // Write the frontmatter-fallback file WITHOUT staging or committing it.
    // `collectSyncableFiles`'s git-aware fast path (`--cached --others
    // --exclude-standard`) still imports it; a bare `git ls-files` would not
    // list it at all.
    writeFileSync(join(repo, '\u{1F389}.md'), exoticMd);

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');

    // Same stale-bookkeeping shape as setupExoticScenario: force the LIVE
    // party-notes row onto the upcoming rename's `from` path so the
    // reconcile treats it as a candidate.
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
    return repo;
  }

  test('an unstaged emoji-filename file that collectSyncableFiles already imported is not misclassified as stale', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupUntrackedExoticScenario();

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The emoji file is real, on disk, still deriving to party-notes — it
    // was simply never `git add`-ed. It must survive the reconcile.
    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');

    // The rename itself still converged.
    const beta = await engine.getPage('people/beta');
    expect(beta).not.toBeNull();
    expect(beta!.compiled_truth).toContain('Alpha is a person.');
  });
});

// Scope note: "persistent state" here means the BRAIN's state (DB rows,
// checkpoints, the failure ledger). The internal `git pull` a preview runs
// without --no-pull mutates the operator's REPO and is longstanding
// upstream behavior with its own knob — out of this suite's scope.
describe('#3583 review: --dry-run must not mutate persistent brain state', () => {
  test('quiet named-source dry run leaves the last_sync_at heartbeat untouched; the real run bumps it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    // The heartbeat UPDATE targets the sources row; create it the way
    // `gbrain sources add` would so the quiet-run UPDATE has a target.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('default', 'default') ON CONFLICT (id) DO NOTHING`,
    );
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = '2000-01-01T00:00:00Z' WHERE id = 'default'`,
    );
    const heartbeat = async (): Promise<string | undefined> => {
      const rows = await engine.executeRaw<{ t: string }>(
        `SELECT last_sync_at::text AS t FROM sources WHERE id = 'default'`,
      );
      return rows[0]?.t;
    };
    const pinned = await heartbeat();
    expect(pinned).toContain('2000-01-01');

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('up_to_date');
    // A preview that bumps the freshness heartbeat masks real staleness
    // from doctor — it must stay pinned.
    expect(await heartbeat()).toBe(pinned);

    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await heartbeat()).not.toBe(pinned);
  });

  test('a preview under a narrower strategy must not hard-delete the now-un-syncable page; the real run still does', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Modify + commit so the file enters manifest.modified; under
    // strategy=code it is then "modified but un-syncable" — the cleanup
    // class that used to be hard-deleted BEFORE the dry-run return.
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol updated body.'));
    execSync('git add -A && git commit -m "update carol"', { cwd: repo, stdio: 'pipe' });

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, strategy: 'code', dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Control: the real run keeps the pre-existing cleanup behavior.
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS, strategy: 'code' });
    expect(await engine.getPage('people/carol')).toBeNull();
  });
});

describe('#3583 review: orphan-sentinel self-heal probe/clear race', () => {
  test('an active row materializing between the two probes keeps the sentinel open', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Simulate a writer outside the sync lock (a raw import, restore_page)
    // committing an active row with the sentinel's old path IMMEDIATELY
    // after the first orphan probe returned "no active row". The second
    // probe must see it and keep the sentinel open — a single-probe sweep
    // cleared it while the duplicate existed.
    const origExecuteRaw = engine.executeRaw.bind(engine);
    let probeCalls = 0;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        const res = await origExecuteRaw(sql, params);
        if (sql.includes('source_path = ANY')) {
          probeCalls++;
          if (probeCalls === 1) {
            await engine.putPage('people/dana-old-revenant', {
              type: 'person', title: 'Dana (revenant)',
              compiled_truth: 'materialized between probe and clear',
            }, { sourceId: 'default' });
            await origExecuteRaw(
              `UPDATE pages SET source_path = 'people/dana-old.md'
               WHERE source_id = 'default' AND slug = 'people/dana-old-revenant'`,
            );
          }
        }
        return res;
      }) as typeof engine.executeRaw;
    try {
      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(result.status).toBe('up_to_date');
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }

    // The duplicate is real, so its sentinel survives...
    expect(await openDanaRows()).toHaveLength(1);
    // ...and the double-probe actually ran (this assertion fails on a
    // single-probe implementation even before the survival check does).
    expect(probeCalls).toBe(2);
  });
});

describe('#3583 review: an over-size-gate fallback-regime file suspends deletes instead of losing the row', () => {
  test('a live row whose emoji file grew past the import size gate is spared as unknown (and so is everything else)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Import while the file is comfortably under the 5MB gate...
    const repo = mkRepo({
      '\u{1F389}.md': [
        '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
        '', 'Party notes live here.',
      ].join('\n'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // ...then the file grows past the gate. Uncommitted on purpose: the
    // growth never enters the commit diff (no import attempt, no ledger
    // noise), but the liveness index reads the WORKING TREE — where the
    // file now sits over the gate. Concluding "no row possible" from the
    // current size would delete the row imported before the growth.
    const bigBody = 'x'.repeat(5_100_000);
    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
      '', bigBody,
    ].join('\n'));

    // Same stale-bookkeeping + ghost construction as the main exotic test.
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The live row survives — its slug could not be read, so staleness is
    // unprovable and the miss is spared, never deleted.
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Deliberate, documented cost of the incomplete index: the genuinely
    // stale ghost is ALSO spared this run (no delete without proof).
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });

  test('R4_UNKNOWN_CLEARS_A_PRIOR_SENTINEL: an unprovable retry must not retire a rename an earlier run left open', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { recordFailures, renameSentinelPath, renameReconcileErrorMessage, loadSyncFailures } =
      await import('../src/core/sync-failure-ledger.ts');
    const repo = mkRepo({
      '\u{1F389}.md': [
        '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
        '', 'Party notes live here.',
      ].join('\n'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const anchorBefore = (await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    ))[0]?.last_commit;

    // An EARLIER run already failed to reconcile this very rename.
    recordFailures('default', [{
      path: renameSentinelPath('people/beta.md'),
      error: renameReconcileErrorMessage('people/alpha.md', 'people/ghost', 'injected prior denial'),
    }], 'deadbeef');

    // Now make the tracked-slug index incomplete, exactly as above.
    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
      '', 'x'.repeat(5_100_000),
    ].join('\n'));
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The sentinel is the operator's only record that this rename never
    // converged. 'unprovable' is not proof of convergence, so it survives...
    const stillOpen = loadSyncFailures().filter(
      f => f.path === renameSentinelPath('people/beta.md') && f.state === 'open',
    );
    expect(stillOpen).toHaveLength(1);
    // ...and it must NOT name an unprovable row as the stale one: that slug
    // feeds the operator remedy (`gbrain delete <slug>`), and an unprovable
    // row may be live — exactly the row this path refused to delete.
    expect(stillOpen[0]?.error).toContain('stale row ? for');
    for (const slug of ['party-notes', 'people/ghost', 'people/alpha']) {
      expect(stillOpen[0]?.error).not.toContain(`stale row "${slug}"`);
    }
    // ...the run does not report a clean sync...
    expect(result.status).not.toBe('synced');
    // ...the bookmark does not advance past the unresolved rename...
    const anchorAfter = (await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    ))[0]?.last_commit;
    expect(anchorAfter).toBe(anchorBefore);
    // ...and nothing was deleted without proof.
    expect(await engine.getPage('party-notes')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: both content states prove liveness — working tree AND index blob', () => {
  test('an uncommitted edit that removes the slug: line must not un-prove the imported row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    // Uncommitted working-tree edit removes `slug:` — the WORKING TREE now
    // derives nothing, but the row was imported from the COMMITTED content,
    // which still names party-notes. Deleting on the working tree alone
    // loses the row.
    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here (slug line temporarily removed).',
    ].join('\n'));

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Proof stayed intact (the blob answered), so the true ghost is still deleted.
    expect(await engine.getPage('people/ghost')).toBeNull();
  });

  test('an extensionless exotic file imports under its frontmatter slug and must count as live', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { importFromFile } = await import('../src/core/import-file.ts');
    const repo = mkRepo({
      '\u{1F389}': [
        '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
        '', 'Party notes live here.',
      ].join('\n'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Sync's walker does not import the extensionless file, but the direct
    // import path does — importFromFile has NO extension gate, and the path
    // derives no slug, so the frontmatter fallback fires.
    const imported = await importFromFile(
      engine, join(repo, '\u{1F389}'), '\u{1F389}', { sourceId: 'default', noEmbed: true },
    );
    expect(imported.status).toBe('imported');
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
  });

  test('a tracked markdown symlink is never followed: its out-of-repo target cannot prove liveness', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const external = mkdtempSync(join(tmpdir(), 'gbrain-3583-external-'));
    repos.push(external);
    const externalTarget = join(external, 'outside.md');
    writeFileSync(externalTarget, [
      '---', 'type: person', 'title: Outside', 'slug: outside-probe', '---',
      '', 'This file is outside the repository.',
    ].join('\n'));
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha is a person.') });
    symlinkSync(externalTarget, join(repo, '\u{1F389}.md'));
    execSync('git add -A', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "add symlink"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A row named by the TARGET's frontmatter slug, wearing the stale path
    // of the rename below. Import refuses symlinks, so no in-repo file can
    // legitimately back this row — the index must treat the symlink as its
    // blob (the target path text, which derives nothing) and let the row
    // be reconciled, NOT follow the link out of the repository and spare it.
    await engine.putPage('outside-probe', {
      type: 'person', title: 'Outside (stale)', compiled_truth: 'no in-repo backing file',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'outside-probe'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('outside-probe')).toBeNull();
  });

  test('absent working copy plus unmerged index makes the fallback index incomplete and spares every miss', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    // Replace the emoji file's stage-0 index entry with unmerged stage-1/2
    // entries and remove the working copy: neither content state is
    // readable, so no slug can be proven and NOTHING may be deleted.
    const stageZero = execSync('git ls-files -s -- "\u{1F389}.md"', {
      cwd: repo, stdio: 'pipe',
    }).toString();
    const blob = stageZero.trim().split(/\s+/)[1];
    expect(blob).toBeTruthy();
    execSync('git update-index --force-remove -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    execSync('git update-index --index-info', {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
      input:
        `100644 ${blob} 1\t\u{1F389}.md\n` +
        `100644 ${blob} 2\t\u{1F389}.md\n`,
    });
    rmSync(join(repo, '\u{1F389}.md'));

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Incomplete index: even the true ghost is spared this run.
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });

  test('unreachable checkpoint rows survive dry-run and are cleared by the real run', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadOpCheckpoint, recordCompleted, syncFingerprint } =
      await import('../src/core/op-checkpoint.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const anchor = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();

    writeFileSync(join(repo, 'people/old-line.md'), personMd('Old line', 'old history'));
    execSync('git add -A && git commit -m "old line"', { cwd: repo, stdio: 'pipe' });
    const unreachableTarget =
      execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    // Rewind to the anchor and diverge — the recorded target becomes
    // unreachable from the new history line (temp repo, nothing of value
    // is discarded).
    execSync(`git reset --hard ${anchor}`, { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'people/new-line.md'), personMd('New line', 'new history'));
    execSync('git add -A && git commit -m "new line"', { cwd: repo, stdio: 'pipe' });

    const fingerprint = syncFingerprint({ sourceId: 'default', lastCommit: anchor });
    const pathsKey = { op: 'sync', fingerprint };
    const targetKey = { op: 'sync-target', fingerprint };
    await recordCompleted(engine, pathsKey, ['people/already-done.md']);
    await recordCompleted(engine, targetKey, [unreachableTarget]);

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(await loadOpCheckpoint(engine, pathsKey)).toEqual(['people/already-done.md']);
    expect(await loadOpCheckpoint(engine, targetKey)).toEqual([unreachableTarget]);

    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('synced');
    expect(await loadOpCheckpoint(engine, pathsKey)).toEqual([]);
    expect(await loadOpCheckpoint(engine, targetKey)).toEqual([]);
  });
});

describe('#3583 review: a writer landing AFTER the second probe gets its sentinel restored', () => {
  test('clear-then-verify detects the post-probe row and re-records the sentinel', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Both orphan probes see "no active row" — the writer lands only AFTER
    // the second probe returned, i.e. after the double-probe verdict is
    // final and the clear is committed. The post-clear verify probe must
    // detect the row and RESTORE the sentinel.
    const origExecuteRaw = engine.executeRaw.bind(engine);
    let probeCalls = 0;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        const res = await origExecuteRaw(sql, params);
        if (sql.includes('source_path = ANY')) {
          probeCalls++;
          if (probeCalls === 2) {
            await engine.putPage('people/dana-old-late-writer', {
              type: 'person', title: 'Dana (late writer)',
              compiled_truth: 'materialized after the second probe',
            }, { sourceId: 'default' });
            await origExecuteRaw(
              `UPDATE pages SET source_path = 'people/dana-old.md'
               WHERE source_id = 'default' AND slug = 'people/dana-old-late-writer'`,
            );
          }
        }
        return res;
      }) as typeof engine.executeRaw;
    try {
      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(result.status).toBe('up_to_date');
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }

    // Probe #1 and #2 (orphan verdict) + probe #3 (post-clear verify).
    expect(probeCalls).toBe(3);
    expect(await engine.getPage('people/dana-old-late-writer')).not.toBeNull();
    // The duplicate is real again — the verify probe restored its sentinel.
    expect(await openDanaRows()).toHaveLength(1);
  });
});

describe('#3583 review: HEAD keeps proving liveness through a STAGED uncommitted edit', () => {
  test('staging the slug-line removal changes the working tree AND the staging index — HEAD still spares the row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    // Remove the slug: line AND stage it (no commit): the working tree and
    // the staging-index blob now both derive nothing — only HEAD still
    // carries the slug the imported row was created from.
    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here (slug line removed and STAGED).',
    ].join('\n'));
    execSync('git add -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Proof intact through HEAD — the true ghost is still deleted.
    expect(await engine.getPage('people/ghost')).toBeNull();
  });
});

describe('#3583 review: the failure-gate clear paths also verify-and-restore', () => {
  test('incremental gate: a writer landing after the orphan verdict gets its sentinel restored post-gate', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // A COMMITTED unrelated change routes the run through the import path
    // and the failure GATE (not the quiet-run sweep) — the gate's clear of
    // the orphaned sentinel used to skip post-clear verification entirely.
    writeFileSync(join(repo, 'people/newfile.md'), personMd('New', 'New person.'));
    execSync('git add -A && git commit -m "unrelated addition"', { cwd: repo, stdio: 'pipe' });

    const origExecuteRaw = engine.executeRaw.bind(engine);
    let probeCalls = 0;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        const res = await origExecuteRaw(sql, params);
        if (sql.includes('source_path = ANY')) {
          probeCalls++;
          if (probeCalls === 2) {
            // After the double-probe verdict is final, before the gate clears.
            await engine.putPage('people/dana-old-gate-writer', {
              type: 'person', title: 'Dana (gate writer)',
              compiled_truth: 'materialized between the gate verdict and the clear',
            }, { sourceId: 'default' });
            await origExecuteRaw(
              `UPDATE pages SET source_path = 'people/dana-old.md'
               WHERE source_id = 'default' AND slug = 'people/dana-old-gate-writer'`,
            );
          }
        }
        return res;
      }) as typeof engine.executeRaw;
    try {
      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(result.status).toBe('synced');
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }

    expect(await engine.getPage('people/dana-old-gate-writer')).not.toBeNull();
    // The post-gate verify probe restored the sentinel.
    expect(await openDanaRows()).toHaveLength(1);
  });

  test('a verify probe that THROWS after the clear restores every cleared sentinel (fail-closed), verbatim', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { recordFailures, renameSentinelPath, renameReconcileErrorMessage } =
      await import('../src/core/sync-failure-ledger.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Plant the orphan TWICE so attempts climbs to 2 — the restore must
    // reproduce the row verbatim, not restart the streak at attempts 1.
    const plant = () => recordFailures('default', [{
      path: renameSentinelPath('people/dana.md'),
      error: renameReconcileErrorMessage('people/dana-old.md', 'people/dana-old', 'injected wedge'),
    }], 'deadbeef');
    plant();
    plant();
    const before = (await openDanaRows())[0];
    expect(before).toBeDefined();
    expect(before!.attempts).toBe(2);

    // Both orphan probes succeed (empty) → clear commits; the post-clear
    // VERIFY probe (third matching SELECT) throws. Fail-closed means every
    // cleared sentinel comes back.
    const origExecuteRaw = engine.executeRaw.bind(engine);
    let probeCalls = 0;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        if (sql.includes('source_path = ANY')) {
          probeCalls++;
          if (probeCalls === 3) throw new Error('injected verify-probe outage');
        }
        return origExecuteRaw(sql, params);
      }) as typeof engine.executeRaw;
    try {
      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(result.status).toBe('up_to_date');
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }

    expect(probeCalls).toBe(3);
    const rows = await openDanaRows();
    expect(rows).toHaveLength(1);
    // Verbatim restore: streak metadata survives the round trip.
    expect(rows[0]!.attempts).toBe(2);
    expect(rows[0]!.first_seen).toBe(before!.first_seen);
    expect(rows[0]!.commit).toBe(before!.commit);
  });
});

describe('#3583 review: the anchor commit keeps proving liveness when HEAD moved past it', () => {
  test('a single commit that removes the slug: line AND carries the colliding rename must not delete the row imported at the anchor', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      '\u{1F389}.md': exoticMd,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    // ONE commit does both: the emoji file loses its slug: line (its
    // re-import will fail with "produces no usable slug") AND the rename
    // that triggers the reconcile lands. Working tree, staging index, and
    // HEAD all show the slugless content — only the ANCHOR commit (what
    // the brain actually reflects) still proves the row.
    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here (slug line removed at HEAD).',
    ].join('\n'));
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "remove slug and rename in one commit"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // The emoji file's re-import fails (no usable slug), so the run blocks —
    // and the reconcile that ran within it must NOT have deleted the row.
    expect(result.status).toBe('blocked_by_failures');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // The true ghost is still gone: the anchor state answered, proof intact.
    expect(await engine.getPage('people/ghost')).toBeNull();
  });
});

describe('#3583 review: a throwing bookmark advance can no longer lose a sentinel', () => {
  test('the orphan sweep sits outside the gate: advance() throwing leaves the sentinel untouched', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // A committed change routes the run through the gate; the injected
    // failure makes the bookmark advance throw AFTER the gate's internal
    // record/clear pass. The orphaned sentinel must survive: its clear
    // lives OUTSIDE the gate now, and is never reached on a throw.
    writeFileSync(join(repo, 'people/newfile.md'), personMd('New', 'New person.'));
    execSync('git add -A && git commit -m "unrelated addition"', { cwd: repo, stdio: 'pipe' });

    const origExecuteRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE sources SET last_commit')) {
          throw new Error('injected advance outage');
        }
        return origExecuteRaw(sql, params);
      }) as typeof engine.executeRaw;
    let threw = false;
    try {
      await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } catch {
      threw = true;
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }
    expect(threw).toBe(true);

    // Fail-closed: nothing cleared, nothing lost.
    expect(await openDanaRows()).toHaveLength(1);
  });
});

describe('#3583 review: the anchor tree is enumerated on its own paths, not looked up through current ones', () => {
  test('renaming the exotic file itself (while dropping its slug) must not lose the anchor-imported row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      '\u{1F389}.md': exoticMd,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    // ONE commit renames the exotic file to a NEW exotic path, drops its
    // slug: line, and carries the colliding rename. The anchor's content
    // for the row now lives at the OLD path — a liveness pass that only
    // queries the anchor through CURRENT paths misses it entirely (and
    // still believes its index is complete).
    execSync('git mv "\u{1F389}.md" "\u{2728}.md"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, '\u{2728}.md'), [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here (renamed and slug line dropped).',
    ].join('\n'));
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "rename exotic file, drop slug, rename alpha"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // The exotic file's re-import fails (no usable slug at its new path),
    // so the run blocks — and the reconcile inside it must NOT have
    // deleted the anchor-imported row.
    expect(result.status).toBe('blocked_by_failures');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // The anchor tree answered, proof stays intact: the ghost is still gone.
    expect(await engine.getPage('people/ghost')).toBeNull();
  });
});

describe('#3583 review: GATE6 — the three anchor-enumeration refutations', () => {
  test('a row carried by ANOTHER rename in the diff (ordinary path renamed to a slugless exotic path) survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'notes/party.md': personMd('Party', 'Party content lives here.'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('notes/party')).not.toBeNull();

    // Stale bookkeeping from a prior cheap rename + the usual ghost/occupier.
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'notes/party'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    // ONE commit renames notes/party.md to an exotic path (derives no slug,
    // carries no frontmatter slug — its re-import will fail) AND carries the
    // colliding alpha rename. No current path, blob, or anchor FALLBACK
    // state names notes/party anymore — only the rename pair itself proves
    // the content is still tracked.
    execSync('git mv notes/party.md "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "carry party to an exotic path; rename alpha"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('blocked_by_failures');
    expect(await engine.getPage('notes/party')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).toBeNull();
  });

  test('a leading-space filename survives NUL-delimited listing intact (no trim corruption, no decoy read)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      // Sorts FIRST in every listing — the entry a trimmed NUL-joined
      // string corrupts. Its decoy (same name minus the space) carries a
      // DIFFERENT slug; a corrupted read would register the decoy's slug
      // twice and never party-notes.
      ' \u{1F389}.md': [
        '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
        '', 'Party notes live here.',
      ].join('\n'),
      '\u{1F389}.md': [
        '---', 'type: person', 'title: Decoy', 'slug: decoy-notes', '---',
        '', 'Decoy content.',
      ].join('\n'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();
    expect(await engine.getPage('decoy-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).toBeNull();
  });

  test('a content filter configured for a fallback-regime file makes anchor-blob proof unprovable (spared, not trusted)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();
    // Even an IDENTITY filter flips the verdict: `cat-file --filters`
    // reconstructs historical blobs with TODAY's filter definitions, so a
    // drifted smudge filter can hand back content whose slug differs from
    // what was imported — a successful read is not evidence of absence.
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=ident\n');
    execSync('git config filter.ident.clean cat', { cwd: repo, stdio: 'pipe' });
    execSync('git config filter.ident.smudge cat', { cwd: repo, stdio: 'pipe' });
    execSync('git add .gitattributes && git commit -m "add filter"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // The filter makes the anchor evidence unprovable → the index is
    // incomplete → even the true ghost is spared this run (documented cost).
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE7 — exclude-filtered carriers and filter-name impersonation', () => {
  test('excluded carried rename is still part of the full diff proof', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'notes/party.md': personMd('Party', 'Party content lives here.'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('notes/party')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'notes/party'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });

    execSync('git mv notes/party.md "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "carry excluded party; rename alpha"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, {
      repoPath: repo,
      ...SYNC_OPTS,
      exclude: ['\u{1F389}.md'],
    });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('notes/party')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).toBeNull();
  });

  test('a configured filter literally named unspecified cannot impersonate no filter', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      '\u{1F389}.md': exoticMd,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    const anchor = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });

    writeFileSync(join(repo, '\u{1F389}.md'), [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Slug line removed in the current tree.',
    ].join('\n'));
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=unspecified\n');
    execSync('git config filter.unspecified.clean cat', { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.unspecified.smudge "sed '/^slug:/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "drift ambiguous filter and rename"', { cwd: repo, stdio: 'pipe' });

    const attr = execSync('git check-attr filter -- "\u{1F389}.md"', {
      cwd: repo, stdio: 'pipe',
    }).toString().trim();
    expect(attr).toEndWith(': filter: unspecified');
    const filteredAnchor = execSync(`git cat-file --filters "${anchor}:\u{1F389}.md"`, {
      cwd: repo, stdio: 'pipe',
    }).toString();
    expect(filteredAnchor).not.toContain('slug: Party-Notes');

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('blocked_by_failures');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // The impersonating filter IS detected (the filter ATTRIBUTE is
    // specified for the path — check-attr --all lists it regardless of
    // its magic-looking value), so anchor evidence is unprovable and the
    // index incomplete — even the true ghost is spared this run, the same
    // documented cost as any filtered fallback path. (party-notes above
    // additionally survives through the RAW anchor blob, which still
    // carries the slug the drifted smudge strips.)
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE8 — a REMOVED filter driver cannot impersonate no filter', () => {
  test('deleting filter.<name>.* config while .gitattributes still names it keeps the historically-smudged row alive', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // The raw blob carries NO slug — the smudge filter INJECTS it at
    // checkout, so the row sync imports exists ONLY through the filter
    // conversion. mkRepo commits BEFORE the driver is configured, so the
    // committed blob is the raw form.
    const rawExotic = [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here.',
    ].join('\n');
    const repo = mkRepo({
      '\u{1F389}.md': rawExotic,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
      '.gitattributes': '*.md filter=unspecified\n',
    });
    execSync(`git config filter.unspecified.clean "sed '/^slug: Party-Notes$/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.unspecified.smudge "awk 'NR==2{print \\"slug: Party-Notes\\"}1'"`, { cwd: repo, stdio: 'pipe' });
    // Materialize the smudged working tree (checkout runs the smudge).
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).toContain('slug: Party-Notes');

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // The operator (or a fresh clone) loses the LOCAL driver config; the
    // committed .gitattributes entry stays behind. Re-checkout leaves the
    // raw, slugless content in the working tree.
    execSync('git config --remove-section filter.unspecified', { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).not.toContain('slug: Party-Notes');
    // The exact ambiguity: check-attr still reports the magic-looking
    // token, and the driver lookup that used to "disambiguate" it finds
    // nothing (config --get-regexp exits non-zero).
    const attr = execSync('git check-attr filter -- "\u{1F389}.md"', {
      cwd: repo, stdio: 'pipe',
    }).toString().trim();
    expect(attr).toEndWith(': filter: unspecified');
    expect(() => execSync(`git config --get-regexp '^filter\\.unspecified\\.'`, {
      cwd: repo, stdio: 'pipe',
    })).toThrow();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    // No current git surface (worktree, staging, HEAD, anchor raw OR
    // anchor filter-converted — the driver is gone) carries the slug the
    // historical smudge injected. Only the still-specified filter
    // attribute proves the evidence is unprovable.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Unprovable evidence spares every miss, including the true ghost
    // (the same documented conservative cost as any filtered path).
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE9 — attribute mutations after the import cannot erase the anchor-time filter', () => {
  test('resetting the attribute to !filter still leaves the anchor-imported row alive (anchor attrs consulted via --source)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Same historical-smudge construction as GATE8: the raw blob has no
    // slug, the smudge injects it, and the imported row exists only
    // through the anchor-time conversion.
    const rawExotic = [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here.',
    ].join('\n');
    const repo = mkRepo({
      '\u{1F389}.md': rawExotic,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
      '.gitattributes': '*.md filter=probe\n',
    });
    execSync(`git config filter.probe.clean "sed '/^slug: Party-Notes$/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.probe.smudge "awk 'NR==2{print \\"slug: Party-Notes\\"}1'"`, { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).toContain('slug: Party-Notes');

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // The attribute is RESET to force-unspecified — the driver stays
    // configured, but today's check-attr --all output for the path is
    // EMPTY. Only the anchor commit's attributes still name the filter.
    writeFileSync(join(repo, '.gitattributes'), '*.md !filter\n');
    execSync('git add .gitattributes && git commit -m "reset filter attribute"', { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).not.toContain('slug: Party-Notes');
    const attrToday = execSync('git check-attr --all -- "\u{1F389}.md"', {
      cwd: repo, stdio: 'pipe',
    }).toString();
    expect(attrToday).toBe('');

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Anchor-time filter detected via --source → evidence unprovable →
    // every miss spared, the ghost included (documented cost).
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });

  test('a filter active only for a PAST interval (attr removal already absorbed by an earlier sync) still downgrades the proof', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Same historical-smudge construction, but the attribute reset is
    // absorbed by an INTERMEDIATE sync: by the time the rename reconcile
    // runs, BOTH endpoints (today's attributes and the current anchor's)
    // are clean — only an interior epoch of the history names the filter
    // the imported row's content came through.
    const rawExotic = [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here.',
    ].join('\n');
    const repo = mkRepo({
      '\u{1F389}.md': rawExotic,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
      '.gitattributes': '*.md filter=probe\n',
    });
    execSync(`git config filter.probe.clean "sed '/^slug: Party-Notes$/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.probe.smudge "awk 'NR==2{print \\"slug: Party-Notes\\"}1'"`, { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    writeFileSync(join(repo, '.gitattributes'), '*.md !filter\n');
    // An ordinary edit rides along so the intermediate sync has syncable
    // work and ADVANCES the anchor past the reset commit. The adds are
    // TARGETED: `git add -A` here would sweep the still-smudged working
    // copy of the exotic file into the commit as a slug-carrying blob
    // (the clean filter no longer strips it), collapsing the scenario.
    writeFileSync(join(repo, 'people/alpha.md'), personMd('Alpha', 'Alpha is a person. Edited.'));
    execSync('git add .gitattributes people/alpha.md && git commit -m "reset filter attribute; edit alpha"', { cwd: repo, stdio: 'pipe' });
    const resetCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).not.toContain('slug: Party-Notes');
    const mid = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(mid.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Scenario precondition: the anchor now sits AT the reset commit, so
    // both endpoint attribute states (today + anchor) are clean.
    const anchorRows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(anchorRows[0]?.last_commit).toBe(resetCommit);

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE10 — historical path-specific attributes survive a rename of the file', () => {
  test('a reachable filter epoch on the pre-rename path must downgrade proof for the anchor-time path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const rawExotic = [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here.',
    ].join('\n');
    const repo = mkRepo({
      '🎉.md': rawExotic,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
      '.gitattributes': '🎉.md filter=probe\n',
    });
    execSync(`git config filter.probe.clean "sed '/^slug: Party-Notes$/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.probe.smudge "awk 'NR==2{print \\"slug: Party-Notes\\"}1'"`, { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '🎉.md'));
    execSync('git checkout -- "🎉.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '🎉.md'), 'utf8')).toContain('slug: Party-Notes');
    const importCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' })
      .toString().trim();

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // Remove the filter and materialize the raw, slugless blob before the
    // file moves. The old-path filter epoch remains reachable from HEAD.
    writeFileSync(join(repo, '.gitattributes'), '*.md !filter\n');
    rmSync(join(repo, '🎉.md'));
    execSync('git checkout -- "🎉.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '🎉.md'), 'utf8')).not.toContain('slug: Party-Notes');
    execSync('git mv "🎉.md" "✨.md"', { cwd: repo, stdio: 'pipe' });
    execSync('git add .gitattributes && git commit -m "reset filter and move exotic file"', {
      cwd: repo, stdio: 'pipe',
    });
    const movedCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' })
      .toString().trim();

    // Absorb the move while excluding its destination. This advances the
    // sync anchor without re-importing the now-slugless fallback file.
    await performSync(engine, {
      repoPath: repo,
      ...SYNC_OPTS,
      exclude: ['✨.md'],
    });
    const anchorRows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(anchorRows[0]?.last_commit).toBe(movedCommit);
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    // Pin the defect mechanism: the epoch enumeration finds both
    // attribute-changing commits, but a PER-PATH check keyed to the
    // anchor path (✨.md) is empty at every epoch, while the same import
    // epoch proves a filter immediately under the HISTORICAL path
    // (🎉.md). Only a repo-wide epoch check can see it.
    const epochOutput = execSync(
      `git log --format=%H HEAD ${movedCommit} -- .gitattributes ':(glob)**/.gitattributes'`,
      { cwd: repo, stdio: 'pipe' },
    ).toString().trim();
    const epochs = epochOutput.split('\n').filter(Boolean);
    expect(epochs).toContain(importCommit);
    expect(epochs).toContain(movedCommit);
    for (const epoch of epochs) {
      expect(execSync(`git check-attr --source=${epoch} --all -- "✨.md"`, {
        cwd: repo, stdio: 'pipe',
      }).toString()).toBe('');
    }
    const oldPathAtImport = execSync(
      `git check-attr --source=${importCommit} --all -- "🎉.md"`,
      { cwd: repo, stdio: 'pipe' },
    ).toString();
    expect(oldPathAtImport).toContain('filter: probe');

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // The repo-wide historical downgrade spares every miss, the true
    // ghost included (documented conservative cost).
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE11 — filter epochs invisible to the default history walk', () => {
  test('a filter epoch on a side branch discarded by a merge (-s ours) still downgrades the proof', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const rawExotic = [
      '---', 'type: person', 'title: Party Notes', '---',
      '', 'Party notes live here.',
    ].join('\n');
    // Base commit has NO attributes file at all.
    const repo = mkRepo({
      '\u{1F389}.md': rawExotic,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    // The filter lives only on an experiment branch; the sync that imports
    // the row runs while THAT branch is checked out.
    const mainBranch = execSync('git branch --show-current', { cwd: repo, stdio: 'pipe' })
      .toString().trim();
    execSync('git switch -qc filtered-side', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=probe\n');
    execSync('git add .gitattributes && git commit -m "side: enable filter"', { cwd: repo, stdio: 'pipe' });
    const sideCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    execSync(`git config filter.probe.clean "sed '/^slug: Party-Notes$/d'"`, { cwd: repo, stdio: 'pipe' });
    execSync(`git config filter.probe.smudge "awk 'NR==2{print \\"slug: Party-Notes\\"}1'"`, { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).toContain('slug: Party-Notes');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // The experiment is DISCARDED at the merge: `-s ours` keeps the main
    // tree (no attributes file), so the merge is TREESAME to the kept
    // parent and the default path-simplified walk prunes the side line.
    execSync(`git switch -q ${mainBranch}`, { cwd: repo, stdio: 'pipe' });
    execSync('git merge -q -s ours filtered-side -m "discard filter experiment"', { cwd: repo, stdio: 'pipe' });
    rmSync(join(repo, '\u{1F389}.md'));
    execSync('git checkout -- "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    expect(readFileSync(join(repo, '\u{1F389}.md'), 'utf8')).not.toContain('slug: Party-Notes');
    // An ordinary edit so the intermediate sync advances the anchor.
    writeFileSync(join(repo, 'people/alpha.md'), personMd('Alpha', 'Alpha is a person. Edited.'));
    execSync('git add people/alpha.md && git commit -m "edit alpha"', { cwd: repo, stdio: 'pipe' });
    const postMergeCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    const mid = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(mid.status).toBe('synced');
    const anchorRows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(anchorRows[0]?.last_commit).toBe(postMergeCommit);
    expect(await engine.getPage('party-notes')).not.toBeNull();

    // Pin the defect mechanism: the default walk omits the side epoch,
    // --full-history keeps it.
    const defaultLog = execSync(
      `git log --format=%H HEAD ${postMergeCommit} -- .gitattributes ':(glob)**/.gitattributes'`,
      { cwd: repo, stdio: 'pipe' },
    ).toString();
    expect(defaultLog).not.toContain(sideCommit);
    const fullLog = execSync(
      `git log --full-history --format=%H HEAD ${postMergeCommit} -- .gitattributes ':(glob)**/.gitattributes'`,
      { cwd: repo, stdio: 'pipe' },
    ).toString();
    expect(fullLog).toContain(sideCommit);

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });

  test('a shallow clone makes attribute history unprovable: no fallback-anchor delete on truncated history', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Full source repo: an attributes-free history whose ghost WOULD be
    // deletable — then a shallow re-clone truncates the history the epoch
    // enumeration needs, and every fallback anchor proof degrades.
    const src = mkRepo({
      '\u{1F389}.md': exoticMd,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    execSync('git commit --allow-empty -m "second commit for depth"', { cwd: src, stdio: 'pipe' });
    const shallow = mkdtempSync(join(tmpdir(), 'gbrain-3056-shallow-'));
    repos.push(shallow);
    execSync(`git clone --no-local --depth 1 "file://${src}" "${shallow}"`, { stdio: 'pipe' });
    execSync('git config user.email "test@test.com" && git config user.name "Test"', {
      cwd: shallow, stdio: 'pipe',
    });
    expect(execSync('git rev-parse --is-shallow-repository', { cwd: shallow, stdio: 'pipe' })
      .toString().trim()).toBe('true');

    await performSync(engine, { repoPath: shallow, ...SYNC_OPTS });
    expect(await engine.getPage('party-notes')).not.toBeNull();

    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies destination',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: shallow, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: shallow, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: shallow, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('party-notes')).not.toBeNull();
    // Truncated history is unprovable history: the ghost is spared too.
    expect(await engine.getPage('people/ghost')).not.toBeNull();
  });
});

describe('#3583 review: GATE13 — a cheap rename repairs its bookkeeping when it lands', () => {
  test('a cheap rename repairs source_path at the moment it lands, and the row survives a full sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();

    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
    const inc = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(inc.status).toBe('synced');
    expect(await engine.getPage('people/beta')).not.toBeNull();
    expect(await engine.getPage('people/alpha')).toBeNull();
    // The root fix: the cheap rename no longer leaves source_path behind
    // (updateSlug moves the row; the unchanged-content reimport is a
    // no-write skip that would never have repaired it).
    const bookkeeping = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = 'people/beta'`,
    );
    expect(bookkeeping[0]?.source_path).toBe('people/beta.md');

    const full = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(full.status).not.toBe('blocked_by_failures');
    expect(await engine.getPage('people/beta')).not.toBeNull();
  });

});

describe('#3583 review: GATE13 — chunker_version is acknowledged only by a completed re-chunk', () => {
  test('a chunker-version-gate dry run leaves chunker_version untouched', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE sources SET chunker_version = 'gate13-stale' WHERE id = 'default'`,
    );
    const preview = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(preview.status).toBe('dry_run');
    const version = await engine.executeRaw<{ chunker_version: string | null }>(
      `SELECT chunker_version FROM sources WHERE id = 'default'`,
    );
    expect(version[0]?.chunker_version).toBe('gate13-stale');
  });

  test('a BLOCKED forced re-chunk keeps the version stale, so the retry actually re-runs', async () => {
    const { CHUNKER_VERSION } = await import('../src/core/chunkers/code.ts');
    const { performSync } = await import('../src/commands/sync.ts');
    const goodAlpha = personMd('Alpha', 'Alpha is a person.');
    const repo = mkRepo({ 'people/alpha.md': goodAlpha });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE sources SET chunker_version = 'gate13-stale' WHERE id = 'default'`,
    );
    // Corrupt the tracked working copy so the forced full re-chunk fails.
    // Invalid YAML frontmatter, NOT a NUL byte: #3998 NUL-sanitizes page
    // bodies at write time, so a NUL now ingests cleanly instead of failing.
    writeFileSync(join(repo, 'people/alpha.md'), '---\ntitle: [unclosed\n---\ngarbage\n');
    const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(blocked.status).toBe('blocked_by_failures');
    const staleVersion = await engine.executeRaw<{ chunker_version: string | null }>(
      `SELECT chunker_version FROM sources WHERE id = 'default'`,
    );
    // The failed re-chunk must NOT be acknowledged...
    expect(staleVersion[0]?.chunker_version).toBe('gate13-stale');

    // ...so once the operator repairs the file, the retry actually
    // re-runs the re-chunk instead of reporting up_to_date.
    writeFileSync(join(repo, 'people/alpha.md'), goodAlpha);
    const retry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(retry.status).not.toBe('up_to_date');
    const ackedVersion = await engine.executeRaw<{ chunker_version: string | null }>(
      `SELECT chunker_version FROM sources WHERE id = 'default'`,
    );
    expect(ackedVersion[0]?.chunker_version).toBe(String(CHUNKER_VERSION));
    expect(await engine.getPage('people/alpha')).not.toBeNull();
  });
});

describe('#3583 review: GATE14 — the cheap-rename bookkeeping repair is source-exact', () => {

  test('the bookkeeping repair never crosses sources: an unscoped sync leaves an identical (slug, source_path) row in another source alone', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const bare = { noPull: true, noEmbed: true, noExtract: true } as const;
    // Source "other" naturally carries the SAME legacy pair the default
    // source is about to repair: slug people/beta, source_path
    // people/alpha.md.
    const repoOther = mkRepo({ 'people/beta.md': personMd('Beta Other', 'Beta in the other source.') });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, created_at)
       VALUES ('other', 'other', '{}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`,
    );
    const otherSync = await performSync(engine, { repoPath: repoOther, ...bare, sourceId: 'other' });
    expect(otherSync.status).not.toBe('blocked_by_failures');
    const otherSeed = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = 'other' AND slug = 'people/beta'`,
    );
    expect(Number(otherSeed[0]?.n)).toBe(1);
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'other' AND slug = 'people/beta'`,
    );

    // The default-source rename runs WITHOUT a sourceId (the bare path).
    // Pin the bare path's dynamic source resolution to the DEFAULT source
    // (tier 5, sources.default — otherwise the sole-non-default-source
    // convenience tier routes the run into 'other'), so the run coheres
    // with updateSlug's own no-opts scope ('default') — the pair the
    // repair UPDATE must match.
    const repoDefault = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha is a person.') });
    await engine.setConfig('sources.default', 'default');
    await performSync(engine, { repoPath: repoDefault, ...bare });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repoDefault, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repoDefault, stdio: 'pipe' });
    const renameRun = await performSync(engine, { repoPath: repoDefault, ...bare });
    expect(renameRun.status).toBe('synced');

    // The default row is repaired...
    const defaultRow = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = 'people/beta'`,
    );
    expect(defaultRow[0]?.source_path).toBe('people/beta.md');
    // ...and the OTHER source's bookkeeping is untouched: rewriting it made
    // that source's later fallback reconcile probe the wrong path, find
    // nothing, and advance without its rename sentinel (gate 14).
    const otherRow = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'other' AND slug = 'people/beta'`,
    );
    expect(otherRow[0]?.source_path).toBe('people/alpha.md');
  });

});

describe('#3583 review: FUGU — the carried-rename spare survives a decoy row displacing the DB resolve', () => {
  test('a decoy row sharing the carrying rename\'s from-path cannot strip the path-derived slug from the spare set', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // The GATE6 sequence — a row carried by ANOTHER rename to a slugless
    // exotic path — plus one DECOY: an unrelated row whose stale
    // bookkeeping names the carrying rename's from-path. A single-slug
    // DB resolve for notes/party.md returns the DECOY's slug and
    // displaces the path-derived notes/party from the spare set; the
    // carried row then loses its protection and is hard-deleted.
    const repo = mkRepo({
      'notes/party.md': personMd('Party', 'Party content lives here.'),
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('notes/party')).not.toBeNull();

    // Stale bookkeeping: the carried row names alpha's path (its
    // candidate-admission ticket for the colliding rename)...
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'notes/party'`,
    );
    // ...and the DECOY names the carrying rename's from-path.
    await engine.putPage('people/decoy', {
      type: 'person', title: 'Decoy', compiled_truth: 'stale bookkeeping pointing at party',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'notes/party.md'
       WHERE source_id = 'default' AND slug = 'people/decoy'`,
    );
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta occupier', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv notes/party.md "\u{1F389}.md"', { cwd: repo, stdio: 'pipe' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "carry party to an exotic path; rename alpha"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('blocked_by_failures');
    // The carried row survives — the spare set holds the path-derived
    // slug REGARDLESS of what the DB resolve returned for the path.
    expect(await engine.getPage('notes/party')).not.toBeNull();
  });
});

describe('#3583 review: GATE24 — the post-purge sweep site converges in one run', () => {
  test('a sentinel whose stale row the purge itself removes clears in the SAME full sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // The one self-heal call site the earlier coverage work left unexercised
    // (blocker 3 named it). The pre-gate probe cannot clear this sentinel:
    // at that point the stale row is still ACTIVE and still carries the old
    // path, so the sentinel is legitimately open. Only the sweep that runs
    // AFTER the purge removed that row can close it — and it has to, or a
    // full sync (the operator's usual reset move) leaves the wedge open for
    // a whole extra run.
    const repo = mkRepo({
      'people/carol.md': personMd('Carol', 'Carol is a person.'),
      'people/dana-old.md': personMd('Dana Old', 'Dana Old is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/dana-old')).not.toBeNull();

    // The file leaves git, so the row becomes a genuine purge candidate…
    execSync('git rm -q people/dana-old.md && git commit -m "delete dana-old"', { cwd: repo, stdio: 'pipe' });
    // …and the sentinel names that same old path, so it is NOT orphaned yet.
    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    const full = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(full.status).not.toBe('blocked_by_failures');
    // The purge took the stale row…
    expect(await engine.getPage('people/dana-old')).toBeNull();
    // …and the post-purge sweep closed the wedge in the same run.
    expect(await openDanaRows()).toHaveLength(0);
    expect(await engine.getPage('people/carol')).not.toBeNull();
  });
});

describe('#3583 review: GATE25 — the upgrade path for someone already wedged by #3056', () => {
  test('a PRE-#3479 legacy sentinel self-heals on the first run after upgrading', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { recordFailures, renameSentinelPath, loadSyncFailures } =
      await import('../src/core/sync-failure-ledger.ts');
    // The review flagged this as unverified and, on the previous head, as an
    // incomplete fix: the self-heal read only the JSON-quoted format, so a
    // ledger row written by the PRE-#3479 code could never be parsed, never
    // be proven orphaned, and never clear — a permanent doctor FAIL for
    // exactly the operators the self-heal was written for. This is the
    // upgrade simulation: the ledger row is byte-for-byte what the old code
    // wrote, and the run is the new code.
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    const legacyPath = 'people/dana-old.md';
    recordFailures('default', [{
      path: renameSentinelPath('people/dana.md'),
      // Verbatim pre-#3479 shape: no slug slot, path interpolated raw.
      error: `rename reconcile failed (stale row for ${legacyPath} not removed): injected wedge`,
    }], 'deadbeef');
    const openBefore = loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(openBefore).toHaveLength(1);
    // No active row carries that path, so the sentinel is genuinely orphaned.
    const carriers = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages
        WHERE source_id = 'default' AND source_path = $1 AND deleted_at IS NULL`,
      [legacyPath],
    );
    expect(Number(carriers[0]?.n ?? 0)).toBe(0);

    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    )).toHaveLength(0);
  });

  test('an AMBIGUOUS legacy sentinel is still left open — fail-closed survives the widening', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { recordFailures, renameSentinelPath, loadSyncFailures } =
      await import('../src/core/sync-failure-ledger.ts');
    // Same upgrade, but the raw interpolation is undecidable (the delimiter
    // appears twice). Widening the parser must not turn "cannot tell" into a
    // clear — that is the failure mode #3479 introduced JSON encoding for.
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    recordFailures('default', [{
      path: renameSentinelPath('people/eve.md'),
      error: 'rename reconcile failed (stale row for a not removed): b.md not removed): injected wedge',
    }], 'deadbeef');

    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(loadSyncFailures().filter(
      f => f.path === '<rename:people/eve.md>' && f.state === 'open',
    )).toHaveLength(1);
  });
});

describe('rename destination import: an errored skip must not checkpoint the rename as done', () => {
  test('a frontmatter slug-authority rejection at the destination is retried, never falsely checkpointed', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();

    // Rename alpha -> beta, but the destination's frontmatter claims a slug
    // that does not match its path. importFile enforces slug authority (the
    // path on disk is the source of truth) and rejects this, returning
    // status 'skipped' with an .error set — never status 'error'. Title/body
    // stay byte-identical to alpha (only a `slug:` line is injected) so
    // git's similarity-based rename detection still classifies this as a
    // RENAME rather than a delete+add (a rewritten body drops similarity
    // below git's threshold and takes a completely different code path).
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'people/beta.md'), [
      '---', 'type: person', 'title: Alpha', 'slug: totally-different', '---',
      '', 'Alpha is a person.',
    ].join('\n'));
    execSync('git add -A && git commit -m "rename alpha to beta, corrupted frontmatter"', {
      cwd: repo, stdio: 'pipe',
    });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('blocked_by_failures');
    // The cheap DB-level rename (updateSlug) runs unconditionally before
    // content import is attempted, so the row is already named 'people/beta'
    // — but its content is untouched (import never wrote anything for the
    // rejected file): compiled_truth still reads the pre-rename body.
    const afterFirst = await engine.getPage('people/beta');
    expect(afterFirst).not.toBeNull();
    expect(afterFirst?.compiled_truth).toBe('Alpha is a person.');

    // Discriminating assertion: without importErrored gating the checkpoint,
    // run 1 falsely marks `to` as done despite the recorded failure, so this
    // SECOND run (same still-rejected content) would read "already done" and
    // report success without ever having imported the destination. The fix
    // makes this run fail again, identically to the first — the checkpoint
    // is never falsely marked, so compiled_truth still has not moved.
    const second = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(second.status).toBe('blocked_by_failures');
    expect((await engine.getPage('people/beta'))?.compiled_truth).toBe('Alpha is a person.');

    // Fixing the content and re-syncing must actually materialize the fixed
    // content — proving the target was never falsely banked as complete.
    writeFileSync(join(repo, 'people/beta.md'), personMd('Alpha', 'Alpha is a person, fixed.'));
    execSync('git add -A && git commit -m "fix beta frontmatter"', { cwd: repo, stdio: 'pipe' });
    const third = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(third.status).toBe('synced');
    expect((await engine.getPage('people/beta'))?.compiled_truth).toBe('Alpha is a person, fixed.');
  });
});

describe('the no-sourceId rename lane must stay source-scoped', () => {
  test('e2e: a same-path row in a different source must not license a rename of an unrelated default-source page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const NO_SOURCE_ID_OPTS = { noPull: true, noEmbed: true, noExtract: true } as const;

    // Two unrelated pages in the 'default' source, synced from one repo.
    const repo = mkRepo({
      'notes/shared.md': personMd('Shared', 'default body'),
      'people/victim.md': personMd('Victim', 'victim body'),
    });
    await performSync(engine, { repoPath: repo, ...NO_SOURCE_ID_OPTS });
    expect(await engine.getPage('notes/shared', { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getPage('people/victim', { sourceId: 'default' })).not.toBeNull();

    // A DIFFERENT source ('acme') happens to have a row whose source_path is
    // the exact file about to be renamed, but whose OWN slug coincides with
    // the unrelated victim page's slug in 'default'. 'acme' sorts before
    // 'default', so a from-path resolve that isn't scoped to the caller's
    // own source would surface this foreign slug instead of the real page's
    // own ('notes/shared') — the rename lane's updateSlug call is always
    // default-scoped (renameOpts is undefined for the no-sourceId lane), so
    // reading a foreign slug here would repoint an unrelated default-source
    // row rather than the file's own page.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      ['acme'],
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('acme', 'people/victim', 'notes/shared.md', 'note', 'people/victim', 'foreign body', '', '{}'::jsonb)`,
    );

    // Rename ONLY notes/shared.md. Content stays byte-identical to keep
    // git's similarity-based rename detection above its threshold.
    execSync('git mv notes/shared.md notes/renamed.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "rename shared"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...NO_SOURCE_ID_OPTS });

    // The rename must land at its own new slug in 'default'...
    expect((await engine.getPage('notes/renamed', { sourceId: 'default' }))?.compiled_truth)
      .toBe('default body');
    // ...the old slug is gone (a real rename, not a permanent orphan)...
    expect(await engine.getPage('notes/shared', { sourceId: 'default' })).toBeNull();
    // ...and the unrelated victim page — which merely shares a slug VALUE
    // with the foreign 'acme' row, never the file being renamed — must
    // never have been touched. A from-path resolve that ignored source
    // scope would return the 'acme' row's slug ('people/victim'), and the
    // default-scoped updateSlug would match and repoint THIS page instead.
    const victim = await engine.getPage('people/victim', { sourceId: 'default' });
    expect(victim).not.toBeNull();
    expect(victim?.compiled_truth).toBe('victim body');
    // ...and the foreign 'acme' row itself was never written to — this is a
    // read-only resolve, so the seeded row must survive byte-identical.
    const acmeRow = await engine.executeRaw<{ slug: string; source_path: string | null; compiled_truth: string }>(
      `SELECT slug, source_path, compiled_truth FROM pages WHERE source_id = 'acme'`,
    );
    expect(acmeRow).toEqual([
      { slug: 'people/victim', source_path: 'notes/shared.md', compiled_truth: 'foreign body' },
    ]);
  });
});

describe('#3942: the rename lane must not repoint a foreign-origin page', () => {
  test('e2e (sourceId set, batched lane): renaming a legacy trailing-hyphen path must not corrupt a different, live page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Sync 1: only the legacy trailing-hyphen file exists. slugifyPath strips
    // the trailing hyphen, so it imports AT the clean slug.
    const repo = mkRepo({
      'extracts/propose-/round-single.md': personMd('Legacy', 'legacy body'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('extracts/propose/round-single', { sourceId: 'default' }))
      .not.toBeNull();

    // Sync 2: the clean file lands at the SAME derived slug with DIFFERENT
    // content. The reimport re-records source_path to the clean file, so the
    // page now has a FOREIGN origin relative to the legacy trailing-hyphen
    // path (whose own file is untouched and still on disk).
    mkdirSync(join(repo, 'extracts/propose'), { recursive: true });
    writeFileSync(join(repo, 'extracts/propose/round-single.md'), personMd('Clean', 'clean body'));
    execSync('git add -A && git commit -m "add clean variant"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect((await engine.getPage('extracts/propose/round-single', { sourceId: 'default' }))
      ?.compiled_truth).toBe('clean body');

    // Sync 3: rename ONLY the legacy trailing-hyphen file (never the clean
    // page's own file). Content stays byte-identical so git's similarity
    // detection reports a RENAME. An unguarded batched pre-resolve's exact
    // source_path lookup misses here (the legacy path is not any page's
    // recorded origin anymore) and falls back to an unverified re-slugified
    // fallback — the SAME slug as the clean page — cheap-renaming that
    // unrelated, live, foreign-origin page.
    mkdirSync(join(repo, 'notes'), { recursive: true });
    execSync('git mv "extracts/propose-/round-single.md" notes/renamed.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "rename legacy trailing-hyphen file"', {
      cwd: repo, stdio: 'pipe',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The clean page — a different file's page — must survive untouched.
    const cleanPage = await engine.getPage('extracts/propose/round-single', { sourceId: 'default' });
    expect(cleanPage).not.toBeNull();
    expect(cleanPage?.compiled_truth).toBe('clean body');
    // The renamed destination lands as its own page, carrying the legacy
    // file's (unchanged) content.
    expect((await engine.getPage('notes/renamed', { sourceId: 'default' }))?.compiled_truth)
      .toBe('legacy body');
  });

  test('e2e (no sourceId, per-path lane): the same collision is guarded on the legacy no-sourceId lane too', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const NO_SOURCE_ID_OPTS = { noPull: true, noEmbed: true, noExtract: true } as const;

    const repo = mkRepo({
      'extracts/propose-/round-single.md': personMd('Legacy', 'legacy body'),
    });
    await performSync(engine, { repoPath: repo, ...NO_SOURCE_ID_OPTS });
    expect(await engine.getPage('extracts/propose/round-single', { sourceId: 'default' }))
      .not.toBeNull();

    mkdirSync(join(repo, 'extracts/propose'), { recursive: true });
    writeFileSync(join(repo, 'extracts/propose/round-single.md'), personMd('Clean', 'clean body'));
    execSync('git add -A && git commit -m "add clean variant"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...NO_SOURCE_ID_OPTS });
    expect((await engine.getPage('extracts/propose/round-single', { sourceId: 'default' }))
      ?.compiled_truth).toBe('clean body');

    mkdirSync(join(repo, 'notes'), { recursive: true });
    execSync('git mv "extracts/propose-/round-single.md" notes/renamed.md', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "rename legacy trailing-hyphen file"', {
      cwd: repo, stdio: 'pipe',
    });
    await performSync(engine, { repoPath: repo, ...NO_SOURCE_ID_OPTS });

    const cleanPage = await engine.getPage('extracts/propose/round-single', { sourceId: 'default' });
    expect(cleanPage).not.toBeNull();
    expect(cleanPage?.compiled_truth).toBe('clean body');
    expect((await engine.getPage('notes/renamed', { sourceId: 'default' }))?.compiled_truth)
      .toBe('legacy body');
  });
});
