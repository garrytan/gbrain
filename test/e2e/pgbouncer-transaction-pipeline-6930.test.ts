/**
 * #6930: behind a transaction-mode PgBouncer, the statements one transaction issues together are pipelined again.
 *
 * #6543 turned pipelining off on a transaction-mode pooler URL (`?prepare=false` or port 6543) because statements
 * pipelined across a transaction boundary went to the wrong server connection. That also cost every transaction one
 * round trip per statement, though the pooler pins one server connection from BEGIN until the transaction ends: a
 * one-file managed commit took 354-500 dependent round trips behind PgBouncer against about 230 direct. The driver
 * now pipelines on a connection its owner holds while every statement in flight leaves it inside a transaction, and
 * never sends anything behind a statement that may end one.
 *
 * Each case reads the socket trace (GBRAIN_SQL_TRACE): a statement sent before the previous one's answer arrived was
 * pipelined, a client decision rather than a timing. Safety: every statement of a pipelined transaction runs in that
 * transaction on one backend; a failure inside one rolls it back; autocommit statements and anything after COMMIT
 * still wait; prepared statements stay off.
 *
 * Runs when the CI PgBouncer fixture is configured (GBRAIN_PGBOUNCER_URL + GBRAIN_PGBOUNCER_DIRECT_URL), against a
 * database of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { declarePersistenceProtocol, isPersistenceDeclaration } from '../../src/core/persistence/protocol.ts';
import { isPipelinableSearchRead } from '../../src/core/postgres-engine/search-settings.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { withEnv } from '../helpers/with-env.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('The transaction pipeline PgBouncer test requires the configured CI PgBouncer fixture.');
const database = `gbrain_test_txn_pipeline_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const pooledUrl = (query: string) => { const url = new URL(pooled!); url.pathname = `/${database}`; url.search = query; return url.toString(); };
const dir = mkdtempSync(join(tmpdir(), 'gbrain-6930-pgbouncer-'));
const trace = join(dir, 'trace.jsonl');

beforeAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  assertSafeE2eDatabaseUrl(pooledAdmin);
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (!(pooled && pooledAdmin)) return;
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
});

/** Runs `run` on a traced pooled engine and returns the trace records it produced, in send order. */
async function traced(label: string, poolSize: number, run: (engine: PostgresEngine) => Promise<void>, env: Record<string, string | undefined> = {}): Promise<StatementRecord[]> {
  const url = pooledUrl('?prepare=false');
  assertSafeE2eDatabaseUrl(url);
  await withEnv({ PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DISABLE_DIRECT_POOL: '1', GBRAIN_PG_TXN_PIPELINE: undefined,
    GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: label, ...env }, async () => {
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize });
    try { await run(engine); } finally { await engine.disconnect(); }
  });
  await Bun.sleep(1200);
  return readSqlTrace(trace).filter(r => (r as { label?: string }).label === label && r.kind !== 'connect').sort((a, b) => a.t - b.t);
}
const end = (r: StatementRecord) => r.t + (r.ms ?? 0);
/** For each record matching `re` after the first on its connection: was it sent before the previous one there was answered? */
const sentBeforeAnswer = (records: StatementRecord[], re: RegExp, limit = Infinity) => {
  const last = new Map<number, StatementRecord>();
  const out: boolean[] = [];
  for (const r of records.filter(x => re.test(x.sql)).slice(0, limit)) {
    const prev = last.get(r.conn);
    if (prev) out.push(r.t < end(prev));
    last.set(r.conn, r);
  }
  return out;
};

