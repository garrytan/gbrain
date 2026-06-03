import { createHash, randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  AgentSessionMemoryRouteResult,
  AgentSessionMemorySignal,
  AgentSessionWriteMode,
  MemoryScenarioSourceKind,
  RouteMemoryWritebackInput,
  RouteMemoryWritebackResult,
} from '../types.ts';
import { reviewDuplicateMemory } from './duplicate-memory-review-service.ts';
import { createMemoryCandidateEntryWithStatusEvent } from './memory-inbox-service.ts';
import { routeMemoryWriteback } from './memory-writeback-router-service.ts';
import { selectPersonalWriteTarget } from './personal-write-target-service.ts';

export interface AgentSessionWritebackInput {
  signals: AgentSessionMemorySignal[];
  apply: boolean;
  write_mode: AgentSessionWriteMode;
}

type DirectWriteResult = Pick<AgentSessionMemoryRouteResult, 'direct_write' | 'blocked_reason'>;

export async function routeAgentSessionMemorySignals(
  engine: BrainEngine,
  input: AgentSessionWritebackInput,
): Promise<AgentSessionMemoryRouteResult[]> {
  const results: AgentSessionMemoryRouteResult[] = [];

  for (const signal of input.signals) {
    const routeInput = routeInputForSignal(signal);
    let route = routeMemoryWriteback(routeInput);
    let directResult: DirectWriteResult = {
      direct_write: null,
      blocked_reason: null,
    };

    if (input.apply === true && input.write_mode === 'direct_personal_when_allowed') {
      directResult = directPersonalRouteAllows(route)
        ? await applyDirectPersonalWriteWhenAllowed(engine, signal)
        : {
            direct_write: null,
            blocked_reason: 'direct_personal_route_blocked',
          };
    }

    if (
      input.apply === true
      && route.decision === 'create_candidate'
      && route.candidate_input
      && directResult.direct_write?.status !== 'written'
    ) {
      route = await applyCandidateRoute(engine, route);
    }

    results.push({
      signal,
      route,
      direct_write: directResult.direct_write,
      blocked_reason: directResult.blocked_reason,
    });
  }

  return results;
}

export function routeInputForSignal(signal: AgentSessionMemorySignal): RouteMemoryWritebackInput {
  return {
    content: signal.content,
    source_refs: signal.source_refs,
    source_kind: signal.scenario_source_kind ?? fallbackSourceKindForSignal(signal),
    evidence_kind: signal.evidence_kind,
    candidate_type: signal.candidate_type ?? undefined,
    target_object_type: signal.target_object_type ?? undefined,
    target_object_id: signal.target_object_id ?? undefined,
    scope_id: signal.scope_id,
    sensitivity: signal.sensitivity,
    confidence_score: signal.confidence_score,
    importance_score: signal.importance_score,
    recurrence_score: signal.recurrence_score,
    allow_canonical_write: false,
  };
}

function directPersonalRouteAllows(route: RouteMemoryWritebackResult): boolean {
  return route.decision === 'create_candidate'
    && route.candidate_input !== undefined
    && route.missing_requirements.length === 0;
}

async function applyCandidateRoute(
  engine: BrainEngine,
  route: RouteMemoryWritebackResult,
): Promise<RouteMemoryWritebackResult> {
  if (!route.candidate_input) return route;

  const candidateInput = {
    ...route.candidate_input,
    id: route.candidate_input.id ?? randomUUID(),
  };
  const duplicateReview = await reviewDuplicateMemory(engine, {
    scope_id: candidateInput.scope_id,
    subject_kind: 'memory_candidate',
    subject_id: candidateInput.id,
    content: candidateInput.proposed_content,
    source_refs: candidateInput.source_refs,
    candidate_type: candidateInput.candidate_type,
    target_object_type: candidateInput.target_object_type ?? undefined,
    target_object_id: candidateInput.target_object_id ?? undefined,
    include_pages: true,
    include_candidates: true,
    limit: 5,
  });
  const created = await createMemoryCandidateEntryWithStatusEvent(engine, candidateInput);

  return {
    ...route,
    applied: true,
    candidate_input: candidateInput,
    created_candidate: created,
    duplicate_review: duplicateReview,
  };
}

