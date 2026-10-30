/**
 * #7355: on a large managed source the first full pass read and classified the whole level, including one walk of the
 * whole Git history for the origin evidence of files a page lost, before its first commit. The drain's in-pass governor
 * counts only commits and committed sweep slices as progress, so a level read past its 5-minute window was abandoned with
 * nothing banked, and every following pass started the same read again. `sync status` kept sending the plain sync.
 * The level read now reports progress while it works (its loops' pauses and the history walk's commits), a pass asking
 * for a history walk already under way joins it, and status names passes that keep stopping before they end.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { runDrain } from '../src/core/persistence/sync-drain.ts';
import { __resetHistoryIndexesForTest, readOriginEvidence } from '../src/core/persistence/sync-origin-evidence.ts';
import { abandonedPasses, passStatusNext, passStatusState } from '../src/core/persistence/sync-pass-status.ts';
import { MANAGED_SYNC_PASS_OP, readPassRow, type PassRow } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const done: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const page = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nA note about ${title}.\n`;

/** `count` empty commits on top of HEAD through one `git fast-import`, so the history walk has thousands of commits to read. */
function emptyCommits(root: string, count: number): void {
  const branch = git(root, ['symbolic-ref', 'HEAD']);
  let stream = '';
  for (let i = 0; i < count; i++) stream += `commit ${branch}\ncommitter Example <example@example.invalid> ${1_700_000_000 + i} +0000\ndata 2\nc\n${i === 0 ? `from ${branch}^0\n` : ''}\n`;
  git(root, ['fast-import', '--quiet', '--force'], stream);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-7355-'));
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'a.md'), page('a'));
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'a']);
  return root;
}

describe('#7355: the drain hears a level read that is still working', () => {
  // The drain's clock advances 20 ms per level-progress event against an 80 ms window, so the verdict no longer depends on
  // event-loop scheduling (a loaded runner stalled the loop past the window). The governor still ticks on real timers; the
  // 120 ms loop stall after the first event outlasts the window on purpose and stopped the pass before the clock seam.
  test('a pass that reports level progress past the no-progress window is not abandoned', async () => {
    let now = 0;
    const result = await runDrain({ governMs: 10, noProgressMs: 80, publicationCeilingMs: 60_000, clock: () => now,
      pass: async (_signal, onProgress) => {
        for (let i = 0; i < 20; i++) {
          onProgress?.({ phase: 'managed_sync.level_progress' }); now += 20;
          if (i === 0) { const blockedUntil = performance.now() + 120; while (performance.now() < blockedUntil) { /* the event loop stalls 120 ms after the first event */ } }
          await Bun.sleep(20);
        }
        return done;
      } });
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 1 });
  }, 15_000);

  test('a pass that goes quiet is still stopped no_progress', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 80, publicationCeilingMs: 60_000,
      pass: async (_signal, onProgress) => { onProgress?.({ phase: 'managed_sync.level_progress' }); return new Promise<SyncResult>(() => undefined); } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', in_pass: true } });
  }, 15_000);
});

describe('#7355: the origin history walk reports its commits and is shared', () => {
  test('two callers asking while one walk runs both hear its commits and get the same evidence', async () => {
    const root = repo();
    try {
      emptyCommits(root, 2_500);
      unlinkSync(join(root, 'a.md')); git(root, ['commit', '-qam', 'remove a']);
      __resetHistoryIndexesForTest();
      const head = git(root, ['rev-parse', 'HEAD']);
      const heard = [0, 0];
      const [first, second] = await Promise.all([0, 1].map(i => readOriginEvidence(root, [head], ['a.md', 'never.md'], { onCommit: () => { heard[i]!++; } })));
      expect(heard[0]).toBeGreaterThan(0);
      expect(heard[1]).toBeGreaterThan(0);
      expect(Object.fromEntries(first!)).toEqual({ 'a.md': 'committed', 'never.md': 'never_committed' });
      expect(Object.fromEntries(second!)).toEqual(Object.fromEntries(first!));
    } finally { rmSync(root, { recursive: true, force: true }); __resetHistoryIndexesForTest(); }
  }, 60_000);
});

