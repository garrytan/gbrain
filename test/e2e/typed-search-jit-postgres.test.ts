/**
 * LHF wave 2 item 1: the typed-search type check (`reconcileTypeFilter`)
 * runs its batched EXISTS probes, and its DISTINCT type list only when a
 * probe misses, in one statement with JIT off (`executeRaw({ jitOff: true })`). The plan assertions
 * run on a one-connection engine whose session sets `jit_above_cost = 0`, so
 * every statement that keeps JIT on compiles and shows a `JIT` block: the
 * control proves the assertion can fail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { reconcileTypeFilter } from '../../src/core/ops/search-type-filter.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

const url = process.env.DATABASE_URL!;
type Raw = { sql: string; params: unknown[]; opts?: { jitOff?: boolean; prepare?: boolean } };

async function oneConnection(settings: string[]): Promise<PostgresEngine> {
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: url, poolSize: 1 });
  for (const setting of settings) await engine.executeRaw(setting);
  return engine;
}

async function explain(engine: PostgresEngine, raw: Raw, opts?: { jitOff?: boolean }): Promise<string> {
  const [row] = await engine.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${raw.sql}`, raw.params, opts);
  return JSON.stringify(row!['QUERY PLAN']);
}

/** Loops of the DISTINCT type list's LIMIT node: 0 when the subplan never ran. */
function distinctLoops(plan: string): number {
  const limits: number[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (node['Node Type'] === 'Limit') limits.push(node['Actual Loops'] as number);
    for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  walk((JSON.parse(plan) as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
  expect(limits.length).toBe(1);
  return limits[0]!;
}

async function captureTypeCheck(engine: PostgresEngine, types: string[]): Promise<{ result: Awaited<ReturnType<typeof reconcileTypeFilter>>; statements: Raw[] }> {
  const statements: Raw[] = [];
  const execute = engine.executeRaw.bind(engine);
  const spy = Object.assign(Object.create(engine), {
    executeRaw: (sql: string, params?: unknown[], opts?: Raw['opts']) => {
      if (/FROM pages p WHERE/.test(sql)) statements.push({ sql, params: params ?? [], opts });
      return execute(sql, params, opts);
    },
  }) as PostgresEngine;
  const ctx = { engine: spy, remote: true } as unknown as OperationContext;
  return { result: await reconcileTypeFilter(ctx, { sourceId: 'default' }, false, types), statements };
}

(hasDatabase() ? describe : describe.skip)('typed-search type check without JIT (Postgres)', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    engine = await setupDB();
    for (const [slug, type] of [['notes/jit-alpha', 'note'], ['companies/acme-example', 'company'], ['people/alice-example', 'person']] as const) {
      await importFromContent(engine, slug, serializeMarkdown({}, `${slug} body`, '', { type, title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
    }
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('the one type-check statement shows no JIT block; with JIT on it does; the DISTINCT list runs only on a miss', async () => {
    const reader = await oneConnection(['SET jit = on', 'SET jit_above_cost = 0']);
    try {
      const hit = await captureTypeCheck(reader, ['note']);
      expect(hit.result).toEqual({ types: ['note'] });
      const miss = await captureTypeCheck(reader, ['note', 'deal-example']);
      expect(miss.result).toEqual({ types: ['note'], notice: 'No pages have type deal-example; filtered to note. Page types in this brain: company, note, person.' });
      expect([hit.statements.length, miss.statements.length]).toEqual([1, 1]);

      for (const statement of [...hit.statements, ...miss.statements]) {
        expect(statement.opts).toEqual({ jitOff: true, prepare: false });
        expect((await explain(reader, statement, statement.opts)).includes('"JIT"')).toBe(false);
        expect((await explain(reader, statement)).includes('"JIT"')).toBe(true);
      }
      expect(distinctLoops(await explain(reader, hit.statements[0]!, { jitOff: true }))).toBe(0);
      expect(distinctLoops(await explain(reader, miss.statements[0]!, { jitOff: true }))).toBe(1);
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`)).toEqual([{ jit: 'on' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);

  test('a server with JIT off runs the statement as a plain read', async () => {
    const reader = await oneConnection(['SET jit = off', 'SET jit_above_cost = 0']);
    try {
      const miss = await captureTypeCheck(reader, ['company', 'deal-example']);
      expect(miss.result.types).toEqual(['company']);
      for (const statement of miss.statements) expect((await explain(reader, statement, statement.opts)).includes('"JIT"')).toBe(false);
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`, [], { jitOff: true })).toEqual([{ jit: 'off' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);

  test('inside a caller transaction the statement runs JIT off and the caller keeps its setting', async () => {
    const reader = await oneConnection(['SET jit = on', 'SET jit_above_cost = 0']);
    try {
      const seen = await reader.transaction(async tx => {
        const inner = await tx.executeRaw<{ jit: string }>(`SELECT current_setting('jit') AS jit`, [], { jitOff: true });
        const after = await tx.executeRaw<{ jit: string }>(`SELECT current_setting('jit') AS jit`);
        await tx.executeRaw(`SET LOCAL jit = off`);
        const offInner = await tx.executeRaw<{ jit: string }>(`SELECT current_setting('jit') AS jit`, [], { jitOff: true });
        const offAfter = await tx.executeRaw<{ jit: string }>(`SELECT current_setting('jit') AS jit`);
        return [inner[0]!.jit, after[0]!.jit, offInner[0]!.jit, offAfter[0]!.jit];
      });
      expect(seen).toEqual(['off', 'on', 'off', 'off']);
      await expect(reader.transaction(async tx => { await tx.executeRaw('SELECT 1 / 0', [], { jitOff: true }); })).rejects.toThrow(/division by zero/);
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`)).toEqual([{ jit: 'on' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);

  test('the envelope keeps the deadline, the abort signal and the connection', async () => {
    const reader = await oneConnection(['SET jit = on']);
    try {
      const bounded = await reader.executeRaw(`SELECT pg_sleep(2)`, [], { jitOff: true, timeoutMs: 150 }).catch((e: { code?: string }) => e.code);
      expect(bounded).toBe('57014');
      const deadline = await reader.executeRaw(`SELECT pg_sleep(2)`, [], { jitOff: true, timeoutMs: 60_000, deadlineAt: Date.now() + 150 }).catch((e: { code?: string }) => e.code);
      expect(deadline).toBe('57014');
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS t`, [], { jitOff: true, timeoutMs: 5_000 }))
        .toEqual([{ jit: 'off', t: '5s' }]);

      const aborted = new AbortController();
      aborted.abort();
      await expect(reader.executeRaw(`SELECT 1`, [], { jitOff: true, signal: aborted.signal })).rejects.toThrow(/abort/i);

      const inFlight = new AbortController();
      const started = Date.now();
      setTimeout(() => inFlight.abort(), 150);
      await expect(reader.executeRaw(`SELECT pg_sleep(5)`, [], { jitOff: true, signal: inFlight.signal })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4_000);

      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`)).toEqual([{ jit: 'on' }]);
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`, [], { jitOff: true, signal: new AbortController().signal })).toEqual([{ jit: 'off' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);
});
