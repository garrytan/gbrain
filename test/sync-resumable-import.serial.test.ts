/**
 * v0.42.x (#1794) — resumable incremental sync: pinned-target path-set
 * checkpoint, last_commit advances only at full import completion.
 *
 * The defect: a large incremental sync killed mid-import never advanced
 * `last_commit`, so every retry re-walked the whole (growing) diff and the
 * backlog outran every attempt. Two co-conspirators: the strict head-drift
 * gate aborted on normal forward progress (the enrich process commits to the
 * same repo mid-sync), and per-run anchor advance would have stranded
 * modifications past the pin.
 *
 * These are the IRON-RULE regression tests. Marked `.serial.test.ts` because
 * they spawn git subprocesses, mutate `process.env.GBRAIN_SYNC_CHECKPOINT_EVERY`,
 * and share one PGLite engine across tests (PGLite forces serial workers, so
 * the batch loop is exercised without the parallel worker-pool branch).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  syncFingerprint,
} from '../src/core/op-checkpoint.ts';
import { commitTimeMs } from '../src/core/source-health.ts';
import {
  clampWorkersForConnectionBudget,
  resolveMaxConnections,
} from '../src/core/sync-concurrency.ts';
import { computePoolBudgetCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

function head(repo: string): string {
  return execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
}

function pageMd(title: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\nBody for ${title}.\n`;
}

/** Write a markdown page under notes/, stage + commit, return new HEAD. */
function commitPages(repo: string, files: Record<string, string>, msg: string): string {
  mkdirSync(join(repo, 'notes'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(repo, 'notes', name), body);
  }
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: repo, stdio: 'pipe' });
  return head(repo);
}

/** Read the no-sourceId config anchor. */
async function lastCommitConfig(): Promise<string | null> {
  return engine.getConfig('sync.last_commit');
}

async function ckptPaths(lastCommit: string): Promise<string[]> {
  const fp = syncFingerprint({ lastCommit });
  return loadOpCheckpoint(engine, { op: 'sync', fingerprint: fp });
}
async function ckptTarget(lastCommit: string): Promise<string[]> {
  const fp = syncFingerprint({ lastCommit });
  return loadOpCheckpoint(engine, { op: 'sync-target', fingerprint: fp });
}
async function seedCheckpoint(lastCommit: string, target: string, paths: string[]): Promise<void> {
  const fp = syncFingerprint({ lastCommit });
  await recordCompleted(engine, { op: 'sync-target', fingerprint: fp }, [target]);
  await recordCompleted(engine, { op: 'sync', fingerprint: fp }, paths);
}