describe('#7355: status names passes that keep stopping before they end', () => {
  const row = (outcome: string, streak: number | undefined, quietMs: number, now: number): PassRow => ({ updated_at: new Date(now - quietMs).toISOString(),
    value: { source_id: 's', incarnation: 'i', lease_token: 't', obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {}, ...(streak ? { abandoned_streak: streak } : {}) },
      telemetry: { pass_id: 'p', target: 'h', started_at: '', ended_at: null, kind: 'full', round: 0, outcome: outcome as never, stop_reason: null, candidates: 0, settled: 0, remaining: 0, counts: {}, duration_ms: null, timings_ms: {} } } });
  const now = Date.parse('2026-10-22T12:00:00Z');

  test('an open pass after an abandoned one, quiet past the window, is blocked pass_abandoned and next is a report', () => {
    const stuck = row('open', 1, 6 * 60_000, now);
    expect(abandonedPasses(stuck, now)).toBe(2);
    expect(passStatusState(stuck, null, null, now)).toEqual(['blocked', 'pass_abandoned']);
    const next = passStatusNext('s', 'pass_abandoned', stuck, ['--source', 's']);
    expect(next.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(next.why).toContain('another plain sync is likely to stop the same way');
  });

  test('a pass that is still moving, or the first one abandoned, keeps sending the plain sync', () => {
    expect(passStatusState(row('open', 1, 10_000, now), null, null, now)).toEqual(['resumable', 'pass_unfinished']);
    expect(passStatusState(row('open', undefined, 6 * 60_000, now), null, null, now)).toEqual(['resumable', 'pass_unfinished']);
    expect(passStatusState(row('synced', 3, 6 * 60_000, now), null, null, now)).toBeNull();
  });
});

describe('#7354 review: the racy window follows the filesystem clock, not only the process clock', () => {
  test('a file written just now is not vouched when the process clock runs ahead of the filesystem', async () => {
    const { probeDirtiness, readIndexLevel, readTreeLevel } = await import('../src/core/persistence/sync-git-stream.ts');
    const root = repo();
    const realNow = Date.now;
    try {
      const tree = await readTreeLevel(root, 'HEAD', ''), index = await readIndexLevel(root);
      Date.now = () => realNow() + 3_000;
      expect((await probeDirtiness(root, root, ['a.md'], tree, index)).get('a.md')?.dp).toBe('clean');
      Date.now = realNow;
      const { renameSync } = await import('node:fs');
      renameSync(join(root, '.git'), join(root, '.git-away'));
      try { expect((await probeDirtiness(root, root, ['a.md'], tree, index)).get('a.md')?.dp).toBe('unknown'); }
      finally { renameSync(join(root, '.git-away'), join(root, '.git')); }
    } finally { Date.now = realNow; rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#7355 [${backend}]: a live pass reports level progress, and a pass after one left open counts it until it ends`, () => managedBrain(async ({ engine, root }) => {
    const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
    expect((await performManagedSync(engine, OPTS)).status).toMatch(/^(first_sync|synced)$/);

    // A file the page lost behind a long history: the pass reads the origin evidence from one walk of it.
    emptyCommits(root, 2_500);
    unlinkSync(join(root, 'b.md')); git(root, ['commit', '-qam', 'remove b']);
    __resetHistoryIndexesForTest();
    // The previous pass never ended: its row is left open, as the governor or a killed process leaves it.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,telemetry,outcome}','"open"') WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    let pinnedStreak: number | undefined;
    installFaultHook(async point => { if (point === 'sync:round_start' && pinnedStreak === undefined) pinnedStreak = (await readPassRow(engine, 'default', incarnation!))?.value.obligations.abandoned_streak; });
    const phases: string[] = [];
    const result = await performManagedSync(engine, { ...OPTS, onProgress: event => { phases.push(event.phase); } }).finally(() => installFaultHook(undefined));
    expect(result.status).toBe('synced');
    expect(pinnedStreak).toBe(1);
    expect(phases).toContain('managed_sync.level_progress');
    const ended = (await readPassRow(engine, 'default', incarnation!))!;
    expect(abandonedPasses(ended)).toBe(0);
    expect(passStatusState(ended, null)).toBeNull();
  }, { databaseUrl, setup: ({ root }) => {
    git(root, ['init', '-q']);
    for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), page(name));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'pages']);
  } }), 120_000);
}
