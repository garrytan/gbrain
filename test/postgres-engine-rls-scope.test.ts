/**
 * withScopedReadTransaction — opt-in Postgres RLS source-scope binding
 * (GBRAIN_RLS_SCOPE_BINDING, lands community PR #2387).
 *
 * Behavioral pins, no real DB (fake postgres.js sql handle):
 *  - flag OFF (default): TRUE pass-through — callback receives the shared
 *    pool handle directly, no sql.begin(), no set_config. This is the
 *    #1794-class guard: reads must not gain a per-read pool hold.
 *  - flag OFF + alwaysTransaction (the search methods' SET LOCAL path):
 *    sql.begin() opens, still no set_config — identical to master's wrap.
 *  - flag ON: sql.begin() + SELECT set_config('app.scopes', $1, true)
 *    with federated-array > scalar > '*' precedence, and the CSV value
 *    carried as a BOUND PARAMETER, never interpolated into the SQL text.
 */

import { describe, test, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withEnv } from './helpers/with-env.ts';

type Recorded = { text: string; params: unknown[] };

function makeFakeSql() {
  const queries: Recorded[] = [];
  let beginCalls = 0;
  const record = (strings: TemplateStringsArray, ...params: unknown[]) => {
    // Join the literal segments with a placeholder marker so the test can
    // assert the exact SQL text shape around each bound parameter.
    queries.push({ text: strings.join('${}'), params });
    return Promise.resolve([]);
  };
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    record(strings, ...params)) as unknown as Record<string, unknown> & {
    (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]>;
    begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const tx = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    record(strings, ...params)) as unknown as Record<string, unknown>;
  sql.begin = async (cb: (t: unknown) => Promise<unknown>) => {
    beginCalls++;
    return await cb(tx);
  };
  return { sql, tx, queries, beginCalls: () => beginCalls };
}

function makeEngine(fake: ReturnType<typeof makeFakeSql>) {
  const e = new PostgresEngine();
  (e as unknown as { _sql: unknown })._sql = fake.sql;
  (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
  // private method, invoked directly for the pin
  return e as unknown as {
    withScopedReadTransaction<T>(
      sourceIds: string[] | undefined,
      sourceId: string | undefined,
      cb: (tx: unknown) => Promise<T>,
      opts?: { alwaysTransaction?: boolean },
    ): Promise<T>;
  };
}

function setConfigQueries(queries: Recorded[]): Recorded[] {
  return queries.filter((q) => q.text.includes('set_config'));
}

describe('withScopedReadTransaction / flag off (default)', () => {
  test('true pass-through: callback gets the shared pool handle, no begin, no set_config', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: undefined }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      let received: unknown;
      const result = await engine.withScopedReadTransaction(undefined, 'src-a', async (tx) => {
        received = tx;
        return 42;
      });
      expect(result).toBe(42);
      expect(received).toBe(fake.sql); // the pool handle itself, not a tx
      expect(fake.beginCalls()).toBe(0);
      expect(setConfigQueries(fake.queries)).toHaveLength(0);
    });
  });

  test('explicit "0" is off too', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '0' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      await engine.withScopedReadTransaction(['a', 'b'], undefined, async () => null);
      expect(fake.beginCalls()).toBe(0);
      expect(setConfigQueries(fake.queries)).toHaveLength(0);
    });
  });

  test('alwaysTransaction keeps master\'s sql.begin() wrap, still no set_config', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: undefined }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      let received: unknown;
      await engine.withScopedReadTransaction(
        undefined,
        'src-a',
        async (tx) => {
          received = tx;
          return null;
        },
        { alwaysTransaction: true },
      );
      expect(fake.beginCalls()).toBe(1);
      expect(received).toBe(fake.tx); // a transaction handle this time
      expect(setConfigQueries(fake.queries)).toHaveLength(0);
    });
  });
});

describe('withScopedReadTransaction / flag on', () => {
  test('emits set_config(\'app.scopes\', ...) inside a transaction, before the callback', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      let queriesAtCallback = -1;
      await engine.withScopedReadTransaction(undefined, 'src-a', async () => {
        queriesAtCallback = fake.queries.length;
        return null;
      });
      expect(fake.beginCalls()).toBe(1);
      const sc = setConfigQueries(fake.queries);
      expect(sc).toHaveLength(1);
      expect(sc[0].params).toEqual(['src-a']);
      // set_config was emitted before the callback ran
      expect(queriesAtCallback).toBe(1);
      expect(fake.queries[0]).toBe(sc[0]);
    });
  });

  test('"true" also enables', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: 'true' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      await engine.withScopedReadTransaction(undefined, 'src-a', async () => null);
      expect(setConfigQueries(fake.queries)).toHaveLength(1);
    });
  });

  test('federated array wins over scalar: CSV of sourceIds', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      await engine.withScopedReadTransaction(['a', 'b', 'c'], 'ignored-scalar', async () => null);
      expect(setConfigQueries(fake.queries)[0].params).toEqual(['a,b,c']);
    });
  });

  test('empty federated array falls back to scalar', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      await engine.withScopedReadTransaction([], 'src-b', async () => null);
      expect(setConfigQueries(fake.queries)[0].params).toEqual(['src-b']);
    });
  });

  test("unscoped (no sourceIds, no sourceId) binds '*'", async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      await engine.withScopedReadTransaction(undefined, undefined, async () => null);
      expect(setConfigQueries(fake.queries)[0].params).toEqual(['*']);
    });
  });

  test('the scopes CSV is a BOUND PARAMETER, never interpolated into SQL text', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql();
      const engine = makeEngine(fake);
      const hostile = "x','y'); DROP TABLE pages; --";
      await engine.withScopedReadTransaction(undefined, hostile, async () => null);
      const sc = setConfigQueries(fake.queries)[0];
      // Exact literal-segment shape: the value slot is the tagged-template hole.
      expect(sc.text).toBe("SELECT set_config('app.scopes', ${}, true)");
      expect(sc.params).toEqual([hostile]);
      expect(sc.text).not.toContain(hostile);
    });
  });
});
