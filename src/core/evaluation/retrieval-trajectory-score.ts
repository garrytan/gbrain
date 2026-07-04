import type { RetrievalTrace } from '../types.ts';

export interface RetrievalTrajectoryWeights {
  groundedness: number;
  redundancy: number;
  cost: number;
}

export interface RetrievalTrajectoryScoreOptions {
  max_steps?: number;
  weights?: Partial<RetrievalTrajectoryWeights>;
  groundedness?: number | null;
  evidence_texts?: string[];
}

export interface RetrievalTrajectoryScore {
  trace_id: string;
  j: number;
  groundedness: number | null;
  redundancy: number;
  redundancy_basis: 'evidence_text' | 'source_ref' | 'none';
  cost: number;
  route_length: number;
  re_escalations: number;
  source_ref_count: number;
  elapsed_ms: number | null;
  retrieved_token_count: number | null;
}

export interface RetrievalTrajectorySummary {
  trace_count: number;
  average_j: number;
  average_groundedness: number | null;
  average_redundancy: number;
  average_cost: number;
  average_elapsed_ms: number | null;
  retrieved_token_count_total: number;
  groundedness_status: 'available' | 'unavailable_without_gold';
  latest_trace_id: string | null;
}

const DEFAULT_WEIGHTS: RetrievalTrajectoryWeights = {
  groundedness: 1,
  redundancy: 0.3,
  cost: 0.1,
};

export function scoreRetrievalTrajectory(
  trace: RetrievalTrace,
  options: RetrievalTrajectoryScoreOptions = {},
): RetrievalTrajectoryScore {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  const maxSteps = Math.max(1, Math.floor(options.max_steps ?? 6));
  const routeLength = trace.route.length;
  const reEscalations = trace.route.filter(isReEscalationStep).length;
  const cost = clamp01((routeLength / maxSteps) + (0.2 * reEscalations));
  const redundancyInput = redundancyInputs(options.evidence_texts, trace.source_refs);
  const redundancy = textRedundancy(redundancyInput.values);
  const groundedness = normalizeGroundedness(options.groundedness);
  const groundednessContribution = groundedness === null ? 0 : weights.groundedness * groundedness;
  const j = groundednessContribution - (weights.redundancy * redundancy) - (weights.cost * cost);

  return {
    trace_id: trace.id,
    j,
    groundedness,
    redundancy,
    redundancy_basis: redundancyInput.basis,
    cost,
    route_length: routeLength,
    re_escalations: reEscalations,
    source_ref_count: trace.source_refs.length,
    elapsed_ms: trace.elapsed_ms,
    retrieved_token_count: trace.retrieved_token_count,
  };
}

export function summarizeRetrievalTrajectoryScores(
  scores: RetrievalTrajectoryScore[],
): RetrievalTrajectorySummary {
  const groundedScores = scores
    .map((score) => score.groundedness)
    .filter((value): value is number => value !== null);
  const elapsedValues = scores
    .map((score) => score.elapsed_ms)
    .filter((value): value is number => typeof value === 'number');

  return {
    trace_count: scores.length,
    average_j: average(scores.map((score) => score.j)),
    average_groundedness: groundedScores.length === 0 ? null : average(groundedScores),
    average_redundancy: average(scores.map((score) => score.redundancy)),
    average_cost: average(scores.map((score) => score.cost)),
    average_elapsed_ms: elapsedValues.length === 0 ? null : average(elapsedValues),
    retrieved_token_count_total: scores.reduce((total, score) => total + (score.retrieved_token_count ?? 0), 0),
    groundedness_status: groundedScores.length === 0 ? 'unavailable_without_gold' : 'available',
    latest_trace_id: scores[0]?.trace_id ?? null,
  };
}

function redundancyInputs(
  evidenceTexts: string[] | undefined,
  sourceRefs: string[],
): { values: string[]; basis: RetrievalTrajectoryScore['redundancy_basis'] } {
  const evidence = (evidenceTexts ?? []).map((text) => text.trim()).filter(Boolean);
  if (evidence.length > 0) return { values: evidence, basis: 'evidence_text' };
  const refs = unique(sourceRefs);
  if (refs.length > 0) return { values: refs, basis: 'source_ref' };
  return { values: [], basis: 'none' };
}

function textRedundancy(values: string[]): number {
  if (values.length <= 1) return 0;
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      total += jaccard(tokens(values[left]!), tokens(values[right]!));
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : clamp01(total / pairs);
}

function tokens(value: string): Set<string> {
  const raw = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return new Set(raw);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isReEscalationStep(step: string): boolean {
  return /(^|[^a-z0-9])(re[-_ ]?escalat|retry|fallback|second[-_ ]pass)([^a-z0-9]|$)/i.test(step);
}

function normalizeGroundedness(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
