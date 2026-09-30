/**
 * The contextual-retrieval convention a markdown import records with its
 * canonical write (#5621): the page/source/global override chain, with the
 * per-chunk synopsis tier demoted to the free title tier (the synopsis tier
 * is the Minion backfill's job), plus the corpus generation that tier embeds
 * under. Shared by `importFromContent` and `gbrain repair contextual-mode`,
 * so an existing page is stamped exactly as a fresh import would stamp it.
 *
 * `strict` (coordinated writes and repairs) fails on any source-row read
 * error. Otherwise only a missing row ('default' not seeded on a fresh brain)
 * or a missing sources table keeps the host-trust defaults; any other failed
 * read fails, because falling back would stamp the wrong source's convention.
 */
import type { BrainEngine } from './engine.ts';
import { resolveContextualRetrievalMode } from './contextual-retrieval-resolver.ts';
import { loadSearchModeConfig, resolveSearchMode } from './search/mode.ts';
import { isUndefinedTableError } from './utils.ts';
import { computeCorpusGeneration, loadSourceRow, SourceRowNotFoundError } from './contextual-retrieval-service.ts';
import { DEFAULT_SYNOPSIS_MODEL } from './page-summary.ts';

export async function resolveImportContextualMode(engine: BrainEngine, sourceId: string, frontmatter: Record<string, unknown> | null | undefined,
  strict: boolean): Promise<{ mode: 'none' | 'title'; corpusGeneration: string | null }> {
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
  let source: { id: string; contextual_retrieval_mode?: string | null; trust_frontmatter_overrides?: boolean } =
    { id: sourceId, contextual_retrieval_mode: null, trust_frontmatter_overrides: false };
  try {
    const row = await loadSourceRow(engine, sourceId);
    source = { id: row.id, contextual_retrieval_mode: row.contextual_retrieval_mode ?? null, trust_frontmatter_overrides: row.trust_frontmatter_overrides === true };
  } catch (error) {
    if (strict || !(error instanceof SourceRowNotFoundError || isUndefinedTableError(error))) throw error;
  }
  const resolution = resolveContextualRetrievalMode({ pageFrontmatter: frontmatter ?? {}, source,
    globalMode: knobs.contextual_retrieval, killSwitchDisabled: knobs.contextual_retrieval_disabled });
  const effectiveCRMode = resolution.mode === 'per_chunk_synopsis' ? 'title' : resolution.mode;
  const mode = effectiveCRMode === 'none' ? 'none' : 'title';
  // The inline path never uses per_chunk_synopsis, so the doc-cap field stays out of the hash.
  return { mode, corpusGeneration: mode === 'none' ? null : computeCorpusGeneration({ crMode: mode, synopsisModel: DEFAULT_SYNOPSIS_MODEL }) };
}
