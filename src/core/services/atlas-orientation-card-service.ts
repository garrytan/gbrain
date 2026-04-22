import type { BrainEngine } from '../engine.ts';
import type {
  AtlasOrientationCard,
  AtlasOrientationCardInput,
  AtlasOrientationCardResult,
  ContextAtlasEntry,
} from '../types.ts';
import { getStructuralContextAtlasEntry, selectStructuralContextAtlasEntry } from './context-atlas-service.ts';
import { getWorkspaceCorpusCard } from './workspace-corpus-card-service.ts';

export async function getAtlasOrientationCard(
  engine: BrainEngine,
  input: AtlasOrientationCardInput = {},
): Promise<AtlasOrientationCardResult> {
  const selection = await resolveAtlasEntry(engine, input);
  if (!selection.entry) {
    return {
      selection_reason: selection.selection_reason,
      candidate_count: selection.candidate_count,
      card: null,
    };
  }

  const corpusCard = await getWorkspaceCorpusCard(engine, {
    map_id: selection.entry.map_id,
    scope_id: selection.entry.scope_id,
  });
  if (!corpusCard.card) {
    return {
      selection_reason: 'no_corpus_card',
      candidate_count: selection.candidate_count,
      card: null,
    };
  }

  return {
    selection_reason: selection.selection_reason,
    candidate_count: selection.candidate_count,
    card: buildCard(selection.entry, corpusCard.card),
  };
}

async function resolveAtlasEntry(
  engine: BrainEngine,
  input: AtlasOrientationCardInput,
): Promise<{
  selection_reason: string;
  candidate_count: number;
  entry: ContextAtlasEntry | null;
}> {
  if (input.atlas_id) {
    const entry = await getStructuralContextAtlasEntry(engine, input.atlas_id);
    return {
      selection_reason: entry ? 'direct_atlas_id' : 'atlas_not_found',
      candidate_count: entry ? 1 : 0,
      entry,
    };
  }

  const selected = await selectStructuralContextAtlasEntry(engine, {
    scope_id: input.scope_id,
    kind: input.kind,
    max_budget_hint: input.max_budget_hint,
    allow_stale: input.allow_stale,
  });
  return {
    selection_reason: selected.reason,
    candidate_count: selected.candidate_count,
    entry: selected.entry,
  };
}

function buildCard(
  entry: ContextAtlasEntry,
  corpusCard: Awaited<ReturnType<typeof getWorkspaceCorpusCard>>['card'] extends infer T ? Exclude<T, null> : never,
): AtlasOrientationCard {
  return {
    card_kind: 'atlas_orientation',
    title: `${entry.title} Orientation Card`,
    atlas_entry_id: entry.id,
    map_id: entry.map_id,
    freshness: entry.freshness,
    budget_hint: entry.budget_hint,
    anchor_slugs: corpusCard.anchor_slugs,
    recommended_reads: corpusCard.recommended_reads,
    summary_lines: [
      `Atlas freshness is ${entry.freshness}.`,
      `Atlas budget hint is ${entry.budget_hint}.`,
      `Anchor artifacts attached: ${corpusCard.anchor_slugs.length}.`,
      `Compact recommended reads available: ${corpusCard.recommended_reads.length}.`,
    ],
  };
}
