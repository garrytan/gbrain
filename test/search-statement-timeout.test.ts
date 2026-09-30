/**
 * The search arms' statement_timeout must be configurable (#5024).
 *
 * Four lexical search arms (keyword, titles, keyword-chunks, CJK) bound their
 * query with a transaction-scoped statement_timeout hardcoded to '8s'. That is
 * ample on a small brain and unreachable on a large one: on a 157k-page /
 * 896MB `pages` table the keyword arm cannot finish inside it, so every search
 * logs "searchKeyword arm failed (fail-open)" and silently degrades to
 * vector-only — exact-token lookups stop working at the corpus size where they
 * matter most.
 *
 * Hermetic: Object.create(PostgresEngine.prototype) + a stubbed getConfig, the
 * same shape as postgres-engine-reserved-routing.test.ts. No database.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const ENV_KEY = 'GBRAIN_SEARCH_STATEMENT_TIMEOUT_MS';

function makeEngine(configValue: string | null, opts: { throws?: boolean } = {}) {
  // Reach past `private` deliberately: intersecting PostgresEngine with the
  // private field collapses the type to `never` (TS2339), so go through unknown.
  const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
  const priv = engine as unknown as {
    searchStatementTimeout(): Promise<string>;
    _searchTimeoutCache: unknown;
    getConfig: (k: string) => Promise<string | null>;
  };
  let reads = 0;
  priv._searchTimeoutCache = null;
  priv.getConfig = async (k: string) => {
    reads++;
    if (opts.throws) throw new Error('pooler drop');
    return k === 'search.statement_timeout_ms' ? configValue : null;
  };
  return { engine: priv, reads: () => reads };
}

describe('search statement timeout is configurable', () => {
  test('defaults to the historical 8s when nothing is configured', async () => {
    const { engine } = makeEngine(null);
    expect(await engine.searchStatementTimeout()).toBe('8s');
  });

  test('honours search.statement_timeout_ms from the config plane', async () => {
    const { engine } = makeEngine('45000');
    expect(await engine.searchStatementTimeout()).toBe('45000ms');
  });

  test('env override wins over config, for an immediate unblock', async () => {
    await withEnv({ [ENV_KEY]: '30000' }, async () => {
      const { engine, reads } = makeEngine('45000');
      expect(await engine.searchStatementTimeout()).toBe('30000ms');
      // env short-circuits before the round trip
      expect(reads()).toBe(0);
    });
  });

  test('ignores a non-numeric config value rather than emitting bad SQL', async () => {
    const { engine } = makeEngine('30 seconds; DROP TABLE pages');
    expect(await engine.searchStatementTimeout()).toBe('8s');
  });

  test('rejects 0, which would disable the bound entirely', async () => {
    const { engine } = makeEngine('0');
    expect(await engine.searchStatementTimeout()).toBe('8s');
  });

  test('memoises so the hot path does not read config per query', async () => {
    const { engine, reads } = makeEngine('20000');
    await engine.searchStatementTimeout();
    await engine.searchStatementTimeout();
    await engine.searchStatementTimeout();
    expect(reads()).toBe(1);
  });

  test('a config read failure never takes search down', async () => {
    const { engine } = makeEngine(null, { throws: true });
    expect(await engine.searchStatementTimeout()).toBe('8s');
  });
});

describe('search arms apply the configured timeout', () => {
  test('searchKeywordChunks binds search.statement_timeout_ms in its transaction', async () => {
    const { engine } = makeEngine('45000');
    let insideTransaction = false;
    engine.getConfig = async () => {
      expect(insideTransaction).toBe(false); // Avoid a second pool checkout inside the read transaction.
      return '45000';
    };
    const issued: { text: string; values: unknown[] }[] = [];
    const tx = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        issued.push({ text: strings.join('$'), values });
        return [];
      },
      { unsafe: async () => [] },
    );
    (engine as unknown as { withScopedReadTransaction: unknown }).withScopedReadTransaction =
      async (_ids: unknown, _id: unknown, fn: (t: typeof tx) => Promise<unknown>) => {
        insideTransaction = true;
        try { return await fn(tx); } finally { insideTransaction = false; }
      };
    await (engine as unknown as PostgresEngine).searchKeywordChunks('hello');
    expect(issued).toEqual([{ text: "SELECT set_config('statement_timeout', $, true)", values: ['45000ms'] }]);
  });
});
