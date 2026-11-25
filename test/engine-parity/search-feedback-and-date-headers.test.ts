/**
 * BrainEngine parity — the search feedback stage's weight read (search/feedback-boost.ts, through
 * BrainEngine.readPageFeedbackWeights) and the evidence date header's page read (search/evidence-date.ts
 * loadPageDateHeaders, through BrainEngine.readPageDateFieldsByIds).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with feedback on, the stage boosts each result by its page's learned weight (halved toward neutral after
 *    the page changed since it was rated, neutral without a rating) and reorders the list, equal on every engine. The
 *    date header of each page hit is its observation date (slug date, else frontmatter date), soft-deleted pages
 *    included, equal on every engine.
 *  - Regression: both reads were raw SQL inside a catch that turned any error, a refusal included, into "no boost" or
 *    "date unknown", so on a Rust brain feedback never moved a result and every page header read unknown.
 *  - Why existing coverage misses it: the feedback-boost and evidence-date tests run on PGLite only.
 *  - Seam: none. Real engines, the stage and header functions as search calls them, and the typed members.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { applyFeedbackStage } from '../../src/core/search/feedback-boost.ts';
import { loadPageDateHeaders } from '../../src/core/search/evidence-date.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

async function page(engine: BrainEngine, slug: string, frontmatter: Record<string, unknown> = {}): Promise<{ id: number; hash: string | null }> {
  await seedPage(engine, { slug, input: { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '', frontmatter }, chunks: [chunk(0, `Body of ${slug}.`)] });
  const p = await engine.getPage(slug, { sourceId: 'default' });
  return { id: Number(p!.id), hash: (p as { content_hash?: string | null }).content_hash ?? null };
}

describe('engine parity: the search feedback weights and the page date headers', () => {
  parityTest('the feedback stage boosts and reorders by learned weight, halved after an edit, neutral when unrated',
    { methods: ['putPage', 'insertRetrievalEvents', 'applyRetrievalRatings', 'readPageFeedbackWeights'], timeout: 120_000 }, async (engine) => {
      const liked = await page(engine, 'notes/liked');
      const edited = await page(engine, 'notes/edited');
      const plain = await page(engine, 'notes/plain');
      await engine.insertRetrievalEvents([{ id: 'ev-1', client_id: 'cli', op: 'query', links: [], pages: [
        { source_id: 'default', slug: 'notes/liked', content_hash: liked.hash, rank: 1, cited: false },
        { source_id: 'default', slug: 'notes/edited', content_hash: 'an-older-hash', rank: 2, cited: false },
      ] }]);
      await engine.applyRetrievalRatings({ eventId: 'ev-1', clientId: 'cli', signal: 'explicit', alpha: 0.3, targets: [
        { kind: 'page', source_id: 'default', key: 'notes/liked', rating: 5, content_hash: liked.hash },
        { kind: 'page', source_id: 'default', key: 'notes/edited', rating: 5, content_hash: 'an-older-hash' },
      ] });
      await engine.setConfig('feedback.enabled', 'true');
      await engine.setConfig('feedback.influence', '0.5');
      const name = (id: number) => id === liked.id ? 'liked' : id === edited.id ? 'edited' : id === plain.id ? 'plain' : 'other';
      const weights = (await engine.readPageFeedbackWeights([plain.id, edited.id, liked.id, 999_999]))
        .map(r => ({ page: name(r.id), weight: r.weight, hash_matches: r.content_hash === (r.id === liked.id ? liked.hash : r.id === edited.id ? edited.hash : plain.hash) }))
        .sort((a, b) => (a.page < b.page ? -1 : 1));
      const results = [plain, edited, liked].map((p, i) => ({ page_id: p.id, slug: name(p.id), score: 1 - i * 0.01 })) as unknown as SearchResult[];
      const metas: unknown[] = [];
      const ranked = (await applyFeedbackStage(engine, results, { reranked: false, onMeta: m => metas.push(m) }))
        .map(r => ({ page: r.slug, boost: (r as { feedback_boost?: number }).feedback_boost ?? null }));
      const out = { weights, ranked, metas };
      expect(out.weights.map(w => [w.page, w.weight === null ? null : Math.round(w.weight * 1e6) / 1e6, w.hash_matches]))
        .toEqual([['edited', 0.575, true], ['liked', 0.65, true], ['plain', null, true]]);
      expect(out.ranked.map(r => r.page)).toEqual(['liked', 'edited', 'plain']);
      expect(out.metas).toEqual([{ applied: true, boosted: 2, errored: false }]);
      return out;
    });

  parityTest('page date headers come from the slug date, else the frontmatter date, for every page row the ids name',
    { methods: ['putPage', 'softDeletePage', 'readPageDateFieldsByIds'], timeout: 120_000 }, async (engine) => {
      const dated = await page(engine, 'meetings/2025-06-01-harbor');
      const fm = await page(engine, 'notes/harbor-update', { date: '2025-09-02' });
      const none = await page(engine, 'notes/undated');
      const gone = await page(engine, 'meetings/2025-03-04-retired');
      await engine.softDeletePage('meetings/2025-03-04-retired', { sourceId: 'default' });
      const name = (id: number) => ({ [dated.id]: 'dated', [fm.id]: 'frontmatter', [none.id]: 'undated', [gone.id]: 'soft-deleted' } as Record<number, string>)[id] ?? 'other';
      const headers = await loadPageDateHeaders(engine, [dated.id, fm.id, none.id, gone.id, 999_999]);
      const rows = (await engine.readPageDateFieldsByIds([gone.id, dated.id])).map(r => ({ page: name(r.id), slug: r.slug, import_filename: r.import_filename ?? null }))
        .sort((a, b) => (a.page < b.page ? -1 : 1));
      const out = { headers: Object.fromEntries([...headers].map(([id, h]) => [name(id), h]).sort()), rows, none: await engine.readPageDateFieldsByIds([]) };
      expect(Object.keys(out.headers)).toEqual(['dated', 'frontmatter', 'soft-deleted', 'undated']);
      expect(out.headers.dated).toContain('2025-06-01');
      expect(out.headers.frontmatter).toContain('2025-09-02');
      expect(out.headers['soft-deleted']).toContain('2025-03-04');
      expect(out.rows.map(r => r.page)).toEqual(['dated', 'soft-deleted']);
      expect(out.none).toEqual([]);
      return out;
    });
});
