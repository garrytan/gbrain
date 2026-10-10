/**
 * GBRA-75 wave 9: `withBoundedReadSession`, the one transaction a waiver
 * screen's bounded reads share. Protects: the reads run on one reserved
 * connection between one `BEGIN; SET LOCAL statement_timeout` and one `COMMIT`;
 * the bound stays per statement on the server (set again once the one in force
 * differs from a read's own bound by more than the slack; a screen inside a
 * waiver run's session joins it); a statement held by a
 * relation lock ends on the server at its bound with no statement left running;
 * a failed read rolls the transaction back and the reads it aborted (25P02) run
 * again, so each read sees its own outcome; a read after the session closed and
 * every unbounded statement take the engine's own path; PGLite and a pool with
 * no long-hold capacity get the engine itself; and a full re-sync's screens
 * run their bounded reads on sessions on Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine, ReservedConnection } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PoolCapacityError } from '../src/core/pool-budget.ts';
import { BOUNDED_SESSION_SLACK_MS, boundedReads, PreparationDeadlineError, withBoundedReadSession } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A fake Postgres engine whose reserved connection records each statement and answers through `respond`. */
function fakePostgres(respond: (sql: string) => Promise<unknown[]> = async () => [{ ok: true }]) {
  const conn: string[] = [], direct: Array<{ sql: string; timeoutMs?: number }> = [];
  const reserved = { executeRaw: (sql: string) => { conn.push(sql); return respond(sql); } } as unknown as ReservedConnection;
  const engine = { kind: 'postgres',
    executeRaw: async (sql: string, _params?: unknown[], opts?: { timeoutMs?: number }) => { direct.push({ sql, timeoutMs: opts?.timeoutMs }); return [{ direct: true }]; },
    withReservedConnection: <T>(fn: (c: ReservedConnection) => Promise<T>) => fn(reserved) } as unknown as BrainEngine;
  return { engine, conn, direct };
}

test('a session runs its bounded reads in one transaction; unbounded statements and reads after it closed take the engine\'s path', async () => {
  const { engine, conn, direct } = fakePostgres();
  let view: BrainEngine | undefined;
  await withBoundedReadSession(engine, async session => {
    view = session;
    const reads = boundedReads(session, startClaimPhase(Date.now(), undefined, 60_000));
    await Promise.all([reads.executeRaw('SELECT 1 AS a'), reads.executeRaw('SELECT 2 AS b')]);
    await reads.executeRaw('SELECT 3 AS c');
    await session.executeRaw('SELECT 4 AS unbounded');
  });
  expect(conn.slice(0, 2)).toEqual(['BEGIN', expect.stringMatching(/^SET LOCAL statement_timeout = (5\d{4}|60000)$/)]);
  expect(conn.slice(2)).toEqual(['SELECT 1 AS a', 'SELECT 2 AS b', 'SELECT 3 AS c', 'COMMIT']);
  expect(direct).toEqual([{ sql: 'SELECT 4 AS unbounded', timeoutMs: undefined }]);
  // A read issued after the session settled (an abandoned preparation) runs on its own bounded transaction.
  await view!.executeRaw('SELECT 5 AS late', [], { timeoutMs: 1000 });
  expect(direct[1]).toEqual({ sql: 'SELECT 5 AS late', timeoutMs: 1000 });
});

test('the bound in force is set again once it differs from a read\'s own bound by more than the slack', async () => {
  const { engine, conn } = fakePostgres();
  await withBoundedReadSession(engine, async session => {
    await session.executeRaw('SELECT 1', [], { timeoutMs: 10_000 });
    await session.executeRaw('SELECT 2', [], { timeoutMs: 10_000 - BOUNDED_SESSION_SLACK_MS });
    await session.executeRaw('SELECT 3', [], { timeoutMs: 10_000 - BOUNDED_SESSION_SLACK_MS - 1 });
    await session.executeRaw('SELECT 4', [], { timeoutMs: 20_000 });
  });
  expect(conn).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 10000', 'SELECT 1', 'SELECT 2',
    `SET LOCAL statement_timeout = ${10_000 - BOUNDED_SESSION_SLACK_MS - 1}`, 'SELECT 3', 'SET LOCAL statement_timeout = 20000', 'SELECT 4', 'COMMIT']);
});

test('a failed read rolls the transaction back, the reads it aborted run again, and the next read opens a new transaction', async () => {
  let aborted = false;
  const { engine, conn } = fakePostgres(async sql => {
    if (sql === 'SELECT held') { aborted = true; throw pgError('57014', 'canceling statement due to statement timeout'); }
    if (aborted && sql === 'SELECT queued') { aborted = false; throw pgError('25P02', 'current transaction is aborted'); }
    return [{ sql }];
  });
  await withBoundedReadSession(engine, async session => {
    const reads = boundedReads(session, startClaimPhase(Date.now(), undefined, 60_000));
    const [held, queued] = await Promise.allSettled([reads.executeRaw('SELECT held'), reads.executeRaw('SELECT queued')]);
    expect((held as PromiseRejectedResult).reason).toBeInstanceOf(PreparationDeadlineError);
    expect(queued).toEqual({ status: 'fulfilled', value: [{ sql: 'SELECT queued' }] });
    expect(await reads.executeRaw('SELECT after')).toEqual([{ sql: 'SELECT after' }]);
  });
  expect(conn.filter(sql => /^(BEGIN|ROLLBACK|COMMIT)$/.test(sql))).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  expect(conn.filter(sql => sql === 'SELECT queued')).toHaveLength(2);
});

