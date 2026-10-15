/**
 * #6721: a Postgres search transaction applies every setting it needs in one
 * statement. Each separate settings statement (`SET LOCAL jit = off`, the
 * `statement_timeout` set_config, the relaxed arms' `SHOW enable_seqscan` /
 * set / restore, the vector settings' read / set / restore) was a round trip
 * in series with the query, about 30 ms each to a remote pooler.
 *
 * Contract: at the top level a search transaction sends one settings
 * statement and then its query (nothing read first, nothing restored after:
 * the settings end with the transaction); inside a caller's transaction it
 * reads the caller's values, sets its own and restores the caller's; the
 * vendored driver reads the `statement_timeout` it binds (#6543); a setting
 * name is never spliced from outside the code. Regression that fails it on
 * master: the strict keyword attempt sends three statements in its
 * transaction and the relaxed one six.
 *
 * Unit test over a recording postgres.js handle; the Postgres behavior
 * (settings in effect for the query, caller values restored) is pinned by
 * test/e2e/search-query-contract-postgres.test.ts and
 * test/e2e/jit-off-reads-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { searchSettingsStatement, withSearchSettings } from '../src/core/postgres-engine/search-settings.ts';
import { vectorScanSettings } from '../src/core/search/vector-settings.ts';

const { default: Connection } = await import(new URL('../vendor/postgres/src/connection.js', import.meta.url).href) as {
  default: { statementTimeoutChanges: (text: string, parameters?: unknown[]) => Array<{ kind: string; local?: boolean; ms?: number }> };
};

type Statement = { sql: string; params: unknown[] };

/** A transaction handle that records `unsafe` statements and answers a current_setting read with `current`. */
function recordingTx(current: Record<string, string | null> = {}) {
  const statements: Statement[] = [];
  const unsafe = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    return sql.startsWith('SELECT current_setting') ? [current] : [];
  };
  return { tx: { unsafe } as never, statements };
}

describe('withSearchSettings', () => {
  test('top level: one statement, every value bound, nothing read or restored', async () => {
    const { tx, statements } = recordingTx();
    const result = await withSearchSettings(tx, false, { jit: 'off', statement_timeout: '8000ms', enable_seqscan: 'off' }, async () => 'rows');
    expect(result).toBe('rows');
    expect(statements).toEqual([{
      sql: "SELECT set_config('jit', $1, true), set_config('statement_timeout', $2, true), set_config('enable_seqscan', $3, true)",
      params: ['off', '8000ms', 'off'],
    }]);
    // The driver budgets the next statement by the timeout this one binds (#6543).
    expect(Connection.statementTimeoutChanges(statements[0]!.sql, statements[0]!.params)).toEqual([{ kind: 'set', local: true, ms: 8000 }]);
  });

  test("nested: reads the caller's values, sets its own, restores the caller's (fallback for an unloaded extension setting)", async () => {
    const { tx, statements } = recordingTx({ jit: 'on', 'hnsw.ef_search': null });
    let during = -1;
    await withSearchSettings(tx, true, { jit: 'off', 'hnsw.ef_search': '120' }, async () => { during = statements.length; }, { 'hnsw.ef_search': '40' });
    expect(during).toBe(2);
    expect(statements).toEqual([
      { sql: `SELECT current_setting('jit', true) AS "jit", current_setting('hnsw.ef_search', true) AS "hnsw.ef_search"`, params: [] },
      { sql: "SELECT set_config('jit', $1, true), set_config('hnsw.ef_search', $2, true)", params: ['off', '120'] },
      { sql: "SELECT set_config('jit', $1, true), set_config('hnsw.ef_search', $2, true)", params: ['on', '40'] },
    ]);
  });

  test('a failed read propagates its own error and sends no restore (the savepoint rollback reverts the settings)', async () => {
    const { tx, statements } = recordingTx({ jit: 'on' });
    await expect(withSearchSettings(tx, true, { jit: 'off' }, async () => { throw new Error('read sentinel'); })).rejects.toThrow('read sentinel');
    expect(statements.map(s => s.sql.slice(0, 22))).toEqual(['SELECT current_setting', 'SELECT set_config(\'jit']);
  });

  test('no settings: no statement', async () => {
    const { tx, statements } = recordingTx();
    expect(await withSearchSettings(tx, true, {}, async () => 1)).toBe(1);
    expect(statements).toEqual([]);
  });

  test('a setting name outside [a-z0-9_.] is refused before anything is sent', async () => {
    const { tx, statements } = recordingTx();
    await expect(withSearchSettings(tx, false, { "jit', 'on', true); DROP TABLE pages; --": 'off' }, async () => 1)).rejects.toThrow('search setting name not allowed');
    expect(() => searchSettingsStatement({ 'Upper.Case': 'x' })).toThrow('search setting name not allowed');
    expect(statements).toEqual([]);
  });

  test('the vector scan settings carry the attempt deadline as a timeout the driver reads', () => {
    const settings = vectorScanSettings(true, 100, 20_000, performance.now() + 5_000);
    const { sql, params } = searchSettingsStatement({ jit: 'off', ...settings });
    const [change] = Connection.statementTimeoutChanges(sql, params);
    expect(change).toMatchObject({ kind: 'set', local: true });
    expect(change!.ms).toBeGreaterThan(4_000);
    expect(change!.ms).toBeLessThanOrEqual(5_000);
  });
});