describe.skipIf(!(pooled && pooledAdmin))('#6930 transaction pipelining through transaction-mode PgBouncer', () => {
  test('a transaction\'s concurrent statements are pipelined, each reads its own rows, all on one backend in one transaction', async () => {
    let rows: Array<{ n: number; pid: number; xid: string }> = [];
    let prepare: unknown;
    const records = await traced('txn-pipeline', 1, async engine => {
      prepare = (engine.sql as unknown as { options: { prepare: boolean } }).options.prepare;
      rows = (await engine.sql.begin(tx => Promise.all(Array.from({ length: 12 }, (_, n) =>
        tx.unsafe(`SELECT ${n}::int AS n, pg_backend_pid() AS pid, txid_current()::text AS xid /* pipelined */`))))).map(r => r[0] as unknown as { n: number; pid: number; xid: string });
    });
    expect(prepare).toBe(false);
    expect(rows.map(r => r.n)).toEqual(Array.from({ length: 12 }, (_, n) => n));
    expect(new Set(rows.map(r => r.pid)).size).toBe(1);
    expect(new Set(rows.map(r => r.xid)).size).toBe(1);
    expect(sentBeforeAnswer(records, /\/\* pipelined \*\/$/)).toEqual(Array.from({ length: 11 }, () => true));
  }, 60_000);

  test('a bounded read sends BEGIN; SET LOCAL, the read and COMMIT before any answer, and the bound still applies server-side', async () => {
    let timedOut: string | undefined;
    const records = await traced('txn-bounded', 1, async engine => {
      await engine.executeRaw('SELECT 1 AS bounded_read', [], { timeoutMs: 5000 });
      timedOut = await engine.executeRaw('SELECT pg_sleep(2) AS slept', [], { timeoutMs: 200 }).then(() => 'none', (e: { code?: string }) => e.code);
    });
    expect(sentBeforeAnswer(records, /^BEGIN READ WRITE; SET LOCAL statement_timeout|^SELECT 1 AS bounded_read$|^COMMIT$/, 3)).toEqual([true, true]);
    expect(timedOut).toBe('57014');
  }, 60_000);

  test('a failure inside a pipelined transaction rolls the whole transaction back, and the pool answers the next statement with its own rows', async () => {
    const table = `txn_pipeline_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    let failed: string | undefined;
    let count = -1;
    let after: unknown;
    await traced('txn-failure', 1, async engine => {
      await engine.sql.unsafe(`CREATE TABLE ${table} (n int)`);
      failed = await engine.sql.begin(tx => Promise.all([tx.unsafe(`INSERT INTO ${table} VALUES (1)`), tx.unsafe('SELECT 1/0 AS boom'), tx.unsafe(`INSERT INTO ${table} VALUES (2)`)]))
        .then(() => 'none', (e: { code?: string }) => e.code);
      count = Number((await engine.sql.unsafe(`SELECT count(*)::int AS c FROM ${table}`))[0]!.c);
      after = (await engine.sql.unsafe('SELECT 42 AS after_failure'))[0]!.after_failure;
    });
    expect(failed).toBe('22012');
    expect(count).toBe(0);
    expect(after).toBe(42);
  }, 60_000);

  test('#6543 kept: autocommit statements are not pipelined, nothing is sent behind COMMIT, and concurrent transactions over a small pool never share a backend mid-transaction', async () => {
    let txns: Array<Array<{ pid: number; xid: string; tag: number }>> = [];
    const records = await traced('txn-safety', 2, async engine => {
      await Promise.all(Array.from({ length: 6 }, (_, n) => engine.sql.unsafe(`SELECT ${n} AS autocommit_read`)));
      const reserved = await engine.sql.reserve();
      try {
        await Promise.all([reserved.unsafe('BEGIN').simple().execute(), reserved.unsafe('SELECT 1 AS inside_reserved').execute(),
          reserved.unsafe('COMMIT').execute(), reserved.unsafe('SELECT 2 AS after_commit').execute()]);
      } finally { reserved.release(); }
      txns = await Promise.all(Array.from({ length: 16 }, (_, tag) => engine.sql.begin(tx => Promise.all(Array.from({ length: 4 }, () =>
        tx.unsafe(`SELECT pg_backend_pid() AS pid, txid_current()::text AS xid, ${tag}::int AS tag`)))).then(rs => rs.map(r => r[0] as unknown as { pid: number; xid: string; tag: number }))));
    });
    const autocommit = sentBeforeAnswer(records, /AS autocommit_read$/);
    expect(autocommit.length).toBeGreaterThanOrEqual(4);
    expect(autocommit.filter(Boolean)).toEqual([]);
    const commit = records.find(r => r.sql === 'COMMIT')!;
    const afterCommit = records.find(r => /AS after_commit$/.test(r.sql))!;
    expect(afterCommit.t >= end(commit)).toBe(true);
    for (const [tag, rows] of txns.entries()) {
      expect({ tag, tags: [...new Set(rows.map(r => r.tag))], pids: new Set(rows.map(r => r.pid)).size, xids: new Set(rows.map(r => r.xid)).size })
        .toEqual({ tag, tags: [tag], pids: 1, xids: 1 });
    }
    expect(new Set(txns.map(rows => rows[0]!.xid)).size).toBe(16);
  }, 60_000);

  test('a reserved transaction\'s body waits for BEGIN\'s answer, so a BEGIN the pooler refuses never leaves its writes in autocommit', async () => {
    const records = await traced('txn-reserved', 2, async engine => {
      await engine.withReservedConnection(conn => (conn as unknown as { transaction<R>(run: (tx: PostgresEngine) => Promise<R>): Promise<R> })
        .transaction(tx => Promise.all([tx.executeRaw('SELECT 1 AS reserved_body'), tx.executeRaw('SELECT 2 AS reserved_body')])));
    });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const first = records.find(r => /AS reserved_body$/.test(r.sql))!;
    expect(first.conn).toBe(begin.conn);
    expect(first.t >= end(begin)).toBe(true);
    expect(sentBeforeAnswer(records, /AS reserved_body$/)).toEqual([true]);
  }, 60_000);

  test('GBRAIN_PG_TXN_PIPELINE=0 restores one round trip per statement inside a transaction', async () => {
    const records = await traced('txn-off', 1, async engine => {
      await engine.sql.begin(tx => Promise.all(Array.from({ length: 4 }, (_, n) => tx.unsafe(`SELECT ${n} AS switched_off`))));
    }, { GBRAIN_PG_TXN_PIPELINE: '0' });
    expect(sentBeforeAnswer(records, /AS switched_off$/)).toEqual([false, false, false]);
  }, 60_000);
});

describe.skipIf(!(pooled && pooledAdmin))('GBRA-156: a transaction\'s first statement goes out with BEGIN when the caller opts in', () => {
  const table = `txn_first_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const declaration = "SELECT set_config('gbrain.persistence_protocol','2',true),(SELECT brain_id::text FROM persistence_brain WHERE singleton=1 FOR SHARE) AS brain";
  beforeAll(async () => {
    if (!(pooled && pooledAdmin)) return;
    const admin = postgres(pooledUrl('?prepare=false'), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await admin.unsafe('CREATE TABLE IF NOT EXISTS persistence_brain (singleton int PRIMARY KEY, brain_id uuid NOT NULL)');
      await admin.unsafe("INSERT INTO persistence_brain VALUES (1, gen_random_uuid()) ON CONFLICT DO NOTHING");
      await admin.unsafe(`CREATE TABLE ${table} (n int)`);
    } finally { await admin.end(); }
  }, 60_000);
  const rows = async (engine: PostgresEngine) => Number((await engine.sql.unsafe(`SELECT count(*)::int AS c FROM ${table}`))[0]!.c);

  test('the declaration is sent before BEGIN\'s answer, the next statement only after it, and both run in the transaction', async () => {
    let seen: Array<{ protocol: string | null; xid: string; pid: number }> = [];
    const records = await traced('first-declared', 1, async engine => {
      seen = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        return tx.executeRaw<{ protocol: string | null; xid: string; pid: number }>(
          "SELECT current_setting('gbrain.persistence_protocol', true) AS protocol, txid_current()::text AS xid, pg_backend_pid() AS pid /* after declaration */");
      }, { pipelineFirst: isPersistenceDeclaration });
    });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const declared = records.find(r => r.sql === declaration)!;
    const after = records.find(r => /after declaration \*\/$/.test(r.sql))!;
    expect(declared.t < end(begin)).toBe(true);
    expect(after.t >= end(begin)).toBe(true);
    expect(seen.map(r => r.protocol)).toEqual(['2']);
  }, 60_000);

  test('a first statement the test refuses (a write) waits for BEGIN\'s answer', async () => {
    const records = await traced('first-refused', 1, async engine => {
      await engine.transaction(async tx => {
        await tx.executeRaw(`INSERT INTO ${table} VALUES (0) /* refused first */`);
        await tx.executeRaw(`DELETE FROM ${table} WHERE n=0`);
      }, { pipelineFirst: isPersistenceDeclaration });
    });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const insert = records.find(r => /refused first \*\/$/.test(r.sql))!;
    expect(insert.t >= end(begin)).toBe(true);
  }, 60_000);

  test('a BEGIN that fails runs at most the accepted declaration, in autocommit: no write runs, and the transaction rejects with BEGIN\'s error', async () => {
    let declaredFirst: string | undefined;
    let writeFirst: string | undefined;
    let ranDeclaration = false;
    let count = -1;
    let after: unknown;
    await traced('first-begin-fails', 1, async engine => {
      // `isolation level bogus` survives begin()'s mode filter and makes the server refuse BEGIN (42601) on a live connection.
      declaredFirst = await engine.sql.begin({ mode: 'isolation level bogus', first: isPersistenceDeclaration }, async tx => {
        await tx.unsafe(declaration);
        ranDeclaration = true;
        await tx.unsafe(`INSERT INTO ${table} VALUES (1)`);
      }).then(() => 'none', (e: { code?: string }) => e.code);
      writeFirst = await engine.sql.begin({ mode: 'isolation level bogus', first: isPersistenceDeclaration }, async tx => {
        await tx.unsafe(`INSERT INTO ${table} VALUES (2)`);
      }).then(() => 'none', (e: { code?: string }) => e.code);
      count = await rows(engine);
      after = (await engine.sql.unsafe('SELECT 42 AS after_failed_begin'))[0]!.after_failed_begin;
    });
    expect(declaredFirst).toBe('42601');
    expect(ranDeclaration).toBe(true);
    expect(writeFirst).toBe('42601');
    expect(count).toBe(0);
    expect(after).toBe(42);
  }, 60_000);

  test('accepted text whose argument is a fragment (SQL, not a value) waits for BEGIN\'s answer', async () => {
    const records = await traced('first-fragment', 1, async engine => {
      await engine.sql.begin({ first: isPersistenceDeclaration }, async tx => {
        await tx`SELECT set_config('lock_timeout',${tx.unsafe("(SELECT '1s' FROM pg_sleep(0))")},true)`;
        await tx.unsafe('SELECT 1 AS after_fragment');
      });
    });
    const begin = records.find(r => /^begin\s*$/i.test(r.sql))!;
    const fragment = records.find(r => /pg_sleep\(0\)/.test(r.sql))!;
    expect(isPersistenceDeclaration("SELECT set_config('lock_timeout',$1,true)")).toBe(true);
    expect(fragment.t >= end(begin)).toBe(true);
  }, 60_000);

  test('a callback that swallows a held statement\'s rejection after a failed BEGIN still gets BEGIN\'s error, and nothing past the declaration reaches the socket', async () => {
    let outcome: string | undefined;
    let swallowed: unknown;
    let count = -1;
    const records = await traced('first-swallowed', 1, async engine => {
      outcome = await engine.sql.begin({ mode: 'isolation level bogus', first: isPersistenceDeclaration }, async tx => {
        await tx.unsafe(declaration);
        swallowed = await tx.unsafe(`INSERT INTO ${table} VALUES (3) /* swallowed */`).then(() => 'sent', (e: { code?: string }) => e.code);
        return 'returned';
      }).then(value => `resolved:${String(value)}`, (e: { code?: string }) => e.code);
      count = await rows(engine);
    });
    expect(outcome).toBe('42601');
    // Rejected unsent: held behind the failed BEGIN (42601), or issued after the failed transaction released its connection.
    expect(['42601', 'CONNECTION_CLOSED']).toContain(swallowed as string);
    expect(count).toBe(0);
    const begin = records.findIndex(r => /^begin isolation level bogus/i.test(r.sql));
    const next = records.slice(begin + 1).filter(r => r.conn === records[begin]!.conn).map(r => r.sql);
    expect(next[0]).toBe(declaration);
    expect(next.slice(1).filter(sql => /swallowed|^commit|^rollback/i.test(sql))).toEqual([]);
  }, 60_000);

  type Lent = { executeRaw(sql: string): Promise<unknown>; transaction<R>(run: (tx: PostgresEngine) => Promise<R>, opts?: { pipelineFirst?: (s: string) => boolean }): Promise<R> };

  test('a reserved transaction sends the declaration with BEGIN and the rest of its body after BEGIN\'s answer', async () => {
    const records = await traced('first-reserved', 2, async engine => {
      await engine.withReservedConnection(conn => (conn as unknown as Lent).transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw('SELECT 1 AS reserved_after_declaration');
      }, { pipelineFirst: isPersistenceDeclaration }));
    });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const declared = records.find(r => r.sql === declaration)!;
    const after = records.find(r => /AS reserved_after_declaration$/.test(r.sql))!;
    expect([declared.conn, after.conn]).toEqual([begin.conn, begin.conn]);
    expect(declared.t < end(begin)).toBe(true);
    expect(after.t >= end(begin)).toBe(true);
  }, 60_000);

  test('a reserved transaction whose BEGIN fails sends nothing past the declaration, even when the body swallows the rejection', async () => {
    let outcome: string | undefined;
    let count = -1;
    const records = await traced('first-reserved-fails', 2, async engine => {
      outcome = await engine.withReservedConnection(async conn => {
        const lent = conn as unknown as Lent;
        // An aborted transaction left on the reserved connection makes the server refuse the next BEGIN (25P02).
        await lent.executeRaw('BEGIN');
        await lent.executeRaw('SELECT 1/0 AS abort_reserved').catch(() => undefined);
        return lent.transaction(async tx => {
          await tx.executeRaw(declaration).catch(() => undefined);
          await tx.executeRaw(`INSERT INTO ${table} VALUES (4) /* reserved swallowed */`).catch(() => undefined);
          return 'returned';
        }, { pipelineFirst: isPersistenceDeclaration }).then(value => `resolved:${value}`, (e: { code?: string }) => e.code);
      });
      count = await rows(engine);
    });
    expect(outcome).toBe('25P02');
    expect(count).toBe(0);
    expect(records.filter(r => /reserved swallowed/.test(r.sql))).toEqual([]);
  }, 60_000);

  test('a reserved transaction whose BEGIN fails sends nothing from a nested transaction\'s body, even when it swallows the rejection', async () => {
    let outcome: string | undefined;
    let count = -1;
    const records = await traced('first-reserved-savepoint-fails', 2, async engine => {
      outcome = await engine.withReservedConnection(async conn => {
        const lent = conn as unknown as Lent;
        await lent.executeRaw('BEGIN');
        await lent.executeRaw('SELECT 1/0 AS abort_reserved').catch(() => undefined);
        return lent.transaction(async tx => {
          await tx.executeRaw(declaration).catch(() => undefined);
          await tx.transaction(inner => inner.executeRaw(`INSERT INTO ${table} VALUES (5) /* savepoint swallowed */`).catch(() => undefined)).catch(() => undefined);
          return 'returned';
        }, { pipelineFirst: isPersistenceDeclaration }).then(value => `resolved:${value}`, (e: { code?: string }) => e.code);
      });
      count = await rows(engine);
    });
    expect(outcome).toBe('25P02');
    expect(count).toBe(0);
    expect(records.filter(r => /savepoint swallowed/.test(r.sql))).toEqual([]);
  }, 60_000);

  test('GBRAIN_PG_TXN_PIPELINE=0 keeps the declaration behind BEGIN\'s answer', async () => {
    const records = await traced('first-off', 1, async engine => {
      await engine.transaction(tx => declarePersistenceProtocol(tx), { pipelineFirst: isPersistenceDeclaration });
    }, { GBRAIN_PG_TXN_PIPELINE: '0' });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const declared = records.find(r => r.sql === declaration)!;
    expect(declared.t >= end(begin)).toBe(true);
  }, 60_000);

  test('a failed single-statement bounded read rolls back at its pipelined COMMIT without an error of its own, and leaves no transaction behind', async () => {
    let failed: string | undefined;
    let next: Array<{ timeout: string; fresh: boolean }> = [];
    const records = await traced('bounded-failed', 1, async engine => {
      failed = await engine.executeRaw('SELECT 1/0 AS bounded_failure', [], { timeoutMs: 5000 }).then(() => 'none', (e: { code?: string }) => e.code);
      next = await engine.sql.unsafe("SELECT current_setting('statement_timeout') AS timeout, now() = statement_timestamp() AS fresh") as unknown as typeof next;
    });
    expect(sentBeforeAnswer(records, /^BEGIN READ WRITE; SET LOCAL statement_timeout|^SELECT 1\/0 AS bounded_failure$|^COMMIT$/, 3)).toEqual([true, true]);
    expect(failed).toBe('22012');
    expect(next.map(r => r.fresh)).toEqual([true]);
    expect(next[0]!.timeout).not.toBe('5s');
  }, 60_000);
});