describe('#1794 — resumable incremental sync (pinned target)', () => {
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
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-1794-'));
    gitInit(repoPath);
    // Baseline commit so the first sync has a real anchor.
    commitPages(repoPath, { 'base.md': pageMd('Base') }, 'initial');
  });

  afterEach(() => {
    delete process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  // ── A. CRITICAL: resume skips checkpointed paths (the mechanism) ──────────
  test('[CRITICAL] resume skips paths already in the checkpoint', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    const full = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(full.status);
    const c0 = (await lastCommitConfig())!;
    expect(c0).toBeTruthy();

    // Six new pages at C1.
    const c1 = commitPages(repoPath, {
      'a.md': pageMd('A'), 'b.md': pageMd('B'), 'c.md': pageMd('C'),
      'd.md': pageMd('D'), 'e.md': pageMd('E'), 'f.md': pageMd('F'),
    }, 'six pages');

    // Simulate a prior killed run that drained a,b,c (pinned at C1) but DID
    // NOT import them — so if resume honors the checkpoint, a,b,c stay absent.
    await seedCheckpoint(c0, c1, ['notes/a.md', 'notes/b.md', 'notes/c.md']);

    const res = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(res.status).toBe('synced');

    // d,e,f imported; a,b,c skipped (proof resumeFilter honored the checkpoint).
    expect(await engine.getPage('notes/d')).not.toBeNull();
    expect(await engine.getPage('notes/e')).not.toBeNull();
    expect(await engine.getPage('notes/f')).not.toBeNull();
    expect(await engine.getPage('notes/a')).toBeNull();
    expect(await engine.getPage('notes/b')).toBeNull();
    expect(await engine.getPage('notes/c')).toBeNull();

    // Anchor advanced to the pinned target; checkpoint cleared.
    expect(await lastCommitConfig()).toBe(c1);
    expect(await ckptPaths(c0)).toEqual([]);
    expect(await ckptTarget(c0)).toEqual([]);
  }, 60_000);

  // ── B. CRITICAL: real abort banks progress, second run converges ──────────
  test('[CRITICAL] killed mid-import banks progress; next run converges', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    process.env.GBRAIN_SYNC_CHECKPOINT_EVERY = '1'; // flush after every file

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const c0 = (await lastCommitConfig())!;

    // Many files so the import window is wide enough for the abort to land mid-loop.
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`p${i}.md`] = pageMd(`P${i}`);
    const c1 = commitPages(repoPath, files, 'thirty pages');

    // Abort once the checkpoint shows at least one banked path.
    const ac = new AbortController();
    const fp = syncFingerprint({ lastCommit: c0 });
    const poll = setInterval(() => {
      loadOpCheckpoint(engine, { op: 'sync', fingerprint: fp })
        .then((paths) => { if (paths.length >= 1 && !ac.signal.aborted) ac.abort(); })
        .catch(() => {});
    }, 1);
    const aborted = await performSync(engine, { repoPath, noPull: true, noEmbed: true, signal: ac.signal });
    clearInterval(poll);

    if (aborted.status === 'partial') {
      // Anchor MUST NOT advance on a partial.
      expect(await lastCommitConfig()).toBe(c0);
      // Banked at least one, not all (proof the kill banked progress).
      const banked = await ckptPaths(c0);
      expect(banked.length).toBeGreaterThanOrEqual(1);
      expect(banked.length).toBeLessThan(30);
    }

    // Second run resumes and converges regardless of whether the abort landed.
    // (If the abort never fired, the first run already completed → up_to_date.)
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'up_to_date']).toContain(second.status);
    expect(await lastCommitConfig()).toBe(c1);
    for (let i = 0; i < 30; i++) {
      expect(await engine.getPage(`notes/p${i}`)).not.toBeNull();
    }
    // Checkpoint cleared on completion.
    expect(await ckptPaths(c0)).toEqual([]);
  }, 90_000);

  // ── C. CRITICAL: pinned target — forward commits don't block, land next sync
  test('[CRITICAL] advances to the pinned target, not live HEAD', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const c0 = (await lastCommitConfig())!;

    const c1 = commitPages(repoPath, { 'x.md': pageMd('X') }, 'add x');
    // Simulate a started-but-unfinished run pinned at C1 (nothing drained yet).
    await seedCheckpoint(c0, c1, []);
    // The enrich process commits FORWARD past the pin while we were "down".
    const c2 = commitPages(repoPath, { 'y.md': pageMd('Y') }, 'add y (forward drift)');
    expect(c2).not.toBe(c1);

    // Run 1: drains C0..C1 only, advances to the PIN (C1), not live HEAD (C2).
    const r1 = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(r1.status).toBe('synced');
    expect(await engine.getPage('notes/x')).not.toBeNull();
    expect(await engine.getPage('notes/y')).toBeNull(); // past the pin, not yet
    expect(await lastCommitConfig()).toBe(c1);

    // Run 2: now anchored at C1, diff C1..C2 picks up y.
    const r2 = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(r2.status).toBe('synced');
    expect(await engine.getPage('notes/y')).not.toBeNull();
    expect(await lastCommitConfig()).toBe(c2);
  }, 60_000);

  // ── D. Rewrite of the pin → discard checkpoint, re-pin to HEAD ─────────────
  test('history rewrite (pin not ancestor of HEAD) discards checkpoint + re-pins', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const c0 = (await lastCommitConfig())!;

    const c1 = commitPages(repoPath, { 'x.md': pageMd('X') }, 'add x');
    // Stale checkpoint pinned at C1 claiming a ghost path drained.
    await seedCheckpoint(c0, c1, ['notes/ghost.md']);

    // Rewrite: reset hard back to C0, then commit a DIFFERENT file. Now C1 is
    // dangling (not an ancestor of the new HEAD).
    execSync(`git reset --hard ${c0}`, { cwd: repoPath, stdio: 'pipe' });
    const c1b = commitPages(repoPath, { 'z.md': pageMd('Z') }, 'rewritten branch');
    expect(c1b).not.toBe(c1);

    const res = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(res.status).toBe('synced');
    // Re-pinned to the live HEAD (C1b), drained z; x and ghost never existed here.
    expect(await engine.getPage('notes/z')).not.toBeNull();
    expect(await engine.getPage('notes/x')).toBeNull();
    expect(await engine.getPage('notes/ghost')).toBeNull();
    expect(await lastCommitConfig()).toBe(c1b);
    expect(await ckptPaths(c0)).toEqual([]);
  }, 60_000);

  // ── E + G. blocked_by_failures: last_sync_at NOT bumped, good file banked ──
  test('[Codex #2/#5] blocked sync leaves last_sync_at + last_commit unchanged; good file banked', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    const sid = 'srcE';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      [sid, sid, repoPath],
    );

    await performSync(engine, { repoPath, sourceId: sid, full: true, noPull: true, noEmbed: true });
    const beforeRows = await engine.executeRaw<{ last_commit: string | null; last_sync_at: string | null }>(
      `SELECT last_commit, last_sync_at FROM sources WHERE id = $1`, [sid],
    );
    const c0 = beforeRows[0].last_commit!;
    const t0 = beforeRows[0].last_sync_at;
    expect(c0).toBeTruthy();
    expect(t0).toBeTruthy();

    // One good page + one with a frontmatter slug that doesn't match the
    // path-derived slug → SLUG_MISMATCH import failure (the same reliable
    // failure the e2e sync test uses).
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(join(repoPath, 'notes/good.md'), pageMd('Good'));
    writeFileSync(
      join(repoPath, 'notes/bad.md'),
      ['---', 'type: concept', 'title: Bad', 'slug: wrong-slug', '---', '', 'Body.'].join('\n'),
    );
    execSync('git add -A && git commit -m "good + bad"', { cwd: repoPath, stdio: 'pipe' });

    const res = await performSync(engine, { repoPath, sourceId: sid, noPull: true, noEmbed: true });
    expect(res.status).toBe('blocked_by_failures');

    // Codex #2: blocked path writes neither last_commit NOR last_sync_at.
    const afterRows = await engine.executeRaw<{ last_commit: string | null; last_sync_at: string | null }>(
      `SELECT last_commit, last_sync_at FROM sources WHERE id = $1`, [sid],
    );
    expect(afterRows[0].last_commit).toBe(c0);
    // last_sync_at is a Date instance; compare by value (unchanged == #2 fix).
    expect(String(afterRows[0].last_sync_at)).toBe(String(t0));

    // Codex #5 / banking: the good file imported + is banked; the bad one isn't.
    expect(await engine.getPage('notes/good', { sourceId: sid })).not.toBeNull();
    const banked = await (async () => {
      const fp = syncFingerprint({ sourceId: sid, lastCommit: c0 });
      return loadOpCheckpoint(engine, { op: 'sync', fingerprint: fp });
    })();
    expect(banked).toContain('notes/good.md');
    expect(banked).not.toContain('notes/bad.md');
  }, 60_000);

  // ── F. Codex #3: file added in range but deleted from disk → skip, not block
  test('[Codex #3] vanished-on-disk added file is skipped, not a failure', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const c1 = commitPages(repoPath, { 'keep.md': pageMd('Keep'), 'gone.md': pageMd('Gone') }, 'two pages');

    // Delete gone.md from disk WITHOUT committing — it's still 'added' in the
    // C0..C1 diff, but importFile won't find it (forward-delete simulation).
    unlinkSync(join(repoPath, 'notes/gone.md'));

    const res = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(res.status).toBe('synced'); // NOT blocked_by_failures
    expect(await engine.getPage('notes/keep')).not.toBeNull();
    expect(await engine.getPage('notes/gone')).toBeNull();
    expect(await lastCommitConfig()).toBe(c1);
  }, 60_000);

  // ── H. Dry-run shape unchanged; totalChanges==0 advances to pin ───────────
  test('--dry-run reports counts without writing; non-syncable-only diff advances anchor', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    const c0 = (await lastCommitConfig())!;

    commitPages(repoPath, { 'dry.md': pageMd('Dry') }, 'add dry');
    const dry = await performSync(engine, { repoPath, noPull: true, noEmbed: true, dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(dry.added).toBeGreaterThanOrEqual(1);
    expect(await lastCommitConfig()).toBe(c0); // dry-run wrote nothing
    expect(await engine.getPage('notes/dry')).toBeNull();

    // First, sync the dry.md commit so the anchor is past it.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(await engine.getPage('notes/dry')).not.toBeNull();

    // Commit only a NON-syncable file (.txt) → filtered totalChanges == 0 →
    // advance to pin + clear checkpoint, status up_to_date.
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(join(repoPath, 'notes/readme.txt'), 'not syncable');
    execSync('git add -A && git commit -m "txt only"', { cwd: repoPath, stdio: 'pipe' });
    const cTxt = head(repoPath);

    const res = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['up_to_date', 'synced']).toContain(res.status);
    expect(await lastCommitConfig()).toBe(cTxt);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — no PGLite, no git (fail-open cases) needed.
// ───────────────────────────────────────────────────────────────────────────
describe('#1794 pure helpers', () => {
  test('syncFingerprint is stable on (sourceId, lastCommit) and varies otherwise', () => {
    const a = syncFingerprint({ sourceId: 's', lastCommit: 'abc' });
    expect(syncFingerprint({ sourceId: 's', lastCommit: 'abc' })).toBe(a);
    expect(syncFingerprint({ sourceId: 's', lastCommit: 'def' })).not.toBe(a);
    expect(syncFingerprint({ sourceId: 't', lastCommit: 'abc' })).not.toBe(a);
    // sourceId undefined defaults to 'default' but stays stable.
    const u = syncFingerprint({ lastCommit: 'abc' });
    expect(syncFingerprint({ lastCommit: 'abc' })).toBe(u);
  });

  test('commitTimeMs fails open to null on bad input', () => {
    expect(commitTimeMs(null, 'abc')).toBeNull();
    expect(commitTimeMs('/definitely/not/a/repo', 'abc')).toBeNull();
  });

  test('clampWorkersForConnectionBudget — no-op when budget unset', () => {
    expect(clampWorkersForConnectionBudget(4, { parentPool: 10, perWorkerPool: 2 }))
      .toEqual({ workers: 4, clamped: false });
  });

  test('clampWorkersForConnectionBudget — clamps to fit budget', () => {
    // budget 16, parent 10, perWorker 2 → room for (16-10)/2 = 3 workers.
    expect(clampWorkersForConnectionBudget(4, { maxConnections: 16, parentPool: 10, perWorkerPool: 2 }))
      .toEqual({ workers: 3, clamped: true });
    // already fits → unchanged.
    expect(clampWorkersForConnectionBudget(2, { maxConnections: 16, parentPool: 10, perWorkerPool: 2 }))
      .toEqual({ workers: 2, clamped: false });
    // parent pool eats the whole budget → fall back to serial (1).
    expect(clampWorkersForConnectionBudget(4, { maxConnections: 10, parentPool: 10, perWorkerPool: 2 }))
      .toEqual({ workers: 1, clamped: true });
  });

  test('resolveMaxConnections parses env, ignores garbage', () => {
    const prev = process.env.GBRAIN_MAX_CONNECTIONS;
    try {
      delete process.env.GBRAIN_MAX_CONNECTIONS;
      expect(resolveMaxConnections()).toBeUndefined();
      process.env.GBRAIN_MAX_CONNECTIONS = '20';
      expect(resolveMaxConnections()).toBe(20);
      process.env.GBRAIN_MAX_CONNECTIONS = 'nope';
      expect(resolveMaxConnections()).toBeUndefined();
      process.env.GBRAIN_MAX_CONNECTIONS = '0';
      expect(resolveMaxConnections()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_MAX_CONNECTIONS;
      else process.env.GBRAIN_MAX_CONNECTIONS = prev;
    }
  });

  test('computePoolBudgetCheck — ok when unset, warn when parent pool eats budget', () => {
    expect(computePoolBudgetCheck(undefined, 10, 2).status).toBe('ok');
    expect(computePoolBudgetCheck(20, 10, 2).status).toBe('ok');
    expect(computePoolBudgetCheck(10, 10, 2).status).toBe('warn'); // 10+2 > 10
  });
});
