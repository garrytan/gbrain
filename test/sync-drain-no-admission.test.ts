/**
 * #6423 (P2.2): behind a transaction-mode pooler a managed sync pass admitted nothing and never returned, and with no
 * unfinished request there was no claim for the stall detector to read. The in-pass governor stops it `blocked /
 * drain_stalled` after the no-progress window and names the process-local step and the last statement label the pass
 * stamped. #6712 PR 2 retired the separate `no_admission` cause (and its serve fallback and pooler warning): the stop is
 * `no_progress` like any other pass that moved nothing, with the same step and statement, and its next step is the
 * writer inspection. These tests pinned `no_admission`; they now assert `no_progress`. Synthetic results only.
 */
import { describe, expect, test } from 'bun:test';
import { drainNext, formatDrainSummary, runDrain, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { noteDrainSql, readDrainStep, stampDrainStep } from '../src/core/persistence/drain-step.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const RESUME = 'gbrain sync --source s --no-pull';
const empty: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, head: async () => null };

describe('in-pass governor: a pass that admits nothing', () => {
  test('pass blocked forever with no unfinished head: blocked/drain_stalled/no_progress naming waiver_run and the last SQL', async () => {
    const started = Date.now();
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty,
      pass: signal => { stampDrainStep('waiver_run', signal); noteDrainSql('SELECT id FROM persistence_requests WHERE page_id=$1'); return new Promise<SyncResult>(() => undefined); } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', in_pass: true, step: 'waiver_run', head_request_id: null } });
    expect(result.drain!.stall!.last_sql?.label).toBe('SELECT persistence_requests');
    const summary = formatDrainSummary(result, RESUME, 's').join('\n');
    expect(summary).toContain('No request of this source was unfinished');
    expect(summary).toContain('step=waiver_run, last_sql=SELECT persistence_requests');
    expect(summary).toContain('cause=no_progress');
    expect(summary).not.toContain('no_admission');
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: 'gbrain sources writer status s', safe_to_loop: false, code: 'drain_stalled', cause: 'no_progress' });
    expect(next.why).toContain('stuck at step waiver_run');
  });

  test('the abandoned pass admits nothing more: its next step boundary throws the abort', async () => {
    let signal: AbortSignal | undefined;
    await runDrain({ governMs: 10, noProgressMs: 40, probe: empty, pass: s => { signal = s; return new Promise<SyncResult>(() => undefined); } });
    expect(() => stampDrainStep('admission', signal)).toThrow();
    expect(readDrainStep()).toBeNull();
  });

  // The drain's clock advances 25 ms per committed page against a 60 ms window, so the governor's verdict no longer depends on
  // event-loop scheduling. The governor still ticks on real timers between pages; the 80 ms loop stall at pass start and the
  // first page's 85 ms real wait each outlast the window on purpose: either alone stopped the pass before the clock seam.
  test('a pass that commits keeps the governor quiet', async () => {
    let now = 0;
    const result = await runDrain({ governMs: 10, noProgressMs: 60, probe: empty, clock: () => now, pass: async (_signal, onProgress) => {
      const blockedUntil = performance.now() + 80; while (performance.now() < blockedUntil) { /* the event loop stalls 80 ms at pass start */ }
      for (let i = 1; i <= 6; i++) { now += 25; await new Promise(r => setTimeout(r, i === 1 ? 85 : 25)); onProgress({ phase: 'managed_sync.page_committed', bankedFiles: i, total: 6 }); }
      return { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 6, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], managedCursor: { index: 6, total: 6 } };
    } });
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 6 });
  });

  test('the same governor stops the pass once the clock passes the window before a commit', async () => {
    let now = 0;
    const result = await runDrain({ governMs: 10, noProgressMs: 60, probe: empty, clock: () => now, pass: async (_signal, onProgress) => {
      now += 25; onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 1, total: 6 });
      now += 61;
      return new Promise<SyncResult>(() => undefined);
    } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', written: 1, stall: { cause: 'no_progress', in_pass: true } });
  });
});
