/**
 * v0.38 autopilot per-source fan-out unit tests.
 *
 * Pure-function coverage:
 *   - readLastFullCycleAt: JSONB roundtrip + nulls
 *   - isSourceStale: 60-min floor + never-cycled
 *   - selectSourcesForDispatch: gate + cap + deterministic ordering
 *   - resolveFanoutMax: PGLite=1, Postgres=4, operator override
 *   - dispatchPerSource: fallback path + per-source idempotency + cap
 *
 * No engine; queue + engine are stubbed.
 */
import { describe, test, expect } from 'bun:test';
import {
  readLastFullCycleAt,
  isSourceStale,
  selectSourcesForDispatch,
  resolveFanoutMax,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
import type { SourceRow, BrainEngine } from '../src/core/engine.ts';

function src(id: string, last_full_cycle_at?: string | null, extra: Record<string, unknown> = {}): SourceRow {
  return {
    id,
    name: null,
    local_path: `/tmp/${id}`,
    last_sync_at: null,
    config: {
      ...(last_full_cycle_at !== undefined ? { last_full_cycle_at } : {}),
      ...extra,
    },
  };
}

describe('readLastFullCycleAt', () => {
  test('returns Date when ISO string present', () => {
    const d = readLastFullCycleAt(src('a', '2026-05-22T07:00:00.000Z'));
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-05-22T07:00:00.000Z');
  });
  test('returns null when missing', () => {
    expect(readLastFullCycleAt(src('a'))).toBeNull();
  });
  test('returns null when explicitly null', () => {
    expect(readLastFullCycleAt(src('a', null))).toBeNull();
  });
  test('returns null for unparseable string (codex P0-5 robustness)', () => {
    expect(readLastFullCycleAt(src('a', 'not-a-date'))).toBeNull();
  });
});

describe('isSourceStale', () => {
  const NOW = Date.parse('2026-05-22T12:00:00.000Z');
  test('never-cycled source is stale', () => {
    expect(isSourceStale(src('a'), NOW)).toBe(true);
  });
  test('source cycled 30min ago is fresh', () => {
    const past = new Date(NOW - 30 * 60_000).toISOString();
    expect(isSourceStale(src('a', past), NOW)).toBe(false);
  });
  test('source cycled exactly at floor (60min) is stale (>=)', () => {
    const past = new Date(NOW - 60 * 60_000).toISOString();
    expect(isSourceStale(src('a', past), NOW)).toBe(true);
  });
  test('source cycled 2h ago is stale', () => {
    const past = new Date(NOW - 2 * 60 * 60_000).toISOString();
    expect(isSourceStale(src('a', past), NOW)).toBe(true);
  });
  test('override floor (5 min) flips stale earlier', () => {
    const past = new Date(NOW - 6 * 60_000).toISOString();
    expect(isSourceStale(src('a', past), NOW, 5)).toBe(true);
    expect(isSourceStale(src('a', past), NOW, 60)).toBe(false);
  });
});

describe('selectSourcesForDispatch', () => {
  const NOW = Date.parse('2026-05-22T12:00:00.000Z');
  const fresh = (id: string, agoMin: number) =>
    src(id, new Date(NOW - agoMin * 60_000).toISOString());

  test('only stale sources dispatched', () => {
    const result = selectSourcesForDispatch(
      [fresh('a', 30), fresh('b', 90), src('c')],
      10,
      NOW,
    );
    expect(result.dispatch.map(s => s.id).sort()).toEqual(['b', 'c']);
    expect(result.skippedFresh.map(s => s.id)).toEqual(['a']);
    expect(result.skippedCap).toEqual([]);
  });

  test('never-cycled (NULL) sorts before timestamped', () => {
    const result = selectSourcesForDispatch(
      [fresh('b', 90), src('a'), fresh('c', 120)],
      10,
      NOW,
    );
    // 'a' has no last_full_cycle_at → -Infinity → sorts first
    // then 'c' (120min ago, older) before 'b' (90min ago, newer)
    expect(result.dispatch.map(s => s.id)).toEqual(['a', 'c', 'b']);
  });

  test('cap honored; overflow goes to skippedCap', () => {
    const result = selectSourcesForDispatch(
      [src('a'), src('b'), src('c'), src('d'), src('e')],
      2,
      NOW,
    );
    expect(result.dispatch.length).toBe(2);
    expect(result.skippedCap.length).toBe(3);
  });

  test('alphabetical tiebreaker when two NULL sources', () => {
    const result = selectSourcesForDispatch([src('zebra'), src('alpha')], 10, NOW);
    expect(result.dispatch.map(s => s.id)).toEqual(['alpha', 'zebra']);
  });

  test('all-fresh produces empty dispatch (the steady-state)', () => {
    const result = selectSourcesForDispatch([fresh('a', 5), fresh('b', 10)], 10, NOW);
    expect(result.dispatch).toEqual([]);
    expect(result.skippedFresh.length).toBe(2);
  });

  test('empty input is safe', () => {
    const result = selectSourcesForDispatch([], 4, NOW);
    expect(result.dispatch).toEqual([]);
    expect(result.skippedFresh).toEqual([]);
    expect(result.skippedCap).toEqual([]);
  });
});

describe('resolveFanoutMax', () => {
  function stubEngine(kind: 'postgres' | 'pglite', configValue?: string): BrainEngine {
    return {
      kind,
      getConfig: async (_key: string) => configValue ?? null,
    } as unknown as BrainEngine;
  }
  test('PGLite default is 1 (codex P1-3)', async () => {
    expect(await resolveFanoutMax(stubEngine('pglite'))).toBe(1);
  });
  test('Postgres default is 4', async () => {
    expect(await resolveFanoutMax(stubEngine('postgres'))).toBe(4);
  });
  test('operator override honored', async () => {
    expect(await resolveFanoutMax(stubEngine('postgres', '8'))).toBe(8);
    expect(await resolveFanoutMax(stubEngine('pglite', '3'))).toBe(3);
  });
  test('invalid override falls back to default', async () => {
    expect(await resolveFanoutMax(stubEngine('postgres', 'not-a-number'))).toBe(4);
    expect(await resolveFanoutMax(stubEngine('postgres', '0'))).toBe(4);
    expect(await resolveFanoutMax(stubEngine('postgres', '-5'))).toBe(4);
    expect(await resolveFanoutMax(stubEngine('pglite', ''))).toBe(1);
  });
});

describe('dispatchPerSource — integration with stubbed engine + queue', () => {
  type AddedJob = { name: string; data: unknown; opts: Record<string, unknown> };

  function makeStubs(sources: SourceRow[], opts?: { listThrows?: boolean }) {
    const added: AddedJob[] = [];
    let nextId = 100;
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => {
        if (opts?.listThrows) throw new Error('sources table missing');
        return sources;
      },
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, addOpts: Record<string, unknown>) => {
        added.push({ name, data, opts: addOpts });
        return { id: nextId++ };
      },
    } as unknown as Parameters<typeof dispatchPerSource>[1];
    const events: string[] = [];
    const logs: string[] = [];
    const fanoutOpts = {
      repoPath: '/tmp/brain',
      slot: '2026-05-22T12:00:00.000Z',
      timeoutMs: 600_000,
      fanoutMax: 4,
      jsonMode: true,
      emit: (line: string) => events.push(line),
      log: (line: string) => logs.push(line),
    };
    return { engine, queue, added, events, logs, fanoutOpts };
  }

  test('empty sources list falls back to legacy single-job dispatch', async () => {
    const { engine, queue, added, fanoutOpts } = makeStubs([]);
    const result = await dispatchPerSource(engine, queue, fanoutOpts);
    expect(result.legacy_fallback).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-cycle');
    expect((added[0].data as Record<string, unknown>).source_id).toBeUndefined();
    expect(added[0].opts.idempotency_key).toBe('autopilot-cycle:2026-05-22T12:00:00.000Z');
  });

  test('listAllSources throwing also falls back to legacy', async () => {
    const { engine, queue, added, fanoutOpts } = makeStubs([], { listThrows: true });
    const result = await dispatchPerSource(engine, queue, fanoutOpts);
    expect(result.legacy_fallback).toBe(true);
    expect(added.length).toBe(1);
  });

  test('per-source fan-out: 2 stale sources, both dispatched with distinct keys', async () => {
    const { engine, queue, added, fanoutOpts } = makeStubs([src('alpha'), src('beta')]);
    const result = await dispatchPerSource(engine, queue, fanoutOpts);
    expect(result.legacy_fallback).toBe(false);
    expect(result.dispatched.sort()).toEqual(['alpha', 'beta']);
    expect(added.length).toBe(2);
    // Per-source idempotency keys
    const keys = added.map(j => j.opts.idempotency_key as string).sort();
    expect(keys).toEqual([
      'autopilot-cycle:alpha:2026-05-22T12:00:00.000Z',
      'autopilot-cycle:beta:2026-05-22T12:00:00.000Z',
    ]);
    // source_id threaded through job data
    const sourceIds = added.map(j => (j.data as Record<string, unknown>).source_id).sort();
    expect(sourceIds).toEqual(['alpha', 'beta']);
  });

  test('pull: true only when source.config.remote_url is set', async () => {
    const remote = src('remote', undefined, { remote_url: 'https://github.com/x/y' });
    const local = src('local');
    const { engine, queue, added, fanoutOpts } = makeStubs([remote, local]);
    await dispatchPerSource(engine, queue, fanoutOpts);
    const byId = new Map<string, AddedJob>(
      added.map(j => [(j.data as Record<string, unknown>).source_id as string, j]),
    );
    expect((byId.get('remote')!.data as Record<string, unknown>).pull).toBe(true);
    expect((byId.get('local')!.data as Record<string, unknown>).pull).toBe(false);
  });

  test('fanoutMax cap: 3 sources, fanoutMax=1, 1 dispatched + 2 in skippedCap', async () => {
    const { engine, queue, added, fanoutOpts } = makeStubs([src('a'), src('b'), src('c')]);
    fanoutOpts.fanoutMax = 1;
    const result = await dispatchPerSource(engine, queue, fanoutOpts);
    expect(result.dispatched.length).toBe(1);
    expect(result.skipped_cap.length).toBe(2);
    expect(added.length).toBe(1);
  });

  test('per-submit error does NOT abort the tick', async () => {
    const sources = [src('alpha'), src('boom'), src('charlie')];
    const added: AddedJob[] = [];
    const events: string[] = [];
    let nextId = 100;
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        const id = (data as Record<string, unknown>).source_id;
        if (id === 'boom') throw new Error('queue full');
        added.push({ name, data, opts });
        return { id: nextId++ };
      },
    } as unknown as Parameters<typeof dispatchPerSource>[1];
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true,
      emit: (l) => events.push(l), log: () => {},
    });
    // 2 of 3 dispatched (alpha + charlie); boom failed but didn't abort
    expect(result.dispatched.sort()).toEqual(['alpha', 'charlie']);
    expect(added.length).toBe(2);
    expect(events.some(e => e.includes('fanout_submit_failed') && e.includes('boom'))).toBe(true);
  });

  test('cap-reached event fires when skippedCap is non-empty', async () => {
    const { engine, queue, events, fanoutOpts } = makeStubs([src('a'), src('b'), src('c')]);
    fanoutOpts.fanoutMax = 1;
    await dispatchPerSource(engine, queue, fanoutOpts);
    const capEvent = events.find(e => e.includes('fanout_cap_reached'));
    expect(capEvent).toBeDefined();
    const parsed = JSON.parse(capEvent!);
    expect(parsed.cap).toBe(1);
    expect(parsed.pending.length).toBe(2);
  });

  test('per-source submit MUST NOT pass maxWaiting (regression — coalesces all sources to one job)', async () => {
    // Direct unit-stub queues can't enforce maxWaiting semantics (the
    // production MinionQueue implementation does), so this catches the
    // regression by inspecting the submit opts at the dispatch boundary.
    // If a future refactor re-adds maxWaiting:1 to the per-source path,
    // the production fan-out would silently coalesce N sources to ONE
    // waiting job per tick — killing the entire feature. The e2e test
    // also catches this against a real queue, but this guard fires in
    // unit tests too so the bug surfaces 100x faster.
    const { engine, queue, added, fanoutOpts } = makeStubs([src('a'), src('b'), src('c')]);
    await dispatchPerSource(engine, queue, fanoutOpts);
    for (const job of added) {
      expect(job.opts.maxWaiting).toBeUndefined();
    }
  });

  test('all-fresh tick dispatches nothing (no jobs added)', async () => {
    const NOW = Date.now();
    const recent = (id: string) =>
      src(id, new Date(NOW - 5 * 60_000).toISOString());
    const { engine, queue, added, fanoutOpts } = makeStubs([recent('a'), recent('b')]);
    const result = await dispatchPerSource(engine, queue, fanoutOpts);
    expect(result.dispatched.length).toBe(0);
    expect(result.skipped_fresh.length).toBe(2);
    expect(added.length).toBe(0);
  });
});
