/**
 * Provenance-aware ranking (Cat 40 Hard fix wave, F3): pages gbrain generated
 * (frontmatter `dream_generated: true`, `type: extract_receipt`) rank below a
 * primary record about the same entity that matches the same query, and only
 * then; corrections are never demoted.
 *
 * Protects: an auto-generated summary outranking the account's own record for
 * a question about that account; a human-authored page, a generated page with
 * no competing record, and a generated correction keep their scores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { applyGeneratedDemotion, GENERATED_FACTOR, recordsCorrection } from '../src/core/search/provenance-demotion.ts';
import { mentionBrain, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function put(slug: string, type: string, title: string, body: string, fm: Record<string, unknown> = {}) {
  await importFromContent(engine, slug, serializeMarkdown(fm, body, '', { type, title, tags: [] }), { noEmbed: true, forceRechunk: true });
}
async function rows(slugs: string[]): Promise<SearchResult[]> {
  const r = await engine.executeRaw<{ id: number; slug: string; source_id: string }>('SELECT id, slug, source_id FROM pages WHERE slug = ANY($1::text[])', [slugs]);
  return slugs.map(s => { const p = r.find(x => x.slug === s)!; return { slug: s, page_id: Number(p.id), source_id: p.source_id, score: 1, title: s, type: 'note', chunk_text: '', chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, stale: false } as SearchResult; });
}
const scope = { sourceId: 'default', excludePrivate: false };

async function seed() {
  await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO. Discount: 12 percent.');
  await put('notes/renewal', 'note', 'Renewal memo', 'Widget Co renewal: discount stays at 12 percent.');
  await put('syntheses/widget', 'synthesis', 'Summary: Widget Co', 'Widget Co discount is 10 percent (summary).', { dream_generated: true });
  await put('receipts/r1', 'extract_receipt', 'Extract receipt', 'Extracted from Widget Co notes: discount 10 percent.');
  await put('notes/human', 'note', 'Human note', 'Widget Co discount history by hand.');
  await sweep(engine);
}

describe('generated-page demotion', () => {
  test('dream_generated and extract_receipt rows are stamped and demoted when a primary record for the entity is in the pool', async () => {
    await seed();
    const list = await rows(['syntheses/widget', 'receipts/r1', 'crm/widget-co', 'notes/human']);
    await applyGeneratedDemotion(engine, list, 'Widget Co discount', scope);
    const by = Object.fromEntries(list.map(r => [r.slug, r]));
    expect(by['syntheses/widget']).toMatchObject({ provenance: 'generated', score: GENERATED_FACTOR, generated_demotion: GENERATED_FACTOR });
    expect(by['receipts/r1']).toMatchObject({ provenance: 'generated', score: GENERATED_FACTOR });
    expect(by['notes/human'].provenance).toBeUndefined();
    expect(by['notes/human'].score).toBe(1);
    expect(by['crm/widget-co'].score).toBe(1);
  });

  test('no competing primary record, or no resolved entity: nothing moves (rows still stamped)', async () => {
    await seed();
    const alone = await rows(['syntheses/widget']);
    await applyGeneratedDemotion(engine, alone, 'Widget Co discount', scope);
    expect(alone[0]).toMatchObject({ provenance: 'generated', score: 1 });
    const unnamed = await rows(['syntheses/widget', 'crm/widget-co']);
    await applyGeneratedDemotion(engine, unnamed, 'what discount did we give', scope);
    expect(unnamed[0]!.score).toBe(1);
  });

  test('a generated page about another entity is not demoted for this one', async () => {
    await seed();
    await put('crm/kite-co', 'crm', 'CRM record: Kite Co', 'Account code: KTCO.');
    await put('syntheses/kite', 'synthesis', 'Summary: Kite Co', 'Kite Co discount is 5 percent.', { dream_generated: true });
    await sweep(engine);
    const list = await rows(['syntheses/kite', 'crm/widget-co']);
    await applyGeneratedDemotion(engine, list, 'Widget Co discount', scope);
    expect(list[0]!.score).toBe(1);
  });

  test('a generated correction is never demoted and keeps outranking the obsolete original', async () => {
    await seed();
    await put('syntheses/correction', 'synthesis', 'Correction: Widget Co discount', 'Widget Co discount corrected to 15 percent.', { dream_generated: true, supersedes: 'notes/renewal' });
    await sweep(engine);
    const list = await rows(['syntheses/correction', 'notes/renewal', 'crm/widget-co']);
    list[0]!.score = 2;
    await applyGeneratedDemotion(engine, list, 'Widget Co discount', scope);
    expect(list[0]).toMatchObject({ provenance: 'generated', score: 2 });
    expect(list[0]!.generated_demotion).toBeUndefined();
    expect(recordsCorrection(null, '## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Discount 10 | fact | 1.0 | world | medium | 2026-01-01 | 2026-03-01 | test |  |\n<!--- gbrain:facts:end -->\n')).toBe(true);
  });

  test('search.demote_generated=false keeps scores', async () => {
    await seed();
    await engine.setConfig('search.demote_generated', 'false');
    const list = await rows(['syntheses/widget', 'crm/widget-co']);
    await applyGeneratedDemotion(engine, list, 'Widget Co discount', scope);
    expect(list[0]).toMatchObject({ provenance: 'generated', score: 1 });
  });

  test('end to end (keyword path, no reranker): the record ranks above the summary', async () => {
    await seed();
    const r = await dispatchToolCall(engine, 'search', { query: 'Widget Co discount', fields: 'full' }, { remote: false, sourceId: 'default', config: { engine: 'pglite' } } as never);
    const slugs = (JSON.parse(r.content[0].text!) as Array<{ slug: string; provenance?: string }>);
    const at = (s: string) => slugs.findIndex(x => x.slug === s);
    expect(at('syntheses/widget')).toBeGreaterThan(-1);
    expect(at('syntheses/widget')).toBeGreaterThan(at('crm/widget-co'));
    expect(slugs.find(x => x.slug === 'syntheses/widget')!.provenance).toBe('generated');
  });
});
