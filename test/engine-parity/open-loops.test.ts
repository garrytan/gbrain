/**
 * BrainEngine parity — open loops (`open_loops`): the upsert, list and close members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: upsertOpenLoop's insert, its manual-close and mute guards and the columns an update keeps or takes;
 *    listOpenLoops' source, status, type, counterparty and id filters, its limit clamp and its order;
 *    readEntityOpenLoops' card read (open loops whose counterparty page is the card's source and slug, newest first,
 *    at most the limit; an email that equals the slug does not count); and closeOpenLoop's open-only, source-scoped
 *    close return the same observable result on every engine arm (PGLite
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
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';
const T3 = '2026-03-09T10:00:00.000Z';

const NOW_FIELDS = new Set(['closed_at', 'created_at', 'updated_at']);

/**
 * Loop ids counted from the case's first loop (1, 2, ...). The Postgres arm empties its tables between
 * cases without a sequence restart, so its raw ids go on from the case before; PGLite and Rust start at 1.
 */
function loopIds(first: { id: number }) {
  const base = Number(first.id) - 1;
  return {
    /** The raw id of the case's n-th id. */
    at: (n: number) => base + n,
    /** A raw id as the case's n. */
    rel: (id: unknown) => (id === null || id === undefined ? id : Number(id) - base),
  };
}

type LoopIds = ReturnType<typeof loopIds>;

/** An upsert result with its id counted from the case's first loop. */
function result(ids: LoopIds, r: { id: number; created: boolean; applied: boolean }) {
  return { ...r, id: ids.rel(r.id) };
}

/** A row with the fields `now()` fills mapped to whether they are set, the other times as ISO text, and the id counted from the case's first loop. */
function observe(ids: LoopIds, row: Record<string, unknown> | null): Record<string, unknown> | null {
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

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'default', dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartyEmail: 'a@example.com',
    summary: 'first', evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a', detector: 'deterministic_thread',
    lastActivityAt: T1, openedAt: T1, ...over,
  };
}

async function listAll(engine: BrainEngine, ids: LoopIds, opts: Parameters<BrainEngine['listOpenLoops']>[0] = {}) {
  return (await engine.listOpenLoops(opts)).map(row => observe(ids, row));
}

