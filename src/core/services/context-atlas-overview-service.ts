import type { BrainEngine } from '../engine.ts';
import type {
  ContextAtlasEntry,
  ContextAtlasOverviewArtifact,
  ContextAtlasOverviewInput,
  ContextAtlasOverviewRead,
  ContextAtlasOverviewResult,
} from '../types.ts';
import { ATLAS_ENTRYPOINT_LIMIT, getStructuralContextAtlasEntry, selectStructuralContextAtlasEntry } from './context-atlas-service.ts';

export async function getStructuralContextAtlasOverview(
  engine: BrainEngine,
  input: ContextAtlasOverviewInput = {},
): Promise<ContextAtlasOverviewResult> {
  if (input.atlas_id) {
    const entry = await getStructuralContextAtlasEntry(engine, input.atlas_id);
    if (!entry) {
      return {
        selection_reason: 'atlas_not_found',
        candidate_count: 0,
        overview: null,
      };
    }
    return {
      selection_reason: 'direct_atlas_id',
      candidate_count: 1,
      overview: {
        overview_kind: 'structural',
        entry,
        recommended_reads: await resolveAtlasRecommendedReads(engine, entry),
      },
    };
  }

  const selection = await selectStructuralContextAtlasEntry(engine, input);
  if (!selection.entry) {
    return {
      selection_reason: selection.reason,
      candidate_count: selection.candidate_count,
      overview: null,
    };
  }

  return {
    selection_reason: selection.reason,
    candidate_count: selection.candidate_count,
    overview: {
      overview_kind: 'structural',
      entry: selection.entry,
      recommended_reads: await resolveAtlasRecommendedReads(engine, selection.entry),
    },
  };
}

async function resolveAtlasRecommendedReads(
  engine: BrainEngine,
  entry: ContextAtlasEntry,
): Promise<ContextAtlasOverviewRead[]> {
  const resolved = await Promise.all(
    entry.entrypoints
      .slice(0, ATLAS_ENTRYPOINT_LIMIT)
      .map((nodeId) => resolveAtlasEntrypoint(engine, entry.scope_id, nodeId)),
  );
  return resolved.filter((candidate): candidate is ContextAtlasOverviewRead => candidate !== null);
}

async function resolveAtlasEntrypoint(
  engine: BrainEngine,
  scopeId: string,
  nodeId: string,
): Promise<ContextAtlasOverviewRead | null> {
  if (nodeId.startsWith('page:')) {
    const slug = nodeId.slice('page:'.length);
    const [manifest] = await engine.listNoteManifestEntries({
      scope_id: scopeId,
      slug,
      limit: 1,
    });
    if (!manifest) return null;
    return {
      node_id: nodeId,
      node_kind: 'page',
      label: manifest.title,
      page_slug: manifest.slug,
      path: manifest.path,
    };
  }

  if (nodeId.startsWith('section:')) {
    const sectionId = nodeId.slice('section:'.length);
    const [section] = await engine.listNoteSectionEntries({
      scope_id: scopeId,
      section_id: sectionId,
      limit: 1,
    });
    if (!section) return null;
    return {
      node_id: nodeId,
      node_kind: 'section',
      label: section.heading_text,
      page_slug: section.page_slug,
      path: section.page_path,
      section_id: section.section_id,
    };
  }

  return null;
}
