/**
 * #6423 (P2.2): behind a transaction-mode pooler a managed sync pass admitted nothing and never returned, and with no
 * unfinished request there was no claim for the stall detector to read. The in-pass governor stops it `blocked /
 * drain_stalled / no_admission` after the no-progress window and names the process-local step and the last statement
 * label the pass stamped. Synthetic results only.
 */
import { describe, expect, test } from 'bun:test';
import { drainNext, formatDrainSummary, runDrain, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { noteDrainSql, readDrainStep, stampDrainStep } from '../src/core/persistence/drain-step.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const RESUME = 'gbrain sync --source s --no-pull';
const empty: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, head: async () => null };

describe('in-pass governor: a pass that admits nothing', () => {
  test('pass blocked forever with no unfinished head: blocked/drain_stalled/no_admission naming waiver_run and the last SQL', async () => {
    const started = Date.now();
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty,
      pass: signal => { stampDrainStep('waiver_run', signal); noteDrainSql('SELECT id FROM persistence_requests WHERE page_id=$1'); return new Promise<SyncResult>(() => undefined); } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_admission', in_pass: true, step: 'waiver_run', head_request_id: null } });
    expect(result.drain!.stall!.last_sql?.label).toBe('SELECT persistence_requests');
    const summary = formatDrainSummary(result, RESUME, 's').join('\n');
    expect(summary).toContain('Nothing admitted for');
    expect(summary).toContain('step=waiver_run, last_sql=SELECT persistence_requests, cause=no_admission');
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: RESUME, safe_to_loop: false, code: 'drain_stalled', cause: 'no_admission' });
    expect(next.why).toContain('transaction-mode pooler');
  });

  test('the abandoned pass admits nothing more: its next step boundary throws the abort', async () => {
    let signal: AbortSignal | undefined;
    await runDrain({ governMs: 10, noProgressMs: 40, probe: empty, pass: s => { signal = s; return new Promise<SyncResult>(() => undefined); } });
    expect(() => stampDrainStep('admission', signal)).toThrow();
    expect(readDrainStep()).toBeNull();
  });

  test('a pass that commits keeps the governor quiet', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 60, probe: empty, pass: async (_signal, onProgress) => {
      for (let i = 1; i <= 6; i++) { await new Promise(r => setTimeout(r, 25)); onProgress({ phase: 'managed_sync.page_committed', bankedFiles: i, total: 6 }); }
      return { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 6, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], managedCursor: { index: 6, total: 6 } };
    } });
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 6 });
  });
});
