/**
 * #6495: the Postgres engine's keyword, keyword-count, keyword-page, title,
 * chunk-keyword and CJK search statements all run under one transaction-local
 * `statement_timeout`, and that bound comes from the operator knob
 * `search.keyword_statement_timeout_ms` (default 8000 ms, range 1000..60000,
 * file plane over DB plane, resolved once per connection, never from the
 * request) instead of six `'8s'` literals.
 *
 * Contract protected: a value the operator set is the value every one of the
 * six sites binds; a stored value outside the range reads as the default;
 * `countKeywordPages` keeps a narrower caller `timeoutMs`; PGLite sets no
 * statement timeout at all. Regression that fails it: a site that keeps a
 * literal, reads the request, or ignores the range. Existing coverage runs
 * these statements but never looks at the timeout they set.
 *
 * Unit arm: the real engine methods over a recording transaction handle (no
 * database); the knob is primed the way `connect()` primes it, from a stubbed
 * config read. Postgres arm (DATABASE_URL): a session holding an ACCESS
 * EXCLUSIVE lock on the searched tables makes each statement wait, and the
 * knob, not the old 8 s, decides when Postgres cancels it (SQLSTATE 57014).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import postgres from '#postgres';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS,
  KEYWORD_STATEMENT_TIMEOUT_KEY,
  KEYWORD_STATEMENT_TIMEOUT_MAX_MS,
  KEYWORD_STATEMENT_TIMEOUT_MIN_MS,
  keywordStatementTimeoutValueProblem,
  resolveKeywordStatementTimeoutMs,
} from '../src/core/postgres-engine/keyword-statement-timeout.ts';
import { searchSettingsStatement, type SearchSettings } from '../src/core/postgres-engine/search-settings.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const { default: Connection } = await import(new URL('../vendor/postgres/src/connection.js', import.meta.url).href) as {
  default: { statementTimeoutChanges: (text: string, parameters?: unknown[]) => Array<{ kind: string; ms?: number }> };
};

interface Recorded { sql: string; params: unknown[] }

/** The six engine entry points that bind the keyword statement timeout. */
const SITES: Record<string, (engine: PostgresEngine, countTimeoutMs?: number) => Promise<unknown>> = {
  searchKeyword: engine => engine.searchKeyword('alpha beta'),
  countKeywordPages: (engine, timeoutMs) => engine.countKeywordPages('alpha', timeoutMs === undefined ? undefined : { timeoutMs }),
  searchKeywordPages: engine => engine.searchKeywordPages('alpha', undefined, { limit: 10, offset: 0 }),
  searchTitles: engine => engine.searchTitles('alpha'),
  searchKeywordChunks: engine => engine.searchKeywordChunks('alpha'),
  searchKeywordCJK: engine => engine.searchKeyword('日本語'),
};

/** A PostgresEngine whose scoped read transactions run over a recording handle; config comes from the stubs. */
async function recordingEngine(opts: { dbValue?: string | null; fileValue?: unknown; connected?: boolean }): Promise<{ engine: PostgresEngine; recorded: Recorded[]; configReads: () => number }> {
  const engine = new PostgresEngine();
  const recorded: Recorded[] = [];
  const rows = (sql: string): unknown[] => (/SHOW enable_seqscan/i.test(sql) ? [{ enable_seqscan: 'on' }] : Object.assign([], { count: 0 }));
  const tx = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('$');
      recorded.push({ sql, params: values });
      return rows(sql);
    },
    { unsafe: async (sql: string, params?: unknown[]) => { recorded.push({ sql, params: params ?? [] }); return rows(sql); } },
  );
  const priv = engine as unknown as {
    withScopedReadTransaction: (ids: unknown, id: unknown, cb: (tx: unknown) => Promise<unknown>, opts?: { settings?: SearchSettings | (() => SearchSettings) }) => Promise<unknown>;
    getConfig: (key: string) => Promise<string | null>;
    executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    _savedConfig: { keyword_statement_timeout_ms?: unknown } | undefined;
    _pageTransaction: boolean;
  };
  let configReads = 0;
  // The transaction's one settings statement, as withScopedReadTransaction sends it (postgres-engine/search-settings.ts).
  priv.withScopedReadTransaction = async (_ids, _id, cb, txOpts) => {
    const settings = typeof txOpts?.settings === 'function' ? txOpts.settings() : txOpts?.settings;
    if (settings) { const set = searchSettingsStatement(settings); await tx.unsafe(set.sql, set.params); }
    return cb(tx);
  };
  priv.getConfig = async key => { configReads++; return key === KEYWORD_STATEMENT_TIMEOUT_KEY ? opts.dbValue ?? null : null; };
  priv.executeRaw = async (sql, params) => {
    if (opts.connected === false) throw new Error('No database connection');
    recorded.push({ sql, params: params ?? [] });
    if (!sql.includes(KEYWORD_STATEMENT_TIMEOUT_KEY)) return [];
    configReads++;
    return opts.dbValue == null ? [] : [{ value: opts.dbValue }];
  };
  priv._savedConfig = opts.connected === false ? undefined : { keyword_statement_timeout_ms: opts.fileValue };
  priv._pageTransaction = true;
  return { engine, recorded, configReads: () => configReads };
}

