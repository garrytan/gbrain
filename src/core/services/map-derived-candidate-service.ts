import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry } from '../types.ts';
import { getStructuralContextMapReport } from './context-map-report-service.ts';

const READY_MAP_CONFIDENCE = 0.65;
const STALE_MAP_CONFIDENCE = 0.35;

export interface CaptureMapDerivedCandidatesInput {
  map_id?: string;
  scope_id?: string;
  limit?: number;
}

export interface CaptureMapDerivedCandidatesResult {
  selection_reason: string;
  map_status: 'ready' | 'stale' | null;
  candidates: MemoryCandidateEntry[];
}

export async function captureMapDerivedCandidates(
  engine: BrainEngine,
  input: CaptureMapDerivedCandidatesInput = {},
): Promise<CaptureMapDerivedCandidatesResult> {
  const reportResult = await getStructuralContextMapReport(engine, {
    map_id: input.map_id,
    scope_id: input.scope_id,
  });

  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      map_status: null,
      candidates: [],
    };
  }

  const boundedLimit = normalizeCaptureLimit(input.limit, reportResult.report.recommended_reads.length);
  const reads = reportResult.report.recommended_reads.slice(0, boundedLimit);
  const candidates: MemoryCandidateEntry[] = [];
  const reportStatus = reportResult.report.status;
  const mapStatus = normalizeMapStatus(reportStatus);

  for (const [index, read] of reads.entries()) {
    const candidate = await engine.createMemoryCandidateEntry({
      id: crypto.randomUUID(),
      scope_id: reportResult.report.scope_id,
      candidate_type: 'note_update',
      proposed_content: `Context map recommends reviewing ${read.label} (${read.path}) in ${reportResult.report.title}.`,
      source_refs: [
        `Context map report, map_id=${reportResult.report.map_id}, status=${reportStatus}`,
        `Context map recommended read, path=${read.path}, page_slug=${read.page_slug}${read.section_id ? `, section_id=${read.section_id}` : ''}`,
      ],
      generated_by: 'map_analysis',
      extraction_kind: mapStatus === 'ready' ? 'inferred' : 'ambiguous',
      confidence_score: mapStatus === 'ready' ? READY_MAP_CONFIDENCE : STALE_MAP_CONFIDENCE,
      importance_score: roundScore(Math.max(0.4, 0.8 - (index * 0.05))),
      recurrence_score: 0,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: read.page_slug,
      reviewed_at: null,
      review_reason: null,
    });
    candidates.push(candidate);
  }

  return {
    selection_reason: reportResult.selection_reason,
    map_status: mapStatus,
    candidates,
  };
}

function normalizeMapStatus(status: string): 'ready' | 'stale' | null {
  if (status === 'ready' || status === 'stale') {
    return status;
  }
  return null;
}

function normalizeCaptureLimit(limit: number | undefined, reportReadCount: number): number {
  if (!Number.isFinite(limit)) {
    return reportReadCount;
  }
  return Math.max(0, Math.min(reportReadCount, Math.floor(limit ?? reportReadCount)));
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