test('a screen inside a waiver run\'s session joins it: one transaction for both, reads named as prepared statements', async () => {
  const { engine, conn } = fakePostgres();
  const prepared: unknown[] = [];
  const spy = { ...engine, withReservedConnection: <T>(fn: (c: ReservedConnection) => Promise<T>) => engine.withReservedConnection(c => fn({ executeRaw: (sql: string, params?: unknown[], opts?: { prepare?: boolean }) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) prepared.push(opts?.prepare); return c.executeRaw(sql, params, opts); } } as ReservedConnection)) } as unknown as BrainEngine;
  let reserved = 0;
  const counted = new Proxy(spy, { get(target, key) { if (key === 'withReservedConnection') reserved++; return Reflect.get(target, key); } });
  await withBoundedReadSession(counted, async run => {
    await run.executeRaw('SELECT 1', [], { timeoutMs: 10_000 });
    await withBoundedReadSession(run, async screen => { expect(screen).toBe(run); await screen.executeRaw('SELECT 2', [], { timeoutMs: 10_000 }); });
  });
  expect(reserved).toBe(1);
  expect(conn).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 10000', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  expect(prepared).toEqual([true, true]);
});

test('PGLite, or a pool with no long-hold capacity, gets the engine itself; an error from inside the session passes through', async () => {
  const pglite = { kind: 'pglite' } as unknown as BrainEngine;
  expect(await withBoundedReadSession(pglite, async engine => engine)).toBe(pglite);
  const full = { kind: 'postgres', withReservedConnection: async () => { throw new PoolCapacityError(); } } as unknown as BrainEngine;
  expect(await withBoundedReadSession(full, async engine => engine)).toBe(full);
  const { engine } = fakePostgres();
  await expect(withBoundedReadSession(engine, async () => { throw new PoolCapacityError(); })).rejects.toBeInstanceOf(PoolCapacityError);
});

const home = mkdtempSync(join(tmpdir(), 'gbrain-bounded-session-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

test('on Postgres: one backend and one transaction per session, each statement bounded; a lock-held read ends at its bound with nothing left running', async () => {
  for (const engine of engines.filter(e => e.kind === 'postgres')) {
    await engine.executeRaw('CREATE TABLE IF NOT EXISTS bounded_session_probe(id int)');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const holder = engine.transaction(async tx => { await tx.executeRaw('LOCK TABLE bounded_session_probe IN ACCESS EXCLUSIVE MODE'); locked(); await gate; });
    await holding;
    try {
      await withBoundedReadSession(engine, async session => {
        const reads = boundedReads(session, startClaimPhase(Date.now(), undefined, 60_000));
        const probe = 'SELECT pg_backend_pid() AS pid, now()::text AS started, (SELECT setting FROM pg_settings WHERE name=\'statement_timeout\') AS bound';
        const rows = [] as Array<{ pid: number; started: string; bound: string }>;
        for (let i = 0; i < 3; i++) rows.push(...await reads.executeRaw<{ pid: number; started: string; bound: string }>(probe));
        expect(new Set(rows.map(row => String(row.pid))).size).toBe(1);
        expect(new Set(rows.map(row => row.started)).size).toBe(1);
        for (const row of rows) expect(Number.parseInt(row.bound, 10)).toBeGreaterThan(55_000);
        const t0 = Date.now();
        const [held, queued] = await Promise.allSettled([
          session.executeRaw('SELECT count(*) FROM bounded_session_probe', [], { timeoutMs: 400 }),
          session.executeRaw<{ one: number }>('SELECT 1 AS one', [], { timeoutMs: 5_000 }),
        ]);
        const elapsed = Date.now() - t0;
        expect((held as PromiseRejectedResult).reason).toMatchObject({ code: '57014' });
        expect(elapsed).toBeLessThan(400 + BOUNDED_SESSION_SLACK_MS + 1_500);
        expect(queued.status).toBe('fulfilled');
        expect(Number((queued as PromiseFulfilledResult<Array<{ one: number }>>).value[0]!.one)).toBe(1);
        const zombies = await engine.executeRaw("SELECT pid FROM pg_stat_activity WHERE query LIKE 'SELECT count(*) FROM bounded_session_probe%' AND state='active'");
        expect(zombies).toEqual([]);
        const [after] = await reads.executeRaw<{ pid: number }>(probe);
        expect(String(after!.pid)).toBe(String(rows[0]!.pid));
      });
    } finally { release(); await holder; await engine.executeRaw('DROP TABLE IF EXISTS bounded_session_probe'); }
  }
}, 60_000);

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { noPull: true, noEmbed: true, noExtract: true };

test('a full re-sync\'s waiver screens run their bounded reads on the waiver run\'s session, not one bounded transaction per read', () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const id = `brs-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `n${i}.md`), `---\ntitle: N${i}\n---\nA synthetic observation ${i}.\n`);
    git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await performManagedSync(engine, { sourceId: id, ...OPTS })).status).toBe('first_sync');
    await disposePersistenceConsumer(engine);
    let perRead = 0, sessions = 0;
    const counted = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { timeoutMs?: number }) => { if (opts?.timeoutMs !== undefined) perRead++; return target.executeRaw(sql, params, opts); };
      if (key === 'withReservedConnection') return (...args: Parameters<BrainEngine['withReservedConnection']>) => { sessions++; return target.withReservedConnection(...args); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      expect(await performManagedSync(counted, { sourceId: id, ...OPTS, full: true })).toMatchObject({ status: 'synced', modified: 0, waived: { imports: 8, deletes: 0 } });
      // Only the run's checkpoint, which the consumer prepares, reads per statement (each screen took 14 such reads before),
      // and the screens of one waiver run share its session.
      if (engine.kind === 'postgres') { expect(perRead).toBeLessThan(8 * 3); expect(sessions).toBeGreaterThanOrEqual(1); expect(sessions).toBeLessThan(8); }
      else expect(perRead).toBe(0);
    } finally { await disposePersistenceConsumer(counted); }
  }
}), 120_000);
