/**
 * Keyword-only MCP failures must name the operator's statement timeout and
 * tell the caller how to narrow its next request. Regresses if either read
 * escapes as internal_error, or if the mapping absorbs user cancellations,
 * unrelated errors or hybrid degradation. Existing paging tests cover count
 * timeouts, not a failed ranking statement. No production test seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 180_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('notes/example', { type: 'note', title: 'Commonterm fixture', compiled_truth: 'commonterm' });
  await installFixtureChunks(engine, 'notes/example', [{ chunk_index: 0, chunk_text: 'commonterm', chunk_source: 'compiled_truth' }]);
});

const branches = [
  { name: 'keyword paging', method: 'searchKeywordPages', params: { match: 'keyword' }, keywordOnly: false },
  { name: 'operator keyword-only mode', method: 'searchKeyword', params: {}, keywordOnly: true },
] as const;

function failingRead(method: string, error: unknown): BrainEngine {
  return new Proxy(engine, {
    get(target, key) {
      if (key === method) return async () => { throw error; };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const call = (db: BrainEngine, params: Record<string, unknown>) => dispatchToolCall(db, 'search', { query: 'commonterm', limit: 10, ...params }, {
  remote: true, transport: 'http', sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true },
});

describe('keyword-only timeout errors over MCP dispatch', () => {
  for (const branch of branches) {
    for (const shape of ['Error', 'driver object'] as const) {
      test(`${branch.name}: ${shape} statement timeout is actionable`, async () => {
        await engine.setConfig('search.mcp_keyword_only', String(branch.keywordOnly));
        const error = Object.assign(shape === 'Error' ? new Error() : {}, {
          code: '57014', message: 'canceling statement due to statement timeout',
        });
        const result = await call(failingRead(branch.method, error), branch.params);
        expect(result.isError).toBe(true);
        const body = JSON.parse(result.content[0]!.text);
        expect(body).toMatchObject({ error: 'keyword_statement_timeout', code: 'keyword_statement_timeout', class: 'retryable', retryable: true });
        expect(body.message).toContain('search.keyword_statement_timeout_ms');
        expect(body.suggestion).toContain('source_id');
        expect(body.suggestion).toContain('types');
        expect(body.suggestion).toContain('more specific query');
      });
    }

    test(`${branch.name}: other failures keep their existing envelopes`, async () => {
      await engine.setConfig('search.mcp_keyword_only', String(branch.keywordOnly));
      for (const [error, code] of [
        [Object.assign(new Error('canceling statement due to user request'), { code: '57014' }), 'internal_error'],
        [Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }), 'internal_error'],
        [new Error('canceling statement due to statement timeout'), 'internal_error'],
        [new OperationError('permission_denied', 'Read refused.'), 'permission_denied'],
      ] as const) {
        const result = await call(failingRead(branch.method, error), branch.params);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text).code).toBe(code);
      }
    });
  }

  test('hybrid keyword timeouts still return usable results with degradation', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'false');
    const result = await call(failingRead('searchKeyword', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })), {});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text).some((row: { slug: string }) => row.slug === 'notes/example')).toBe(true);
    const meta = result._meta?.retrieval as { degraded: unknown[] };
    expect(meta.degraded).toContainEqual({ stage: 'keyword_arm_failed', reason: 'timeout' });
  });
});
