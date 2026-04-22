import type {
  AtlasOrientationBundle,
  AtlasOrientationBundleInput,
  AtlasOrientationBundleResult,
} from '../types.ts';
import type { BrainEngine } from '../engine.ts';
import { getAtlasOrientationCard } from './atlas-orientation-card-service.ts';
import { getStructuralContextAtlasReport } from './context-atlas-report-service.ts';

export async function getAtlasOrientationBundle(
  engine: BrainEngine,
  input: AtlasOrientationBundleInput = {},
): Promise<AtlasOrientationBundleResult> {
  const reportResult = await getStructuralContextAtlasReport(engine, input);
  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      candidate_count: reportResult.candidate_count,
      bundle: null,
    };
  }

  const cardResult = await getAtlasOrientationCard(engine, {
    atlas_id: reportResult.report.entry_id,
  });
  if (!cardResult.card) {
    return {
      selection_reason: 'no_orientation_card',
      candidate_count: reportResult.candidate_count,
      bundle: null,
    };
  }

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    bundle: buildBundle(reportResult.report, cardResult.card),
  };
}

function buildBundle(
  report: Awaited<ReturnType<typeof getStructuralContextAtlasReport>>['report'] extends infer T ? Exclude<T, null> : never,
  card: Awaited<ReturnType<typeof getAtlasOrientationCard>>['card'] extends infer T ? Exclude<T, null> : never,
): AtlasOrientationBundle {
  return {
    bundle_kind: 'atlas_orientation',
    title: `${report.title} Bundle`,
    atlas_entry_id: report.entry_id,
    freshness: report.freshness,
    budget_hint: card.budget_hint,
    summary_lines: [
      `Atlas freshness is ${report.freshness}.`,
      `Atlas budget hint is ${card.budget_hint}.`,
      `Recommended reads available: ${report.recommended_reads.length}.`,
      `Anchor artifacts attached: ${card.anchor_slugs.length}.`,
    ],
    report,
    card,
  };
}
