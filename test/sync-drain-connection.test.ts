/**
 * #6340: a managed drain whose pass dies on a dropped database connection
 * (`write ECONNABORTED host:port`, the session-mode pooler closing the socket
 * mid-statement) resumes instead of exiting. Before this change the drain's
 * transient classifier did not know `ECONNABORTED` (only `ECONNRESET`), so the
 * error escaped `runDrain`, the CLI exited 1 and the operator relaunched by
 * hand; four such deaths cost one brain fifty minutes in an afternoon. Now the
 * drain reconnects, waits 5 / 15 / 45 s and re-enters the pass at the stored
 * cursor; three drops in a row with no page committed between them end the
 * drain `blocked` / `connection_lost` with the same resume command as `next`.
 * `CONNECTION_DESTROYED` / `CONNECTION_CLOSED` stay out of the retry (#6329:
 * this process's own settle of a cancelled statement, the stall path).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { CONNECTION_RETRY_MS, CONNECTION_STRIKES, drainJsonFields, drainNext, formatDrainSummary, isConnectionDrop, runDrain } from '../src/core/persistence/sync-drain.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';
import { CODES } from '../src/core/error-registry.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const RESUME = 'gbrain sync --source s --no-pull --retry-failed';
const dropped = (errno = 'ECONNABORTED') => Object.assign(new Error(`write ${errno} db.example.invalid:5432`), { code: errno });

function captureStderr(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('classifying a dropped connection', () => {
  test('the socket errnos a pooler drop surfaces are retryable connection errors; the settle codes and page faults are not', () => {
    for (const errno of ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
      expect(isRetryableConnError(dropped(errno))).toBe(true);
      expect(isConnectionDrop(dropped(errno))).toBe(true);
      expect(isConnectionDrop(new Error(`write ${errno} undefined:undefined`))).toBe(true);
    }
    expect(isConnectionDrop(Object.assign(new Error('write CONNECTION_DESTROYED'), { code: 'CONNECTION_DESTROYED' }))).toBe(false);
    expect(isConnectionDrop(Object.assign(new Error('write CONNECTION_CLOSED host:5432'), { code: 'CONNECTION_CLOSED' }))).toBe(false);
    expect(isConnectionDrop(Object.assign(new Error('A page changed after this sync cursor was enumerated.'), { code: 'revision_conflict' }))).toBe(false);
    expect(isConnectionDrop(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(false);
  });

  test('the schedule is 5, 15 and 45 seconds and the strike count matches it', () => {
    expect([...CONNECTION_RETRY_MS]).toEqual([5_000, 15_000, 45_000]);
    expect(CONNECTION_STRIKES).toBe(3);
  });
});

describe('runDrain over a dropping connection', () => {
  test('a drop is reconnected and retried; a pass that then commits resets the strikes and the drain finishes synced', async () => {
    let passes = 0;
    const reconnects: unknown[] = [];
    const err = captureStderr();
    try {
      const result = await runDrain({ announce: true, progressMs: 1, backoffMs: 2, reconnect: async error => { reconnects.push(error); },
        pass: async (_signal, onProgress) => {
          passes++;
          // Drops on passes 1 and 2, a page on pass 3, drops on 4 and 5 (the counter restarted at the commit), done on 6.
          if (passes === 1 || passes === 2 || passes === 4 || passes === 5) throw dropped(passes === 4 ? 'ETIMEDOUT' : 'ECONNABORTED');
          if (passes === 3) { onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 1, total: 2 }); return { ...base, status: 'partial', reason: 'writer_yield', managedCursor: { index: 1, total: 2 } }; }
          onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 2, total: 2 });
          return { ...base, managedCursor: { index: 2, total: 2 } };
        } });
      expect(result.drain).toMatchObject({ outcome: 'synced', passes: 6, written: 2 });
      expect(result.drain!.stop_reason).toBeUndefined();
      expect(reconnects).toHaveLength(4);
      expect(reconnects.every(error => isConnectionDrop(error))).toBe(true);
      const drops = err.lines.filter(line => line.includes('database connection dropped'));
      expect(drops).toHaveLength(4);
      expect(drops[0]).toMatch(/^\[sync\] 0\/\? processed · database connection dropped \(write ECONNABORTED db\.example\.invalid:5432\); reconnecting and retrying in \d+s \(1 of 3\)$/);
      expect(drops[2]).toContain('(1 of 3)');
    } finally { err.restore(); }
  });

  test('three drops with no page between them end the drain blocked / connection_lost with the resume command as next, loopable', async () => {
    let passes = 0;
    const result = await runDrain({ backoffMs: 2, pass: async () => { passes++; throw dropped(); } });
    expect(passes).toBe(3);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'connection_lost', connection: { drops: 3, last_error: 'write ECONNABORTED db.example.invalid:5432' } });
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: RESUME, safe_to_loop: true, retry_after_ms: 60_000, code: 'connection_lost', docs: ERROR_CATALOGUE.sync_drain_connection_lost.docs });
    expect(next.why).toContain('3 times in a row');
    expect(next.why).toContain('without re-freezing');
    expect(ERROR_CATALOGUE.sync_drain_connection_lost).toEqual({ code: 'connection_lost', docs: 'docs/guides/write-refusals.md#drain-connection-lost' });
    expect(CODES.connection_lost).toMatchObject({ class: 'retryable', retryable: true });
    expect(drainJsonFields(result, RESUME, 's')).toMatchObject({ outcome: 'blocked', next: { command: RESUME, safe_to_loop: true } });
    const summary = formatDrainSummary(result, RESUME, 's').join('\n');
    expect(summary).toContain('Database connection dropped 3 times in a row');
    expect(summary).toContain(`Next: ${RESUME} (safe to rerun in a loop)`);
  });

  test('a connection URL in the error text never reaches the report, and a drop after a successful pass keeps that pass\'s counts', async () => {
    let passes = 0;
    const leaky = Object.assign(new Error('write ECONNABORTED postgresql://user:secret@db.example.invalid:5432/brain'), { code: 'ECONNABORTED' });
    const pending: SyncResult = { ...base, status: 'partial', reason: 'writer_yield', added: 4, managedCursor: { index: 4, total: 9 } };
    const result = await runDrain({ backoffMs: 2, pass: async () => { if (++passes === 1) return pending; throw leaky; } });
    expect(result).toMatchObject({ added: 4, drain: { outcome: 'blocked', stop_reason: 'connection_lost', remaining: 5 } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.drain!.connection!.last_error).toBe('write ECONNABORTED <url>');
  });

  test('a settle-discard code is not a drop: the drain ends with the error as before', async () => {
    const destroyed = Object.assign(new Error('write CONNECTION_DESTROYED'), { code: 'CONNECTION_DESTROYED' });
    await expect(runDrain({ backoffMs: 2, pass: async () => { throw destroyed; } })).rejects.toBe(destroyed);
  });
});
