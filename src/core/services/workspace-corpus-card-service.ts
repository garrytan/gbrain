import type { BrainEngine } from '../engine.ts';
import type {
  WorkspaceCorpusCard,
  WorkspaceCorpusCardInput,
  WorkspaceCorpusCardResult,
} from '../types.ts';
import { getWorkspaceOrientationBundle } from './workspace-orientation-bundle-service.ts';

const CORPUS_CARD_READ_LIMIT = 3;

export async function getWorkspaceCorpusCard(
  engine: BrainEngine,
  input: WorkspaceCorpusCardInput = {},
): Promise<WorkspaceCorpusCardResult> {
  const bundleResult = await getWorkspaceOrientationBundle(engine, input);
  if (!bundleResult.bundle) {
    return {
      selection_reason: bundleResult.selection_reason,
      candidate_count: bundleResult.candidate_count,
      card: null,
    };
  }

  return {
    selection_reason: bundleResult.selection_reason,
    candidate_count: bundleResult.candidate_count,
    card: buildCard(bundleResult.bundle),
  };
}

function buildCard(
  bundle: Awaited<ReturnType<typeof getWorkspaceOrientationBundle>>['bundle'] extends infer T ? Exclude<T, null> : never,
): WorkspaceCorpusCard {
  const anchorSlugs = [
    bundle.project_card?.project_slug,
    bundle.system_card?.system_slug,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const recommendedReads = bundle.recommended_reads.slice(0, CORPUS_CARD_READ_LIMIT);
  const baseTitle = bundle.title.endsWith(' Bundle')
    ? bundle.title.slice(0, -' Bundle'.length)
    : bundle.title;

  return {
    card_kind: 'workspace_corpus',
    title: `${baseTitle} Corpus Card`,
    map_id: bundle.map_id,
    status: bundle.status,
    anchor_slugs: anchorSlugs,
    recommended_reads: recommendedReads,
    summary_lines: [
      `Context map status is ${bundle.status}.`,
      `Anchor artifacts attached: ${anchorSlugs.length}.`,
      bundle.system_card ? 'Workspace system anchor is available.' : 'Workspace system anchor is unavailable.',
      bundle.project_card ? 'Workspace project anchor is available.' : 'Workspace project anchor is unavailable.',
      `Compact recommended reads available: ${recommendedReads.length}.`,
    ],
  };
}
