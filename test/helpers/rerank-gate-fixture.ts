/**
 * W3 rerank gate fixture shared by test/search/rerank-gate-hybrid.test.ts
 * (shadow) and test/search/rerank-gate-skip.test.ts (on): seven queries, one
 * per grade outcome, a deterministic query embedder and a stub reranker that
 * reverses fused order (so a skipped or reordered input shows), with counters
 * on the alias-table and page reads.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { installFixtureChunks } from './page-projection.ts';

export const DIM = 1536;

/** Unit vector with cosine `cos` to basis `dim` and 0 to every other fixture dim. */
function leaning(cos: number, dim: number, privateDim: number): Float32Array {
  const e = new Float32Array(DIM);
  e[dim] = cos;
  e[privateDim] = Math.sqrt(1 - cos * cos);
  return e;
}

export const QUERY_DIM: Record<string, number> = {
  'orbital period of the gold probe': 12,
  'tidal locking near twins': 13,
  'Acme Widget': 14,
  'the hall': 15,
  'hall of light': 16,
  'notes/gold-probe': 12,
  'magnetar spin rate': 17,
};

export const EXPECTED: Record<string, { grade: 'strong' | 'not_strong'; reason: string; would_skip: boolean; skip_blocked?: string }> = {
  'orbital period of the gold probe': { grade: 'strong', reason: 'high_vector_match', would_skip: true },
  'tidal locking near twins': { grade: 'not_strong', reason: 'gap_below_min', would_skip: false },
  'Acme Widget': { grade: 'strong', reason: 'exact_lookup', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'the hall': { grade: 'not_strong', reason: 'identity_ambiguous', would_skip: false },
  'hall of light': { grade: 'strong', reason: 'alias_hit', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'notes/gold-probe': { grade: 'strong', reason: 'exact_lookup', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'magnetar spin rate': { grade: 'not_strong', reason: 'below_trust_floor', would_skip: false },
};

export async function seed(engine: BrainEngine): Promise<void> {
  const page = async (slug: string, title: string, chunks: Array<[string, Float32Array]>) => {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: chunks.map(([t]) => t).join('\n\n') });
    await installFixtureChunks(engine, slug, chunks.map(([text, embedding], i) => ({
      chunk_index: i, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding, token_count: 12,
    })));
  };
  await page('notes/gold-probe', 'Gold Probe', [['the orbital period of the gold probe is ninety minutes', basisEmbedding(12, DIM)]]);
  await page('notes/decoy-one', 'Decoy One', [['an orbital period table for other probes', leaning(0.6, 12, 700)]]);
  await page('notes/decoy-two', 'Decoy Two', [['gold mining notes, unrelated probe', leaning(0.5, 12, 701)]]);
  await page('notes/twin-a', 'Twin A', [
    ['tidal locking near twins: the inner pair', leaning(0.95, 13, 702)],
    ['tidal locking near twins: the second half', leaning(0.94, 13, 703)],
  ]);
  await page('notes/twin-b', 'Twin B', [['tidal locking near twins: the outer pair', leaning(0.93, 13, 704)]]);
  await page('companies/acme-widget', 'Acme Widget', [
    ['acme widget makes small brass gears', leaning(0.3, 14, 705)],
    ['acme widget was founded in a garage', leaning(0.31, 14, 706)],
  ]);
  await page('notes/acme-widget-review', 'Acme Widget Review', [['a review of the acme widget gearbox', leaning(0.5, 14, 707)]]);
  await page('places/the-hall', 'The Great Hall', [['the hall seats four hundred', leaning(0.4, 15, 708)]]);
  await page('places/other-hall', 'Other Hall', [['the other hall is closed on mondays', leaning(0.3, 15, 709)]]);
  await page('projects/mingtang', 'Mingtang', [['the mingtang ritual building', leaning(0.2, 16, 710)]]);
  await page('notes/magnetar', 'Magnetar Notes', [['magnetar spin rate measurements', basisEmbedding(17, DIM)]]);
  await page('notes/magnetar-other', 'Pulsar Notes', [['pulsar spin rate measurements', leaning(0.3, 17, 711)]]);
  await engine.setPageAliases('places/the-hall', 'default', ['the hall']);
  await engine.setPageAliases('places/other-hall', 'default', ['the hall']);
  await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
  await engine.executeRaw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE source_id = 'default' AND slug = 'notes/magnetar'");
}

export interface Run { results: SearchResult[]; meta: HybridSearchMeta; payloads: RerankInput[]; aliasReads: number; pageReads: number }

export async function run(
  engine: BrainEngine, query: string, rerankGate: 'off' | 'shadow' | 'on',
  { topNOut = null, rerankerEnabled = true }: { topNOut?: number | null; rerankerEnabled?: boolean } = {},
): Promise<Run> {
  const payloads: RerankInput[] = [];
  let aliasReads = 0;
  let pageReads = 0;
  const counted = new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'resolveAliases') return (...args: unknown[]) => { aliasReads++; return (value as Function).apply(target, args); };
      if (prop === 'getPage') return (...args: unknown[]) => { pageReads++; return (value as Function).apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(counted, query, {
    limit: 10,
    autocut: false,
    rerankGate,
    queryEmbedFn: () => basisEmbedding(QUERY_DIM[query], DIM),
    onMeta: (m) => { meta = m; },
    reranker: {
      enabled: rerankerEnabled, topNIn: 30, topNOut,
      // Reverse the fused order so a skipped or reordered input would show.
      rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => {
        payloads.push(structuredClone({ query: input.query, documents: input.documents }) as RerankInput);
        return input.documents.map((_, i) => ({ index: input.documents.length - 1 - i, relevanceScore: 1 - i * 0.05 }));
      },
    },
  });
  return { results, meta: meta!, payloads, aliasReads, pageReads };
}
