import type { BrainEngine } from '../engine.ts';
import type { DerivedIndexState, SearchOpts, SearchResult } from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../services/note-manifest-service.ts';

export async function appendPendingDerivedSearchResults(
  engine: Pick<BrainEngine, 'listDerivedIndexStates' | 'getPageProjection'>,
  results: SearchResult[],
  opts?: SearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  if (results.length >= limit) return results.slice(0, limit);

  const seen = new Set(results.map((result) => result.slug));
  const excluded = new Set((opts?.exclude_slugs ?? []).map((slug) => slug.toLowerCase()));
  const fallback: SearchResult[] = [];
  const pageSize = Math.max(limit, 20);

  for (const status of ['pending', 'failed'] as const) {
    let offset = 0;
    while (results.length + fallback.length < limit) {
      const states = await engine.listDerivedIndexStates({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        artifact_kind: 'page_chunks',
        status,
        limit: pageSize,
        offset,
      });
      if (states.length === 0) break;

      for (const state of states) {
        if (seen.has(state.slug) || excluded.has(state.slug)) continue;
        const projection = await engine.getPageProjection(state.slug, {
          windows: { compiled_truth: { char_start: 0, char_limit: 320 } },
        });
        if (!projection) continue;
        if (opts?.type && projection.type !== opts.type) continue;

        seen.add(projection.slug);
        fallback.push(searchResultFromDerivedState(state, projection));
        if (results.length + fallback.length >= limit) {
          return [...results, ...fallback].slice(0, limit);
        }
      }

      offset += states.length;
      if (states.length < pageSize) break;
    }
  }

  return [...results, ...fallback].slice(0, limit);
}

function searchResultFromDerivedState(
  state: DerivedIndexState,
  projection: NonNullable<Awaited<ReturnType<BrainEngine['getPageProjection']>>>,
): SearchResult {
  return {
    slug: projection.slug,
    page_id: projection.id,
    title: projection.title,
    type: projection.type,
    chunk_text: projection.content_windows.compiled_truth?.text || projection.title,
    chunk_source: 'compiled_truth',
    score: 0,
    stale: true,
    derived_artifact_kind: state.artifact_kind,
    derived_status: state.status,
    derived_target_content_hash: state.target_content_hash,
    derived_indexed_content_hash: state.indexed_content_hash,
    derived_warning: `${state.artifact_kind} derived index is ${state.status}; canonical page-level match returned until derived data is current.`,
  };
}
