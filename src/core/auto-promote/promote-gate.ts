import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry, Page, PageType } from '../types.ts';
import type { PromotionVerdict } from './verdict.ts';
import type { AutoPromoteConfig } from './config.ts';
import { advanceMemoryCandidateStatus } from '../services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../services/canonical-handoff-service.ts';
import { operationsByName, type OperationContext } from '../operations.ts';
import type { MBrainConfig } from '../config.ts';

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
}
export interface PromoteGateResult {
  promoted: string[];
  would_promote: string[];
  would_canonicalize: string[];
  canonical_handoffs: string[];
  canonical_writes: string[];
  skipped: { id: string; reason: string }[];
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
  };
  for (const v of input.verdicts) {
    if (v.decision !== 'promote') { result.skipped.push({ id: v.candidate_id, reason: `decision_${v.decision}` }); continue; }
    if (v.confidence < input.config.confidence_threshold) { result.skipped.push({ id: v.candidate_id, reason: 'below_threshold' }); continue; }
    const candidate = byId.get(v.candidate_id);
    if (!candidate) { result.skipped.push({ id: v.candidate_id, reason: 'candidate_missing' }); continue; }
    if (v.proposed_patch) { result.skipped.push({ id: v.candidate_id, reason: 'patch_apply_not_yet_supported' }); continue; }

    if (input.config.dry_run) {
      result.would_promote.push(v.candidate_id);
      if (isPageBackedCandidate(candidate) && isCanonicalWriteEligible(input, candidate)) {
        result.would_canonicalize.push(v.candidate_id);
      }
      continue;
    }

    try {
      await advanceToStaged(input.engine, candidate, input.now, input.actor);
      await promoteMemoryCandidateEntry(input.engine, {
        id: candidate.id,
        reviewed_at: input.now,
        review_reason: `auto_promote verdict (confidence ${v.confidence}): ${v.reasoning}`.slice(0, 500),
      });
      result.promoted.push(candidate.id);
      const canonicalized = await canonicalizePromotedCandidate(input, candidate);
      if (canonicalized.handoff) result.canonical_handoffs.push(candidate.id);
      if (canonicalized.write_slug) result.canonical_writes.push(canonicalized.write_slug);
      if (canonicalized.skipped_reason) result.skipped.push({ id: candidate.id, reason: canonicalized.skipped_reason });
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

async function canonicalizePromotedCandidate(
  input: PromoteGateInput,
  candidate: MemoryCandidateEntry,
): Promise<{ handoff: boolean; write_slug?: string; skipped_reason?: string }> {
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
      patch_body: buildCanonicalCandidatePagePatch(currentPage, targetSlug, candidate, handoff.handoff.id, input.now),
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
    return { handoff: true, write_slug: targetSlug };
  } catch (error) {
    return { handoff: true, skipped_reason: error instanceof Error ? error.message : String(error) };
  }
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

function buildCanonicalCandidatePagePatch(
  page: Page | null,
  slug: string,
  candidate: MemoryCandidateEntry,
  handoffId: string,
  now: string,
): Record<string, unknown> {
  const citation = sourceCitation(candidate.source_refs);
  const compiledLine = `${candidate.proposed_content.trim()} ${citation}`.trim();
  const compiledTruth = appendUniqueLine(page?.compiled_truth ?? '', compiledLine);
  const timelineLine = `- **${now.slice(0, 10)}** | Auto-promoted Memory Inbox candidate ${candidate.id} via canonical handoff ${handoffId}. ${citation}`;
  const timeline = appendUniqueLine(page?.timeline ?? '', timelineLine);
  return {
    type: page?.type ?? inferPageType(slug),
    title: page?.title ?? inferTitle(slug),
    frontmatter: page?.frontmatter ?? {},
    compiled_truth: compiledTruth,
    timeline,
  };
}

function appendUniqueLine(existing: string, line: string): string {
  const trimmedExisting = existing.trim();
  const trimmedLine = line.trim();
  if (!trimmedLine) return trimmedExisting;
  if (!trimmedExisting) return trimmedLine;
  if (trimmedExisting.includes(trimmedLine)) return trimmedExisting;
  return `${trimmedExisting}\n\n${trimmedLine}`;
}

function sourceCitation(sourceRefs: string[]): string {
  const refs = sourceRefs.map((ref) => normalizeSourceRef(ref)).filter(Boolean);
  const ref = refs[0] ?? 'mbrain:auto_promote';
  return `[Source: ${ref}]`;
}

function normalizeSourceRef(ref: string): string {
  return ref.trim().replace(/^\[?Source:\s*/i, '').replace(/\]$/u, '').trim();
}

function inferPageType(slug: string): PageType {
  const normalized = `/${slug.toLowerCase()}/`;
  if (normalized.includes('/people/')) return 'person';
  if (normalized.includes('/companies/')) return 'company';
  if (normalized.includes('/deals/')) return 'deal';
  if (normalized.includes('/yc/')) return 'yc';
  if (normalized.includes('/civic/')) return 'civic';
  if (normalized.includes('/projects/')) return 'project';
  if (normalized.includes('/systems/')) return 'system';
  if (normalized.includes('/sources/')) return 'source';
  if (normalized.includes('/media/')) return 'media';
  return 'concept';
}

function inferTitle(slug: string): string {
  const last = slug.split('/').filter(Boolean).at(-1) ?? slug;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
