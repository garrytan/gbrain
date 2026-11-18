/**
 * BrainEngine parity — open loops (`open_loops`): the upsert, list and close members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: upsertOpenLoop's insert, its manual-close and mute guards and the columns an update keeps or takes;
 *    listOpenLoops' source, status, type, counterparty and id filters, its limit clamp and its order; and
 *    closeOpenLoop's open-only, source-scoped close return the same observable result on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that reopens a loop the owner closed on a re-render with no newer activity, reopens a
 *    muted loop for the same counterparty, overwrites the thread or detector, drops the counterparty source when a
 *    later write names no slug, reuses ids, or orders ties differently: `gbrain loops done` would silently revert, or
 *    `loops show <id>` would name the wrong loop.
 *  - Why existing coverage misses it: the loop tests drive these statements through `executeRaw` on PGLite alone; no
 *    case compares engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OpenLoopUpsert } from '../../src/core/loops/loops-store.ts';
import type { OpenLoopUpsertResult } from '../../src/core/engine-sql/open-loops.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';
const T3 = '2026-03-09T10:00:00.000Z';

const NOW_FIELDS = new Set(['closed_at', 'created_at', 'updated_at']);

/**
 * Loop ids relative to the case's first insert. The Postgres arm's reset keeps sequences counting (harness.ts
 * resetPostgres), so a case names a loop as `id(n)`, the n-th id its own inserts took, and reads ids back as
 * `rel(id)`; on a fresh sequence both are the identity.
 */
type Ids = { id: (n: number) => number; rel: (v: unknown) => number | null; first: OpenLoopUpsertResult };
async function firstLoop(engine: BrainEngine, loop: OpenLoopUpsert): Promise<Ids> {
  const first = await engine.upsertOpenLoop(loop);
  const base = Number(first.id) - 1;
  return { id: (n) => n + base, rel: (v) => (v === null || v === undefined ? null : Number(v) - base), first: { ...first, id: 1 } };
}

/** A row with the fields `now()` fills mapped to whether they are set, the other times as ISO text, ids relative. */
function observe(row: Record<string, unknown> | null, ids: Ids): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (NOW_FIELDS.has(k)) out[k] = v !== null && v !== undefined;
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (k === 'id') out[k] = ids.rel(v);
    else if (k === 'fact_id') out[k] = v === null ? null : Number(v);
    else out[k] = v;
  }
  return out;
}

/** An upsert result with its id relative. */
function result(r: OpenLoopUpsertResult, ids: Ids) {
  return { ...r, id: ids.rel(r.id) };
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'default', dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartyEmail: 'a@example.com',
    summary: 'first', evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a', detector: 'deterministic_thread',
    lastActivityAt: T1, openedAt: T1, ...over,
  };
}

async function listAll(engine: BrainEngine, ids: Ids, opts: Parameters<BrainEngine['listOpenLoops']>[0] = {}) {
  return (await engine.listOpenLoops(opts)).map(r => observe(r, ids));
}

