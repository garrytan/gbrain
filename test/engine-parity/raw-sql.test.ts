/**
 * BrainEngine parity — raw_sql family (runMigration, executeRaw,
 * executeRawDirect, keywordBoundedRead).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the raw-SQL entry points answer the same rows on every SQL
 *    arm (PGLite always; Postgres with DATABASE_URL), see the writes the
 *    typed methods made, and keep their transaction and parameter contract.
 *    Every case declares `requires: 'raw_sql'`, so a Rust arm must refuse
 *    each call with `engine_capability_missing` reason `raw_sql` (D18) and
 *    is never compared on rows (test/engine-parity/arm-capabilities.ts).
 *  - Regression: an engine whose raw read misses a committed typed write,
 *    binds parameters differently, returns numbers as strings, runs a
 *    migration's statements partly, or leaks keywordBoundedRead's read
 *    transaction; the minion queue, migrations and doctor read through these.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts calls
 *    executeRaw only on Postgres, as a fixture, and never compares arms.
 *  - Seam: none. Real engines. Raw SQL is the method under test here, the one
 *    family where a case may call it.
 */
import { describe, expect, test } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { entityLookupFault, FAULT_MESSAGE } from '../helpers/entity-lookup-fault.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { IGNORED_WRITE_MEMBERS, memberKind } from '../../src/shadow/write-map.ts';
import { withReadDeadline } from '../../src/core/read-deadline.ts';

const { parityTest, arms } = parityArms(testBackends());

const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

