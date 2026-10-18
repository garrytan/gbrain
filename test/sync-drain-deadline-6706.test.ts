/**
 * #6706: a managed drain bounded by a caller deadline (the `sync` job's `timeout_at`).
 *
 * Protects: the drain stops `resumable / deadline` before the caller's deadline and never starts a pass after it; a past
 * deadline makes zero passes; the earlier of the CLI run deadline and the caller deadline wins; a far deadline does not
 * fire early (setTimeout overflow); a deadline landing in a retry backoff is a resumable report, not a throw; a pass that
 * ignores the abort is abandoned after the grace; and `jobDisposition` classifies every drained stop.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { registerRunDeadline } from '../src/core/forward-progress.ts';
import { deadlinePassed, jobDisposition, runDrain, type DrainReport } from '../src/core/persistence/sync-drain.ts';
import { stampDrainStep } from '../src/core/persistence/drain-step.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0,
  chunksCreated: 0, embedded: 0, pagesAffected: [] };
const pending = (index: number, total = 10): SyncResult => ({ ...base, status: 'partial', reason: 'writer_pending', managedCursor: { index, total } });

afterEach(() => registerRunDeadline(null));

describe('runDrain with a caller deadline', () => {
  test('stops resumable/deadline before the deadline and starts no pass after it', async () => {
    const deadlineAtMs = Date.now() + 400;
    const starts: number[] = [];
    const result = await runDrain({ deadlineAtMs, pauseMs: 20, pass: async () => { starts.push(Date.now()); return pending(starts.length); } });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline' });
    expect(result.reason).toBe('timeout');
    expect(Date.now()).toBeLessThan(deadlineAtMs + 100);
    expect(starts.every(at => at < deadlineAtMs)).toBe(true);
    expect(starts.length).toBeGreaterThan(1);
  });

  test('a deadline already past makes exactly zero passes', async () => {
    let calls = 0;
    const result = await runDrain({ deadlineAtMs: Date.now() - 1, pass: async () => { calls++; return pending(1); } });
    expect(calls).toBe(0);
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline', passes: 0 });
  });

  test('the earlier of the strict run deadline and the caller deadline wins', async () => {
    registerRunDeadline({ atMs: Date.now() + 60_000, strict: true });
    const started = Date.now();
    const early = await runDrain({ deadlineAtMs: Date.now() + 200, pauseMs: 10, pass: async () => pending(1) });
    expect(early.drain?.stop_reason).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(2_000);
    registerRunDeadline({ atMs: Date.now() + 200, strict: true });
    const runFirst = Date.now();
    const late = await runDrain({ deadlineAtMs: Date.now() + 60_000, pauseMs: 10, pass: async () => pending(1) });
    expect(late.drain?.stop_reason).toBe('deadline');
    expect(Date.now() - runFirst).toBeLessThan(2_000);
  });

  test('a deadline 30 days out does not fire early', async () => {
    let calls = 0;
    const result = await runDrain({ deadlineAtMs: Date.now() + 30 * 24 * 3_600_000, pauseMs: 1,
      pass: async () => (++calls < 3 ? pending(calls) : { ...base, managedCursor: { index: 10, total: 10 } }) });
    expect(calls).toBe(3);
    expect(result.drain?.outcome).toBe('synced');
  });

  test('a deadline that lands in a transient retry backoff returns resumable instead of throwing', async () => {
    let calls = 0;
    const result = await runDrain({ deadlineAtMs: Date.now() + 150, backoffMs: 400,
      pass: async () => { calls++; if (calls === 1) return pending(2); throw new OperationError('database_contention', 'busy'); } });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline', remaining: 8 });
  });

  test('a fatal error after the deadline still throws', async () => {
    await expect(runDrain({ deadlineAtMs: Date.now() + 100, pauseMs: 1, pass: async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      throw new OperationError('permission_denied', 'no');
    } })).rejects.toThrow('no');
  });

  test('a pass that ignores the abort is abandoned after the grace and its late result is dropped', async () => {
    let lateSignal: AbortSignal | undefined;
    const started = Date.now();
    const result = await runDrain({ deadlineAtMs: Date.now() + 100, deadlineGraceMs: 50, pass: signal => { lateSignal = signal; return new Promise<SyncResult>(() => undefined); } });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lateSignal?.aborted).toBe(true);
  });

  test('an abandoned pass is fenced at its next step even though the deadline aborted its signal first', async () => {
    let passSignal: AbortSignal | undefined;
    await runDrain({ deadlineAtMs: Date.now() + 100, deadlineGraceMs: 30, pass: signal => { passSignal = signal; return new Promise<SyncResult>(() => undefined); } });
    expect(passSignal?.aborted).toBe(true);
    expect((passSignal!.reason as Error).message).toBe('run deadline');
    expect(() => stampDrainStep('admission', passSignal)).toThrow('pass abandoned');
  });

  test('a reconnect that hangs past the deadline is not awaited; the stop is resumable', async () => {
    const drop = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    let calls = 0;
    const started = Date.now();
    const result = await runDrain({ deadlineAtMs: Date.now() + 200, backoffMs: 1, reconnect: () => new Promise<void>(() => undefined),
      pass: async () => { calls++; if (calls === 1) return pending(3); throw drop; } });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('deadlinePassed is true only inside the cooperative margin', () => {
    const now = 1_000_000;
    expect(deadlinePassed(undefined, now)).toBe(false);
    expect(deadlinePassed(now + 60_000, now)).toBe(false);
    expect(deadlinePassed(now + 10_000, now)).toBe(true);
    expect(deadlinePassed(now - 1, now)).toBe(true);
  });
});

describe('jobDisposition', () => {
  const drained = (drain: Partial<DrainReport>, over: Partial<SyncResult> = {}): SyncResult => ({ ...base, status: 'partial', reason: 'timeout', ...over,
    drain: { outcome: 'resumable', passes: 1, processed: 1, written: 1, waived: 0, remaining: 3, rate_pages_per_min: null, eta_seconds: null, ...drain } });

  test('a result with no drain keeps the master result (null)', () => {
    expect(jobDisposition(base, 's')).toBeNull();
    expect(jobDisposition({ ...base, status: 'partial', reason: 'timeout' }, 's')).toBeNull();
  });

  test.each([
    ['synced', drained({ outcome: 'synced', remaining: 0 }, { status: 'synced', reason: undefined }), 'synced'],
    ['deadline', drained({ stop_reason: 'deadline' }), 'continue'],
    ['preparation_abandoned', drained({ stop_reason: 'preparation_abandoned' }), 'continue'],
    ['connection_lost', drained({ outcome: 'blocked', stop_reason: 'connection_lost', connection: { drops: 3, last_error: 'x' } }), 'continue'],
    ['write_capacity', drained({ outcome: 'blocked', stop_reason: 'write_capacity' }), 'needs_operator'],
    ['database_contention', drained({ outcome: 'blocked', stop_reason: 'database_contention' }), 'needs_operator'],
    ['preparation_systemic', drained({ outcome: 'blocked', stop_reason: 'preparation_systemic' }), 'needs_operator'],
    ['blocked_by_failures', drained({ outcome: 'blocked', stop_reason: 'blocked_by_failures' }, { status: 'blocked_by_failures' }), 'needs_operator'],
    ['recovery_required', drained({ outcome: 'blocked', stop_reason: 'recovery_required' }), 'needs_operator'],
    ['owner_unavailable', drained({ outcome: 'blocked', stop_reason: 'owner_unavailable' }), 'needs_operator'],
    ['unexpected_file_bytes', drained({ outcome: 'blocked', stop_reason: 'unexpected_file_bytes' }), 'needs_operator'],
    ['unexpected_staging_bytes', drained({ outcome: 'blocked', stop_reason: 'unexpected_staging_bytes' }), 'needs_operator'],
    ['drain_stalled (no progress)', drained({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { request_id: 'r', state: 'running', blocked_reason: null, head_request_id: null, head_state: null, claimable_here: null, owner_is_this_host: null, stalled_seconds: 30, cause: 'no_progress' } }), 'needs_operator'],
    ['drain_stalled (owner wedged, ceiling ahead)', drained({ outcome: 'blocked', stop_reason: 'drain_stalled', retry_after_ms: 60_000, stall: { request_id: 'r', state: 'running', blocked_reason: null, head_request_id: null, head_state: null, claimable_here: null, owner_is_this_host: true, stalled_seconds: 300, cause: 'owner_wedged_here', past_ceiling: false, owner_pid: 1, owner_kind: 'serve' } }), 'continue'],
    ['drain_stalled (owner wedged, past ceiling)', drained({ outcome: 'blocked', stop_reason: 'drain_stalled', retry_after_ms: 0, stall: { request_id: 'r', state: 'running', blocked_reason: null, head_request_id: null, head_state: null, claimable_here: null, owner_is_this_host: true, stalled_seconds: 700, cause: 'owner_wedged_here', past_ceiling: true, owner_pid: 1, owner_kind: 'serve' } }), 'needs_operator'],
  ] as const)('%s', (_name, result, expected) => {
    expect(jobDisposition(result as SyncResult, 's')).toBe(expected);
  });
});
