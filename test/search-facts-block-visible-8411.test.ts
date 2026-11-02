/** #8411: the default budgeted query must not hide all page evidence behind facts.
 * Value: protects=bounded mixed evidence through the real op and CLI rendering;
 * fails_when=facts add rows or consume rank one; seam=none;
 * no_claim=embedding ranking, answer-model quality or status-section selection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { formatResult } from '../src/cli/main.ts';
import { formatResultsExplain } from '../src/core/search/explain-formatter.ts';
import { applyFactsBlock } from '../src/core/search/facts-arm.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

for (const backend of testBackends()) describe(`facts block visible rows (${backend})`, () => {
  let engine: BrainEngine;
  let sourceId: string;
  let other: string;
  beforeAll(async () => {
    engine = backend === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
    await engine.connect(backend === 'postgres' ? { database_url: process.env.DATABASE_URL } : {});
    await engine.initSchema();
    sourceId = await newSource(engine);
    for (let i = 0; i < 6; i++) await putPage(engine, sourceId, `notes/closure-${i}`,
      page('note', `Alice goodbye letter ${i}`, `Alice goodbye letter closure status CLOSED. Evidence page ${i}.`));
    await putPage(engine, sourceId, 'people/alice-example', page('person', 'Alice Example', 'Alice goodbye letter status CLOSED.'));
    for (let i = 0; i < 8; i++) await engine.insertFact({ fact: `Alice goodbye letter discussed in meeting ${i}.`, kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'world' }, { source_id: sourceId });
    await engine.insertFact({ fact: 'Alice goodbye letter PRIVATE-CANARY.', kind: 'fact', entity_slug: 'people/alice-example', source: 'test', visibility: 'private' }, { source_id: sourceId });
    other = await newSource(engine);
    await engine.insertFact({ fact: 'Alice goodbye letter OTHER-SOURCE-CANARY.', kind: 'fact', source: 'test', visibility: 'world' }, { source_id: other });
  }, 120_000);
  afterAll(async () => {
    if (sourceId) await engine.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
    if (other) await engine.executeRaw('DELETE FROM sources WHERE id = $1', [other]);
    await engine?.disconnect();
  }, 60_000);
  const query = (params: Record<string, unknown> = {}) => handleToolCall(engine, 'query', {
    query: 'Alice goodbye letter', expand: false, use_cache: false, source_id: sourceId, token_budget: 4000, limit: 5, ...params,
  }) as Promise<SearchResult[]>;

  test('default block preserves rank one and the visible page majority within --limit', async () => {
    const rows = await query();
    expect(rows).toHaveLength(5);
    expect(rows[0]!.result_type).not.toBe('fact');
    expect(rows.filter(r => r.result_type === 'fact')).toHaveLength(1);
    expect(rows.filter(r => r.result_type !== 'fact')).toHaveLength(4);
    expect(rows.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(4000);
    const text = formatResult('query', rows);
    expect(text).not.toContain('undefined');
    const fact = rows.find(r => r.result_type === 'fact')!;
    expect(text).toContain(`fact ${fact.fact_id}`);
    expect(text).toContain('people/alice-example');
    const explained = formatResultsExplain(rows);
    expect(explained).not.toContain('undefined');
    expect(explained).toContain(`fact ${fact.fact_id} (people/alice-example)`);
  });

  test('limit one retains the page; limit two still admits one fact', async () => {
    const one = await query({ limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.result_type).not.toBe('fact');
    const two = await query({ limit: 2 });
    expect(two).toHaveLength(2);
    expect(two[0]!.result_type).not.toBe('fact');
    expect(two[1]!.result_type).toBe('fact');
  });

  test('auto evidence delivery keeps the row bound and top page', async () => {
    const rows = await query({ return_unit: 'auto' });
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows[0]!.result_type).not.toBe('fact');
    expect(rows.some(r => r.result_type === 'fact')).toBe(true);
  });

  test('no page candidates still returns bounded facts', async () => {
    const rows = await applyFactsBlock(engine, 'Alice goodbye letter', [], {
      remote: false, sourceId, readScope: { sourceId }, budget: 4000, tokenBudget: 4000, rowCap: async () => 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.result_type === 'fact')).toBe(true);
  });

  test('budget pressure truncates the same top page rather than replacing it', async () => {
    const baseline = await query({ token_budget: undefined, return_unit: 'chunk' });
    const pages = baseline.filter(r => r.result_type !== 'fact');
    pages[0] = { ...pages[0]!, chunk_text: 'Alice goodbye letter CLOSED. '.repeat(500) };
    const rows = await applyFactsBlock(engine, 'Alice goodbye letter', pages, {
      remote: false, sourceId, readScope: { sourceId }, budget: 200, tokenBudget: 200, rowCap: async () => 5,
    });
    expect(rows[0]!.slug).toBe(baseline[0]!.slug);
    expect(rows[0]!.chunk_text.length).toBeLessThan(pages[0]!.chunk_text.length);
    expect(rows.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(200);
    expect(rows.some(r => r.result_type === 'fact')).toBe(true);
  });

  test('a large facts-only result retains the forty-row ceiling', async () => {
    const src = await newSource(engine);
    try {
      for (let i = 0; i < 55; i++) await engine.insertFact({ fact: `Cobalt workshop registration number ${i}.`, kind: 'fact', source: 'test', visibility: 'world' }, { source_id: src });
      const rows = await applyFactsBlock(engine, 'Cobalt workshop registration', [], {
        remote: false, sourceId: src, readScope: { sourceId: src }, budget: 16000, rowCap: async () => 200,
      });
      expect(rows).toHaveLength(40);
    } finally { await engine.executeRaw('DELETE FROM sources WHERE id = $1', [src]); }
  });

  test('CLI labels entityless facts without fabricating a page slug', () => {
    const text = formatResult('query', [{ result_type: 'fact', fact_id: '123', score: 0.5, chunk_text: 'Saved fact without an entity.' }]);
    expect(text).toContain('fact 123 --');
    expect(text).not.toContain('undefined');
  });

  test('remote MCP retains facts without private or cross-source leakage', async () => {
    const out = await dispatchToolCall(engine, 'query', { query: 'Alice goodbye letter', limit: 5, token_budget: 4000, expand: false, use_cache: false }, {
      remote: true, transport: 'http', sourceId, auth: { token: 'test', clientId: 'fixture', scopes: ['read'], sourceId, allowedSources: [sourceId] },
    });
    expect(out.isError).toBeFalsy();
    const text = JSON.stringify(out);
    expect(text).toContain('fact_id');
    expect(text).not.toContain('PRIVATE-CANARY');
    expect(text).not.toContain('OTHER-SOURCE-CANARY');
  });
});
