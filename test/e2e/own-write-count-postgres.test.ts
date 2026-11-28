/**
 * The own-write count on a Postgres primary (src/core/postgres-engine/own-writes.ts): the ledger of this engine's own
 * committed row changes equals what the database's write counters (`pg_stat_user_tables`) moved by, per relation and
 * per counter, for every way the engine writes: autocommit statements (executeRaw, tagged templates, unsafe),
 * transactions with savepoints that roll back, ON CONFLICT updates, cascaded deletes, trigger writes, deferred
 * triggers, and a reserved connection's raw statements and transactions.
 *
 * Protects: the shadow seal's rule that the counters may move by exactly this process's own writes. A ledger above
 * the counters would let another client's write hide behind ours; the tests assert equality where the count is exact
 * and "ledger never above the counters" where a write is left out (a failed statement, a reserved connection's text
 * that mixes transaction control with other statements). Also: a write on another database whose relations share the
 * counted oids (a clone of the same template) is left out, and a write is never sent when its BEGIN fails (it would
 * run in autocommit). Regression it catches: an own write the seal refuses, or a foreign write the ledger absorbs.
 * Needs DATABASE_URL (Postgres 15+); skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { ownWriteCounter, physicalPool, type OwnWriteLedger } from '../../src/core/postgres-engine/own-writes.ts';
import type { ReservedTransactions } from '../../src/core/postgres-engine/reserved-transactions.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';

const d = hasDatabase() ? describe : describe.skip;
const NAMES = ['own_parent', 'own_child', 'own_log'];

type Template = Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let template: Template;
let engine: PostgresEngine;
let close: () => Promise<void>;
let ledger: OwnWriteLedger;
let observer: ReturnType<typeof postgres>;
const sockets: Array<ReturnType<typeof postgres>> = [];

const url = (): string => (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
type Row = Record<string, [string, string, string]>;

function plain(app: string): ReturnType<typeof postgres> {
  const sql = postgres(url(), { max: 1, connection: { application_name: app }, onnotice: () => undefined });
  sockets.push(sql);
  return sql;
}

/** The global counters of the test relations, as another connection sees them now. */
async function counters(): Promise<Row> {
  return observer.begin(async (tx) => {
    await tx`SELECT pg_catalog.pg_stat_clear_snapshot()`;
    const rows = await tx`SELECT relname::text AS name, n_tup_ins::text AS ins, n_tup_upd::text AS upd, n_tup_del::text AS del
      FROM pg_stat_user_tables WHERE relname = ANY(${NAMES}::text[])`;
    const out: Row = {};
    for (const r of rows) out[r.name as string] = [r.ins as string, r.upd as string, r.del as string];
    return out;
  });
}

function diff(a: Row, b: Row): Row {
  const out: Row = {};
  for (const n of NAMES) {
    const x = a[n]!, y = b[n]!;
    out[n] = [0, 1, 2].map(i => String(BigInt(y[i]!) - BigInt(x[i]!))) as [string, string, string];
  }
  return out;
}

function own(k: number): Row {
  const since = ledger.since(k);
  const out: Row = {};
  for (const n of NAMES) out[n] = (since.get(n) ?? [0n, 0n, 0n]).map(String) as [string, string, string];
  return out;
}

function stats(): { counted: number; dropped: number } {
  const c = (engine as unknown as { _ownWrites: { counted: number; dropped: number } })._ownWrites;
  return { counted: c.counted, dropped: c.dropped };
}