async function applyDirectPersonalWriteWhenAllowed(
  engine: BrainEngine,
  signal: AgentSessionMemorySignal,
): Promise<DirectWriteResult> {
  if (signal.evidence_kind !== 'direct_user_statement' && signal.evidence_kind !== 'source_extracted') {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_evidence_kind_blocked',
    };
  }
  if (!signal.scope_id.startsWith('personal:')) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_scope_blocked',
    };
  }
  if (signal.sensitivity !== 'personal') {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_sensitivity_blocked',
    };
  }
  if (signal.prompt_injection_flagged === true) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_prompt_injection_blocked',
    };
  }

  if (signal.signal_kind === 'profile_memory') {
    if (signal.target_object_type !== 'profile_memory') {
      return {
        direct_write: null,
        blocked_reason: 'direct_personal_target_type_blocked',
      };
    }
    return applyDirectProfileWrite(engine, signal);
  }
  if (signal.signal_kind === 'personal_episode') {
    if (signal.target_object_type !== 'personal_episode') {
      return {
        direct_write: null,
        blocked_reason: 'direct_personal_target_type_blocked',
      };
    }
    return applyDirectPersonalEpisodeWrite(engine, signal);
  }

  return {
    direct_write: null,
    blocked_reason: null,
  };
}

async function applyDirectProfileWrite(
  engine: BrainEngine,
  signal: AgentSessionMemorySignal,
): Promise<DirectWriteResult> {
  const profileType = signal.profile_type;
  const profileSubject = normalizeOptionalString(signal.profile_subject);
  const content = normalizeOptionalString(signal.content);
  if (!profileType || !profileSubject || !content) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_profile_metadata_missing',
    };
  }

  const target = await selectPersonalWriteTarget(engine, {
    target_kind: 'profile_memory',
    requested_scope: requestedScopeForSignal(signal),
    query: content,
    subject: profileSubject,
  });
  if (!target.route) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_preflight_failed',
    };
  }

  const entry = await engine.upsertProfileMemoryEntry({
    id: stableId('profile-memory', target.route.scope_id, profileType, profileSubject),
    scope_id: target.route.scope_id,
    profile_type: profileType,
    subject: profileSubject,
    content,
    source_refs: normalizeSourceRefs(signal.source_refs),
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: new Date(),
    superseded_by: null,
  });

  return {
    direct_write: {
      kind: 'profile_memory',
      id: entry.id,
      status: 'written',
    },
    blocked_reason: null,
  };
}

async function applyDirectPersonalEpisodeWrite(
  engine: BrainEngine,
  signal: AgentSessionMemorySignal,
): Promise<DirectWriteResult> {
  const title = normalizeOptionalString(signal.personal_episode_title) ?? 'Agent session memory';
  const summary = normalizeOptionalString(signal.content);
  if (!summary) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_episode_metadata_missing',
    };
  }

  const target = await selectPersonalWriteTarget(engine, {
    target_kind: 'personal_episode',
    requested_scope: requestedScopeForSignal(signal),
    query: summary,
    title,
  });
  if (!target.route) {
    return {
      direct_write: null,
      blocked_reason: 'direct_personal_preflight_failed',
    };
  }

  const episodeId = stableId('personal-episode', target.route.scope_id, signal.id, summary);
  const existing = await engine.getPersonalEpisodeEntry(episodeId);
  if (existing) {
    return {
      direct_write: {
        kind: 'personal_episode',
        id: existing.id,
        status: 'written',
      },
      blocked_reason: null,
    };
  }

  const entry = await engine.createPersonalEpisodeEntry({
    id: episodeId,
    scope_id: target.route.scope_id,
    title,
    start_time: new Date(),
    end_time: null,
    source_kind: signal.personal_episode_source_kind ?? 'chat',
    summary,
    source_refs: normalizeSourceRefs(signal.source_refs),
    candidate_ids: [],
  });

  return {
    direct_write: {
      kind: 'personal_episode',
      id: entry.id,
      status: 'written',
    },
    blocked_reason: null,
  };
}

function fallbackSourceKindForSignal(signal: AgentSessionMemorySignal): MemoryScenarioSourceKind {
  if (signal.signal_kind === 'personal_episode') return 'session_end';
  if (signal.signal_kind === 'task_memory' || signal.evidence_kind === 'code_sensitive') return 'code_event';
  if (signal.evidence_kind === 'task_mechanics') return 'code_event';
  if (signal.evidence_kind === 'direct_user_statement') return 'chat';
  return 'trace_review';
}

function requestedScopeForSignal(signal: AgentSessionMemorySignal): 'personal' | undefined {
  return signal.scope_id.startsWith('personal:') ? 'personal' : undefined;
}

function normalizeSourceRefs(sourceRefs: string[]): string[] {
  return [...new Set(sourceRefs.map((sourceRef) => sourceRef.trim()).filter((sourceRef) => sourceRef.length > 0))];
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
