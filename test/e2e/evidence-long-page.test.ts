/**
 * F2 (`search.long_page_unit`) on Postgres: the PGLite unit arm
 * (test/evidence-long-page.test.ts) run against a real Postgres brain. Pins
 * the off path (byte-identical to return_unit chunk), the frozen on-path
 * golden, the replay case (default 20,000-character threshold, section; a
 * medium and a short hit keep their ranked chunks), the cap and explicit-unit
 * paths unchanged with the key on, the serialized lean MCP `delivered {unit,
 * reason}`, the widened row surviving `snippet_chars` 300, the precedence
 * of a non-auto global unit, the over-budget fallback, recall/think/
 * assemble_evidence unchanged with the key on, and the d5b/F4 instruction
 * config readers, all on the same engine.
 *
 * Runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { assembleEvidenceForHits } from '../../src/core/search/evidence-delivery.ts';
import { buildMcpInstructions, readInstructionContent } from '../../src/mcp/instructions.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { DECIDING, LONG_SLUG, MEDIUM_SLUG, mcpCall, opCall, seedLongPages, withConfig } from '../helpers/long-page-fixture.ts';

const GOLDEN = join(import.meta.dir, '../fixtures/goldens/evidence-delivery/long-page-on-path.json');
const KEY = 'search.long_page_unit';
const run = process.env.DATABASE_URL ? describe : describe.skip;
let engine: PostgresEngine;
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  engine = isolated.engine;
  close = isolated.close;
  await seedLongPages(engine);
}, 240_000);
afterAll(async () => { await close(); }, 120_000);

const long = (rows: Array<Record<string, unknown>>) => rows.find(r => r.slug === LONG_SLUG)!;

run('long-page delivery on Postgres', () => {
  test('off (unset or `off`) is byte-identical to return_unit chunk', async () => {
    for (const [name, params] of [['search', { query: 'renewal fee' }], ['query', { query: 'renewal fee', expand: false }]] as const) {
      const chunk = await mcpCall(engine, name, { ...params, return_unit: 'chunk' });
      expect((await mcpCall(engine, name, params)).bytes).toBe(chunk.bytes);
      expect((await withConfig(engine, { [KEY]: 'off' }, () => mcpCall(engine, name, params))).bytes).toBe(chunk.bytes);
    }
  });

  test('on: the frozen golden holds, and the lean long row carries delivered {unit, reason}', async () => {
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    for (const unit of ['window', 'section', 'page'] as const) {
      const on = await withConfig(engine, { [KEY]: unit }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
      expect(long(on.rows).delivered).toEqual({ unit, reason: 'long_page' });
      const ids = (bytes: string) => bytes.replace(/\\"chunk_id\\":\d+/g, '\\"chunk_id\\":0');
      expect(ids(on.bytes)).toBe(ids(want[`mcp-search:${unit}`]));
    }
    const page = await withConfig(engine, { [KEY]: 'page' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    expect(String(long(page.rows).chunk_text)).toContain(DECIDING);
  });

  test('replay: section at the default threshold widens only the long hit; every other row is its off-path bytes', async () => {
    const off = await mcpCall(engine, 'search', { query: 'renewal fee' });
    const on = await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    expect(long(on.rows).delivered).toEqual({ unit: 'section', reason: 'long_page' });
    expect(on.rows.map(r => r.slug)).toEqual(expect.arrayContaining([MEDIUM_SLUG, 'notes/short-example']));
    for (const r of on.rows.filter(r => r.slug !== LONG_SLUG)) expect(JSON.stringify(r)).toBe(JSON.stringify(off.rows.find(o => o.slug === r.slug)));
    const lowered = await withConfig(engine, { [KEY]: 'section', 'search.long_page_min_chars': '5000' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    expect(lowered.rows.find(r => r.slug === MEDIUM_SLUG)!.delivered).toEqual({ unit: 'section', reason: 'long_page' });
  });

  test('the cap path and explicit chunk/window units are byte-identical with the key on', async () => {
    for (const params of [{ token_budget: 4000 }, { return_unit: 'chunk' }, { return_unit: 'window' }]) {
      const call = { query: 'renewal fee', ...params };
      const off = await mcpCall(engine, 'search', call);
      expect((await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'search', call))).bytes).toBe(off.bytes);
    }
  });

  test('snippet_chars 300: the widened section survives whole with delivered {unit, reason}; every other row is cut to 300 exactly as with the key off and marks delivered {truncated}', async () => {
    const off = await mcpCall(engine, 'search', { query: 'renewal fee', snippet_chars: 300 });
    const [on, full] = await withConfig(engine, { [KEY]: 'section' }, async () => [
      await mcpCall(engine, 'search', { query: 'renewal fee', snippet_chars: 300 }),
      await mcpCall(engine, 'search', { query: 'renewal fee' }),
    ]);
    const widened = long(on.rows);
    expect(widened.delivered).toEqual({ unit: 'section', reason: 'long_page' });
    expect(widened.chunk_text).toBe(long(full.rows).chunk_text);
    expect(String(widened.chunk_text).length).toBeGreaterThan(300);
    for (const r of on.rows.filter(r => r.slug !== LONG_SLUG)) {
      const { delivered, ...rest } = r;
      expect(JSON.stringify(rest)).toBe(JSON.stringify(off.rows.find(o => o.slug === r.slug)));
      expect(delivered).toEqual(String(r.chunk_text).includes('[truncated ') ? { truncated: true } : undefined);
    }
    expect(on.rows.some(r => r.slug !== LONG_SLUG && String(r.chunk_text).includes('[truncated '))).toBe(true);
  });

  test('global window wins over the long-page section; explicit budget keeps it off; over budget keeps the chunk', async () => {
    const pick = (rows: unknown) => (rows as Array<SearchResult & { delivered?: { unit: string; reason?: string } }>).find(r => r.slug === LONG_SLUG)!;
    const global = await withConfig(engine, { 'search.return_unit': 'window', [KEY]: 'section' }, () => opCall(engine, 'search', { query: 'renewal fee' }));
    expect(pick(global.result).delivered).toEqual(expect.objectContaining({ unit: 'window' }));
    expect(pick(global.result).delivered?.reason).toBeUndefined();
    const budget = await withConfig(engine, { [KEY]: 'section' }, () => opCall(engine, 'search', { query: 'renewal fee', token_budget: 4000 }));
    expect(pick(budget.result).delivered?.reason).not.toBe('long_page');
    const over = await withConfig(engine, { [KEY]: 'section', 'search.return_budget_conversation': '40' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    expect(long(over.rows).delivered).toEqual({ unit: 'chunk', reason: 'long_page_chunk' });
  });

  test('recall and queryless assemble_evidence are unchanged with the key on', async () => {
    const capture = async () => {
      const page = await engine.getPage(LONG_SLUG);
      const [chunk] = await engine.executeRaw<{ id: number }>(`SELECT id FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index LIMIT 1`, [page!.id]);
      return {
        recall: (await mcpCall(engine, 'recall', { query: 'renewal fee' })).bytes,
        assembled: JSON.stringify(await assembleEvidenceForHits(engine, { hits: [{ source_id: 'default', slug: LONG_SLUG, chunk_id: chunk.id }], return_unit: 'auto', caller: { remote: true } })),
      };
    };
    const off = await capture();
    expect(await withConfig(engine, { [KEY]: 'section' }, capture)).toEqual(off);
  });

  test('instruction content (d5b names-row references, F4 governing rule) reads from Postgres config', async () => {
    expect(await readInstructionContent(engine)).toEqual({ references: { namesRow: true, records: false }, governingRule: 'in_effect' });
    const content = await withConfig(engine, { 'entity.names_references': 'false', 'entity.record_types': 'contract', 'mcp.instructions_governing_rule': 'newest' }, () => readInstructionContent(engine));
    expect(content).toEqual({ references: { namesRow: false, records: true }, governingRule: 'newest' });
    const text = buildMcpInstructions(content);
    expect(text).toContain('a `names` row lists `records` by type.');
    expect(text).toContain('For what is true now, prefer the newest governing source');
  });
});
