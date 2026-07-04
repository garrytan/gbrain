import type { BrainEngine } from '../engine.ts';
import type {
  MemoryCandidateEntry,
  MemoryCandidateExtractionKind,
  MemoryCandidateGeneratedBy,
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
  MemoryScenarioSourceKind,
  MemoryWriteSession,
} from '../types.ts';
import { createMemoryCandidateEntryWithStatusEvent } from './memory-inbox-service.ts';

export interface ExpiredWriteSessionFallbackInput {
  scope_id?: string;
  now?: Date | string;
  limit?: number;
}

export interface ExpiredWriteSessionFallbackResult {
  swept: Array<{
    session_id: string;
    candidate_id: string;
    target_slug: string;
  }>;
  skipped: Array<{
    session_id: string;
    reason: string;
  }>;
}

export async function sweepExpiredWriteSessionFallbacks(
  engine: BrainEngine,
  input: ExpiredWriteSessionFallbackInput = {},
): Promise<ExpiredWriteSessionFallbackResult> {
  const now = normalizeNow(input.now);
  const scopeFilter = input.scope_id ? { scope_id: input.scope_id } : {};
  const [openSessions, expiredSessions] = await Promise.all([
    engine.listMemoryWriteSessions({
      status: 'open',
      ...scopeFilter,
      limit: input.limit ?? 100,
      offset: 0,
    }),
    engine.listMemoryWriteSessions({
      status: 'expired',
      ...scopeFilter,
      limit: input.limit ?? 100,
      offset: 0,
    }),
  ]);
  const sessions = [...new Map([...openSessions, ...expiredSessions].map((session) => [session.id, session])).values()];
  const result: ExpiredWriteSessionFallbackResult = { swept: [], skipped: [] };

  for (const session of sessions) {
    if (session.consumed_at !== null || session.expires_at.getTime() > now.getTime()) {
      continue;
    }
    const candidateId = fallbackCandidateId(session.id);
    const content = routedContent(session);
    if (!content) {
      result.skipped.push({ session_id: session.id, reason: 'missing_routed_content' });
      continue;
    }
    const candidate = await engine.transaction(async (txBase) => {
      const tx = txBase as BrainEngine;
      const existing = await tx.getMemoryCandidateEntry(candidateId);
      const created = existing ?? await createMemoryCandidateEntryWithStatusEvent(tx, {
        id: candidateId,
        scope_id: session.scope_id,
        candidate_type: fallbackCandidateType(session),
        proposed_content: content,
        source_refs: fallbackSourceRefs(session),
        generated_by: generatedByForSourceKind(fallbackSourceKind(session)),
        extraction_kind: fallbackExtractionKind(session),
        confidence_score: fallbackScore(session, 'confidence_score', 0.5),
        importance_score: fallbackScore(session, 'importance_score', 0.5),
        recurrence_score: fallbackScore(session, 'recurrence_score', 0),
        sensitivity: fallbackSensitivity(session),
        status: 'captured',
        target_object_type: fallbackTargetObjectType(session),
        target_object_id: session.target_slug,
        reviewed_at: now,
        review_reason: 'expired_write_session_fallback',
        interaction_id: fallbackInteractionId(session),
      });
      const consumed = await tx.consumeMemoryWriteSession(session.id, {
        status: 'expired',
        consumed_by_event_id: created.id,
        status_reason: 'expired_write_session_fallback',
      });
      if (!consumed) {
        throw new Error(`Expired write session could not be consumed: ${session.id}`);
      }
      return created;
    });
    result.swept.push({
      session_id: session.id,
      candidate_id: candidate.id,
      target_slug: session.target_slug,
    });
  }

  return result;
}

function fallbackCandidateId(sessionId: string): string {
  return `expired-write-session-fallback:${sessionId}`;
}

function routedContent(session: MemoryWriteSession): string | null {
  const value = session.governance_metadata.routed_content;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function fallbackSourceRefs(session: MemoryWriteSession): string[] {
  return [...new Set([...session.source_refs, `memory_write_session:${session.id}`])];
}

function fallbackCandidateType(session: MemoryWriteSession): MemoryCandidateType {
  const value = normalizedSignal(session).candidate_type;
  return isMemoryCandidateType(value) ? value : 'note_update';
}

function fallbackExtractionKind(session: MemoryWriteSession): MemoryCandidateExtractionKind {
  const value = normalizedSignal(session).extraction_kind;
  if (isMemoryCandidateExtractionKind(value)) return value;
  return extractionKindForEvidenceKind(normalizedSignal(session).evidence_kind);
}

function fallbackSensitivity(session: MemoryWriteSession): MemoryCandidateSensitivity {
  const value = normalizedSignal(session).sensitivity;
  return isMemoryCandidateSensitivity(value) ? value : 'work';
}

function fallbackSourceKind(session: MemoryWriteSession): MemoryScenarioSourceKind | null {
  const value = normalizedSignal(session).source_kind;
  return isMemoryScenarioSourceKind(value) ? value : null;
}

function fallbackTargetObjectType(session: MemoryWriteSession): MemoryCandidateTargetObjectType {
  const value = normalizedSignal(session).target_object_type;
  return isMemoryCandidateTargetObjectType(value) ? value : 'curated_note';
}

function fallbackInteractionId(session: MemoryWriteSession): string | null {
  const value = session.governance_metadata.interaction_id;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function fallbackScore(session: MemoryWriteSession, field: 'confidence_score' | 'importance_score' | 'recurrence_score', fallback: number): number {
  const scores = session.governance_metadata.input_scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return fallback;
  const value = (scores as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizedSignal(session: MemoryWriteSession): Record<string, unknown> {
  const value = session.governance_metadata.normalized_signal;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function generatedByForSourceKind(sourceKind: MemoryScenarioSourceKind | null): MemoryCandidateGeneratedBy {
  if (sourceKind === 'import') return 'import';
  if (sourceKind === 'manual') return 'manual';
  return 'agent';
}

function normalizeNow(value: Date | string | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('now must be a valid date');
  return date;
}

function isMemoryCandidateType(value: unknown): value is MemoryCandidateType {
  return typeof value === 'string' && ['fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale'].includes(value);
}

function isMemoryCandidateExtractionKind(value: unknown): value is MemoryCandidateExtractionKind {
  return typeof value === 'string' && ['extracted', 'inferred', 'ambiguous', 'manual'].includes(value);
}

function extractionKindForEvidenceKind(value: unknown): MemoryCandidateExtractionKind {
  switch (value) {
    case 'direct_user_statement':
      return 'manual';
    case 'source_extracted':
      return 'extracted';
    case 'ambiguous':
      return 'ambiguous';
    case 'agent_inferred':
    case 'contradicts_existing':
    case 'code_sensitive':
    case 'task_mechanics':
      return 'inferred';
    default:
      return 'inferred';
  }
}

function isMemoryCandidateSensitivity(value: unknown): value is MemoryCandidateSensitivity {
  return typeof value === 'string' && ['public', 'work', 'personal', 'secret', 'unknown'].includes(value);
}

function isMemoryScenarioSourceKind(value: unknown): value is MemoryScenarioSourceKind {
  return typeof value === 'string' && ['chat', 'code_event', 'import', 'meeting', 'cron', 'manual', 'session_end', 'trace_review'].includes(value);
}

function isMemoryCandidateTargetObjectType(value: unknown): value is MemoryCandidateTargetObjectType {
  return typeof value === 'string' && ['curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other'].includes(value);
}
