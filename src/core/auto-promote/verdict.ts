import type { RestrictedRunnerKind } from '../runners/runner-registry.ts';

export type PromotionDecision = 'promote' | 'reject' | 'defer';

export interface PromotionVerdict {
  candidate_id: string;
  decision: PromotionDecision;
  confidence: number;            // 0..1
  reasoning: string;
  source_refs: string[];
  proposed_patch?: Record<string, unknown>;
  runner_kind?: RestrictedRunnerKind;
  model?: string | null;
  prompt_version?: string;
  judged_at?: string;
}

export type ParseVerdictResult =
  | { ok: true; verdict: PromotionVerdict }
  | { ok: false; reason: string };

const DECISIONS: ReadonlySet<string> = new Set(['promote', 'reject', 'defer']);

export function parsePromotionVerdict(raw: string, candidateId: string): ParseVerdictResult {
  const json = normalizeJsonPayload(raw);
  if (json === null) return { ok: false, reason: 'not_json_only' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'json_parse_failed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const o = parsed as Record<string, unknown>;
  const envelopeVerdict = parseVerdictEnvelope(o, candidateId);
  if (envelopeVerdict) return envelopeVerdict;
  if (typeof o.decision !== 'string' || !DECISIONS.has(o.decision)) {
    return { ok: false, reason: 'invalid_decision' };
  }
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    return { ok: false, reason: 'invalid_confidence' };
  }
  const reasoning = typeof o.reasoning === 'string' ? o.reasoning : '';
  const sourceRefs = Array.isArray(o.source_refs)
    ? o.source_refs.filter((r): r is string => typeof r === 'string')
    : [];
  const proposedPatch = (typeof o.proposed_patch === 'object' && o.proposed_patch !== null && !Array.isArray(o.proposed_patch))
    ? (o.proposed_patch as Record<string, unknown>)
    : undefined;
  return {
    ok: true,
    verdict: {
      candidate_id: candidateId,
      decision: o.decision as PromotionDecision,
      confidence: o.confidence,
      reasoning,
      source_refs: sourceRefs,
      ...(proposedPatch ? { proposed_patch: proposedPatch } : {}),
    },
  };
}

function parseVerdictEnvelope(o: Record<string, unknown>, candidateId: string): ParseVerdictResult | null {
  for (const field of ['result', 'output', 'content']) {
    const value = o[field];
    if (typeof value !== 'string') continue;
    const nested = parsePromotionVerdict(value, candidateId);
    if (nested.ok) return nested;
  }
  return null;
}

function normalizeJsonPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  const payload = (fenced?.[1] ?? trimmed).trim();
  return payload.startsWith('{') && payload.endsWith('}') ? payload : null;
}
