/**
 * BrainEngine parity — ambient recall session state (engine-sql/session-state.ts): the context pack's read
 * (`readSessionContextState`), delta's read (`readDeltaSessionRow`), the cursor upsert (`upsertSessionContextRow`), the
 * compaction harvest's manifest (`readCheckpointManifest`, `writeCheckpointManifest`) and the row GC
 * (`gcSessionContextRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls return the same answers on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). A `delta` with a session_id establishes the cursor on the first
 *    call and returns only the later changes on the second. The upsert inserts a row with the column defaults, then
 *    replaces standing entities and the surfaced slug only when given, keeps a stored wake time or facts cursor when the
 *    write has none, and counts incomplete wakes up, back to zero or not at all. A manifest write replaces only the
 *    manifest. The GC deletes the rows not updated in the age window, then the oldest rows past the per-client cap.
 *  - Regression: an engine that cannot read or write the row — `delta` with a session_id refusing every call as
 *    `session_state` unavailable, the context pack losing its standing entities, the harvest's manifest never settling —
 *    or a GC that keeps stale rows or deletes the wrong lane's rows.
 *  - Why existing coverage misses it: test/session-state-gc.test.ts, test/checkpoint-manifest.test.ts and
 *    test/ambient-recall.test.ts run on PGLite only and age rows with raw SQL; a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only. The age window is a fraction of a day the case waits out; the
 *    seven-day default and the 1,000-row cap need a clock the harness cannot move: cargo tests of the store
 *    (rust/crates/gbrain-store/tests/session_state.rs) cover them with a fake clock. Generated timestamps are checked for
 *    their shape and never returned.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SessionStateKey } from '../../src/core/engine-sql/session-state.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ISO_US = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const key = (sessionId: string, clientId = 'local', sourceId = 'default'): SessionStateKey => ({ sourceId, clientId, sessionId });
const keep = { standingEntities: null, cursorSlug: null, lastWakeAt: null, factsCursorAt: null, factsCursorId: null, degradedWakes: 'keep' } as const;

function deltaCtx(engine: BrainEngine): OperationContext {
  return {
    engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {},
  } as unknown as OperationContext;
}

describe('engine parity: session state', () => {
  parityTest('delta with a session_id starts the cursor, then returns only the pages written after it', {
    methods: ['readDeltaSessionRow', 'upsertSessionContextRow', 'gcSessionContextRows', 'putPage'],
  }, async (engine) => {
    const op = operations.find((o) => o.name === 'delta')!;
    const ctx = deltaCtx(engine);
    await engine.putPage('notes/before-example', { type: 'note', title: 'Before', compiled_truth: 'written before the session', timeline: '' });
    const first = await op.handler(ctx, { session_id: 'agent-main' }) as Record<string, unknown>;
    const row = await engine.readDeltaSessionRow(key('agent-main'));
    expect(row?.last_wake_at).toMatch(ISO_US);
    expect(row?.facts_cursor_at).toBe(row?.last_wake_at);
    await Bun.sleep(5);
    await engine.putPage('notes/after-example', { type: 'note', title: 'After', compiled_truth: 'written after the session began', timeline: '' });
    const second = await op.handler(ctx, { session_id: 'agent-main' }) as Record<string, unknown>;
    const fold = (r: Record<string, unknown>) => ({
      pages: (r.pages as Array<{ slug: string }>).map((p) => p.slug),
      facts: (r.facts as unknown[]).length,
      has_more: r.has_more,
      degraded: r.degraded_reason ?? null,
    });
    // The first call starts the cursor and delivers nothing; the second delivers only the later page.
    expect(fold(first).pages).toEqual([]);
    expect(fold(second).pages).toEqual(['notes/after-example']);
    const after = await engine.readDeltaSessionRow(key('agent-main'));
    return {
      first: fold(first),
      second: fold(second),
      row: { surfaced: row?.surfaced_slugs, facts_id: row?.facts_cursor_id, wakes: row?.degraded_wakes },
      advanced: after !== null && after.last_wake_at !== null && after.last_wake_at >= row!.last_wake_at!,
      afterSurfaced: after?.surfaced_slugs,
    };
  });

  parityTest('the upsert inserts with defaults, replaces only given fields, and counts incomplete wakes', {
    methods: ['readSessionContextState', 'readDeltaSessionRow', 'upsertSessionContextRow'],
  }, async (engine) => {
    const k = key('s1');
    const absent = { pack: await engine.readSessionContextState(k), delta: await engine.readDeltaSessionRow(k) };
    const inserted = await engine.upsertSessionContextRow(k, {
      ...keep, standingEntities: ['people/alice-example'], lastWakeAt: '2026-06-01T10:00:00.123456Z', degradedWakes: 'increment',
    });
    const afterInsert = { pack: await engine.readSessionContextState(k), delta: await engine.readDeltaSessionRow(k) };
    const bumped = await engine.upsertSessionContextRow(k, {
      ...keep, cursorSlug: 'notes/a-example', factsCursorAt: '2026-06-02T00:00:00Z', factsCursorId: 42, degradedWakes: 'increment',
    });
    const afterCursor = { pack: await engine.readSessionContextState(k), delta: await engine.readDeltaSessionRow(k) };
    // No facts time: the stored id stays, whatever id the write carries.
    const kept = await engine.upsertSessionContextRow(k, { ...keep, factsCursorId: 7 });
    const afterKeep = await engine.readDeltaSessionRow(k);
    const reset = await engine.upsertSessionContextRow(k, { ...keep, standingEntities: [], degradedWakes: 'reset' });
    const afterReset = { pack: await engine.readSessionContextState(k), delta: await engine.readDeltaSessionRow(k) };
    // Another client and another source are other rows.
    const other = { client: await engine.readDeltaSessionRow(key('s1', 'remote')), source: await engine.readDeltaSessionRow(key('s1', 'local', 'other')) };
    return { absent, inserted, afterInsert, bumped, afterCursor, kept, afterKeep, reset, afterReset, other };
  });

  parityTest('the checkpoint manifest is read back as written and leaves the cursor alone', {
    methods: ['readCheckpointManifest', 'writeCheckpointManifest', 'upsertSessionContextRow', 'readDeltaSessionRow'],
  }, async (engine) => {
    const k = key('harvest');
    const absent = await engine.readCheckpointManifest(k);
    const links = [{ slug: 'notes/x-example', title: 'X', at: '2026-06-01T00:00:00.000Z', n: 1, seg: 'abc' }];
    await engine.writeCheckpointManifest(k, links);
    const created = { manifest: await engine.readCheckpointManifest(k), delta: await engine.readDeltaSessionRow(k) };
    await engine.upsertSessionContextRow(k, { ...keep, cursorSlug: 'notes/y-example', lastWakeAt: '2026-06-03T00:00:00Z' });
    await engine.writeCheckpointManifest(k, [{ slug: 'notes/z-example', title: 'Z', at: '2026-06-04T00:00:00.000Z', n: 2, seg: 'def' }, ...links]);
    const replaced = { manifest: await engine.readCheckpointManifest(k), delta: await engine.readDeltaSessionRow(k) };
    return { absent, created, replaced };
  });

  parityTest('the GC deletes rows past the age window, then the oldest rows past the per-client cap', {
    methods: ['upsertSessionContextRow', 'readSessionContextState', 'gcSessionContextRows'],
    timeout: 30_000,
  }, async (engine) => {
    const seed = (k: SessionStateKey) => engine.upsertSessionContextRow(k, { ...keep, cursorSlug: k.sessionId });
    const present = async (ks: SessionStateKey[]) => Object.fromEntries(
      await Promise.all(ks.map(async (k) => [`${k.sourceId}/${k.clientId}/${k.sessionId}`, (await engine.readSessionContextState(k)) !== null])));
    // Age: a row older than 0.6 seconds goes, a newer one stays.
    const old = key('old');
    await seed(old);
    await Bun.sleep(1_200);
    const fresh = key('fresh');
    await seed(fresh);
    await engine.gcSessionContextRows(0.6 / 86_400, 1000);
    const aged = await present([old, fresh]);
    // Cap: three rows in one (source, client) lane with cap 2 keep the newest two; other lanes stay.
    const lane = [key('c1', 'capped'), key('c2', 'capped'), key('c3', 'capped')];
    for (const k of lane) { await seed(k); await Bun.sleep(10); }
    const others = [key('o1', 'other-client'), key('c1', 'capped', 'other-source')];
    for (const k of others) await seed(k);
    await engine.gcSessionContextRows(7, 2);
    const capped = await present([...lane, ...others, fresh]);
    return { aged, capped };
  });
});
