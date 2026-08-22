/**
 * #3985 — expose `types?: string[]` on the public search + query ops.
 *
 * The SQL-level plumbing (SearchOpts.types → both engines' keyword / title /
 * vector legs) has existed since v0.33 for whoknows; pre-fix the search and
 * query ops simply never accepted the param, so MCP/CLI callers could not
 * type-scope retrieval. Pins: param reaches the engine on both ops, CLI
 * comma-string form works, junk is rejected as invalid_params.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const searchOp = operations.find((o) => o.name === 'search')!;
const queryOp = operations.find((o) => o.name === 'query')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: console as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[slug: string, type: string]> = [
    ['people/alice-example', 'person'],
    ['companies/acme-example', 'company'],
    ['notes/telescope-note', 'note'],
  ];
  for (const [slug, type] of pages) {
    await engine.putPage(slug, {
      type,
      title: `Zebra telescope ${type}`,
      compiled_truth: `the zebra telescope appears in this ${type} page`,
      frontmatter: {},
    });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `the zebra telescope appears in this ${type} page`, chunk_source: 'compiled_truth' },
    ]);
  }
  // Keyword-only path for the search op: no embedding provider needed.
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

function slugsOf(results: unknown): string[] {
  return (results as SearchResult[]).map((r) => r.slug).sort();
}

describe('search op — types param (#3985)', () => {
  test('no types → all matching pages (baseline)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope' });
    expect(slugsOf(out)).toEqual(['companies/acme-example', 'notes/telescope-note', 'people/alice-example']);
  });

  test('types array filters at SQL level', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope', types: ['person'] });
    expect(slugsOf(out)).toEqual(['people/alice-example']);
  });

  test('CLI comma-string form works (--types person,company)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope', types: 'person,company' });
    expect(slugsOf(out)).toEqual(['companies/acme-example', 'people/alice-example']);
  });

  test('non-string entries reject loudly as invalid_params', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'zebra telescope', types: [42] }),
    ).rejects.toThrow(/types.*must be an array/i);
  });

  test('all-empty list rejects loudly instead of silently dropping the filter', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'zebra telescope', types: ' , ' }),
    ).rejects.toThrow(/no usable page-type/i);
  });
});

describe('query op — types param (#3985)', () => {
  test('types filter applies on the no-provider hybrid path', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), {
        query: 'zebra telescope',
        expand: false,
        types: ['company'],
      });
      expect(slugsOf(out)).toEqual(['companies/acme-example']);
    });
  });

  test('query without types keeps full recall', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), { query: 'zebra telescope', expand: false });
      expect(slugsOf(out)).toEqual(['companies/acme-example', 'notes/telescope-note', 'people/alice-example']);
    });
  });

  test('junk types reject before any retrieval work', async () => {
    await expect(
      queryOp.handler(ctxOf(), { query: 'zebra telescope', types: { person: true } }),
    ).rejects.toThrow(/types.*must be an array/i);
  });
});
