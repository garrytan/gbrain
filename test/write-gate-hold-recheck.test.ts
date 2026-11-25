/**
 * Held writes a purge kept for another page are checked again by maintenance (plan run-rystzv-20261125083144, gate
 * decisions d1-d4). Companion of test/hold-page-id-postgres.test.ts, whose side-by-side purge race this sweep cleans up.
 *
 * Authoring gate
 *  1. Protects: a held write a purge kept only because the rename record still led to another page is noted with the
 *     version the purge saw; the `bookkeeping_gc` maintenance phase deletes it and its receipts once no page row is left
 *     for it, and otherwise keeps it. A held write re-opened after the purge (d1), one a hidden page may still need (d2),
 *     one bound to a page or marked with candidates, and one saved before its page exists are never deleted. Only the
 *     notes a sweep selected are consumed (d4). Dry run and the off switch change nothing.
 *  2. Fails when: the sweep deletes by slug absence alone, ignores the observed version, consumes notes by hold id, or
 *     deletes while row security hides evidence; or when the purge does not note the held write it kept.
 *  3. Why new: before this change nothing removed the held write two side-by-side purges leave behind.
 *  4. Seams: `afterCheck` on the sweep (a test hook between the page check and the delete) to interleave a purge with
 *     a sweep on Postgres. Everything else goes through the engine's purge methods and the maintenance phase. Rows are
 *     read directly only to state what is held and noted. A leftover is made on one connection by deleting the last page
 *     row without its purge sweep (what the other purge of the race amounts to); the real race is in the Postgres block.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runPhaseBookkeepingGc } from '../src/core/cycle/bookkeeping-gc.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { bareBody, HELD, holdFenceRow, ROWS } from './helpers/hold-page-id-fixture.ts';

const backends = testBackends();
const brains: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    brains.push({ backend: 'pglite', engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 8);
    brains.push({ backend: 'postgres', engine: pg.engine, close: pg.close });
  }
}, 180_000);
afterAll(async () => { for (const b of brains) await b.close(); });

/** The sweep module, loaded per call so a tree without it fails each test on its assertion path, not at file load. */
const sweepModule = () => import('../src/core/write-gate-recheck.ts');

