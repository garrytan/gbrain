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
 *    At the top level that one statement is all (the setting ends with the
 *    transaction); inside a caller's transaction the caller's scope is read
 *    first and restored after (postgres-engine/search-settings.ts).
 */

import { describe, test, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withEnv } from './helpers/with-env.ts';

type Recorded = { text: string; params: unknown[]; lane: 'pool' | 'transaction' };

function makeFakeSql() {
  const queries: Recorded[] = [];
  let beginCalls = 0; let savepointCalls = 0; let scopes = 'outside';
  // Tagged templates join their literal segments with a placeholder marker
  // so the test can assert the exact SQL text around each bound parameter;
  // `unsafe` statements keep their $n text.
  const record = (lane: Recorded['lane'], text: string, params: unknown[]) => {
    queries.push({ text, params, lane });
    if (text.includes("current_setting('app.scopes'")) return Promise.resolve([{ 'app.scopes': scopes }]);
    const bound = /set_config\('app\.scopes', \$(\d+)/.exec(text);
    if (bound) scopes = String(params[Number(bound[1]) - 1]);
    return Promise.resolve([]);
  };
  const handle = (lane: Recorded['lane']) => Object.assign(
    (strings: TemplateStringsArray, ...params: unknown[]) => record(lane, strings.join('${}'), params),
    { unsafe: (text: string, params: unknown[] = []) => record(lane, text, params) },
  );
  const sql = handle('pool') as unknown as Record<string, unknown> & {
    (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]>;
    begin: (first: unknown, second?: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const tx = handle('transaction') as unknown as Record<string, unknown>;
  tx.savepoint = async (cb: (tx: unknown) => Promise<unknown>) => {
    savepointCalls++; const prior = scopes;
    try { return await cb(tx); } catch (error) { scopes = prior; throw error; }
  };
  // The pool's begin also takes options first (GBRA-156: `{ early }` on search reads).
  sql.begin = async (first: unknown, second?: (t: unknown) => Promise<unknown>) => {
    const cb = (second ?? first) as (t: unknown) => Promise<unknown>;
    beginCalls++;
    const prior = scopes;
    try { return await cb(tx); } finally { scopes = prior; }
  };
  return { sql, tx, queries, beginCalls: () => beginCalls, savepointCalls: () => savepointCalls, scopes: () => scopes };
}

interface ScopedEngine {
  transaction<T>(fn: (tx: ScopedEngine) => Promise<T>): Promise<T>;
  withScopedReadTransaction<T>(sourceIds: string[] | undefined, sourceId: string | undefined,
    cb: (tx: unknown) => Promise<T>, opts?: { alwaysTransaction?: boolean }): Promise<T>;
}
function makeEngine(fake: ReturnType<typeof makeFakeSql>, inTransaction = false): ScopedEngine {
  const e = new PostgresEngine();
  (e as unknown as { _sql: unknown })._sql = fake.sql;
  (e as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
  // An engine over a transaction handle is a page transaction, as transaction() builds it.
  if (inTransaction) Object.defineProperty(e, '_pageTransaction', { value: true });
  // private method, invoked directly for the pin
  return e as unknown as ScopedEngine;
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
          await (tx as typeof fake.sql)`SELECT callback_connection`;
          return null;
        },
        { alwaysTransaction: true },
      );
      expect(fake.beginCalls()).toBe(1);
      expect(typeof received).toBe('function');
      expect(fake.queries.at(-1)?.lane).toBe('transaction');
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
      // Top level: one settings statement, nothing read first or restored after.
      expect(sc).toHaveLength(1);
      expect(sc[0].params).toEqual(['src-a']);
      expect(fake.queries).toHaveLength(1);
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
      expect(sc.text).toBe("SELECT set_config('app.scopes', $1, true)");
      expect(sc.params).toEqual([hostile]);
      expect(sc.text).not.toContain(hostile);
    });
  });

  test('nested scoped reads use savepoints and restore the caller scope', async () => {
    await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
      const fake = makeFakeSql(); const engine = makeEngine(fake);
      await engine.transaction(async outer => {
        await outer.withScopedReadTransaction(undefined, 'parent', async tx => {
          // Nested work uses the scoped handle, never its waiting parent.
          const nested = makeEngine({ ...fake, sql: tx as typeof fake.sql }, true);
          expect(fake.scopes()).toBe('parent');
          await nested.withScopedReadTransaction(undefined, 'child', async () => { expect(fake.scopes()).toBe('child'); });
          expect(fake.scopes()).toBe('parent');
          await expect(nested.withScopedReadTransaction(undefined, 'failing-child', async () => { throw new Error('read sentinel'); }))
            .rejects.toThrow('read sentinel');
          expect(fake.scopes()).toBe('parent');
        });
        expect(fake.scopes()).toBe('outside');
      });
      expect(fake.beginCalls()).toBe(1); expect(fake.savepointCalls()).toBe(3);
      expect(fake.queries.every(query => query.lane === 'transaction')).toBe(true);
      // Each savepoint reads the caller's scope, sets its own, and restores the caller's on success.
      expect(fake.queries.map(query => query.text.startsWith('SELECT current_setting') ? 'read' : query.params[0])).toEqual(
        ['read', 'parent', 'read', 'child', 'parent', 'read', 'failing-child', 'outside']);
    });
  });
});