d('the own-write count on Postgres', () => {
  beforeAll(async () => { assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => {
    ({ engine, close } = await template.clone());
    await engine.executeRaw(`CREATE TABLE own_parent (id int PRIMARY KEY, v text)`);
    await engine.executeRaw(`CREATE TABLE own_child (id int PRIMARY KEY, parent int REFERENCES own_parent(id) ON DELETE CASCADE)`);
    await engine.executeRaw(`CREATE TABLE own_log (id bigserial PRIMARY KEY, what text)`);
    await engine.executeRaw(`CREATE FUNCTION own_log_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO own_log (what) VALUES (TG_OP); RETURN NULL; END $$`);
    await engine.executeRaw(`CREATE TRIGGER own_log_t AFTER INSERT OR UPDATE OR DELETE ON own_parent FOR EACH ROW EXECUTE FUNCTION own_log_it()`);
    const l = await engine.countOwnWrites([...NAMES, 'not_a_relation']);
    expect(l).not.toBeNull();
    ledger = l!;
    observer = plain('own-write-observer');
  }, 60_000);
  afterEach(async () => {
    for (const s of sockets.splice(0)) await s.end({ timeout: 5 }).catch(() => undefined);
    await close();
  }, 60_000);

  test('autocommit statements of every kind: the ledger equals the counter movement', async () => {
    const before = await counters();
    const k = ledger.mark();
    await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    const returned = await engine.executeRaw<{ id: number }>(`INSERT INTO own_child (id, parent) VALUES ($1, $2), ($3, $4) RETURNING id`, [10, 1, 11, 2]);
    expect(returned.map(r => r.id).sort()).toEqual([10, 11]);
    await engine.sql`UPDATE own_parent SET v = ${'z'} WHERE id = ${3}`;
    await engine.sql.unsafe(`INSERT INTO own_parent (id, v) VALUES ($1, 'x') ON CONFLICT (id) DO UPDATE SET v = 'y'`, [1]);
    await engine.executeRaw(`WITH gone AS (DELETE FROM own_parent WHERE id = 2 RETURNING id) SELECT count(*) FROM gone`);
    expect(diff(before, await counters())).toEqual(own(k));
    expect(own(k).own_child).toEqual(['2', '0', '1']); // the cascade
    expect(stats().dropped).toBe(0);
  });

  test('transactions with savepoints, ON CONFLICT, cascades and triggers: the ledger equals the counter movement', async () => {
    const before = await counters();
    const k = ledger.mark();
    await engine.transaction(async (tx) => {
      await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
      await tx.executeRaw(`INSERT INTO own_child (id, parent) VALUES (10, 1), (11, 2)`);
      await tx.transaction(async (inner) => {
        await inner.executeRaw(`INSERT INTO own_parent (id, v) VALUES (4, 'gone')`);
        throw new Error('roll the savepoint back');
      }).catch(() => undefined);
      await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (5, 'n') ON CONFLICT (id) DO NOTHING`);
      await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'n') ON CONFLICT (id) DO UPDATE SET v = 'u'`);
      await tx.executeRaw(`DELETE FROM own_parent WHERE id = 2`);
    });
    expect(diff(before, await counters())).toEqual(own(k));
    expect(own(k).own_parent).toEqual(['5', '1', '1']); // the rolled-back savepoint's row is counted, as the server counts it
  });

  test('a transaction that sets its isolation level first still runs, and a read-only one adds no reads', async () => {
    const before = await counters();
    const k = ledger.mark();
    const counted = stats().counted;
    await engine.transaction(async (tx) => {
      await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await tx.executeRaw(`SELECT count(*) FROM own_parent`);
      await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (7, 'r')`);
    });
    await engine.transaction(async (tx) => { await tx.executeRaw(`SELECT count(*) FROM own_parent`); });
    await engine.transaction(async (tx) => { await tx.executeRaw(`SELECT 1`); }, { readOnly: true });
    expect(stats().counted).toBe(counted + 1);
    expect(diff(before, await counters())).toEqual(own(k));
  });

  test('a failed write keeps its own error and is left out: the ledger never exceeds the counters', async () => {
    await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'a')`);
    const before = await counters();
    const k = ledger.mark();
    const err = await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'dup')`).catch((e: unknown) => e) as { code?: string };
    expect(err.code).toBe('23505');
    const txErr = await engine.transaction(async (tx) => { await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (2, 'ok')`); await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'dup')`); }).catch((e: unknown) => e) as { code?: string };
    expect(txErr.code).toBe('23505');
    expect(own(k).own_parent).toEqual(['0', '0', '0']);
    // The server counts the aborted inserts once their backend flushes; the ledger never does.
    const moved = diff(before, await counters());
    for (const n of NAMES) for (let i = 0; i < 3; i++) expect(BigInt(own(k)[n]![i]!)).toBeLessThanOrEqual(BigInt(moved[n]![i]!));
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM own_parent`))[0]!.n).toBe(1);
  });

  test('a foreign write, also from a client with the same application_name, leaves the counters ahead of the ledger', async () => {
    const app = ((await engine.executeRaw<{ a: string }>(`SELECT current_setting('application_name') AS a`))[0]!.a);
    const before = await counters();
    const k = ledger.mark();
    await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'own')`);
    const foreign = plain(app);
    await foreign`INSERT INTO own_child (id, parent) VALUES (20, 1)`;
    await foreign.end({ timeout: 5 }); // its backend flushes its counters when it exits
    sockets.splice(sockets.indexOf(foreign), 1);
    let moved: Row = {};
    for (let i = 0; i < 50; i++) { moved = diff(before, await counters()); if (moved.own_child![0] !== '0') break; await new Promise(r => setTimeout(r, 100)); }
    expect(moved.own_child).toEqual(['1', '0', '0']);
    expect(own(k).own_child).toEqual(['0', '0', '0']);
    expect(own(k).own_parent).toEqual(moved.own_parent!);
  });

  test('deferred trigger writes fire before the count is read, not at COMMIT: the ledger equals the counter movement', async () => {
    // A constraint trigger that waits for COMMIT and writes another relation, and a deferred foreign key whose check
    // reads the parent: both would fire after a count read at the end of the body; SET CONSTRAINTS ALL IMMEDIATE fires
    // them before END, so their rows are inside END - START.
    await engine.executeRaw(`CREATE FUNCTION own_late_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO own_log (what) VALUES ('late'); RETURN NULL; END $$`);
    await engine.executeRaw(`CREATE CONSTRAINT TRIGGER own_late_t AFTER INSERT ON own_child DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION own_late_log()`);
    await engine.executeRaw(`ALTER TABLE own_child ADD COLUMN sib int, ADD CONSTRAINT own_child_sib FOREIGN KEY (sib) REFERENCES own_child(id) DEFERRABLE INITIALLY DEFERRED`);
    await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'p')`);
    const before = await counters();
    const k = ledger.mark();
    await engine.executeRaw(`INSERT INTO own_child (id, parent, sib) VALUES (31, 1, 30), (30, 1, NULL)`);
    await engine.transaction(async (tx) => {
      await tx.executeRaw(`INSERT INTO own_child (id, parent, sib) VALUES (41, 1, 40)`);
      await tx.executeRaw(`INSERT INTO own_child (id, parent) VALUES (40, 1)`);
    });
    expect(diff(before, await counters())).toEqual(own(k));
    expect(own(k).own_log).toEqual(['4', '0', '0']);
    // A deferred check that fails at the end still fails the write with its own error, and nothing is booked.
    const k2 = ledger.mark();
    const err = await engine.executeRaw(`INSERT INTO own_child (id, parent, sib) VALUES (51, 1, 999)`).catch((e: unknown) => e) as { code?: string };
    expect(err.code).toBe('23503');
    const txErr = await engine.transaction(async (tx) => { await tx.executeRaw(`INSERT INTO own_child (id, parent, sib) VALUES (61, 1, 999)`); }).catch((e: unknown) => e) as { code?: string };
    expect(txErr.code).toBe('23503');
    expect(own(k2).own_child).toEqual(['0', '0', '0']);
    expect(stats().dropped).toBe(0);
  });

  test('a reserved connection: autocommit writes, the caller\'s own BEGIN and COMMIT, and conn.transaction are counted', async () => {
    await engine.executeRaw(`ALTER TABLE own_child ADD COLUMN sib int, ADD CONSTRAINT own_child_sib FOREIGN KEY (sib) REFERENCES own_child(id) DEFERRABLE INITIALLY DEFERRED`);
    const before = await counters();
    const k = ledger.mark();
    await engine.withReservedConnection(async (conn) => {
      await conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'a'), (2, 'b')`);
      // The caller's transaction, pipelined as backfill batches send it: SET LOCAL and the writes ride behind BEGIN.
      await Promise.all([conn.executeRaw('BEGIN READ WRITE'), conn.executeRaw(`SET LOCAL statement_timeout = '30s'`),
        conn.executeRaw(`UPDATE own_parent SET v = 'u' WHERE id = $1`, [1]), conn.executeRaw(`INSERT INTO own_child (id, parent) VALUES (10, 1)`)]);
      await conn.executeRaw('SAVEPOINT s1');
      await conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (3, 'gone')`);
      await conn.executeRaw('ROLLBACK TO SAVEPOINT s1');
      const done = await conn.executeRaw('COMMIT') as unknown as { command?: string };
      expect(done.command).toBe('COMMIT');
      await (conn as typeof conn & ReservedTransactions).transaction(async (tx) => { await tx.executeRaw(`DELETE FROM own_parent WHERE id = 2`); });
      // A deferred check that fails at the caller's COMMIT still fails it with its own error, and nothing is booked.
      await conn.executeRaw('BEGIN');
      await conn.executeRaw(`INSERT INTO own_child (id, parent, sib) VALUES (11, 1, 999)`);
      const err = await conn.executeRaw('COMMIT').catch((e: unknown) => e) as { code?: string };
      expect(err.code).toBe('23503');
      // A rolled-back transaction books nothing.
      await conn.executeRaw('BEGIN');
      await conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (4, 'rolled back')`);
      await conn.executeRaw('ROLLBACK');
    });
    // The rolled-back rows still move the server's insert counter: compare the relations they did not touch.
    const moved = diff(before, await counters());
    expect(own(k).own_child).toEqual(['1', '0', '0']); // child 10; child 11 failed its deferred check at COMMIT
    expect(own(k).own_parent).toEqual(['3', '1', '1']); // 1, 2 and the rolled-back savepoint row 3; not row 4
    expect(own(k).own_log).toEqual(['5', '0', '0']);
    for (const n of NAMES) for (let i = 0; i < 3; i++) expect(BigInt(own(k)[n]![i]!)).toBeLessThanOrEqual(BigInt(moved[n]![i]!));
    expect(stats().dropped).toBe(0);
  });

  test('a reserved connection\'s exact writes equal the counter movement, and a text that mixes transaction control stops the count', async () => {
    const before = await counters();
    const k = ledger.mark();
    await engine.withReservedConnection(async (conn) => {
      await conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'a')`);
      await conn.executeRaw('BEGIN');
      await conn.executeRaw(`INSERT INTO own_child (id, parent) VALUES (10, 1)`);
      await conn.executeRaw('COMMIT');
    });
    expect(diff(before, await counters())).toEqual(own(k));
    expect([own(k).own_parent, own(k).own_child]).toEqual([['1', '0', '0'], ['1', '0', '0']]);
    const k2 = ledger.mark();
    await engine.withReservedConnection(async (conn) => {
      await conn.executeRaw(`BEGIN; INSERT INTO own_parent (id, v) VALUES (2, 'b'); COMMIT`);
      await conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (3, 'c')`);
    });
    expect(own(k2).own_parent).toEqual(['0', '0', '0']);
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM own_parent`))[0]!.n).toBe(3);
  });

  test('a cancellable statement on its own reserved connection is counted, keeps its own error, and a cancelled write is left out', async () => {
    const before = await counters();
    const k = ledger.mark();
    const signal = new AbortController().signal;
    const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO own_parent (id, v) VALUES (1, 'a'), (2, 'b') RETURNING id`, undefined, { signal });
    expect(rows.map(r => r.id).sort()).toEqual([1, 2]);
    await engine.executeRawDirect(`UPDATE own_parent SET v = 'z' WHERE id = $1`, [1], { signal });
    await engine.executeRaw(`SELECT 1`, undefined, { signal });
    expect(diff(before, await counters())).toEqual(own(k));
    expect(own(k).own_parent).toEqual(['2', '1', '0']);
    // A failed insert still moves n_tup_ins (its aborted tuple): the ledger leaves it out and falls short, never over.
    const dup = await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (1, 'again')`, undefined, { signal }).then(() => null, (e: { code?: string }) => e.code);
    expect(dup).toBe('23505');
    const cancel = new AbortController();
    const slow = engine.executeRaw(`INSERT INTO own_parent (id, v) SELECT 9, 'slow' FROM pg_sleep(5)`, undefined, { signal: cancel.signal }).then(() => 'ran', () => 'refused');
    setTimeout(() => cancel.abort(), 300);
    expect(await slow).toBe('refused');
    expect(own(k).own_parent).toEqual(['2', '1', '0']);
    expect(diff(before, await counters()).own_parent).toEqual(['3', '1', '0']);
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM own_parent`))[0]!.n).toBe(2);
    expect(stats().dropped).toBe(0);
  });

  test('a mark leaves out the writes before it, and many concurrent writes stay exact', async () => {
    await engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES (100, 'before')`);
    const before = await counters();
    const k = ledger.mark();
    await Promise.all(Array.from({ length: 40 }, (_, i) => i % 2
      ? engine.executeRaw(`INSERT INTO own_parent (id, v) VALUES ($1, 'c')`, [i])
      : engine.transaction(async (tx) => { await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES ($1, 't')`, [i]); await tx.executeRaw(`UPDATE own_parent SET v = 'u' WHERE id = $1`, [i]); })));
    expect(diff(before, await counters())).toEqual(own(k));
    expect(own(k).own_parent).toEqual(['40', '20', '0']);
  });

  test('a write on another database whose relations have the same oids (a clone of the same template) is left out', async () => {
    const other = await template.clone();
    try {
      const here = physicalPool(engine.sql), there = physicalPool(other.engine.sql);
      const oid = async (sql: ReturnType<typeof postgres>) => String((await sql.unsafe(`SELECT 'config'::regclass::oid::text AS o`))[0]!.o);
      expect(await oid(there)).toBe(await oid(here)); // the same oid on both, so only the database tells them apart
      const counter = (await ownWriteCounter(here, ['config']))!;
      await counter.pool(there).unsafe(`INSERT INTO config (key, value) VALUES ('own-write-clone', 'there')`);
      expect([counter.counted, counter.dropped]).toEqual([0, 1]);
      expect(counter.ledger.since(0).size).toBe(0);
      await counter.pool(here).unsafe(`INSERT INTO config (key, value) VALUES ('own-write-clone', 'here')`);
      expect([counter.counted, counter.dropped]).toEqual([1, 1]);
      expect(counter.ledger.since(0).get('config')).toEqual([1n, 0n, 0n]);
    } finally { await other.close(); }
  }, 60_000);

  test('a pool write whose BEGIN fails is never sent: it gets BEGIN\'s error and the table is untouched', async () => {
    const pool = physicalPool(engine.sql);
    // `isolation level bogus` survives begin()'s mode filter and makes the server refuse BEGIN (42601) on a live connection.
    const refusing = new Proxy(pool, {
      get(target, key) {
        if (key === 'begin') return (options: object, fn: unknown) => (target.begin as unknown as (o: unknown, f: unknown) => Promise<unknown>)({ ...options, mode: 'isolation level bogus' }, fn);
        return Reflect.get(target, key, target);
      },
    });
    const counter = (await ownWriteCounter(pool, NAMES))!;
    const outcome = await counter.pool(refusing).unsafe(`INSERT INTO own_parent (id, v) VALUES (90, 'begin-refused')`).then(() => 'ran', (e: { code?: string }) => e.code);
    expect(outcome).toBe('42601');
    expect(Number((await observer`SELECT count(*)::int AS n FROM own_parent WHERE id = 90`)[0]!.n)).toBe(0);
    expect(counter.ledger.since(0).size).toBe(0);
  }, 60_000);

  test('a reserved connection: an autocommit write whose BEGIN fails is never sent, and statements sent behind a write wait for it', async () => {
    const pool = physicalPool(engine.sql);
    const counter = (await ownWriteCounter(pool, NAMES))!;
    const reserved = await pool.reserve();
    try {
      const refusing = new Proxy(reserved, {
        get(target, key) {
          if (key === 'unsafe') return (text: string, ...rest: unknown[]) => (target.unsafe as (...a: unknown[]) => unknown)(text === 'BEGIN' ? 'BEGIN ISOLATION LEVEL BOGUS' : text, ...rest);
          return Reflect.get(target, key, target);
        },
      });
      const failing = counter.reserved(refusing as unknown as ReturnType<typeof postgres>, pool);
      const outcome = await failing(`INSERT INTO own_parent (id, v) VALUES (91, 'begin-refused')`).then(() => 'ran', (e: { code?: string }) => e.code);
      expect(outcome).toBe('42601');
      expect(Number((await observer`SELECT count(*)::int AS n FROM own_parent WHERE id = 91`)[0]!.n)).toBe(0);
      // Sent without waiting: the read goes on the connection after the write's COMMIT, not between its BEGIN and the write.
      const run = counter.reserved(reserved as unknown as ReturnType<typeof postgres>, pool);
      const wrote = run(`INSERT INTO own_parent (id, v) VALUES (92, 'counted')`);
      const read = run(`SELECT count(*)::int AS n, pg_catalog.now() = pg_catalog.statement_timestamp() AS outside FROM own_parent WHERE id = 92`);
      await wrote;
      expect(await read).toEqual([{ n: 1, outside: true }]);
      expect(counter.ledger.since(0).get('own_parent')).toEqual([1n, 0n, 0n]);
    } finally { reserved.release(); }
  }, 60_000);

  test('a reserved connection: conn.transaction opened right behind an unawaited write waits for that write\'s transaction to close', async () => {
    let rolledBack = false;
    await engine.withReservedConnection(async (conn) => {
      const wrote = conn.executeRaw(`INSERT INTO own_parent (id, v) VALUES (93, 'autocommit')`);
      await (conn as typeof conn & ReservedTransactions).transaction(async (tx) => {
        await tx.executeRaw(`INSERT INTO own_parent (id, v) VALUES (94, 'rolled back')`);
        throw new Error('roll the transaction back');
      }).catch(() => { rolledBack = true; });
      await wrote;
    });
    expect(rolledBack).toBe(true);
    const ids = (await observer`SELECT id FROM own_parent WHERE id IN (93, 94) ORDER BY id`).map(r => Number(r.id));
    expect(ids).toEqual([93]); // 94 stayed inside its own transaction, which rolled back
    expect(own(0).own_parent).toEqual(['1', '0', '0']);
  }, 60_000);
});
