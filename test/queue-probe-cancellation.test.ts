/**
 * issue #6 — timed-out probes are CANCELLED, not abandoned.
 *
 * Closes the TODOS entry "cancel (not just abandon) timed-out submit-time
 * queue probes": `probeQueueState` time-bounds via Promise.race, but the
 * losing query used to keep running on the pool after the race resolved —
 * under pool exhaustion (the exact regime the probe exists to detect) the
 * abandoned query held a slot and made the exhaustion worse. The timeout now
 * aborts a per-probe AbortSignal threaded through `queryWedgeSignals` into
 * `engine.executeRaw`, and `withRefreshingLock`'s heartbeat does the same for
 * `handle.refresh`.
 *
 * Hermetic: stub engines (`as unknown as BrainEngine`), no DB.
 */

import { describe, expect, test } from 'bun:test';
import { probeQueueState, queryWedgeSignals } from '../src/core/minions/supervisor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const WEDGE_ROW = {
  stalled: '0',
  active_healthy: '1',
  waiting: '2',
  waiting_claimable: '2',
  last_completed: null,
  last_completed_claimable: null,
};

describe('queryWedgeSignals signal threading (issue #6)', () => {
  test('forwards opts.signal to executeRaw', async () => {
    let seenOpts: { signal?: AbortSignal } | undefined;
    const engine = {
      kind: 'postgres',
      executeRaw: async (_sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        seenOpts = opts;
        return [WEDGE_ROW];
      },
    } as unknown as BrainEngine;
    const ac = new AbortController();

    const sig = await queryWedgeSignals(engine, 'default', ['sync'], { signal: ac.signal });

    expect(sig.waiting).toBe(2);
    expect(seenOpts?.signal).toBe(ac.signal);
  });
});

describe('probeQueueState cancellation (issue #6)', () => {
  test('timeout aborts the per-probe signal so the losing query is cancelled', async () => {
    let seenSignal: AbortSignal | undefined;
    const engine = {
      kind: 'postgres',
      executeRaw: (_sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        seenSignal = opts?.signal;
        // Hang forever — the abandoned-racer scenario.
        return new Promise<never>(() => {});
      },
    } as unknown as BrainEngine;

    const state = await probeQueueState(engine, 'default', ['sync'], { timeoutMs: 50 });

    expect(state.probe_failed).toBe(true);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(true);
  });

  test('fast probe: signal delivered but never aborted; result returned', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        seenSignals.push(opts?.signal);
        if (sql.includes('EXTRACT(EPOCH')) return [{ age: 12 }];
        return [WEDGE_ROW];
      },
    } as unknown as BrainEngine;

    const state = await probeQueueState(engine, 'default', ['sync'], { timeoutMs: 5_000 });

    expect(state.probe_failed).toBeUndefined();
    expect(state.depth).toBe(2);
    // The wedge + age queries carry the probe signal. Other engine calls made
    // by the probe (e.g. inspectLock) pass no opts — filter to the signals we
    // threaded and assert none were aborted on the fast path.
    const threaded = seenSignals.filter((s): s is AbortSignal => s instanceof AbortSignal);
    expect(threaded.length).toBeGreaterThanOrEqual(2);
    for (const s of threaded) {
      expect(s.aborted).toBe(false);
    }
  });

  test('probe throw still collapses to {probe_failed: true} (fail-open contract)', async () => {
    const engine = {
      kind: 'postgres',
      executeRaw: async () => {
        throw new Error('query was cancelled');
      },
    } as unknown as BrainEngine;

    const state = await probeQueueState(engine, 'default', ['sync'], { timeoutMs: 5_000 });
    expect(state.probe_failed).toBe(true);
  });
});