describe('engine parity: open loops', () => {
  parityTest(
    'upsertOpenLoop inserts, keeps a closed loop on equal activity, reopens on newer activity, and takes ids on every call',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine) => {
      const ids = await firstLoop(engine, loop({ counterpartySlug: 'people/alice-example', pageSlug: 'emails/a', factId: 7, dueAt: '2026-03-20T12:00:00+02:00', confidence: 0.3 }));
      const results: unknown[] = [ids.first];
      // Open row: opened_at keeps the earlier time, slug/page/due/fact keep the old value when the new one is null.
      results.push(result(await engine.upsertOpenLoop(loop({ summary: 'second', openedAt: T2, lastActivityAt: T1, threadId: 't-other', detector: 'manual', loopType: 'commitment_owed_by_me' })), ids));
      const afterOpenUpdate = await listAll(engine, ids);
      const closed = observe(await engine.closeOpenLoop('default', ids.id(1), 'done', 'manual'), ids);
      // Equal activity on a closed row: the guard keeps it closed.
      results.push(result(await engine.upsertOpenLoop(loop({ summary: 'third' })), ids));
      const afterGuard = await listAll(engine, ids);
      // Newer activity reopens it and takes the incoming opened_at; a slug resets the counterparty source.
      results.push(result(await engine.upsertOpenLoop(loop({ summary: 'fourth', openedAt: T3, lastActivityAt: T2, counterpartySlug: 'people/bob-example', counterpartySourceId: 'default', evidence: [{ quote: 'q', page_slug: 'p', message_id: 'm2' }] })), ids));
      results.push(result(await engine.upsertOpenLoop(loop({ dedupKey: 'thread:b', counterpartyEmail: null, threadId: null, lastActivityAt: T1, openedAt: null })), ids));
      const afterReopen = await listAll(engine, ids);
      return { results, afterOpenUpdate, closed, afterGuard, afterReopen: afterReopen.map(r => r && { ...r, opened_at: r.dedup_key === 'thread:b' ? 'now' : r.opened_at }) };
    },
  );

  parityTest(
    'a mute holds a loop for the same counterparty email, an email change or a re-check mark lets it reopen',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine) => {
      const ids = await firstLoop(engine, loop());
      await engine.closeOpenLoop(null, ids.id(1), 'dropped', 'muted');
      const sameEmail = result(await engine.upsertOpenLoop(loop({ lastActivityAt: T2 })), ids);
      const otherEmail = result(await engine.upsertOpenLoop(loop({ lastActivityAt: T2, counterpartyEmail: 'b@example.com' })), ids);
      await engine.upsertOpenLoop(loop({ dedupKey: 'thread:r' }));
      const rechecked = observe(await engine.closeOpenLoop('default', ids.id(4), 'stale', 'mute_recheck'), ids);
      const recheck = result(await engine.upsertOpenLoop(loop({ dedupKey: 'thread:r' })), ids);
      return { sameEmail, otherEmail, rechecked, recheck, rows: await listAll(engine, ids) };
    },
  );

  parityTest(
    'listOpenLoops filters by sources, status, type, counterparty and id, clamps the limit and orders by activity then id',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const loopIds = await firstLoop(engine, loop({ dedupKey: 'k1', counterpartySlug: 'people/alice-example', lastActivityAt: T2 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k2', counterpartySlug: 'people/alice-example', counterpartySourceId: 'work', lastActivityAt: T2 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k3', sourceId: 'work', counterpartyEmail: 'people/alice-example', loopType: 'decision_pending', lastActivityAt: T1 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k4', sourceId: 'work', counterpartySlug: 'people/alice-example', lastActivityAt: T3 }));
      await engine.closeOpenLoop(null, loopIds.id(2), 'done', 'manual');
      const ids = async (opts: Parameters<BrainEngine['listOpenLoops']>[0]) => (await engine.listOpenLoops(opts)).map(r => loopIds.rel(r.id));
      return {
        all: await ids({}),
        emptyList: await ids({ sourceIds: [] }),
        blankId: await ids({ sourceIds: [''] }),
        work: await ids({ sourceIds: ['work'] }),
        both: await ids({ sourceIds: ['work', 'default'] }),
        open: await ids({ status: 'open' }),
        done: await ids({ status: 'done' }),
        decision: await ids({ loopType: 'decision_pending' }),
        counterparty: await ids({ counterparty: 'people/alice-example' }),
        counterpartyInWork: await ids({ counterparty: 'people/alice-example', counterpartySourceId: 'work' }),
        counterpartyInDefault: await ids({ counterparty: 'people/alice-example', counterpartySourceId: 'default' }),
        byId: await ids({ loopId: loopIds.id(3) }),
        byIdOutOfScope: await ids({ loopId: loopIds.id(3), sourceIds: ['default'] }),
        limitZero: await ids({ limit: 0 }),
        limitTwo: await ids({ limit: 2 }),
      };
    },
  );

  parityTest(
    'closeOpenLoop closes only an open loop in the named source, and refuses a status the table does not allow',
    { methods: ['upsertOpenLoop', 'closeOpenLoop'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const ids = await firstLoop(engine, loop());
      const refused = async (run: () => Promise<unknown>) => { try { await run(); return false; } catch { return true; } };
      return {
        otherSource: await engine.closeOpenLoop('work', ids.id(1), 'done', 'x'),
        missing: await engine.closeOpenLoop(null, ids.id(99), 'done', 'x'),
        badStatusNoRow: await refused(() => engine.closeOpenLoop(null, ids.id(99), 'bogus' as 'done', 'x')),
        badStatus: await refused(() => engine.closeOpenLoop(null, ids.id(1), 'bogus' as 'done', 'x')),
        closed: observe(await engine.closeOpenLoop(null, ids.id(1), 'dropped', 'x'), ids),
        again: await engine.closeOpenLoop(null, ids.id(1), 'done', 'x'),
        badType: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', loopType: 'nope' as 'decision_pending' }))),
        badDetector: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', detector: 'nope' as 'manual' }))),
        unknownSource: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', sourceId: 'missing' }))),
      };
    },
  );
});
