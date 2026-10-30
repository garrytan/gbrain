/**
 * GBRA-133 PR 3a: truthful status and honest stalls. Progress means committed work (a page written, deleted or renamed, a
 * cursor advanced); screening unchanged files and legacy-sweep slices are not. What it protects:
 *   - a progress-aware deadline never extends a run that committed nothing: the delegated deadline and the watchdog stop it
 *     as a coded stall (`sync_deadline_stalled`, with why and a read-only fix), never "still progressing";
 *   - the drain notes committed progress only for commits; a legacy-sweep slice keeps the governor from calling the pass hung
 *     but extends no deadline; once the governor stops a pass, its late progress events reach no listener;
 *   - a drain stop whose head owner reports restart_required is `owner_restart_required`, with the owner row and a next step
 *     that names the process to restart;
 *   - the commit notifier counts a run that committed pages as progress, and a drain-lease holder that commits nothing is a
 *     failed attempt (`drain_holder_stalled`) that runs the retry tiers to notifier_stalled instead of a silent defer.
 * Synthetic content only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { DelegatedSyncDeadline } from '../src/commands/sync-persistence-delegate.ts';
import { noteCommittedProgress, noteForwardProgress, onCommittedProgress, onForwardProgress, registerRunDeadline } from '../src/core/forward-progress.ts';
import { progressDeadlineDecision } from '../src/core/process-watchdog.ts';
import { syncDeadlineStallNotice, syncWatchdogPlan } from '../src/core/sync-reconcile.ts';
import { drainNext, drainStopFields, formatDrainSummary, runDrain, type DrainClaim, type DrainOwnerRow, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { startServeHeadWatcher, type OnCommitJobStatus, type ServeHeadWatcherOptions } from '../src/core/serve-head-watcher.ts';
import { RETRY_BACKOFF_MS } from '../src/core/commit-notifier.ts';
import { CODES } from '../src/core/error-registry.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';

afterEach(() => registerRunDeadline(null));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const base: SyncResult = { status: 'partial', reason: 'writer_yield', fromCommit: null, toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const screened = (settled: number): SyncResult => ({ ...base,
  pass: { pass_id: 'pass-example', kind: 'full', round: 1, outcome: 'partial', stop_reason: 'writer_yield', candidates: settled + 5, settled, remaining: 5, not_converged_streak: 0 } as SyncResult['pass'] });

describe('a deadline never extends a run that committed nothing', () => {
  test('progressDeadlineDecision: past the deadline, a run that committed nothing stops even with a fresh progress note', () => {
    expect(progressDeadlineDecision(5000, 1000, 0, 500, true)).toBe('extend');
    expect(progressDeadlineDecision(5000, 1000, 0, 500, false)).toBe('stop');
    expect(progressDeadlineDecision(999, 1000, 0, 500, false)).toBe('wait');
    // A run that has committed nothing yet gets one window from its start (its first unit of work may still be running).
    expect(progressDeadlineDecision(1200, 1000, 1200, 60_000, false)).toBe('extend');
    expect(progressDeadlineDecision(61_000, 1000, 0, 60_000, false)).toBe('stop');
  });

  test('the delegated deadline: passes that only screen paths stop the run at the deadline as sync_deadline_stalled', async () => {
    const lines: string[] = [];
    const deadline = new DelegatedSyncDeadline(150, 600, line => lines.push(line));
    try {
      await sleep(60);
      deadline.noteSlice(screened(40));
      await sleep(60);
      deadline.noteSlice(screened(80));
      await sleep(200);
      expect(deadline.stop.signal.aborted).toBe(true);
      expect(deadline.stalled).toBe(true);
      expect(lines.join('\n')).toContain('code=sync_deadline_stalled');
      expect(lines.join('\n')).not.toContain('still progressing');
    } finally { deadline.dispose(); }
  });

  test('the delegated deadline: a pass that committed a page extends it and is no stall', async () => {
    const lines: string[] = [];
    const deadline = new DelegatedSyncDeadline(150, 400, line => lines.push(line));
    try {
      await sleep(100);
      deadline.noteSlice({ ...screened(3), modified: 1 });
      await sleep(150);
      expect(deadline.stop.signal.aborted).toBe(false);
      expect(lines.join('\n')).toContain('still progressing');
      await sleep(450);
      expect(deadline.stop.signal.aborted).toBe(true);
      expect(deadline.stalled).toBe(false);
    } finally { deadline.dispose(); }
  });

  test('the delegated deadline: a first slice still running at the deadline is waited for, and its commits extend the run', async () => {
    const lines: string[] = [];
    const deadline = new DelegatedSyncDeadline(100, 600, line => lines.push(line));
    try {
      await sleep(250);
      expect(deadline.stop.signal.aborted).toBe(false);
      deadline.noteSlice({ ...screened(3), added: 2 });
      expect(deadline.stop.signal.aborted).toBe(false);
      expect(deadline.stalled).toBe(false);
      expect(lines.join('\n')).toContain('still progressing');
    } finally { deadline.dispose(); }
  });

  test('the delegated deadline: a first slice that returns past the deadline having committed nothing stops the run then, as a stall', async () => {
    const lines: string[] = [];
    const deadline = new DelegatedSyncDeadline(100, 5_000, line => lines.push(line));
    try {
      await sleep(250);
      expect(deadline.stop.signal.aborted).toBe(false);
      deadline.noteSlice(screened(40));
      expect(deadline.stop.signal.aborted).toBe(true);
      expect(deadline.stalled).toBe(true);
      expect(lines.join('\n')).toContain('code=sync_deadline_stalled');
    } finally { deadline.dispose(); }
  });

  test('the delegated deadline: a first slice that never returns stops the run one progress window after it started, as a stall', async () => {
    const deadline = new DelegatedSyncDeadline(100, 300, () => undefined);
    try {
      await sleep(200);
      expect(deadline.stop.signal.aborted).toBe(false);
      await sleep(200);
      expect(deadline.stop.signal.aborted).toBe(true);
      expect(deadline.stalled).toBe(true);
    } finally { deadline.dispose(); }
  });

  test('the sync watchdog listens for commits only and carries a coded stall notice (human and --json)', () => {
    const res = { deadlineMs: 3_600_000, graceMs: 30_000, reason: 'non-TTY default', progressWindowMs: 900_000 };
    const plan = syncWatchdogPlan(['--source', 'source-a', '--no-pull'], res);
    expect(plan.watchdog.progressSignal).toBe('committed');
    expect(plan.watchdog.stallNotice).toContain('code=sync_deadline_stalled');
    expect(plan.watchdog.stallNotice).toContain('committed nothing');
    expect(plan.watchdog.stallNotice).toContain('Fix: gbrain sync status --source source-a --json');
    expect(plan.armedLine).toContain('extends while the sync keeps progressing');
    const json = JSON.parse(syncDeadlineStallNotice(['--source', 'source-a', '--no-pull', '--json'], res));
    expect(json).toMatchObject({ status: 'stalled', code: 'sync_deadline_stalled', committed: 0, deadline_seconds: 3600,
      fix: { next: 'run', argv: ['gbrain', 'sync', 'status', '--source', 'source-a', '--json'] }, docs: 'docs/guides/error-codes.md#sync_deadline_stalled' });
    expect(json.why).toContain('legacy-sweep slices');
    expect(CODES.sync_deadline_stalled.fix.argv).toEqual(['gbrain', 'sync', 'status', '--source', '{source_id}', '--json']);
  });

  test('forward progress (screening) is not committed progress; a commit is both', () => {
    let forward = 0, committed = 0;
    const offForward = onForwardProgress(() => forward++), offCommitted = onCommittedProgress(() => committed++);
    try {
      noteForwardProgress();
      expect([forward, committed]).toEqual([1, 0]);
      noteCommittedProgress();
      expect([forward, committed]).toEqual([2, 1]);
    } finally { offForward(); offCommitted(); }
  });
});

describe('drain: only commits are progress, and a stopped pass reports nothing late', () => {
  const done: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
  const publishing = (ageMs: number): DrainClaim => ({ phase: 'publishing', step: 'group_commit', waiting_on: 'publication', step_age_ms: ageMs, claim_age_ms: ageMs, lapsed: false,
    owner_pid: 4242, owner_kind: 'serve', owner_nonce: 'n1', last_sql: null, allowance_ms: 150_000, ceiling_ms: 600_000 });

  test('a legacy-sweep slice is not committed progress; a page commit is', async () => {
    let committed = 0;
    const off = onCommittedProgress(() => committed++);
    try {
      const swept = await runDrain({ pauseMs: 1, pass: async (_signal, onProgress) => { onProgress?.({ phase: 'managed_sync.legacy_swept' } as never); return done; } });
      expect(swept.drain?.outcome).toBe('synced');
      expect(committed).toBe(0);
      await runDrain({ pauseMs: 1, pass: async (_signal, onProgress) => { onProgress?.({ phase: 'managed_sync.page_committed' } as never); return done; } });
      expect(committed).toBe(1);
    } finally { off(); }
  });

  test('after the governor stops a pass, its late progress events reach no deadline listener and no count', async () => {
    let report!: (event: unknown) => void;
    const started = Date.now();
    const probe: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, head: async () => ({ head_state: 'running', request_id: 'req-head', claim: publishing(Date.now() - started) }) };
    const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 30, probe,
      pass: (_signal, onProgress) => { report = event => onProgress?.(event as never); return new Promise<SyncResult>(() => undefined); } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'publication_overdue', in_pass: true } });
    let forward = 0;
    const off = onForwardProgress(() => forward++);
    try {
      report({ phase: 'managed_sync.page_committed' });
      report({ phase: 'managed_sync.finish' });
      await sleep(20);
      expect(forward).toBe(0);
    } finally { off(); }
  });

  test('a stop whose head owner reports restart_required is owner_restart_required, naming the process to restart', async () => {
    const started = Date.now();
    const row: DrainOwnerRow = { kind: 'serve', pid: 4242, nonce: 'n1', mode: 'resident', live: true, restart_required: true, root_barrier_age_ms: 700_000 };
    const probe: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, owner: async () => row,
      head: async () => ({ head_state: 'running', request_id: 'req-head', claim: publishing(Date.now() - started) }) };
    const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 30, probe, pass: () => new Promise<SyncResult>(() => undefined) });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
      stall: { cause: 'owner_restart_required', in_pass: true, head_request_id: 'req-head', owner_row: { pid: 4242, restart_required: true } } });
    const next = drainNext(result, 'gbrain sync --source source-a --no-pull', 'source-a')!;
    expect(next).toMatchObject({ code: 'drain_stalled', cause: 'owner_restart_required', safe_to_loop: false, command: 'gbrain sources writer status --source source-a --json' });
    expect(next.why).toContain('the gbrain serve process (pid 4242)');
    expect(next.why).toContain('reports restart_required');
    expect(next.fix?.user_message).toContain('Restart the gbrain serve process (pid 4242)');
    expect(formatDrainSummary(result, 'gbrain sync --source source-a --no-pull', 'source-a').join('\n')).toContain('cause=owner_restart_required');
    expect(CODES.drain_stalled.reasons as readonly string[]).toContain('owner_restart_required');
  });

  test('an owner that does not report restart_required keeps the stop as it was', async () => {
    const started = Date.now();
    const probe: StallProbe = { blockedHead: async () => null, fingerprint: async () => null,
      owner: async () => ({ kind: 'serve', pid: 4242, nonce: 'n1', mode: 'resident', live: true, restart_required: false, root_barrier_age_ms: null }),
      head: async () => ({ head_state: 'running', request_id: 'req-head', claim: publishing(Date.now() - started) }) };
    const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 30, probe, pass: () => new Promise<SyncResult>(() => undefined) });
    expect(result.drain?.stall?.cause).toBe('publication_overdue');
  });
});

describe('commit notifier: committed runs are progress, and a stalled lease holder is acted on', () => {
  const sha = (c: string) => c.repeat(40);
  const A = sha('a'), B = sha('b'), QUIET = 400;
  function harness(over: Partial<ServeHeadWatcherOptions> = {}) {
    const s = { t: 1_000_000, head: A, dbCommit: A as string | null, held: false as boolean | 'stalled', starts: [] as string[], jobs: new Map<string, OnCommitJobStatus>(), lines: [] as string[] };
    const store = memoryNotifierStore({ lastCommit: () => s.dbCommit });
    const w = startServeHeadWatcher({} as BrainEngine, {
      log: line => s.lines.push(line), pollMs: 3000, debounceMs: QUIET, hostId: 'host-example', store, now: () => s.t,
      setInterval: () => 'interval', clearInterval: () => {}, setTimeout: () => 'timer', clearTimeout: () => {},
      readFlag: async () => true,
      listSources: async () => [{ sourceId: 'acme-example', root: '/brains/acme-example', gitDir: null, lastCommit: s.dbCommit }],
      lastCommit: async () => s.dbCommit, revParse: async () => s.head, syncRunning: () => false, drainHeld: async () => s.held,
      startSync: async () => { const jobId = 'job-' + (s.starts.length + 1); s.starts.push(jobId); s.jobs.set(jobId, { state: 'running' }); return { jobId }; },
      jobStatus: jobId => s.jobs.get(jobId) ?? null,
      ...over,
    });
    return { w, s, store, decisions: (kind: string) => w.decisions.filter(d => d.decision === kind), advance: (ms: number) => { s.t += ms; } };
  }

  test('a resumable run that committed pages resumes even though last_commit has not moved yet', async () => {
    const h = harness();
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    h.s.jobs.set('job-1', { state: 'done', outcome: 'resumable', reason: 'deadline', committed: true });
    h.advance(QUIET); await h.w.tick();
    h.advance(QUIET); await h.w.tick();
    expect(h.decisions('resume')).toHaveLength(1);
    expect(h.decisions('retry')).toEqual([]);
    expect(h.s.starts).toEqual(['job-1', 'job-2']);
  });

  test('a drain-lease holder that commits nothing is a failed attempt: the retry tiers run to notifier_stalled with the sync-now fix', async () => {
    const h = harness();
    h.s.held = 'stalled';
    await h.w.tick();
    h.s.head = B; await h.w.tick();
    for (const wait of [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!]) { h.advance(wait); await h.w.tick(); }
    expect(h.s.starts).toEqual([]);
    expect(h.decisions('defer_drain_lease')).toEqual([]);
    expect(h.decisions('retry').map(d => d.detail)[0]).toBe('drain_holder_stalled');
    expect(h.decisions('stalled').length).toBeGreaterThan(0);
    expect(h.store.states.get('acme-example')).toMatchObject({ state: 'retry', reason: 'notifier_stalled', last_error_code: 'notifier_stalled' });
    expect(h.s.lines.filter(l => l.includes('notifier_stalled') && l.includes('drain_holder_stalled'))).toHaveLength(1);
    expect(h.s.lines.some(l => l.includes('gbrain sync --source acme-example --no-pull'))).toBe(true);
    expect(CODES.drain_holder_stalled.docs).toBe('docs/guides/on-commit-sync.md#notifier-stalled');
    // The holder recovers (a live, committing holder): the source is deferred to it again, never started beside it.
    h.s.held = true;
    h.advance(RETRY_BACKOFF_MS.at(-1)!); await h.w.tick();
    expect(h.decisions('defer_drain_lease').length).toBeGreaterThan(0);
    expect(h.s.starts).toEqual([]);
  });
});

describe('GBRA-133: a drain that stops short names its cause on the serve done line', () => {
  const base = { added: 3, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], fromCommit: null, toCommit: 'a'.repeat(40) } as unknown as SyncResult;
  test('a synced result adds nothing', () => {
    expect(drainStopFields({ ...base, status: 'synced', drain: { outcome: 'synced' } as never })).toBe('');
  });
  test('a blocked stop names its stop reason, the write that stopped it, and the failed files by code', () => {
    const managedWrite = { write_error: 'storage_error', reason: 'database_contention', write_request: { request_id: '123e4567-e89b-42d3-a456-426614174000' } } as never;
    expect(drainStopFields({ ...base, status: 'blocked_by_failures', drain: { outcome: 'blocked', stop_reason: 'blocked_by_failures' } as never, managedWrite }))
      .toBe(' stop=blocked_by_failures write_error=storage_error write_reason=database_contention request=123e4567-e89b-42d3-a456-426614174000');
    expect(drainStopFields({ ...base, status: 'blocked_by_failures', failedFiles: 3, failureCodes: [{ code: 'invalid_frontmatter', count: 2 }, { code: 'file_too_large', count: 1 }] }))
      .toBe(' failed_files=3 failures=invalid_frontmatter:2,file_too_large:1');
  });
  test('a blocked stop that recorded no write and no failed file says cause=unrecorded instead of reading like a clean end', () => {
    expect(drainStopFields({ ...base, status: 'blocked_by_failures', drain: { outcome: 'blocked', stop_reason: 'blocked_by_failures' } as never }))
      .toBe(' stop=blocked_by_failures cause=unrecorded');
  });
  test('a resumable stop names its reason', () => {
    expect(drainStopFields({ ...base, status: 'partial', reason: 'writer_yield', drain: { outcome: 'resumable', stop_reason: 'deadline' } as never })).toBe(' stop=deadline');
    expect(drainStopFields({ ...base, status: 'partial', reason: 'writer_yield' })).toBe(' stop=writer_yield');
  });
});
