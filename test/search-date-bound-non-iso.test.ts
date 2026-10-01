/**
 * Search date bounds accept only what the contract documents: YYYY-MM-DD, an
 * ISO-8601 timestamp, or a relative duration. JavaScript's Date.parse accepts
 * far more ("May 5" reads as 2001-05-05 in Bun), and such a string used to
 * pass validation, fail the database's timestamptz cast inside both lexical
 * arms, be swallowed as a degraded arm and come back as []. It is now
 * rejected up front, and a datetime cast error that still reaches an arm is
 * surfaced instead of swallowed. (gbrain-evals N3 temporal-asof, bug 4.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { hybridSearch, resolveDateBoundary } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
  await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: 'notes/a', content: '---\ntype: note\ntitle: A\ndate: 2024-06-01\n---\nzebrafish note\n' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveDateBoundary rejects non-ISO strings', () => {
  test.each(['May 5', 'June 2024', '5/5/2024', 'Sat May 05 2024', '2024-06-01T25:00:00Z', '2024-02-30T10:00:00Z', '20240601'])('%p is rejected', (raw) => {
    expect(() => resolveDateBoundary(raw, 'since')).toThrow(/Invalid since/);
    expect(() => resolveDateBoundary(raw, 'until')).toThrow(/Invalid until/);
  });

  test.each(['2024-06-01T10:00', '2024-06-01T10:00:00Z', '2024-06-01T10:00:00.123Z', '2024-06-01 10:00:00+02:00', '2024-06-01T10:00:00-0500'])('%p passes through', (raw) => {
    expect(resolveDateBoundary(raw, 'since')).toBe(raw);
  });
});

describe('query with a non-ISO date bound', () => {
  const query = (since: string) => {
    const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
    return operations.find(o => o.name === 'query')!.handler(ctx, { query: 'zebrafish', since, expand: false }) as Promise<Array<{ slug: string }>>;
  };

  test('an ISO bound still filters normally', async () => {
    expect((await query('2024-01-01')).map(r => r.slug)).toEqual(['notes/a']);
  });

  test('"May 5" is rejected with a clear error, like "last week"', async () => {
    await expect(query('last week')).rejects.toThrow(/Invalid since value/);
    await expect(query('May 5')).rejects.toThrow(/Invalid since value "May 5"/);
  });
});

describe('a datetime cast error in a lexical arm is not swallowed', () => {
  const castError = () => Object.assign(new Error('invalid input syntax for type timestamp with time zone: "May 5"'), { code: '22007' });
  const fake = (arms: { searchKeyword: () => Promise<SearchResult[]>; searchTitles: () => Promise<SearchResult[]> }) => ({
    kind: 'pglite',
    getConfig: async () => null,
    executeRaw: async () => [],
    resolveAliases: async () => new Map(),
    getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(),
    getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: async () => [],
    searchVector: async () => [],
    ...arms,
  }) as unknown as BrainEngine;

  test('keyword arm cast error rethrows instead of returning []', async () => {
    const err = castError();
    await expect(hybridSearch(fake({ searchKeyword: () => Promise.reject(err), searchTitles: async () => [] }), 'orchard telemetry notes', { limit: 5 }))
      .rejects.toBe(err);
  });

  test('title arm cast error rethrows too', async () => {
    const err = castError();
    await expect(hybridSearch(fake({ searchKeyword: async () => [], searchTitles: () => Promise.reject(err) }), 'orchard telemetry notes', { limit: 5 }))
      .rejects.toBe(err);
  });
});