/** Every statement timeout a recording set, as the vendored driver reads it from the statement it sends (#6543). */
function timeoutsSet(recorded: Recorded[]): string[] {
  return recorded.flatMap(({ sql, params }) => Connection.statementTimeoutChanges(sql, params)
    .map(change => (change.kind === 'set' ? `${change.ms}ms` : `unreadable ${change.kind}`)));
}

async function timeoutFor(site: string, opts: { dbValue?: string | null; fileValue?: unknown }, countTimeoutMs?: number): Promise<string[]> {
  const { engine, recorded } = await recordingEngine(opts);
  await SITES[site](engine, countTimeoutMs);
  return timeoutsSet(recorded);
}

describe('search.keyword_statement_timeout_ms: the resolver', () => {
  test('default, range and precedence', () => {
    expect(resolveKeywordStatementTimeoutMs(undefined, undefined)).toBe(KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS);
    expect(KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS).toBe(8000);
    expect([KEYWORD_STATEMENT_TIMEOUT_MIN_MS, KEYWORD_STATEMENT_TIMEOUT_MAX_MS]).toEqual([1000, 60_000]);
    expect(resolveKeywordStatementTimeoutMs(undefined, '2500')).toBe(2500);
    expect(resolveKeywordStatementTimeoutMs(3000, '2500')).toBe(3000);
    for (const outside of ['999', '60001', '0', '-5', '2500.5', 'abc', '']) {
      expect(resolveKeywordStatementTimeoutMs(undefined, outside), outside).toBe(KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS);
      expect(resolveKeywordStatementTimeoutMs(outside, '2500'), `file ${outside}`).toBe(2500);
    }
    expect(resolveKeywordStatementTimeoutMs(undefined, '1000')).toBe(1000);
    expect(resolveKeywordStatementTimeoutMs(undefined, '60000')).toBe(60_000);
  });

  test('config set refuses a value outside the range and accepts the bounds', () => {
    expect(keywordStatementTimeoutValueProblem('8000')).toBeNull();
    expect(keywordStatementTimeoutValueProblem('1000')).toBeNull();
    expect(keywordStatementTimeoutValueProblem('60000')).toBeNull();
    for (const bad of ['999', '60001', '8s', '2500.5', '']) {
      expect(keywordStatementTimeoutValueProblem(bad)).toBe(
        `${KEYWORD_STATEMENT_TIMEOUT_KEY} must be an integer number of milliseconds from 1000 to 60000 (got '${bad}'). Nothing was written.`);
    }
  });
});

describe('gbrain config set search.keyword_statement_timeout_ms', () => {
  async function configSet(value: string): Promise<{ errs: string; exit: number | null; written: Array<[string, string]> }> {
    const written: Array<[string, string]> = [];
    const engine = {
      getConfig: async () => null,
      setConfig: async (key: string, v: string) => { written.push([key, v]); },
      unsetConfig: async () => 1,
    } as unknown as BrainEngine;
    const errs: string[] = [];
    let exit: number | null = null;
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errs.push(String(chunk)); return true; }) as never);
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
    try {
      await runConfig(engine, ['set', KEYWORD_STATEMENT_TIMEOUT_KEY, value]);
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore(); writeSpy.mockRestore(); exitSpy.mockRestore();
    }
    return { errs: errs.join('\n'), exit, written };
  }

  test('a value outside 1000..60000 is refused with exit 2 and nothing is written', async () => {
    for (const bad of ['500', '60001', '8s']) {
      const { errs, exit, written } = await configSet(bad);
      expect(exit, bad).toBe(2);
      expect(written, bad).toEqual([]);
      expect(errs).toContain(`Error [invalid_params]: ${KEYWORD_STATEMENT_TIMEOUT_KEY} must be an integer number of milliseconds from 1000 to 60000 (got '${bad}'). Nothing was written.`);
      expect(errs).toContain(`Fix: gbrain config get ${KEYWORD_STATEMENT_TIMEOUT_KEY}`);
      expect(errs).toContain('Why: The Postgres engine reads the keyword statement timeout once per connection');
    }
  });

  test('a value in range is written', async () => {
    const { exit, written } = await configSet('15000');
    expect(exit).toBeNull();
    expect(written).toEqual([[KEYWORD_STATEMENT_TIMEOUT_KEY, '15000']]);
  });
});