describe('engine parity: open loops', () => {
  parityTest(
    'upsertOpenLoop inserts, keeps a closed loop on equal activity, reopens on newer activity, and takes ids on every call',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine) => {
      const first = await engine.upsertOpenLoop(loop({ counterpartySlug: 'people/alice-example', pageSlug: 'emails/a', factId: 7, dueAt: '2026-03-20T12:00:00+02:00', confidence: 0.3 }));
      const ids = loopIds(first);
      const results = [first];
      // Open row: opened_at keeps the earlier time, slug/page/due/fact keep the old value when the new one is null.
      results.push(await engine.upsertOpenLoop(loop({ summary: 'second', openedAt: T2, lastActivityAt: T1, threadId: 't-other', detector: 'manual', loopType: 'commitment_owed_by_me' })));
      const afterOpenUpdate = await listAll(engine, ids);
      const closed = observe(ids, await engine.closeOpenLoop('default', ids.at(1), 'done', 'manual'));
      // Equal activity on a closed row: the guard keeps it closed.
      results.push(await engine.upsertOpenLoop(loop({ summary: 'third' })));
      const afterGuard = await listAll(engine, ids);
      // Newer activity reopens it and takes the incoming opened_at; a slug resets the counterparty source.
      results.push(await engine.upsertOpenLoop(loop({ summary: 'fourth', openedAt: T3, lastActivityAt: T2, counterpartySlug: 'people/bob-example', counterpartySourceId: 'default', evidence: [{ quote: 'q', page_slug: 'p', message_id: 'm2' }] })));
      results.push(await engine.upsertOpenLoop(loop({ dedupKey: 'thread:b', counterpartyEmail: null, threadId: null, lastActivityAt: T1, openedAt: null })));
      const afterReopen = await listAll(engine, ids);
      return { results: results.map(r => result(ids, r)), afterOpenUpdate, closed, afterGuard, afterReopen: afterReopen.map(r => r && { ...r, opened_at: r.dedup_key === 'thread:b' ? 'now' : r.opened_at }) };
    },
  );

  parityTest(
    'a mute holds a loop for the same counterparty email, an email change or a re-check mark lets it reopen',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine) => {
      const ids = loopIds(await engine.upsertOpenLoop(loop()));
      await engine.closeOpenLoop(null, ids.at(1), 'dropped', 'muted');
      const sameEmail = result(ids, await engine.upsertOpenLoop(loop({ lastActivityAt: T2 })));
      const otherEmail = result(ids, await engine.upsertOpenLoop(loop({ lastActivityAt: T2, counterpartyEmail: 'b@example.com' })));
      await engine.upsertOpenLoop(loop({ dedupKey: 'thread:r' }));
      const rechecked = observe(ids, await engine.closeOpenLoop('default', ids.at(4), 'stale', 'mute_recheck'));
      const recheck = result(ids, await engine.upsertOpenLoop(loop({ dedupKey: 'thread:r' })));
      return { sameEmail, otherEmail, rechecked, recheck, rows: await listAll(engine, ids) };
    },
  );

  parityTest(
    'listOpenLoops filters by sources, status, type, counterparty and id, clamps the limit and orders by activity then id',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'listOpenLoops'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const loopId = loopIds(await engine.upsertOpenLoop(loop({ dedupKey: 'k1', counterpartySlug: 'people/alice-example', lastActivityAt: T2 })));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k2', counterpartySlug: 'people/alice-example', counterpartySourceId: 'work', lastActivityAt: T2 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k3', sourceId: 'work', counterpartyEmail: 'people/alice-example', loopType: 'decision_pending', lastActivityAt: T1 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k4', sourceId: 'work', counterpartySlug: 'people/alice-example', lastActivityAt: T3 }));
      await engine.closeOpenLoop(null, loopId.at(2), 'done', 'manual');
      const ids = async (opts: Parameters<BrainEngine['listOpenLoops']>[0]) => (await engine.listOpenLoops(opts)).map(r => loopId.rel(r.id));
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
        byId: await ids({ loopId: loopId.at(3) }),
        byIdOutOfScope: await ids({ loopId: loopId.at(3), sourceIds: ['default'] }),
        limitZero: await ids({ limit: 0 }),
        limitTwo: await ids({ limit: 2 }),
      };
    },
  );

  parityTest(
    'readEntityOpenLoops reads the open loops whose counterparty page is the card, newest first, at most the limit',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'readEntityOpenLoops'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const T0 = '2026-02-20T10:00:00.000Z';
      const loopId = loopIds(await engine.upsertOpenLoop(loop({ dedupKey: 'k1', counterpartySlug: 'people/alice-example', lastActivityAt: T2, dueAt: T3 })));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k2', counterpartySlug: 'people/alice-example', counterpartySourceId: 'work', lastActivityAt: T3 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k3', sourceId: 'work', counterpartyEmail: 'people/alice-example', lastActivityAt: T3 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k4', sourceId: 'work', counterpartySlug: 'people/alice-example', counterpartySourceId: 'default', loopType: 'commitment_owed_by_me', summary: 'owed', lastActivityAt: T3 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k5', counterpartySlug: 'people/alice-example', lastActivityAt: T1 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k6', counterpartySlug: 'people/alice-example', loopType: 'decision_pending', lastActivityAt: T0 }));
      await engine.upsertOpenLoop(loop({ dedupKey: 'k7', sourceId: 'work', counterpartySlug: 'people/alice-example', lastActivityAt: T2 }));
      await engine.closeOpenLoop(null, loopId.at(5), 'done', 'manual');
      const read = async (slug: string, sourceId: string, limit: number) =>
        (await engine.readEntityOpenLoops(slug, sourceId, limit)).map(r => observe(loopId, r as unknown as Record<string, unknown>));
      const card = await read('people/alice-example', 'default', 3);
      expect(card.map(r => r?.id)).toEqual([4, 1, 6]);
      return {
        card,
        one: await read('people/alice-example', 'default', 1),
        all: await read('people/alice-example', 'default', 10),
        work: await read('people/alice-example', 'work', 3),
        none: await read('people/bob-example', 'default', 3),
      };
    },
  );

  parityTest(
    'readEntityOpenLoops breaks a tie in last activity by the newest loop id, so tied loops read in one order',
    { methods: ['upsertOpenLoop', 'readEntityOpenLoops'] },
    async (engine) => {
      const loopId = loopIds(await engine.upsertOpenLoop(loop({ dedupKey: 't1', counterpartySlug: 'people/alice-example', lastActivityAt: T2 })));
      for (const k of ['t2', 't3', 't4']) {
        await engine.upsertOpenLoop(loop({ dedupKey: k, counterpartySlug: 'people/alice-example', lastActivityAt: T2 }));
      }
      await engine.upsertOpenLoop(loop({ dedupKey: 't5', counterpartySlug: 'people/alice-example', lastActivityAt: T3 }));
      const read = async (limit: number) =>
        (await engine.readEntityOpenLoops('people/alice-example', 'default', limit)).map(r => observe(loopId, r as unknown as Record<string, unknown>)?.id);
      const all = await read(10);
      expect(all).toEqual([5, 4, 3, 2, 1]);
      return { all, two: await read(2), three: await read(3) };
    },
  );

  parityTest(
    'closeOpenLoop closes only an open loop in the named source, and refuses a status the table does not allow',
    { methods: ['upsertOpenLoop', 'closeOpenLoop'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const ids = loopIds(await engine.upsertOpenLoop(loop()));
      const refused = async (run: () => Promise<unknown>) => { try { await run(); return false; } catch { return true; } };
      return {
        otherSource: await engine.closeOpenLoop('work', ids.at(1), 'done', 'x'),
        missing: await engine.closeOpenLoop(null, ids.at(99), 'done', 'x'),
        badStatusNoRow: await refused(() => engine.closeOpenLoop(null, ids.at(99), 'bogus' as 'done', 'x')),
        badStatus: await refused(() => engine.closeOpenLoop(null, ids.at(1), 'bogus' as 'done', 'x')),
        closed: observe(ids, await engine.closeOpenLoop(null, ids.at(1), 'dropped', 'x')),
        again: await engine.closeOpenLoop(null, ids.at(1), 'done', 'x'),
        badType: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', loopType: 'nope' as 'decision_pending' }))),
        badDetector: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', detector: 'nope' as 'manual' }))),
        unknownSource: await refused(() => engine.upsertOpenLoop(loop({ dedupKey: 'z', sourceId: 'missing' }))),
      };
    },
  );
  parityTest(
    'countOpenLoopsByCounterpartyEmail counts every open loop of the type per sender email in the source, with no limit',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'countOpenLoopsByCounterpartyEmail'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'g1');
      await createSource(engine, backend, 'g2');
      const at = '2026-03-01T10:00:00.000Z';
      const add = (sourceId: string, key: string, email: string, loopType: OpenLoopUpsert['loopType'] = 'unanswered_inbound') => engine.upsertOpenLoop({
        sourceId, dedupKey: key, loopType, counterpartyEmail: email, summary: key, evidence: [], detector: 'manual', lastActivityAt: at, openedAt: at });
      const first = await add('g1', 'a1', 'a@example.com');
      await add('g1', 'a2', 'a@example.com');
      await add('g1', 'a3', 'a@example.com');
      await add('g1', 'b1', 'b@example.com');
      await add('g1', 'a-owed', 'a@example.com', 'commitment_owed_by_me');
      await add('g2', 'a-other', 'a@example.com');
      await engine.closeOpenLoop('g1', first.id, 'done', 'parity');
      const count = async (emails: string[]) => (await engine.countOpenLoopsByCounterpartyEmail('g1', emails, 'unanswered_inbound'))
        .map(r => `${r.email}=${r.n}`).sort();
      return { both: await count(['a@example.com', 'b@example.com', 'c@example.com']), one: await count(['b@example.com']), none: await count([]) };
    },
  );
});