describe('PostgresEngine.searchKeyword: statements per search transaction', () => {
  /** An engine over a fake pool whose transactions record their statements; every query returns no rows. */
  function recordingEngine() {
    const transactions: Statement[][] = [];
    const handle = (into: () => Statement[]) => Object.assign(
      async (strings: TemplateStringsArray, ...params: unknown[]) => { into().push({ sql: strings.join('$'), params }); return []; },
      { unsafe: async (sql: string, params: unknown[] = []) => { into().push({ sql, params }); return []; } },
    );
    const pool: Statement[] = [];
    const sql = Object.assign(handle(() => pool), {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        const statements: Statement[] = [];
        transactions.push(statements);
        return fn(Object.assign(handle(() => statements), { savepoint: (inner: (tx: unknown) => Promise<unknown>) => inner(handle(() => statements)) }));
      },
    });
    const engine = new PostgresEngine();
    const priv = engine as unknown as { _sql: unknown; _connectionStyle: string; _savedConfig: unknown; registerBeforeDisconnect: () => () => void };
    priv._sql = sql;
    priv._connectionStyle = 'instance';
    priv._savedConfig = { keyword_statement_timeout_ms: 8000 };
    priv.registerBeforeDisconnect = () => () => {};
    return { engine, transactions };
  }

  test('strict attempt: settings then query; OR fallback: the same two, with enable_seqscan off in the one settings statement', async () => {
    const { engine, transactions } = recordingEngine();
    expect(await engine.searchKeyword('alpha beta', { orFallback: true })).toEqual([]);
    expect(transactions).toHaveLength(2);
    const [strict, relaxed] = transactions.map(statements => statements.map(s => s.sql.trim().split('\n')[0]!.slice(0, 60)));
    expect(strict).toEqual(["SELECT set_config('jit', $1, true), set_config('statement_ti", 'WITH ranked_chunks AS (']);
    expect(relaxed).toEqual(["SELECT set_config('jit', $1, true), set_config('statement_ti", 'WITH ranked_chunks AS (']);
    expect(transactions[0]![0]!.params).toEqual(['off', '8000ms']);
    expect(transactions[1]![0]!.sql).toBe("SELECT set_config('jit', $1, true), set_config('statement_timeout', $2, true), set_config('enable_seqscan', $3, true)");
    expect(transactions[1]![0]!.params).toEqual(['off', '8000ms', 'off']);
  });
});