describe.skipIf(!(pooled && pooledAdmin))('GBRA-156: a search read transaction sends its whole body behind BEGIN', () => {
  const table = `txn_early_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const settings = "SELECT set_config('jit', $1, true), set_config('statement_timeout', $2, true)";
  beforeAll(async () => {
    if (!(pooled && pooledAdmin)) return;
    const admin = postgres(pooledUrl('?prepare=false'), { max: 1, prepare: false, onnotice: () => {} });
    try { await admin.unsafe(`CREATE TABLE ${table} (n int)`); } finally { await admin.end(); }
  }, 60_000);

  test('the settings and the read go out before BEGIN\'s answer, and the read runs inside the transaction under those settings', async () => {
    let seen: Array<{ jit: string; timeout: string }> = [];
    const records = await traced('early-read', 1, async engine => {
      // Transaction-local settings are in effect only inside the transaction (outside one set_config(..., true) is a no-op).
      // The first run also describes the settings statement's parameters; the second is the one measured.
      for (let run = 0; run < 2; run++) {
        seen = await engine.transaction(async tx => {
          const applied = tx.executeRaw(settings, ['off', '4321ms']);
          const read = tx.executeRaw<{ jit: string; timeout: string }>(
            `SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS timeout /* early read ${run} */`);
          await applied;
          return read;
        }, { pipelineEarly: isPipelinableSearchRead });
      }
    });
    const measured = records.slice(records.findLastIndex(r => /^begin read write$/i.test(r.sql)));
    const begin = measured[0]!;
    const applied = measured.find(r => r.sql === settings)!;
    const read = measured.find(r => /early read 1 \*\/$/.test(r.sql))!;
    expect(isPipelinableSearchRead(read.sql)).toBe(true);
    expect([applied.conn, read.conn]).toEqual([begin.conn, begin.conn]);
    expect(applied.t < end(begin)).toBe(true);
    expect(read.t < end(begin)).toBe(true);
    expect(seen.map(r => [r.jit, r.timeout])).toEqual([['off', '4321ms']]);
  }, 60_000);

  test('the first refused statement (a write), and every statement after it, waits for BEGIN\'s answer', async () => {
    const records = await traced('early-refused', 1, async engine => {
      await engine.transaction(async tx => {
        await Promise.all([
          tx.executeRaw('SELECT 1 AS early_before_write'),
          tx.executeRaw(`INSERT INTO ${table} VALUES (0) /* refused write */`),
          tx.executeRaw('SELECT 2 AS early_after_write'),
        ]);
        await tx.executeRaw(`DELETE FROM ${table} WHERE n = 0`);
      }, { pipelineEarly: isPipelinableSearchRead });
    });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const before = records.find(r => /AS early_before_write$/.test(r.sql))!;
    const write = records.find(r => /refused write \*\/$/.test(r.sql))!;
    const after = records.find(r => /AS early_after_write$/.test(r.sql))!;
    expect(before.t < end(begin)).toBe(true);
    expect(write.t >= end(begin)).toBe(true);
    expect(after.t >= end(begin)).toBe(true);
  }, 60_000);

  test('a BEGIN that fails runs only accepted reads, in autocommit: no write runs, and the transaction rejects with BEGIN\'s error', async () => {
    let outcome: string | undefined;
    let count = -1;
    await traced('early-begin-fails', 1, async engine => {
      outcome = await engine.sql.begin({ mode: 'isolation level bogus', early: isPipelinableSearchRead }, async tx => {
        await Promise.all([tx.unsafe(settings, ['off', '1000ms']), tx.unsafe('SELECT 1 AS early_read_before_failed_begin'), tx.unsafe(`INSERT INTO ${table} VALUES (5)`)]);
      }).then(() => 'none', (e: { code?: string }) => e.code);
      count = Number((await engine.sql.unsafe(`SELECT count(*)::int AS c FROM ${table}`))[0]!.c);
    });
    expect(outcome).toBe('42601');
    expect(count).toBe(0);
  }, 60_000);

  test('GBRAIN_PG_TXN_PIPELINE=0 keeps every statement behind BEGIN\'s answer', async () => {
    const records = await traced('early-off', 1, async engine => {
      await engine.transaction(tx => tx.executeRaw('SELECT 1 AS early_switched_off'), { pipelineEarly: isPipelinableSearchRead });
    }, { GBRAIN_PG_TXN_PIPELINE: '0' });
    const begin = records.find(r => /^begin read write$/i.test(r.sql))!;
    const read = records.find(r => /AS early_switched_off$/.test(r.sql))!;
    expect(read.t >= end(begin)).toBe(true);
  }, 60_000);
});
