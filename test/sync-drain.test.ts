import { afterEach, describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { lastForwardProgressAt, registerRunDeadline } from '../src/core/forward-progress.ts';
import { drainEstimate, drainJsonFields, drainNext, formatDuration, runDrain, syncOutcome, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0,
  chunksCreated: 0, embedded: 0, pagesAffected: [] };
const pending = (index: number, total = 10): SyncResult => ({ ...base, status: 'partial', reason: 'writer_pending', managedCursor: { index, total },
  managedWrite: { source_id: 's', slug: 'p', path: 'p.md', write_error: 'write_pending', reason: 'write_pending', message: 'm', suggestion: 's',
    write_request: { request_id: '00000000-0000-0000-0000-000000000001', state: 'queued', retry_after_ms: 0 } as never } });
const yielded = (index: number, total = 10): SyncResult => ({ ...base, status: 'partial', reason: 'writer_yield', managedCursor: { index, total } });
const done = (total = 10): SyncResult => ({ ...base, managedCursor: { index: total, total } });
const RESUME = 'gbrain sync --source s --no-pull';

function scripted(results: Array<SyncResult | Error>) {
  let i = 0;
  return { calls: () => i, pass: async () => { const next = results[Math.min(i++, results.length - 1)]; if (next instanceof Error) throw next; return next; } };
}

afterEach(() => registerRunDeadline(null));

describe('runDrain', () => {
  test('re-enters writer_pending and writer_yield passes until the cursor is done', async () => {
    const s = scripted([pending(1), yielded(3), pending(4), done()]);
    const result = await runDrain({ pass: s.pass, pauseMs: 1 });
    expect(s.calls()).toBe(4);
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 4, remaining: 0 });
    expect(syncOutcome(result)).toBe('synced');
  });

  test('a stopped signal ends the drain as resumable with the cursor intact', async () => {
    const stop = new AbortController();
    const s = scripted([pending(2)]);
    const result = await runDrain({ pass: async () => { stop.abort(); return s.pass(); }, signal: stop.signal, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline', passes: 1, remaining: 8 });
    expect(result.reason).toBe('timeout');
    expect(drainNext(result, RESUME, 's')).toMatchObject({ command: RESUME, safe_to_loop: true });
  });

  test('a strict registered run deadline stops the drain before the watchdog', async () => {
    registerRunDeadline({ atMs: Date.now() + 60, strict: true });
    const started = Date.now();
    const result = await runDrain({ pass: async () => pending(1), pauseMs: 5 });
    expect(result.drain?.outcome).toBe('resumable');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a progress-aware run deadline does not stop a progressing drain', async () => {
    registerRunDeadline({ atMs: Date.now() - 1, strict: false });
    const s = scripted([pending(1), done()]);
    expect((await runDrain({ pass: s.pass, pauseMs: 1 })).drain?.outcome).toBe('synced');
  });

  test('blocked results end the drain as blocked with a retry command', async () => {
    const failed = await runDrain({ pass: async () => ({ ...base, status: 'blocked_by_failures', failedFiles: 1 }) });
    expect(failed.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'blocked_by_failures' });
    expect(drainNext(failed, RESUME, 's')).toMatchObject({ command: `${RESUME} --retry-failed`, safe_to_loop: false });
    const terminal = pending(3);
    terminal.managedWrite!.write_error = 'revision_conflict';
    terminal.status = 'blocked_by_failures';
    expect((await runDrain({ pass: async () => terminal })).drain?.outcome).toBe('blocked');
  });

  test('named transient failures retry with bounded attempts; others stop at once', async () => {
    const contention = () => new OperationError('database_contention', 'busy');
    const s = scripted([contention(), contention(), done()]);
    expect((await runDrain({ pass: s.pass, backoffMs: 1 })).drain?.outcome).toBe('synced');
    expect(s.calls()).toBe(3);
    const exhausted = scripted([contention(), contention(), contention(), contention(), done()]);
    await expect(runDrain({ pass: exhausted.pass, backoffMs: 1 })).rejects.toThrow('busy');
    const fatal = scripted([new OperationError('permission_denied', 'no'), done()]);
    await expect(runDrain({ pass: fatal.pass })).rejects.toThrow('no');
    expect(fatal.calls()).toBe(1);
  });

  test('admission contention keeps retrying the frozen request instead of ending the drain', async () => {
    const contention = new OperationError('storage_error', 'Write admission is temporarily blocked by database contention.');
    contention.detail = 'database_contention';
    const s = scripted([contention, contention, contention, contention, contention, done()]);
    const started = Date.now();
    expect((await runDrain({ pass: s.pass })).drain?.outcome).toBe('synced');
    expect(s.calls()).toBe(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
  }, 15_000);

  test('worktree_refreshing waits its retry_after_ms hint', async () => {
    const refreshing = new OperationError('worktree_refreshing', 'refreshing');
    refreshing.detail = 'retry_after_ms=5';
    const s = scripted([refreshing, refreshing, refreshing, refreshing, done()]);
    expect((await runDrain({ pass: s.pass })).drain?.outcome).toBe('synced');
    expect(s.calls()).toBe(5);
  });

  test('a recovery-blocked head stops the drain as blocked with the writer command', async () => {
    const stall = { request_id: 'r', state: 'queued', blocked_reason: 'recovery_required', head_request_id: 'h', head_state: 'recovering',
      claimable_here: false, owner_is_this_host: true, stalled_seconds: 0 };
    const probe: StallProbe = { blockedHead: async () => ({ reason: 'recovery_required', stall }), fingerprint: async () => null };
    const result = await runDrain({ pass: async () => pending(2), probe, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'recovery_required', stall: { head_request_id: 'h' } });
    expect(drainNext(result, RESUME, 's')).toMatchObject({ command: 'gbrain sources writer status s', safe_to_loop: false });
  });

  test('no change in the awaited request across the stall window stops the drain as drain_stalled', async () => {
    const stall = { request_id: 'r', state: 'queued', blocked_reason: null, head_request_id: 'r', head_state: 'queued', claimable_here: false, owner_is_this_host: false };
    const probe: StallProbe = { blockedHead: async () => null, fingerprint: async () => ({ key: 'same', stall }) };
    const result = await runDrain({ pass: async () => pending(2), probe, pauseMs: 1, stallMs: 20 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { request_id: 'r', claimable_here: false } });
    expect(result.drain!.passes).toBeGreaterThanOrEqual(4);
  });

  test('a changing fingerprint never counts as a stall', async () => {
    let n = 0;
    const stall = { request_id: 'r', state: 'running', blocked_reason: null, head_request_id: 'r', head_state: 'running', claimable_here: false, owner_is_this_host: true };
    const probe: StallProbe = { blockedHead: async () => null, fingerprint: async () => ({ key: String(n), stall }) };
    const result = await runDrain({ pass: async () => (++n < 8 ? pending(2) : done()), probe, pauseMs: 1, stallMs: 1 });
    expect(result.drain?.outcome).toBe('synced');
  });

  test('progress events count written and waived pages and note forward progress', async () => {
    const before = lastForwardProgressAt();
    const seen: string[] = [];
    const result = await runDrain({ onProgress: e => seen.push(e.phase), pass: async (_signal, onProgress) => {
      onProgress({ phase: 'managed_sync.start', bankedFiles: 0, total: 4 });
      onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 1, total: 4 });
      onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 2, total: 4, waived: true });
      onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 3, total: 4, waived: true });
      return done(4);
    } });
    expect(result.drain).toMatchObject({ processed: 3, written: 1, waived: 2, remaining: 0 });
    expect(seen).toContain('managed_sync.start');
    expect(lastForwardProgressAt()).toBeGreaterThanOrEqual(before);
  });
});