function harness(engine: () => BrainEngine) {
  const source = async () => {
    const id = `s${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await engine().executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
    return id;
  };
  const putPage = async (sourceId: string, slug: string) => {
    await engine().putPage(slug, { type: 'note', title: slug, compiled_truth: bareBody(ROWS), timeline: '' }, { sourceId });
    return Number((await engine().executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
  };
  const rename = async (sourceId: string, from: string, to: string) => { expect(await engine().updateSlug(from, to, { sourceId })).toBe(1); };
  const holds = async (sourceId: string) => (await engine().executeRaw<{ id: string; status: string; seen_count: number }>(
    'SELECT id::text AS id, status, seen_count FROM write_gate_holds WHERE source_id=$1 ORDER BY id', [sourceId]))
    .map(h => ({ id: Number(h.id), status: h.status, seen_count: Number(h.seen_count) }));
  const receipts = async (holdId: number) => (await engine().executeRaw("SELECT 1 FROM write_gate_receipts WHERE target_table='write_gate_holds' AND target_id=$1", [String(holdId)])).length;
  const notes = async (sourceId: string) => (await engine().executeRaw<{ id: string; hold_id: string }>(
    'SELECT id::text AS id, hold_id::text AS hold_id FROM write_gate_hold_rechecks WHERE source_id=$1 ORDER BY id', [sourceId])).map(n => ({ id: Number(n.id), hold: Number(n.hold_id) }));
  const gc = () => runPhaseBookkeepingGc(engine(), false);

  /**
   * An unbound held write at notes/first whose rename record leads to notes/moved, and a different page that reused
   * notes/first: both pages are live and the held write is held for both. Returns the held write's id.
   */
  async function reachedByTwoPages(sourceId: string): Promise<number> {
    const late = await holdFenceRow(engine(), { sourceId, slug: 'notes/first', claim: HELD, rowNum: 1 });
    // Written before the page's creation by a transaction that committed after it: the page creation does not bind it.
    await engine().executeRaw("UPDATE write_gate_holds SET created_at = now() + interval '1 day' WHERE id=$1", [late]);
    await putPage(sourceId, 'notes/first');
    await engine().executeRaw("UPDATE write_gate_holds SET created_at = now() - interval '1 day' WHERE id=$1", [late]);
    await rename(sourceId, 'notes/first', 'notes/moved');
    await putPage(sourceId, 'notes/other');
    await rename(sourceId, 'notes/other', 'notes/first');
    return late;
  }

  /**
   * The state two side-by-side purges leave: notes/first is purged and keeps the held write for notes/moved (noting it),
   * then notes/moved's row goes without its own hold sweep, as when its purge saw notes/first still there.
   */
  async function leftover(sourceId: string): Promise<number> {
    const late = await reachedByTwoPages(sourceId);
    expect(await engine().deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']);
    await engine().executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/moved']);
    return late;
  }

  return { source, putPage, rename, holds, receipts, notes, gc, reachedByTwoPages, leftover };
}

for (const backend of backends) {
  describe(`held writes a purge kept are checked again by maintenance (${backend})`, () => {
    const engine = () => brains.find(b => b.backend === backend)!.engine;
    const h = harness(engine);

    test('a purge that keeps a held write for a surviving page notes it, and maintenance keeps it while that page lives', async () => {
      const sourceId = await h.source();
      const late = await h.reachedByTwoPages(sourceId);
      expect(await engine().deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);

      await h.gc();
      expect((await h.holds(sourceId)).map(x => [x.id, x.status])).toEqual([[late, 'held']]);
      expect(await h.receipts(late)).toBe(1);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('maintenance deletes a noted held write and its receipts once no page row is left for it', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);

      const result = await h.gc();
      expect(await h.holds(sourceId)).toEqual([]);
      expect(await h.receipts(late)).toBe(0);
      expect(await h.notes(sourceId)).toEqual([]);
      expect(result.details.held_write_rechecks).toMatchObject({ status: 'ok' });
      expect((result.details.held_write_rechecks as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    });

    // The page purge sweep shared by `gbrain purge` (the delete_page purge door) and the restore replay notes the same way.
    test('the page purge sweep notes a held write it keeps for another page', async () => {
      const sourceId = await h.source();
      const late = await h.reachedByTwoPages(sourceId);
      const pageId = Number((await engine().executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/first']))[0]!.id);
      const { sweepPurgedPage } = await import('../src/core/persistence/page-purge.ts');
      await engine().transaction(async (tx: BrainEngine) => {
        await sweepPurgedPage(tx, { sourceId, slug: 'notes/first', pageId, requestId: randomUUID(), factIds: [], takeIds: [], needles: [], reasons: [],
          census: async () => ({ targets: [], complete: true }), present: new Set(['write_gate_holds', 'write_gate_hold_rechecks', 'write_gate_receipts']) });
      });
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
    });

    test('a held write saved before its page exists is never noted and never removed', async () => {
      const sourceId = await h.source();
      const waiting = await holdFenceRow(engine(), { sourceId, slug: 'notes/future', claim: HELD, rowNum: 1 });
      await h.putPage(sourceId, 'notes/unrelated');
      expect(await engine().deletePages(['notes/unrelated'], { sourceId })).toEqual(['notes/unrelated']);
      await h.gc();
      expect((await h.holds(sourceId)).map(x => [x.id, x.status])).toEqual([[waiting, 'held']]);
      expect(await h.receipts(waiting)).toBe(1);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('doctor lists a noted held write and says the next maintenance run removes it', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const { writeGateHoldsStrandedEntry } = await import('../src/commands/doctor/checks/write-gate-holds-stranded.ts');
      const [check] = await writeGateHoldsStrandedEntry.run({ engine: engine(), sourceIds: [sourceId] } as never) as Array<{ details: Record<string, unknown>; message: string }>;
      expect(check!.details).toMatchObject({ complete: true, stranded: { no_page: 1 }, awaiting_sweep: 1 });
      // It names the recheck without promising a delete (a re-opened held write stays).
      expect(check!.message).toContain('noted for a recheck by the next maintenance run (bookkeeping_gc)');
      expect(check!.message).not.toContain('removes');
      expect(JSON.stringify(check!.details.items)).toContain(`h${late}`);
    });

    // Gate d1: the purge's note carries the version it saw; the same content arriving again after the purges re-opens the
    // held write (a later write), so maintenance keeps it with its payload and receipts and consumes only the stale note.
    test('d1: a held write re-observed after the purges and before maintenance keeps its payload and receipts', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const [before] = await engine().executeRaw<{ payload: unknown }>('SELECT payload FROM write_gate_holds WHERE id=$1', [late]);
      expect(await holdFenceRow(engine(), { sourceId, slug: 'notes/first', claim: HELD, rowNum: 1 })).toBe(late);
      expect((await h.holds(sourceId)).map(x => [x.id, x.seen_count])).toEqual([[late, 2]]);

      await h.gc();
      expect((await h.holds(sourceId)).map(x => [x.id, x.status])).toEqual([[late, 'held']]);
      const [after] = await engine().executeRaw<{ payload: unknown }>('SELECT payload FROM write_gate_holds WHERE id=$1', [late]);
      expect(after!.payload).toEqual(before!.payload);
      expect(await h.receipts(late)).toBe(1);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    // Gate d4: duplicate notes for one held write are all consumed by the one run that deletes it.
    test('d4: duplicate notes for one held write delete it once and are all consumed', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      await engine().executeRaw('INSERT INTO write_gate_hold_rechecks (source_id, hold_id, observed_version) SELECT source_id, hold_id, observed_version FROM write_gate_hold_rechecks WHERE source_id=$1', [sourceId]);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late, late]);
      await h.gc();
      expect(await h.holds(sourceId)).toEqual([]);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('a noted held write that is bound to a page or marked with candidates is never deleted', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const bound = await h.putPage(sourceId, 'notes/bound');
      const marked = await h.putPage(sourceId, 'notes/marked');
      await engine().executeRaw('UPDATE write_gate_holds SET page_id=$2 WHERE id=$1', [late, bound]);
      await engine().executeRaw('DELETE FROM pages WHERE id=$1', [bound]);
      await h.gc();
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect(await h.notes(sourceId)).toEqual([]);

      await engine().executeRaw('UPDATE write_gate_holds SET page_id=NULL, page_candidates=ARRAY[$2::bigint] WHERE id=$1', [late, marked]);
      await engine().executeRaw('DELETE FROM pages WHERE id=$1', [marked]);
      await engine().executeRaw('INSERT INTO write_gate_hold_rechecks (source_id, hold_id, observed_version) VALUES ($1, $2, $3)', [sourceId, late, 'any']);
      await h.gc();
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('a soft-deleted page keeps a noted held write: tombstone expiry still owns it', async () => {
      const sourceId = await h.source();
      const late = await h.reachedByTwoPages(sourceId);
      expect(await engine().deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']);
      expect(await engine().softDeletePage('notes/moved', { sourceId })).toEqual({ slug: 'notes/moved' });
      await h.gc();
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('a dry run reports the noted held writes and changes nothing', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const result = await runPhaseBookkeepingGc(engine(), true);
      expect((result.details.held_write_rechecks as { would_check: number }).would_check).toBeGreaterThanOrEqual(1);
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
    });

    test('the off switch write_gate.orphan_sweep=false skips the step and says so', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      await engine().setConfig('write_gate.orphan_sweep', 'false');
      try {
        const result = await h.gc();
        expect(result.details.held_write_rechecks).toMatchObject({ status: 'skipped', reason: 'disabled' });
        expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      } finally {
        await engine().unsetConfig('write_gate.orphan_sweep');
      }
      await h.gc();
      expect(await h.holds(sourceId)).toEqual([]);
    });

    // Review finding (targeted, pass 1): an unreadable off switch must not read as "on".
    test('an unreadable off switch runs no sweep: the maintenance phase reports the failure and deletes nothing', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const failing = new Proxy(engine(), { get: (t, k) => k === 'getConfig'
        ? async (key: string) => { if (key === 'write_gate.orphan_sweep') throw new Error('permission denied for table config'); return (t as BrainEngine).getConfig(key); }
        : Reflect.get(t, k, t) }) as BrainEngine;
      const { orphanSweepEnabled } = await sweepModule();
      await expect(orphanSweepEnabled(failing)).rejects.toThrow('permission denied');
      const result = await runPhaseBookkeepingGc(failing, false);
      expect(result.details.held_write_rechecks).toMatchObject({ status: 'fail' });
      // Review finding (outside voice, pass 1): a failed sweep is not a successful phase.
      expect(result.status).toBe('warn');
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
    });

    // Review finding (outside voice, pass 1): a purge scrubs the rename records that lead to the purged name, which can cut the
    // route from a held write to the page it is kept for, so the note keeps the surviving page ids the purge saw. Renames
    // keep the record flat (every old name leads straight to the current one), so the chain is written here directly, as
    // history recorded before that rule can hold it.
    test('a held write kept for a page reached through a chain of rename records stays after the middle name is purged', async () => {
      const sourceId = await h.source();
      const late = await holdFenceRow(engine(), { sourceId, slug: 'notes/a', claim: HELD, rowNum: 1 });
      await h.putPage(sourceId, 'notes/c');
      await h.putPage(sourceId, 'notes/b');
      await engine().executeRaw('INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2, $3), ($1, $3, $4)', [sourceId, 'notes/a', 'notes/b', 'notes/c']);
      expect(await engine().deletePages(['notes/b'], { sourceId })).toEqual(['notes/b']);
      expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
      await h.gc();
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
      expect(await h.receipts(late)).toBe(1);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    // Review finding (outside voice, pass 1): a hold id past 2^53 is kept as text, never rounded.
    test('a held write whose id is past 2^53 is checked by its exact id', async () => {
      const sourceId = await h.source();
      const late = await h.leftover(sourceId);
      const big = '9007199254740993';
      await engine().executeRaw('UPDATE write_gate_holds SET id = $2::bigint WHERE id = $1', [late, big]);
      await engine().executeRaw("UPDATE write_gate_receipts SET target_id = $2 WHERE target_table='write_gate_holds' AND target_id = $1", [String(late), big]);
      await engine().executeRaw('UPDATE write_gate_hold_rechecks SET hold_id = $2::bigint WHERE hold_id = $1', [late, big]);
      await h.gc();
      expect(await engine().executeRaw('SELECT 1 FROM write_gate_holds WHERE id = $1::bigint', [big])).toEqual([]);
      expect(await engine().executeRaw("SELECT 1 FROM write_gate_receipts WHERE target_table='write_gate_holds' AND target_id = $1", [big])).toEqual([]);
      expect(await h.notes(sourceId)).toEqual([]);
    });

    test('one run checks at most its limit of notes, oldest first; the rest wait for the next run', async () => {
      const sourceId = await h.source();
      const first = await h.leftover(sourceId);
      const otherSource = await h.source();
      const second = await h.leftover(otherSource);
      const { sweepHoldRechecks } = await sweepModule();
      const run = await sweepHoldRechecks(engine(), { limit: 1, sourceIds: [sourceId, otherSource] });
      expect(run).toMatchObject({ status: 'ok', checked: 1 });
      expect((await h.holds(sourceId)).map(x => x.id)).toEqual([]);
      expect((await h.holds(otherSource)).map(x => x.id)).toEqual([second]);
      await sweepHoldRechecks(engine(), { limit: 1, sourceIds: [sourceId, otherSource] });
      expect(await h.holds(otherSource)).toEqual([]);
      expect(first).toBeGreaterThan(0);
    });
  });
}

// Review finding (outside voice, pass 1): a brain whose v337 migration has not run yet still purges pages.
describe('a purge on a schema without the notes table (pglite)', () => {
  let own: PGLiteEngine;
  beforeAll(async () => { own = new PGLiteEngine(); await own.connect({}); await own.initSchema(); await own.executeRaw('DROP TABLE write_gate_hold_rechecks'); }, 60_000);
  afterAll(async () => { await own.disconnect(); });
  test('still deletes its page', async () => {
    await own.putPage('notes/plain', { type: 'note', title: 'plain', compiled_truth: bareBody(ROWS), timeline: '' });
    expect(await own.deletePages(['notes/plain'], { sourceId: 'default' })).toEqual(['notes/plain']);
  });
});

// Real interleavings on Postgres: two connections.
const pgOnly = backends.includes('postgres') ? describe : describe.skip;
pgOnly('held writes a purge kept are checked again by maintenance: concurrent connections (postgres)', () => {
  const engine = () => brains.find(b => b.backend === 'postgres')!.engine as PostgresEngine;
  const h = harness(engine);
  const BOUND_MS = 15_000;
  const bounded = <T,>(what: string, work: Promise<T>): Promise<T> => Promise.race([work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${BOUND_MS}ms (lock wait or deadlock)`)), BOUND_MS))]);
  const lockWaiters = async () => Number((await engine().executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"))[0]!.n);

  /** Runs `work` in a transaction on its own connection and parks it before commit; returns a handle to commit it. */
  async function parked(work: (t: BrainEngine) => Promise<void>): Promise<{ commit: () => Promise<void> }> {
    let done!: () => void, release!: () => void;
    const reached = new Promise<void>(r => { done = r; });
    const go = new Promise<void>(r => { release = r; });
    const tx = engine().transaction(async (t: BrainEngine) => { await work(t); done(); await go; });
    await bounded('the parked transaction to do its work', Promise.race([reached, tx]));
    return { commit: async () => { release(); await bounded('the parked transaction to commit', tx); } };
  }

  /** Runs `work` in a second transaction while `first` is parked, releasing `first` once `work` finished or waits for a lock. */
  async function beside(first: { commit: () => Promise<void> }, work: (t: BrainEngine) => Promise<void>): Promise<void> {
    let finished = false;
    const second = engine().transaction(async (t: BrainEngine) => { await work(t); finished = true; });
    try {
      await bounded('the second transaction to finish or wait for a lock', (async () => {
        for (;;) {
          if (finished || await lockWaiters() > 0) return;
          await new Promise(r => setTimeout(r, 25));
        }
      })());
    } finally { await first.commit(); }
    await bounded('the second transaction to commit', second);
  }

  test('two hard deletes side by side leave the held write noted, and maintenance removes it and its receipts', async () => {
    const sourceId = await h.source();
    const late = await h.reachedByTwoPages(sourceId);
    const first = await parked(async t => { expect(await t.deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']); });
    await beside(first, async t => { expect(await t.deletePages(['notes/moved'], { sourceId })).toEqual(['notes/moved']); });
    expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
    expect((await h.notes(sourceId)).length).toBeGreaterThanOrEqual(1);

    await h.gc();
    expect(await h.holds(sourceId)).toEqual([]);
    expect(await h.receipts(late)).toBe(0);
    expect(await h.notes(sourceId)).toEqual([]);
  });

  test('a hard delete beside a tombstone expiry of the other page: the held write is noted and maintenance removes it', async () => {
    const sourceId = await h.source();
    const late = await h.reachedByTwoPages(sourceId);
    expect(await engine().softDeletePage('notes/moved', { sourceId })).toEqual({ slug: 'notes/moved' });
    await engine().executeRaw("UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id=$1 AND slug='notes/moved'", [sourceId]);
    await engine().executeRaw("UPDATE write_gate_holds SET last_seen_at = now() - interval '3 hours' WHERE id=$1", [late]);
    const first = await parked(async t => { expect(await t.deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']); });
    await beside(first, async t => { await t.purgeDeletedPages(1); });
    expect(await h.notes(sourceId)).not.toEqual([]);
    await h.gc();
    expect(await h.holds(sourceId)).toEqual([]);
    expect(await h.receipts(late)).toBe(0);
  });

  // Gate d3: the purge notes in the same snapshot as its delete decision. Here the other page's tombstone expiry, whose
  // cutoff excludes the held write (it was seen after that page's soft delete), commits while the hard delete is parked.
  test('d3: a hard purge parked across the other page\'s committed tombstone expiry that kept the held write', async () => {
    const sourceId = await h.source();
    const late = await h.reachedByTwoPages(sourceId);
    expect(await engine().softDeletePage('notes/moved', { sourceId })).toEqual({ slug: 'notes/moved' });
    await engine().executeRaw("UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id=$1 AND slug='notes/moved'", [sourceId]);
    const first = await parked(async t => { expect(await t.deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']); });
    await beside(first, async t => { await t.purgeDeletedPages(1); });
    // The expiry's cutoff kept the held write as a later write; the hard delete saw the soft-deleted page and noted it.
    expect((await h.notes(sourceId)).map(n => n.hold)).toContain(late);
    await h.gc();
    // No page row is left: the hard delete alone would have deleted it (a hard delete keeps no later writes).
    expect(await h.holds(sourceId)).toEqual([]);
  });

  // Gate d4: notes appended while a sweep checks a held write are not consumed by that sweep. A purge that names the held
  // write waits for the sweep's page-key locks, so the note is appended here on another connection, as a purge path that
  // takes no page-key lock would; the two purges then run after the sweep, and the next run deletes the held write.
  test('d4: a note appended while maintenance keeps a held write survives, and the next run after two purges deletes it', async () => {
    const sourceId = await h.source();
    const late = await h.reachedByTwoPages(sourceId);
    await engine().executeRaw('INSERT INTO write_gate_hold_rechecks (source_id, hold_id, observed_version) VALUES ($1, $2, $3)', [sourceId, late, 'stale']);
    const { sweepHoldRechecks } = await import('../src/core/write-gate-recheck.ts');
    const run = await bounded('the sweep', sweepHoldRechecks(engine(), {
      sourceIds: [sourceId],
      afterCheck: async () => {
        await bounded('the concurrent note', engine().executeRaw('INSERT INTO write_gate_hold_rechecks (source_id, hold_id, observed_version) VALUES ($1, $2, $3)', [sourceId, late, 'appended']));
      },
    }));
    expect(run).toMatchObject({ checked: 1, deleted: 0, notes_consumed: 1 });
    expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
    expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
    const first = await parked(async t => { expect(await t.deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']); });
    await beside(first, async t => { expect(await t.deletePages(['notes/moved'], { sourceId })).toEqual(['notes/moved']); });
    await h.gc();
    expect(await h.holds(sourceId)).toEqual([]);
    expect(await h.notes(sourceId)).toEqual([]);
  });

  test('d4: two sweepers at once delete the held write once and leave no note', async () => {
    const sourceId = await h.source();
    const late = await h.leftover(sourceId);
    const { sweepHoldRechecks } = await import('../src/core/write-gate-recheck.ts');
    let firstChecked!: () => void, letFirstGo!: () => void;
    const checked = new Promise<void>(r => { firstChecked = r; });
    const go = new Promise<void>(r => { letFirstGo = r; });
    const a = sweepHoldRechecks(engine(), { sourceIds: [sourceId], afterCheck: async () => { firstChecked(); await go; } });
    await bounded('the first sweeper to check', Promise.race([checked, a]));
    const b = sweepHoldRechecks(engine(), { sourceIds: [sourceId] });
    try {
      await bounded('the second sweeper to wait on the held row', (async () => { while (await lockWaiters() === 0) await new Promise(r => setTimeout(r, 25)); })());
    } finally { letFirstGo(); }
    const [ra, rb] = await bounded('both sweepers', Promise.all([a, b]));
    expect(ra.deleted + rb.deleted).toBe(1);
    expect(await h.holds(sourceId)).toEqual([]);
    expect(await h.receipts(late)).toBe(0);
    expect(await h.notes(sourceId)).toEqual([]);
  });

  // Known limit (owner's delegate's ruling, option A): the sweep takes no page-key lock (`gbrain trust release` locks the held
  // row first, so page keys here could deadlock with it). A rename onto the held write's name that commits between the page
  // check and the delete does not stop the delete: the orphaned held write goes as the page arrives. That removes stale
  // over-hiding from the arriving page and shows no held text. Pinned so a change here is deliberate.
  test('known limit: a rename onto the held write\'s name during the check commits, and the orphaned held write is still deleted', async () => {
    const sourceId = await h.source();
    const late = await h.leftover(sourceId);
    await h.putPage(sourceId, 'notes/elsewhere');
    let renamed = false;
    const { sweepHoldRechecks } = await import('../src/core/write-gate-recheck.ts');
    const run = await bounded('the sweep', sweepHoldRechecks(engine(), {
      sourceIds: [sourceId],
      afterCheck: async () => {
        await bounded('the rename', engine().transaction(async (t: BrainEngine) => {
          await t.lockPageKeys([{ sourceId, slug: 'notes/elsewhere' }, { sourceId, slug: 'notes/first' }]);
          expect(await t.updateSlug('notes/elsewhere', 'notes/first', { sourceId })).toBe(1);
        }));
        renamed = true;
      },
    }));
    expect(renamed).toBe(true);
    expect(run).toMatchObject({ checked: 1, deleted: 1 });
    expect(await h.holds(sourceId)).toEqual([]);
    expect(await h.receipts(late)).toBe(0);
    expect((await engine().executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId])).map(r => r.slug)).toEqual(['notes/first']);
  });

  // Review finding (outside voice, pass 1): row security that applies after the run's preflight still stops the delete. The
  // preflight runs as the owner; the role row security limits is taken inside the held write's own transaction.
  test('row security that applies after the preflight stops the delete inside the held write\'s transaction', async () => {
    const sourceId = await h.source();
    const late = await h.leftover(sourceId);
    const ROLE = `gbrain_recheck_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const owner = engine();
    const schema = (await owner.executeRaw<{ s: string }>('SELECT current_schema() AS s'))[0]!.s;
    await owner.executeRaw(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const wasSecured = (await owner.executeRaw<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'pages'::regclass"))[0]!.on;
    let threw: unknown;
    try {
      await owner.executeRaw(`GRANT USAGE ON SCHEMA ${schema} TO ${ROLE}`);
      await owner.executeRaw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${ROLE}`);
      await owner.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
      const { sweepHoldRechecks } = await import('../src/core/write-gate-recheck.ts');
      try {
        await owner.transaction(async (t: BrainEngine) => sweepHoldRechecks(t, {
          sourceIds: [sourceId],
          beforeHold: async () => { await t.executeRaw(`SET LOCAL ROLE ${ROLE}`); },
        }));
      } catch (e) { threw = e; }
    } finally {
      if (!wasSecured) await owner.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
      await owner.executeRaw(`DROP OWNED BY ${ROLE}`);
      await owner.executeRaw(`DROP ROLE ${ROLE}`);
    }
    expect(String(threw)).toContain('row-level security');
    expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
  });

  // Gate d2: with row security active for the running role on an evidence table, the sweep deletes nothing and names them.
  test('d2: a role row security limits deletes nothing; a hidden page cannot lose its held write', async () => {
    const sourceId = await h.source();
    const late = await h.reachedByTwoPages(sourceId);
    expect(await engine().deletePages(['notes/first'], { sourceId })).toEqual(['notes/first']);
    const ROLE = `gbrain_recheck_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const owner = engine();
    await owner.executeRaw(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const wasSecured = (await owner.executeRaw<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'pages'::regclass"))[0]!.on;
    try {
      await owner.executeRaw(`GRANT USAGE ON SCHEMA ${(await owner.executeRaw<{ s: string }>('SELECT current_schema() AS s'))[0]!.s} TO ${ROLE}`);
      await owner.executeRaw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${(await owner.executeRaw<{ s: string }>('SELECT current_schema() AS s'))[0]!.s} TO ${ROLE}`);
      await owner.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
      // The policy hides the surviving page from the role: an absence check would read it as gone.
      await owner.executeRaw(`CREATE POLICY recheck_hide ON pages FOR SELECT TO ${ROLE} USING (slug <> 'notes/moved')`);
      const { sweepHoldRechecks } = await import('../src/core/write-gate-recheck.ts');
      const result = await owner.transaction(async (t: BrainEngine) => {
        await t.executeRaw(`SET LOCAL ROLE ${ROLE}`);
        return sweepHoldRechecks(t, { sourceIds: [sourceId] });
      });
      expect(result).toMatchObject({ status: 'unknown', reason: 'row_level_security', deleted: 0 });
      expect(result.hidden).toContain('pages');
    } finally {
      await owner.executeRaw('DROP POLICY IF EXISTS recheck_hide ON pages');
      if (!wasSecured) await owner.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
      await owner.executeRaw(`DROP OWNED BY ${ROLE}`);
      await owner.executeRaw(`DROP ROLE ${ROLE}`);
    }
    expect((await h.holds(sourceId)).map(x => x.id)).toEqual([late]);
    expect((await h.notes(sourceId)).map(n => n.hold)).toEqual([late]);
  });
});