describe('engine parity: raw_sql', () => {
  parityTest(
    'executeRaw binds parameters, returns typed rows and sees the typed writes',
    { methods: ['putPage', 'executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/raw-a', PAGE('Raw A', 'first'));
      await engine.putPage('notes/raw-b', PAGE('Raw B', 'second'));
      const scalar = await engine.executeRaw<{ n: number; s: string; nothing: null }>(
        'SELECT $1::int + 1 AS n, $2::text AS s, NULL AS nothing', [41, 'text'],
      );
      expect(scalar).toEqual([{ n: 42, s: 'text', nothing: null }]);
      const pages = await engine.executeRaw<{ slug: string; title: string }>(
        `SELECT slug, title FROM pages WHERE slug LIKE $1 AND deleted_at IS NULL ORDER BY slug`, ['notes/raw-%'],
      );
      const none = await engine.executeRaw('SELECT slug FROM pages WHERE slug = $1', ['notes/nobody']);
      return { scalar, pages, none };
    },
  );

  parityTest(
    'executeRawDirect answers like executeRaw and joins an open transaction',
    { methods: ['putPage', 'executeRawDirect', 'transaction'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/direct', PAGE('Direct', 'body'));
      const direct = await engine.executeRawDirect<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/direct']);
      // Inside a transaction the tx handle's direct read sees the tx's own uncommitted write.
      const inTx = await engine.transaction(async (tx) => {
        await tx.putPage('notes/direct-tx', PAGE('Direct tx', 'body'));
        return tx.executeRawDirect<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/direct-tx']);
      });
      expect([direct, inTx]).toEqual([[{ slug: 'notes/direct' }], [{ slug: 'notes/direct-tx' }]]);
      return { direct, inTx };
    },
  );

  parityTest(
    'runMigration runs every statement of a multi-statement script',
    { methods: ['runMigration', 'executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      await engine.runMigration(9_000_001, `
        CREATE TABLE IF NOT EXISTS parity_raw_probe (id int PRIMARY KEY, label text NOT NULL);
        INSERT INTO parity_raw_probe (id, label) VALUES (1, 'one'), (2, 'two');
      `);
      const rows = await engine.executeRaw<{ id: number; label: string }>('SELECT id, label FROM parity_raw_probe ORDER BY id');
      await engine.runMigration(9_000_002, 'DROP TABLE parity_raw_probe;');
      const gone = await engine.executeRaw<{ present: boolean }>(`SELECT to_regclass('parity_raw_probe') IS NOT NULL AS present`);
      expect([rows, gone]).toEqual([[{ id: 1, label: 'one' }, { id: 2, label: 'two' }], [{ present: false }]]);
      return { rows, gone };
    },
  );

  parityTest(
    'keywordBoundedRead runs the read and returns its value; a throw propagates and the engine stays usable',
    { methods: ['putPage', 'keywordBoundedRead', 'getPage'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/bounded', PAGE('Bounded', 'body'));
      const read = await engine.keywordBoundedRead((db) =>
        db.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['notes/bounded']));
      const thrown = await engine.keywordBoundedRead(async () => { throw new Error('read refused'); })
        .then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
      const after = (await engine.getPage('notes/bounded'))?.title ?? null;
      expect([read, thrown, after]).toEqual([[{ slug: 'notes/bounded' }], 'read refused', 'Bounded']);
      return { read, thrown, after };
    },
  );

  // The `entity` card finds its page with a raw read over `pages` (src/core/verbs/entity-card.ts, arm 2). A read that
  // fails is never a miss: on the SQL arms the card is marked `entity_lookup_failed` (the injected failure stands in
  // for a timeout or a permission error). The Rust engine serves no raw SQL, so there the real lookup read refuses and the
  // card ends on the typed `raw_sql` refusal (before: it swallowed the refusal and answered found:false on every Rust
  // brain). Known stop: the Rust store owns a typed page-row lookup (exact title / slug / slug-suffix with the card's
  // columns) in its pages store member family (rust/crates/gbrain-store, store-members/pages.ts); until it lands the
  // card cannot run there.
  parityTest(
    'entity: a failed page lookup read is marked degraded, never found:false alone (Rust: typed raw_sql refusal)',
    { methods: ['putPage', 'executeRaw'], requires: 'raw_sql' },
    async (engine, backend) => {
      await engine.putPage('people/alice-example', PAGE('Alice Example', 'Alice Example runs operations at Acme Example.'));
      const card = (e: typeof engine) => buildEntityCard(e, 'default', 'people/alice-example', { remote: false, variants: false });
      const failing = await card(backend === 'rust' ? engine : entityLookupFault(engine, { arm2: () => new Error(FAULT_MESSAGE) }));
      const healthy = await card(engine);
      const present = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE slug = $1', ['people/alice-example']);
      const observed = {
        failing: { found: failing.found, degraded: failing.degraded ?? null },
        healthy: { found: healthy.found, degraded: healthy.degraded ?? null, slug: healthy.card?.entity.slug ?? null },
        pagePresent: present.length === 1,
      };
      expect(observed).toEqual({
        failing: { found: false, degraded: [{ stage: 'entity_lookup_failed', reason: 'provider_error' }] },
        healthy: { found: true, degraded: null, slug: 'people/alice-example' },
        pagePresent: true,
      });
      return observed;
    },
  );
});

/**
 * Postgres arm only: a write never travels a read route. PostgresEngine's typed reads run through preparationRead,
 * engineSqlRead and ownRawRead and the abort-aware read getters (writeMiscReads, cliReads); under a read deadline those
 * open BEGIN READ ONLY, so a write routed through one passes every case without a deadline and fails in production under
 * one. (1) No write member (WRITE_MAP, UNMAPPED_WRITE_MEMBERS, IGNORED_WRITE_MEMBERS) enters a read route other than as
 * a locking read (`unbounded`). (2) Every read route refuses a write statement on each of its executor's entry points,
 * with and without a read deadline, before it is sent, and still answers a read.
 */
const READ_ROUTES = ['preparationRead', 'engineSqlRead', 'ownRawRead'] as const;
const postgresTest = testBackends().includes('postgres') ? test : test.skip;
describe('engine parity: raw_sql (Postgres read routes)', () => {
  postgresTest('no write member runs on a read route, and every read route refuses a write statement', async () => {
    // (1) Each write member is entered with every read route replaced by a recorder; a route entry stops the call before SQL.
    type Probe = Record<string, unknown> & { _pageTransaction: unknown; transaction: unknown };
    const probe = new PostgresEngine() as unknown as Probe;
    let entered: string | null = null;
    for (const route of READ_ROUTES) {
      probe[route] = (_fn: unknown, unbounded?: boolean) => { entered ??= unbounded ? `${route}(unbounded)` : route; return Promise.reject(new Error('read route entered')); };
    }
    probe.transaction = (run: (tx: unknown) => unknown) => {
      const tx = Object.create(probe) as Probe;
      tx._pageTransaction = {};
      tx.transaction = (inner: (t: unknown) => unknown) => inner(tx);
      return run(tx);
    };
    const members = new Set<string>();
    for (let proto = Object.getPrototypeOf(probe); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function') members.add(name);
      }
    }
    const isWrite = (name: string) => ['mapped', 'unmapped'].includes(memberKind(name)) || IGNORED_WRITE_MEMBERS.has(name);
    const enteredBy = async (name: string) => {
      entered = null;
      try {
        const result = (probe[name] as (...a: unknown[]) => unknown)('example', 'example', 'example', 'example');
        if (result instanceof Promise) await Promise.race([result.catch(() => undefined), Bun.sleep(5)]);
      } catch { /* an argument the member rejects before any route */ }
      return entered as string | null;
    };
    // The engine's private route helpers are routes themselves, not members.
    const ROUTE_HELPERS = new Set<string>([...READ_ROUTES, 'decideRead', 'engineRead', 'timelineBoundedRead', 'writeMiscRead', 'jitOffRead', 'configRead']);
    const writes = [...members].filter(name => !ROUTE_HELPERS.has(name) && isWrite(name)).sort();
    expect(writes.length).toBeGreaterThan(100);
    const onReadRoute: string[] = [];
    for (const name of writes) {
      const route = await enteredBy(name);
      if (route && !route.endsWith('(unbounded)')) onReadRoute.push(`${name} -> ${route}`);
    }
    // The recorder sees a read member enter its route (the scan is not blind).
    expect(await enteredBy('getSource')).toBe('preparationRead');
    expect(onReadRoute).toEqual([]);

    // (2) On the open Postgres arm: each route, each entry point, with and without a read deadline.
    const arm = arms().find(a => a.backend === 'postgres');
    expect(arm).toBeDefined();
    const engine = arm!.engine as unknown as Record<string, unknown>;
    type Exec = { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown>; query?: (sql: string, params?: unknown[]) => Promise<unknown>;
      unsafe?: (sql: string, params: unknown[]) => Promise<unknown>; transaction?: (fn: (tx: Exec) => Promise<unknown>) => Promise<unknown> };
    const WRITE = "UPDATE config SET value=value WHERE key='parity.read-route.none'";
    const CTE_WRITE = "WITH gone AS (DELETE FROM config WHERE key='parity.read-route.none' RETURNING key) SELECT count(*) FROM gone";
    const routes: Array<[string, <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>]> = [
      ...READ_ROUTES.map(route => [route, <T>(fn: (exec: Exec) => Promise<T>) => (engine[route] as (f: typeof fn) => Promise<T>).call(engine, fn)] as [string, <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>]),
      ...(['writeMiscReads', 'cliReads'] as const).map(getter => [getter, <T>(fn: (exec: Exec) => Promise<T>) => fn(engine[getter] as Exec)] as [string, <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>]),
    ];
    const outcome = (run: () => Promise<unknown>) => run().then(() => 'sent', (error: { code?: unknown }) => error?.code === 'read_route_write' ? 'refused' : `failed:${String(error?.code ?? error)}`);
    const observed: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const deadline of [false, true]) {
      const under = <T>(fn: () => Promise<T>) => deadline ? withReadDeadline(Date.now() + 30_000, fn) : fn();
      for (const [name, route] of routes) {
        const label = `${name}${deadline ? ' (read deadline)' : ''}`;
        const entries: Record<string, (exec: Exec) => Promise<unknown>> = {
          executeRaw: exec => exec.executeRaw(WRITE),
          'executeRaw CTE': exec => exec.executeRaw(CTE_WRITE),
          ...(name === 'ownRawRead' ? {} : {
            query: (exec: Exec) => exec.query!(WRITE),
            unsafe: (exec: Exec) => exec.unsafe!(WRITE, []),
            // Under a deadline the route's executor is already inside its READ ONLY transaction and has no nested transaction().
            ...(deadline ? {} : { 'transaction executeRaw': (exec: Exec) => exec.transaction!(tx => tx.executeRaw(WRITE)) }),
          }),
        };
        for (const [entry, send] of Object.entries(entries)) {
          observed[`${label} ${entry}`] = await outcome(() => under(() => route(send)));
          expected[`${label} ${entry}`] = 'refused';
        }
        observed[`${label} read`] = await outcome(() => under(() => route(exec => exec.executeRaw('SELECT 1 AS one'))));
        expected[`${label} read`] = 'sent';
      }
    }
    expect(observed).toEqual(expected);
  }, 60_000);
});

