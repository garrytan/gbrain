import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry } from '../types.ts';
import type { PromotionDecision, PromotionVerdict } from './verdict.ts';
import type { AutoPromoteConfig } from './config.ts';
import { advanceMemoryCandidateStatus, preflightPromoteMemoryCandidate } from '../services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../services/memory-inbox-promotion-service.ts';
import { buildCanonicalCandidatePagePatch } from '../services/canonical-page-patch-service.ts';
import { completeCanonicalHandoff, recordCanonicalHandoff } from '../services/canonical-handoff-service.ts';
import { operationsByName, type OperationContext } from '../operations.ts';
import type { MBrainConfig } from '../config.ts';

export type AutoPromoteAuditLane = 'low_risk' | 'risky' | 'excluded';
export type AutoPromoteCanonicalWriteResult = 'applied' | 'handoff_only' | 'skipped' | 'not_attempted';

export interface AutoPromoteAuditEntry {
  candidate_id: string;
  lane: AutoPromoteAuditLane;
  lane_reason: string;
  runner_kind: string | null;
  prompt_version: string | null;
  prompt_input_hash: string | null;
  confidence_threshold: number;
  policy_version: 'auto-promote-policy-v1';
  verification: { status: string | null; method: string | null };
  target_snapshot_hash: string | null;
  verdict: { decision: PromotionDecision | null; confidence: number | null; judged_at: string | null };
  gate_skip_reason: string | null;
  preflight_result: null;
  patch_candidate_id: string | null;
  canonical_page_writes_enabled: boolean;
  canonical_write_result: AutoPromoteCanonicalWriteResult;
}

export type AutoPromoteAuditMetadata = Partial<Pick<
  AutoPromoteAuditEntry,
  'lane' | 'lane_reason' | 'confidence_threshold' | 'verification' | 'target_snapshot_hash'
>>;

export interface PromoteGateInput {
  engine: BrainEngine;
  verdicts: PromotionVerdict[];
  candidates: MemoryCandidateEntry[];
  config: AutoPromoteConfig;
  now: string;
  actor: string;
  target_snapshot_hashes?: Map<string, string | null>;
  allow_canonical_page_writes?: boolean;
  canonical_write_candidate_ids: ReadonlySet<string>;
  audit_metadata?: ReadonlyMap<string, AutoPromoteAuditMetadata>;
}
export interface PromoteGateResult {
  promoted: string[];
  would_promote: string[];
  would_canonicalize: string[];
  canonical_handoffs: string[];
  canonical_writes: string[];
  skipped: { id: string; reason: string }[];
  audit: AutoPromoteAuditEntry[];
}

