import type { ContextAtlasOverviewArtifact, ContextAtlasOverviewInput, ContextAtlasReport, ContextAtlasReportResult } from '../types.ts';
import type { BrainEngine } from '../engine.ts';
import { getStructuralContextAtlasOverview } from './context-atlas-overview-service.ts';

export async function getStructuralContextAtlasReport(
  engine: BrainEngine,
  input: ContextAtlasOverviewInput = {},
): Promise<ContextAtlasReportResult> {
  const overview = await getStructuralContextAtlasOverview(engine, input);
  if (!overview.overview) {
    return {
      selection_reason: overview.selection_reason,
      candidate_count: overview.candidate_count,
      report: null,
    };
  }

  return {
    selection_reason: overview.selection_reason,
    candidate_count: overview.candidate_count,
    report: buildAtlasReport(overview.overview),
  };
}

function buildAtlasReport(overview: ContextAtlasOverviewArtifact): ContextAtlasReport {
  const { entry, recommended_reads } = overview;
  const summaryLines = [
    `Atlas freshness is ${entry.freshness}.`,
    `Budget hint is ${entry.budget_hint}.`,
    `Recommended reads available: ${recommended_reads.length}.`,
    entry.freshness === 'stale'
      ? 'Rebuild the linked context map and atlas before trusting routing output.'
      : 'This atlas is safe to use for orientation under the current scope.',
  ];

  return {
    report_kind: 'structural',
    title: `${entry.title} Report`,
    entry_id: entry.id,
    freshness: entry.freshness,
    summary_lines: summaryLines,
    recommended_reads,
  };
}