describe('search.keyword_statement_timeout_ms governs all six Postgres keyword sites (recording handle)', () => {
  for (const site of Object.keys(SITES)) {
    test(`${site}: default 8000ms, the DB plane's value, the file plane over the DB plane, out-of-range reads as the default`, async () => {
      expect(await timeoutFor(site, { dbValue: '2500' })).toEqual(['2500ms']);
      expect(await timeoutFor(site, {})).toEqual(['8000ms']);
      expect(await timeoutFor(site, { dbValue: '2500', fileValue: 3000 })).toEqual(['3000ms']);
      expect(await timeoutFor(site, { dbValue: '500' })).toEqual(['8000ms']);
      expect(await timeoutFor(site, { dbValue: '70000' })).toEqual(['8000ms']);
      expect(await timeoutFor(site, { dbValue: '60000', fileValue: 999 })).toEqual(['60000ms']);
    });
  }

  test('every site issues no statement before its bound but the knob read (the manifest-grant probe runs inside the bounded transaction)', async () => {
    for (const site of Object.keys(SITES)) {
      const { engine, recorded } = await recordingEngine({ dbValue: '2500' });
      await SITES[site](engine);
      const boundAt = recorded.findIndex(({ sql, params }) => Connection.statementTimeoutChanges(sql, params).length > 0);
      expect(boundAt, site).toBeGreaterThanOrEqual(0);
      expect(recorded.slice(0, boundAt).filter(r => !r.sql.includes(KEYWORD_STATEMENT_TIMEOUT_KEY)).map(r => r.sql), site).toEqual([]);
    }
  });

  test('countKeywordPages keeps a narrower caller timeoutMs under the knob', async () => {
    expect(await timeoutFor('countKeywordPages', { dbValue: '5000' }, 1500)).toEqual(['1500ms']);
    expect(await timeoutFor('countKeywordPages', {}, 2000)).toEqual(['2000ms']);
  });

  test('the knob is resolved once per connection by the first keyword statement, never per request; connect issues no statement for it', async () => {
    const { engine, recorded, configReads } = await recordingEngine({ dbValue: '2500' });
    expect(recorded).toEqual([]);
    expect(configReads()).toBe(0);
    await SITES.searchKeyword(engine);
    expect(configReads()).toBe(1);
    await SITES.searchTitles(engine);
    await SITES.searchKeywordChunks(engine);
    expect(timeoutsSet(recorded)).toEqual(['2500ms', '2500ms', '2500ms']);
    expect(configReads()).toBe(1);
    const fileWins = await recordingEngine({ dbValue: '2500', fileValue: 3000 });
    await SITES.searchKeyword(fileWins.engine);
    expect(timeoutsSet(fileWins.recorded)).toEqual(['3000ms']);
    expect(fileWins.configReads()).toBe(0);
  });

  test('the DB-plane read binds no parameter, so it never describes a statement into the pg-types cache', async () => {
    const { engine, recorded } = await recordingEngine({ dbValue: '2500' });
    await SITES.searchKeyword(engine);
    const reads = recorded.filter(r => r.sql.includes(KEYWORD_STATEMENT_TIMEOUT_KEY));
    expect(reads.length).toBe(1);
    expect(reads[0].params).toEqual([]);
    expect(reads[0].sql).toContain(`'${KEYWORD_STATEMENT_TIMEOUT_KEY}'`);
  });

  test('an engine that never connected binds the default', async () => {
    const { engine, recorded, configReads } = await recordingEngine({ dbValue: '2500', connected: false });
    await SITES.searchKeyword(engine);
    expect(timeoutsSet(recorded)).toEqual(['8000ms']);
    expect(configReads()).toBe(0);
  });
});

