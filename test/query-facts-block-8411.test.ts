/**
 * #8411: `query` with the facts block on (the default). An unbudgeted query
 * (the shipped no-budget `auto` plan) must not run the block, so `limit`
 * caps the rows; a budgeted query's block is capped at the caller's row count
 * and never scores above the top page; the CLI prints a fact row's identity,
 * never `undefined`. PGLite, keyword-only, no network. Placeholders only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { formatResult } from '../src/cli/main.ts';
import { applyFactsBlock } from '../src/core/search/facts-arm.ts';
import { formatSearchRow } from '../src/cli/search-row-format.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

type Row = SearchResult & { fact_id?: string; page_slug?: string };

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Where is the acme-example widget launch venue?';
const FACTS = 12;
const local = async (params: Record<string, unknown>) =>
  await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, ...params }) as Row[];
const remote = async (params: Record<string, unknown>) => {
  const auth = { token: 't', clientId: 'gbrain-8411-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const res = await dispatchToolCall(engine, 'query', { query: Q, expand: false, ...params },
    { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return JSON.parse((res.content[0] as { text: string }).text) as Row[];
};
const isFact = (r: Row) => r.result_type === 'fact';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'companies/acme-example', page('company', 'Acme example', 'Acme example plans a widget launch at a venue.'));
  for (let i = 0; i < 6; i++) {
    await putPage(engine, sourceId, `conversations/launch-${i}`, page('conversation', `Launch chat ${i}`,
      `**User:** acme-example widget launch venue, chat ${i}. The widget launch venue moved again.\n\n**Assistant:** Noted the acme-example launch venue.`, `date: 2026-07-0${i + 1}\n`));
  }
  for (let i = 0; i < FACTS; i++) {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from)
       VALUES ($1, 'companies/acme-example', $2, 'event', 'conversation', 'world', 1, $3::timestamptz)`,
      [sourceId, `The acme-example widget launch venue changed to hall ${i}.`, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`]);
  }
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('#8411 limit: an unbudgeted query returns at most limit rows', () => {
  test('MCP local (the CLI path): limit 3 gives 3 rows', async () => {
    const rows = await local({ limit: 3 });
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.filter(r => !isFact(r)).length).toBeGreaterThan(0);
  });

  test('MCP remote: limit 3 gives 3 rows', async () => {
    const rows = await remote({ limit: 3 });
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.filter(r => !isFact(r)).length).toBeGreaterThan(0);
  });
});

describe('#8411 budgeted query: the facts block is capped by limit and never outscores the pages', () => {
  for (const [name, run] of [['local', local], ['remote', remote]] as const) {
    test(`${name}: block rows lead, at most limit of them, scores not above the top page`, async () => {
      const rows = await run({ limit: 3, token_budget: 4000 });
      const facts = rows.filter(isFact);
      const pages = rows.filter(r => !isFact(r));
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts.length).toBeLessThanOrEqual(3);
      expect(pages.length).toBeLessThanOrEqual(3);
      expect(rows.slice(0, facts.length).every(isFact)).toBe(true);
      const topPage = Math.max(...pages.map(r => r.score));
      for (const f of facts) expect(f.score).toBeLessThanOrEqual(topPage);
    });
  }

  test('the block cap is the caller limit even when page rows already run past it (alias fan-out)', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ page_id: i + 1, slug: `conversations/launch-${i}`, title: 't', type: 'conversation', chunk_text: 'x',
      chunk_id: i + 1, chunk_index: 0, chunk_source: 'compiled_truth', score: 1 - i / 10, stale: false, source_id: sourceId })) as unknown as SearchResult[];
    const rows = await applyFactsBlock(engine, Q, pages, { sourceId, remote: false, budget: 4000, tokenBudget: 4000, rowCap: async () => 1 });
    expect(rows.filter(r => r.result_type === 'fact').length).toBe(1);
    expect(rows.filter(r => r.result_type !== 'fact').length).toBe(5);
  });

  test('a budget with a large limit still delivers the whole block (the measured arm is unchanged)', async () => {
    const rows = await local({ limit: 25, token_budget: 4000 });
    expect(rows.filter(isFact).length).toBe(FACTS);
  });
});

describe('#8411 CLI rendering', () => {
  test('human output names each fact row (fact id and entity page), never undefined', async () => {
    const rows = await local({ limit: 3, token_budget: 4000 });
    const facts = rows.filter(isFact);
    expect(facts.length).toBeGreaterThan(0);
    const out = formatResult('query', rows, {});
    expect(out).not.toContain('undefined');
    for (const f of facts) expect(out).toContain(`fact:${f.fact_id} companies/acme-example -- [observed unknown; valid `);
    expect(out.split('\n').filter(l => l.includes(' fact:')).length).toBe(facts.length);
    expect(out.split('\n').filter(l => l.startsWith('The acme-example')).length).toBe(0);
    expect(out.split('\n').filter(l => /^\[\d/.test(l)).length).toBe(rows.length);
  });

  test('a fact row without a readable entity page falls back to follow_up, and to the bare id', () => {
    const fact = { result_type: 'fact', fact_id: '7', score: 0.5, chunk_text: '[observed unknown]\nThe acme-example venue moved.' } as unknown as SearchResult;
    expect(formatSearchRow({ ...fact, follow_up: { op: 'recall', args: { entity: 'companies/acme-example' } } } as never))
      .toBe('[0.5000] fact:7 companies/acme-example -- [observed unknown] The acme-example venue moved.');
    expect(formatSearchRow(fact as never)).toBe('[0.5000] fact:7 -- [observed unknown] The acme-example venue moved.');
  });

  test('--json: every fact row carries fact_id', async () => {
    const rows = await local({ limit: 3, token_budget: 4000 });
    const parsed = JSON.parse(formatResult('query', rows, { json: true }));
    const out = (Array.isArray(parsed) ? parsed : parsed.results) as Row[];
    const facts = out.filter(isFact);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) expect(f.fact_id).toMatch(/^\d+$/);
  });

  test('unbudgeted --limit 3 prints exactly the returned rows, none undefined', async () => {
    const rows = await local({ limit: 3 });
    const out = formatResult('query', rows, {});
    expect(out).not.toContain('undefined');
    expect(out.split('\n').filter(l => /^\[\d/.test(l)).length).toBeLessThanOrEqual(3);
  });
});