describe('estimates and outcomes', () => {
  test('zero progress reports an unknown rate, never a zero or infinite ETA', () => {
    expect(drainEstimate(100, 0, 60_000)).toEqual({ rate_pages_per_min: null, eta_seconds: null });
    expect(drainEstimate(100, 10, 60_000)).toEqual({ rate_pages_per_min: 10, eta_seconds: 600 });
    expect(drainEstimate(null, 10, 60_000)).toEqual({ rate_pages_per_min: 10, eta_seconds: null });
  });

  test('formatDuration', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m05s');
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h12m');
  });

  test('a single-pass pending write keeps the historical blocked verdict; failed pulls stay blocked', () => {
    expect(syncOutcome(pending(1))).toBe('blocked');
    expect(syncOutcome({ ...base, status: 'partial', reason: 'pull_failed' })).toBe('blocked');
    expect(syncOutcome({ ...base, status: 'partial', reason: 'timeout' })).toBe('resumable');
    expect(syncOutcome({ ...base, status: 'up_to_date' })).toBe('synced');
  });

  test('JSON fields appear only for managed results', () => {
    expect(drainJsonFields(base, RESUME, 's')).toEqual({});
    expect(drainJsonFields(done(), RESUME, 's')).toEqual({ outcome: 'synced' });
  });
});