export async function runPromoteGate(input: PromoteGateInput): Promise<PromoteGateResult> {
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  const result: PromoteGateResult = {
    promoted: [],
    would_promote: [],
    would_canonicalize: [],
    canonical_handoffs: [],
    canonical_writes: [],
    skipped: [],
    audit: [],
  };
  for (const v of input.verdicts) {
    if (v.decision !== 'promote') {
      const reason = `decision_${v.decision}`;
      result.skipped.push({ id: v.candidate_id, reason });
      result.audit.push(buildAuditEntry(input, v, byId.get(v.candidate_id), {
        gate_skip_reason: reason,
        canonical_write_result: 'skipped',
      }));
      continue;
    }
    if (v.confidence < input.config.confidence_threshold) {
      result.skipped.push({ id: v.candidate_id, reason: 'below_threshold' });
      result.audit.push(buildAuditEntry(input, v, byId.get(v.candidate_id), {
        gate_skip_reason: 'below_threshold',
        canonical_write_result: 'skipped',
      }));
      continue;
    }
    const candidate = byId.get(v.candidate_id);
    if (!candidate) {
      result.skipped.push({ id: v.candidate_id, reason: 'candidate_missing' });
      result.audit.push(buildAuditEntry(input, v, undefined, {
        gate_skip_reason: 'candidate_missing',
        canonical_write_result: 'skipped',
      }));
      continue;
    }
    if (v.proposed_patch) {
      result.skipped.push({ id: v.candidate_id, reason: 'patch_apply_not_yet_supported' });
      result.audit.push(buildAuditEntry(input, v, candidate, {
        gate_skip_reason: 'patch_apply_not_yet_supported',
        canonical_write_result: 'skipped',
      }));
      continue;
    }

    if (input.config.dry_run) {
      result.would_promote.push(v.candidate_id);
      if (isPageBackedCandidate(candidate) && isCanonicalWriteEligible(input, candidate)) {
        result.would_canonicalize.push(v.candidate_id);
      }
      result.audit.push(buildAuditEntry(input, v, candidate, {
        gate_skip_reason: null,
        canonical_write_result: 'not_attempted',
      }));
      continue;
    }

    try {
      const promoted = await promoteCandidateAtomically(input.engine, candidate, input.now, input.actor, v);
      if (!promoted.ok) {
        const reason = promoted.reason;
        result.skipped.push({ id: candidate.id, reason });
        result.audit.push(buildAuditEntry(input, v, candidate, {
          gate_skip_reason: reason,
          canonical_write_result: 'skipped',
        }));
        continue;
      }
      result.promoted.push(candidate.id);
      const canonicalized = await canonicalizePromotedCandidate(input, candidate);
      if (canonicalized.handoff) result.canonical_handoffs.push(candidate.id);
      if (canonicalized.write_slug) result.canonical_writes.push(canonicalized.write_slug);
      if (canonicalized.skipped_reason) result.skipped.push({ id: candidate.id, reason: canonicalized.skipped_reason });
      result.audit.push(buildAuditEntry(input, v, candidate, {
        gate_skip_reason: canonicalized.skipped_reason ?? null,
        patch_candidate_id: canonicalized.patch_candidate_id ?? null,
        canonical_write_result: canonicalWriteResultFor(canonicalized),
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.skipped.push({ id: candidate.id, reason });
      result.audit.push(buildAuditEntry(input, v, candidate, {
        gate_skip_reason: reason,
        canonical_write_result: 'skipped',
      }));
    }
  }
  return result;
}

async function promoteCandidateAtomically(
  engine: BrainEngine,
  candidate: MemoryCandidateEntry,
  now: string,
  actor: string,
  verdict: PromotionVerdict,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    const preflight = await preflightPromoteMemoryCandidate(tx, {
      id: candidate.id,
      allow_active_status: true,
    });
    if (preflight.decision !== 'allow') {
      return {
        ok: false,
        reason: preflight.reasons[0] ?? `preflight_${preflight.decision}`,
      };
    }
    await advanceToStaged(tx, candidate, now, actor);
    await promoteMemoryCandidateEntry(tx, {
      id: candidate.id,
      reviewed_at: now,
      review_reason: `auto_promote verdict (confidence ${verdict.confidence}): ${verdict.reasoning}`.slice(0, 500),
    });
    return { ok: true };
  });
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

async function canonicalizePromotedCandidate(
  input: PromoteGateInput,
  candidate: MemoryCandidateEntry,
): Promise<{ handoff: boolean; write_slug?: string; skipped_reason?: string; patch_candidate_id?: string }> {
  if (!isPageBackedCandidate(candidate)) {
    return { handoff: false, skipped_reason: 'canonical_target_not_page_backed' };
  }

  const handoff = await recordCanonicalHandoff(input.engine, {
    candidate_id: candidate.id,
    reviewed_at: input.now,
    review_reason: `auto_promote canonical handoff (${input.actor})`,
  });
  if (!isCanonicalWriteEligible(input, candidate)) {
    return { handoff: true, skipped_reason: 'canonical_policy_not_allowed' };
  }
  if (input.allow_canonical_page_writes !== true) {
    return { handoff: true, skipped_reason: 'canonical_page_writes_not_allowed' };
  }
  const targetSlug = handoff.handoff.target_object_id;
  const expectedContentHash = input.target_snapshot_hashes?.get(candidate.id);
  let createdPatchCandidateId: string | undefined;
  let patchSessionId: string | null = null;
  try {
    const currentPage = await input.engine.getPage(targetSlug);
    const baseTargetSnapshotHash = expectedContentHash === undefined ? currentPage?.content_hash ?? null : expectedContentHash;
    if (baseTargetSnapshotHash !== (currentPage?.content_hash ?? null)) {
      throw new Error('base_target_snapshot_hash does not match the current target snapshot hash');
    }
    const sourceRefs = [
      `canonical_handoff:${handoff.handoff.id}`,
      `memory_candidate:${candidate.id}`,
      ...candidate.source_refs,
    ];
    const patchCandidateId = `auto-promote-patch:${candidate.id}`;
    const patchContext = await ensureAutoPromotePatchContext(input, candidate, handoff.handoff.id);
    patchSessionId = patchContext.sessionId;
    const ctx = operationContext(input);
    const createPatchResult = await operationsByName.create_memory_patch_candidate.handler(ctx, {
      id: patchCandidateId,
      session_id: patchContext.sessionId,
      realm_id: patchContext.realmId,
      actor: input.actor,
      scope_id: candidate.scope_id,
      target_kind: 'page',
      target_id: targetSlug,
      base_target_snapshot_hash: baseTargetSnapshotHash,
      patch_body: buildCanonicalCandidatePagePatch(currentPage, targetSlug, candidate, {
        now: input.now,
        timelineNote: `Auto-promoted Memory Inbox candidate ${candidate.id} via canonical handoff ${handoff.handoff.id}.`,
      }),
      patch_format: 'merge_patch',
      risk_class: 'low',
      proposed_content: `Auto-promote canonical patch for ${targetSlug} from Memory Inbox candidate ${candidate.id}.`,
      source_refs: sourceRefs,
      generated_by: 'agent',
      extraction_kind: candidate.extraction_kind,
      confidence_score: candidate.confidence_score,
      importance_score: candidate.importance_score,
      recurrence_score: candidate.recurrence_score,
      sensitivity: candidate.sensitivity,
      provenance_summary: `Auto-promote canonical handoff ${handoff.handoff.id} for Memory Inbox candidate ${candidate.id}.`,
    }) as { id: string };
    createdPatchCandidateId = createPatchResult.id;
    await operationsByName.review_memory_patch_candidate.handler(ctx, {
      candidate_id: createPatchResult.id,
      session_id: patchContext.sessionId,
      realm_id: patchContext.realmId,
      actor: input.actor,
      decision: 'approve',
      reviewed_at: input.now,
      review_reason: `auto_promote approved canonical patch (${input.actor})`,
      source_refs: sourceRefs,
    });
    await operationsByName.apply_memory_patch_candidate.handler(ctx, {
      candidate_id: createPatchResult.id,
      session_id: patchContext.sessionId,
      realm_id: patchContext.realmId,
      actor: input.actor,
      reviewed_at: input.now,
      review_reason: `auto_promote applied approved canonical patch (${input.actor})`,
      source_refs: sourceRefs,
    });
    await completeCanonicalHandoff(input.engine, {
      id: handoff.handoff.id,
      completed_at: input.now,
      completion_kind: 'patch_applied',
      completion_ref: createPatchResult.id,
    });
    return { handoff: true, write_slug: targetSlug, patch_candidate_id: createPatchResult.id };
  } catch (error) {
    return {
      handoff: true,
      skipped_reason: error instanceof Error ? error.message : String(error),
      ...(createdPatchCandidateId ? { patch_candidate_id: createdPatchCandidateId } : {}),
    };
  } finally {
    if (patchSessionId) {
      try {
        await input.engine.closeMemorySession(patchSessionId);
      } catch {
        // Session cleanup must never change the canonicalization outcome.
      }
    }
  }
}

function buildAuditEntry(
  input: PromoteGateInput,
  verdict: PromotionVerdict,
  candidate: MemoryCandidateEntry | undefined,
  outcome: {
    gate_skip_reason: string | null;
    canonical_write_result: AutoPromoteCanonicalWriteResult;
    patch_candidate_id?: string | null;
  },
): AutoPromoteAuditEntry {
  const metadata = input.audit_metadata?.get(verdict.candidate_id);
  const auditedVerdict = verdict as PromotionVerdict & {
    prompt_input_hash?: string;
  };
  return {
    candidate_id: verdict.candidate_id,
    lane: metadata?.lane ?? defaultLaneFor(input, verdict.candidate_id, candidate),
    lane_reason: metadata?.lane_reason ?? defaultLaneReasonFor(input, verdict.candidate_id, candidate),
    runner_kind: verdict.runner_kind ?? null,
    prompt_version: verdict.prompt_version ?? null,
    prompt_input_hash: auditedVerdict.prompt_input_hash ?? null,
    confidence_threshold: metadata?.confidence_threshold ?? input.config.confidence_threshold,
    policy_version: 'auto-promote-policy-v1',
    verification: metadata?.verification ?? verificationFor(candidate),
    target_snapshot_hash: metadata?.target_snapshot_hash ?? input.target_snapshot_hashes?.get(verdict.candidate_id) ?? null,
    verdict: {
      decision: verdict.decision,
      confidence: verdict.confidence,
      judged_at: verdict.judged_at ?? null,
    },
    gate_skip_reason: outcome.gate_skip_reason,
    preflight_result: null,
    patch_candidate_id: outcome.patch_candidate_id ?? null,
    canonical_page_writes_enabled: input.allow_canonical_page_writes === true,
    canonical_write_result: outcome.canonical_write_result,
  };
}

function defaultLaneFor(
  input: PromoteGateInput,
  candidateId: string,
  candidate: MemoryCandidateEntry | undefined,
): AutoPromoteAuditLane {
  if (!candidate) return 'excluded';
  return input.canonical_write_candidate_ids.has(candidateId) ? 'low_risk' : 'risky';
}

function defaultLaneReasonFor(
  input: PromoteGateInput,
  candidateId: string,
  candidate: MemoryCandidateEntry | undefined,
): string {
  if (!candidate) return 'candidate_missing';
  return input.canonical_write_candidate_ids.has(candidateId) ? 'canonical_eligible' : 'unknown';
}

function verificationFor(candidate: MemoryCandidateEntry | undefined): { status: string | null; method: string | null } {
  return {
    status: candidate?.verification_status ?? null,
    method: candidate?.verification_method ?? null,
  };
}

function canonicalWriteResultFor(input: {
  handoff: boolean;
  write_slug?: string;
  skipped_reason?: string;
}): AutoPromoteCanonicalWriteResult {
  if (input.write_slug) return 'applied';
  if (input.skipped_reason === 'canonical_policy_not_allowed' || input.skipped_reason === 'canonical_page_writes_not_allowed') return 'handoff_only';
  if (input.skipped_reason) return 'skipped';
  return input.handoff ? 'not_attempted' : 'skipped';
}

function isPageBackedCandidate(candidate: MemoryCandidateEntry): boolean {
  return candidate.target_object_type === 'curated_note'
    && typeof candidate.target_object_id === 'string'
    && candidate.target_object_id.trim().length > 0;
}

function isCanonicalWriteEligible(input: PromoteGateInput, candidate: MemoryCandidateEntry): boolean {
  return input.canonical_write_candidate_ids.has(candidate.id)
    && isPageBackedCandidate(candidate)
    && input.config.eligibility.sensitivities.includes(candidate.sensitivity as AutoPromoteConfig['eligibility']['sensitivities'][number])
    && candidate.source_refs.some((ref) => ref.trim().length > 0);
}


function operationContext(input: PromoteGateInput): OperationContext {
  return {
    engine: input.engine,
    config: MINIMAL_OPERATION_CONFIG,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
  };
}

const MINIMAL_OPERATION_CONFIG: MBrainConfig = {
  engine: 'postgres',
  offline: false,
  embedding_provider: 'none',
  query_rewrite_provider: 'none',
};

async function ensureAutoPromotePatchContext(
  input: PromoteGateInput,
  candidate: MemoryCandidateEntry,
  handoffId: string,
): Promise<{ sessionId: string; realmId: string }> {
  const realmId = candidate.sensitivity === 'personal' ? 'personal' : 'work';
  const scope = candidate.sensitivity === 'personal' ? 'personal' : 'work';
  const sessionId = `auto_promote:${candidate.id}:${handoffId}`;
  if (!await input.engine.getMemoryRealm(realmId)) {
    await input.engine.upsertMemoryRealm({
      id: realmId,
      name: realmId === 'personal' ? 'Personal auto-promote' : 'Work auto-promote',
      scope,
      default_access: 'read_write',
    });
  }
  const existingSession = await input.engine.getMemorySession(sessionId);
  if (!existingSession) {
    await input.engine.createMemorySession({
      id: sessionId,
      actor_ref: input.actor,
    });
  } else if (existingSession.status !== 'active') {
    throw new Error(`auto-promote memory session is not active: ${sessionId}`);
  }
  await input.engine.attachMemoryRealmToSession({
    session_id: sessionId,
    realm_id: realmId,
    access: 'read_write',
    instructions: `Auto-promote canonical patch for Memory Inbox candidate ${candidate.id}.`,
  });
  return { sessionId, realmId };
}
