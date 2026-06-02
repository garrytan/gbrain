import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry } from '../types.ts';
import type { PromotionVerdict } from './verdict.ts';
import type { AutoPromoteConfig } from './config.ts';
import { advanceMemoryCandidateStatus } from '../services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../services/memory-inbox-promotion-service.ts';

export interface PromoteGateInput {
  engine: BrainEngine;
  verdicts: PromotionVerdict[];
  candidates: MemoryCandidateEntry[];
  config: AutoPromoteConfig;
  now: string;
  actor: string;
}
export interface PromoteGateResult {
  promoted: string[];
  would_promote: string[];
  skipped: { id: string; reason: string }[];
}

export async function runPromoteGate(input: PromoteGateInput): Promise<PromoteGateResult> {
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  const result: PromoteGateResult = { promoted: [], would_promote: [], skipped: [] };
  for (const v of input.verdicts) {
    if (v.decision !== 'promote') { result.skipped.push({ id: v.candidate_id, reason: `decision_${v.decision}` }); continue; }
    if (v.confidence < input.config.confidence_threshold) { result.skipped.push({ id: v.candidate_id, reason: 'below_threshold' }); continue; }
    const candidate = byId.get(v.candidate_id);
    if (!candidate) { result.skipped.push({ id: v.candidate_id, reason: 'candidate_missing' }); continue; }
    if (v.proposed_patch) { result.skipped.push({ id: v.candidate_id, reason: 'patch_apply_not_yet_supported' }); continue; }

    if (input.config.dry_run) { result.would_promote.push(v.candidate_id); continue; }

    try {
      await advanceToStaged(input.engine, candidate, input.now, input.actor);
      await promoteMemoryCandidateEntry(input.engine, {
        id: candidate.id,
        reviewed_at: input.now,
        review_reason: `auto_promote verdict (confidence ${v.confidence}): ${v.reasoning}`.slice(0, 500),
      });
      result.promoted.push(candidate.id);
    } catch (error) {
      result.skipped.push({ id: candidate.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function advanceToStaged(engine: BrainEngine, candidate: MemoryCandidateEntry, now: string, actor: string): Promise<void> {
  let current = candidate.status as string;
  const path: Record<string, 'candidate' | 'staged_for_review' | null> = {
    captured: 'candidate',
    candidate: 'staged_for_review',
    staged_for_review: null,
  };
  while (path[current]) {
    const next = path[current] as 'candidate' | 'staged_for_review';
    await advanceMemoryCandidateStatus(engine, {
      id: candidate.id,
      next_status: next,
      reviewed_at: now,
      review_reason: `auto_promote (${actor})`,
    });
    current = next;
  }
}