describe('managed sync backlog', () => {
  const engineWith = (headers: unknown[]) => ({ executeRaw: async () => headers.map(header => ({ header })) }) as never;

  test('estimates from the latest drain window and builds the resume command from stored options', async () => {
    const { readManagedSyncBacklog, formatManagedSyncBacklog } = await import('../src/core/persistence/sync-drain.ts');
    const now = Date.now();
    const [b] = await readManagedSyncBacklog(engineWith([{ sourceId: 'notes', index: 300, total: 1300,
      progress: { startedAt: now - 120_000, startIndex: 100, lastAt: now, lastIndex: 300 }, processingOptions: { noEmbed: true } }]));
    expect(b).toMatchObject({ source_id: 'notes', remaining: 1000, rate_pages_per_min: 100, eta_seconds: 600,
      resume_command: 'gbrain sync --source notes --no-pull --no-embed' });
    expect(formatManagedSyncBacklog(b!)).toContain('indexing ETA 10m00s');
  });

  test('a cursor with no drain window reports rate unknown, never an infinite ETA', async () => {
    const { readManagedSyncBacklog, formatManagedSyncBacklog } = await import('../src/core/persistence/sync-drain.ts');
    const [b] = await readManagedSyncBacklog(engineWith([{ sourceId: 'notes', index: 0, total: 50 }]));
    expect(b).toMatchObject({ remaining: 50, rate_pages_per_min: null, eta_seconds: null });
    expect(formatManagedSyncBacklog(b!)).toContain('rate unknown');
    expect(await readManagedSyncBacklog(engineWith([{ sourceId: 'other', index: 0, total: 5 }]), ['notes'])).toEqual([]);
  });

  test('a resumed drain window resets, so downtime never depresses the rate', async () => {
    const { readManagedSyncBacklog } = await import('../src/core/persistence/sync-drain.ts');
    const now = Date.now();
    const [b] = await readManagedSyncBacklog(engineWith([{ sourceId: 's', index: 500, total: 600,
      progress: { startedAt: now - 60_000, startIndex: 440, lastAt: now, lastIndex: 500 } }]));
    expect(b!.rate_pages_per_min).toBe(60);
  });
});

describe('classified write waits', () => {
  test('a blocked wait stops the drain with its cause; a repeated read failure stops it as database_contention', async () => {
    const blocked = { ...pending(2), writeWait: { status: 'blocked' as const, request_id: 'r', cause: 'owner_unavailable', command: 'gbrain sources writer status s --json' } };
    expect((await runDrain({ pass: async () => blocked, pauseMs: 1 })).drain).toMatchObject({ outcome: 'blocked', stop_reason: 'owner_unavailable' });
    const failing = { ...pending(2), writeWait: { status: 'read_failed' as const, request_id: 'r', reason: 'conn_dropped', transient: true, attempts: 1, message: 'm', why: 'retry' } };
    const s = scripted([failing, failing, failing, done()]);
    const result = await runDrain({ pass: s.pass, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'database_contention' });
    expect(drainNext(result, RESUME, 's')).toMatchObject({ command: RESUME, safe_to_loop: false });
    const auth = { ...failing, writeWait: { ...failing.writeWait, reason: 'auth_failed', transient: false } };
    expect((await runDrain({ pass: async () => auth, pauseMs: 1 })).drain?.passes).toBe(1);
  });

  test('#6305: a page still waiting for a process that can take the worktree lock after its wait stops the drain', async () => {
    const page = pending(2);
    const unlocked = { ...page, managedWrite: { ...page.managedWrite!, reason: 'writer_lock_unavailable' } };
    const result = await runDrain({ pass: async () => unlocked, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'writer_lock_unavailable', passes: 1 });
    expect(drainNext(result, RESUME, 's')).toMatchObject({ command: 'gbrain sources writer status s', safe_to_loop: false,
      why: expect.stringContaining('(writer_lock_unavailable)'), docs: 'docs/guides/write-refusals.md#drain-writer-blocked' });
    // An ordinary pending page still re-enters the drain.
    const s = scripted([page, done()]);
    expect((await runDrain({ pass: s.pass, pauseMs: 1 })).drain).toMatchObject({ outcome: 'synced', passes: 2 });
  });
});
