import type { BrainEngine } from '../engine.ts';
import type {
  BroadSynthesisRoute,
  BroadSynthesisRouteInput,
  BroadSynthesisRouteRead,
  BroadSynthesisRouteResult,
  ContextMapExplanation,
  ContextMapQueryMatch,
  ContextMapReport,
} from '../types.ts';
import { getStructuralContextMapExplanation } from './context-map-explain-service.ts';
import { queryStructuralContextMap } from './context-map-query-service.ts';
import { getStructuralContextMapReport } from './context-map-report-service.ts';

export async function getBroadSynthesisRoute(
  engine: BrainEngine,
  input: BroadSynthesisRouteInput,
): Promise<BroadSynthesisRouteResult> {
  const reportResult = await getStructuralContextMapReport(engine, input);
  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      candidate_count: reportResult.candidate_count,
      route: null,
    };
  }

  const queryResult = await queryStructuralContextMap(engine, {
    map_id: reportResult.report.map_id,
    query: input.query,
    limit: input.limit,
  });

  const matchedNodes = queryResult.result?.matched_nodes ?? [];
  const focalNodeId = matchedNodes[0]?.node_id ?? null;
  const explanation = focalNodeId
    ? (await getStructuralContextMapExplanation(engine, {
        map_id: reportResult.report.map_id,
        node_id: focalNodeId,
      })).explanation
    : null;

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    route: buildBroadSynthesisRoute({
      report: reportResult.report,
      query: input.query,
      matchedNodes,
      explanation,
    }),
  };
}

function buildBroadSynthesisRoute(input: {
  report: ContextMapReport;
  query: string;
  matchedNodes: ContextMapQueryMatch[];
  explanation: ContextMapExplanation | null;
}): BroadSynthesisRoute {
  const focalNodeId = input.matchedNodes[0]?.node_id ?? null;
  const recommendedReads = dedupeReads([
    ...(input.explanation?.recommended_reads ?? []),
    ...input.report.recommended_reads,
  ]);

  return {
    route_kind: 'broad_synthesis',
    map_id: input.report.map_id,
    query: input.query,
    status: input.report.status,
    retrieval_route: focalNodeId
      ? [
          'curated_notes',
          'context_map_report',
          'context_map_query',
          'context_map_explain',
          'canonical_follow_through',
        ]
      : [
          'curated_notes',
          'context_map_report',
          'context_map_query',
          'canonical_follow_through',
        ],
    focal_node_id: focalNodeId,
    summary_lines: buildSummaryLines(input.report, input.matchedNodes, focalNodeId),
    matched_nodes: input.matchedNodes,
    recommended_reads: recommendedReads,
  };
}

function buildSummaryLines(
  report: ContextMapReport,
  matchedNodes: ContextMapQueryMatch[],
  focalNodeId: string | null,
): string[] {
  const lines = [
    `Context map status is ${report.status}.`,
    `Matched structural nodes available: ${matchedNodes.length}.`,
  ];

  if (focalNodeId) {
    lines.push(`Focal structural node is ${focalNodeId}.`);
  } else {
    lines.push('No structural node matched the route query; fall back to report-driven orientation.');
  }

  lines.push(
    report.status === 'stale'
      ? 'Rebuild the context map before trusting this broad-synthesis route.'
      : 'Open canonical reads before treating this broad-synthesis route as truth.',
  );

  return lines;
}

function dedupeReads(reads: BroadSynthesisRouteRead[]): BroadSynthesisRouteRead[] {
  const deduped: BroadSynthesisRouteRead[] = [];
  const seenPageSlugs = new Set<string>();

  for (const read of reads) {
    if (seenPageSlugs.has(read.page_slug)) continue;
    seenPageSlugs.add(read.page_slug);
    deduped.push(read);
  }

  return deduped;
}