describe('PGLite sets no statement timeout (unchanged)', () => {
  let engine: PGLiteEngine;
  const seen: string[] = [];
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '2500');
    await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha beta', compiled_truth: 'alpha beta gamma' });
    const db = (engine as unknown as { _db: { query: (...a: unknown[]) => Promise<unknown>; transaction: (fn: (tx: { query: (...a: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> } })._db;
    const query = db.query.bind(db);
    db.query = (...args: unknown[]) => { seen.push(String(args[0])); return query(...args); };
    const transaction = db.transaction.bind(db);
    db.transaction = fn => transaction(tx => {
      const txQuery = tx.query.bind(tx);
      tx.query = (...args: unknown[]) => { seen.push(String(args[0])); return txQuery(...args); };
      return fn(tx);
    });
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('the keyword, count, page, title, chunk and CJK statements run with no statement_timeout', async () => {
    await engine.searchKeyword('alpha beta');
    await engine.countKeywordPages('alpha');
    await engine.searchKeywordPages('alpha', undefined, { limit: 10, offset: 0 });
    await engine.searchTitles('alpha');
    await engine.searchKeywordChunks('alpha');
    await engine.searchKeyword('日本語');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(sql => /statement_timeout/i.test(sql))).toEqual([]);
  });
});

if (testBackends().includes('postgres')) {
  describe('postgres: the configured bound is the one Postgres enforces', () => {
    let engine: PostgresEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;
    let locker: ReturnType<typeof postgres>;
    let releaseLock: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha beta', compiled_truth: 'alpha beta gamma' });
      await installFixtureChunks(engine, 'notes/alpha', [{ chunk_index: 0, chunk_text: 'alpha beta gamma', chunk_source: 'compiled_truth' }]);
      locker = postgres(databaseUrl, { max: 1, prepare: false });
    }, 120_000);
    afterAll(async () => {
      await releaseLock?.().catch(() => {});
      await locker?.end({ timeout: 5 }).catch(() => {});
      await close?.();
    });

    /** Holds ACCESS EXCLUSIVE on the searched tables until released, so every keyword statement waits on the lock. */
    async function holdLock(): Promise<void> {
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockedUp = new Promise<void>(resolve => { locked = resolve; });
      const held = locker.begin(async tx => {
        await tx.unsafe('LOCK TABLE content_chunks, pages IN ACCESS EXCLUSIVE MODE');
        locked();
        await released;
      }).catch(() => {});
      releaseLock = async () => { release(); await held; };
      await lockedUp;
    }

    async function cancelledAfter(run: () => Promise<unknown>): Promise<{ ms: number; code: string }> {
      const started = performance.now();
      try {
        await run();
      } catch (error) {
        return { ms: performance.now() - started, code: String((error as { code?: string }).code ?? (error as Error).message) };
      }
      throw new Error('the statement completed although the searched tables were locked');
    }

    async function connectWith(config: { keyword_statement_timeout_ms?: number }): Promise<PostgresEngine> {
      const fresh = new PostgresEngine();
      await fresh.connect({ database_url: databaseUrl, poolSize: 2, ...config });
      return fresh;
    }

    test('a 1000 ms knob cancels each of the six statements after about a second, not eight', async () => {
      await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '1000');
      const bounded = await connectWith({});
      try {
        await holdLock();
        for (const [site, run] of Object.entries(SITES)) {
          const { ms, code } = await cancelledAfter(() => run(bounded));
          expect(code, site).toBe('57014');
          expect(ms, `${site} took ${ms.toFixed(0)} ms`).toBeGreaterThanOrEqual(900);
          expect(ms, `${site} took ${ms.toFixed(0)} ms`).toBeLessThan(4000);
        }
      } finally {
        await releaseLock();
        await bounded.disconnect();
      }
    }, 120_000);

    test('the file plane wins over the DB plane and countKeywordPages keeps a narrower caller bound', async () => {
      await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '30000');
      const bounded = await connectWith({ keyword_statement_timeout_ms: 1000 });
      try {
        await holdLock();
        const title = await cancelledAfter(() => bounded.searchTitles('alpha'));
        expect(title.code).toBe('57014');
        expect(title.ms).toBeLessThan(4000);
        const count = await cancelledAfter(() => bounded.countKeywordPages('alpha', { timeoutMs: 1200 }));
        expect(count.code).toBe('57014');
        expect(count.ms).toBeGreaterThanOrEqual(1000);
        expect(count.ms).toBeLessThan(4000);
      } finally {
        await releaseLock();
        await bounded.disconnect();
      }
    }, 120_000);

    test('the stored page is intact and every site answers once the lock is gone', async () => {
      await engine.unsetConfig(KEYWORD_STATEMENT_TIMEOUT_KEY);
      expect((await engine.searchKeyword('alpha beta')).map(h => h.slug)).toEqual(['notes/alpha']);
      expect(await engine.countKeywordPages('alpha')).toBe(1);
      expect((await engine.searchKeywordPages('alpha', undefined, { limit: 10, offset: 0 })).map(h => h.slug)).toEqual(['notes/alpha']);
      expect((await engine.searchTitles('alpha')).map(h => h.slug)).toEqual(['notes/alpha']);
      expect((await engine.searchKeywordChunks('alpha')).map(h => h.slug)).toEqual(['notes/alpha']);
    });
  });
}
