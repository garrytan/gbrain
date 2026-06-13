import { createHash } from 'crypto';
import type {
  AgentSessionCompressedObservation,
  AgentSessionMemorySignal,
  AgentSessionSummary,
} from '../types.ts';

export interface AgentSessionSignalClassifierInput {
  observations: AgentSessionCompressedObservation[];
  summary: AgentSessionSummary;
}

export function classifyAgentSessionMemorySignals(
  input: AgentSessionSignalClassifierInput,
): AgentSessionMemorySignal[] {
  const signals: AgentSessionMemorySignal[] = [];

  for (const observation of input.observations) {
    const text = classifierTextFor(observation);

    if (isPureTaskMechanics(observation, text)) {
      signals.push(noWriteSignal(observation));
      continue;
    }
    if (isContradictionSignal(text)) {
      signals.push(projectNoteSignal(observation, text, 'contradicts_existing'));
      continue;
    }
    if (isTaskMemorySignal(observation, text)) {
      signals.push(taskMemorySignal(observation, text));
      continue;
    }
    if (isProjectNoteSignal(text)) {
      signals.push(projectNoteSignal(observation, text));
      continue;
    }
    if (isExplicitPreference(text)) {
      signals.push(profileSignal(observation, text));
      continue;
    }
    if (isProcedureSignal(text)) {
      signals.push(procedureSignal(observation, text));
      continue;
    }
    if (isOpenQuestion(text)) {
      signals.push(openQuestionSignal(observation, text));
    }
  }

  const outcome = input.summary.outcome.trim();
  const allObservationsAreMechanics = input.observations.length > 0
    && input.observations.every((observation) => isPureTaskMechanics(observation, classifierTextFor(observation)));
  const hasSessionSummaryObservation = input.observations.some((observation) =>
    observation.observation_type === 'session_summary' || observation.event_kind === 'session_stop');
  if (outcome.length > 0 && hasSessionSummaryObservation && !isMechanicalOutcome(outcome) && !allObservationsAreMechanics) {
    signals.push(personalEpisodeSignal(input.summary, outcome));
  }

  return dedupeSignals(signals);
}

function profileSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  const content = firstSentence(text, 280);
  const directUserStatement = observation.actor === 'user'
    || observation.event_kind === 'explicit_memory_note';

  return {
    id: signalId('profile_memory', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: directUserStatement ? 'direct_user_statement' : 'agent_inferred',
    signal_kind: 'profile_memory',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: observation.sensitivity === 'secret' ? 'secret' : 'personal',
    confidence_score: Math.max(observation.confidence_score, 0.8),
    importance_score: Math.max(observation.importance_score, 0.75),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    profile_type: /routine|habit|루틴|습관/i.test(text) ? 'routine' : 'preference',
    profile_subject: /plan|플랜|planning/i.test(text) ? 'implementation planning' : 'user preference',
    scenario_source_kind: 'chat',
  };
}

function personalEpisodeSignal(summary: AgentSessionSummary, outcome: string): AgentSessionMemorySignal {
  return {
    id: signalId('personal_episode', summary.id, outcome),
    source_observation_id: summary.id,
    content: outcome,
    evidence_kind: 'source_extracted',
    signal_kind: 'personal_episode',
    candidate_type: 'fact',
    target_object_type: 'personal_episode',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: summary.sensitivity === 'secret' ? 'secret' : 'personal',
    confidence_score: 0.7,
    importance_score: summary.decisions.length > 0 || summary.follow_ups.length > 0 ? 0.75 : 0.55,
    recurrence_score: 0,
    source_refs: summary.source_refs,
    prompt_injection_flagged: summary.prompt_injection_flagged === true,
    personal_episode_title: summary.title,
    personal_episode_source_kind: 'chat',
    scenario_source_kind: 'session_end',
  };
}

function noWriteSignal(observation: AgentSessionCompressedObservation): AgentSessionMemorySignal {
  const content = signalContentForObservation(observation);

  return {
    id: signalId('no_write', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: 'task_mechanics',
    signal_kind: 'no_write',
    candidate_type: null,
    target_object_type: null,
    target_object_id: null,
    scope_id: observation.scope_id,
    sensitivity: observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: observation.importance_score,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    scenario_source_kind: scenarioSourceKindFor(observation),
  };
}

function procedureSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  const content = firstSentence(text, 240);

  return {
    id: signalId('procedure', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: observation.confidence_score >= 0.8 ? 'source_extracted' : 'agent_inferred',
    signal_kind: 'procedure',
    candidate_type: 'procedure',
    target_object_type: 'procedure',
    target_object_id: null,
    scope_id: observation.scope_id,
    sensitivity: observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: observation.importance_score,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    scenario_source_kind: scenarioSourceKindFor(observation),
  };
}

function taskMemorySignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  const content = firstSentence(text, 240);

  return {
    id: signalId('task_memory', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: 'code_sensitive',
    signal_kind: 'task_memory',
    candidate_type: 'rationale',
    target_object_type: 'other',
    target_object_id: null,
    scope_id: observation.scope_id.startsWith('personal:') ? 'workspace:default' : observation.scope_id,
    sensitivity: observation.sensitivity === 'personal' ? 'work' : observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: Math.max(observation.importance_score, 0.65),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    scenario_source_kind: 'code_event',
  };
}

function projectNoteSignal(
  observation: AgentSessionCompressedObservation,
  text: string,
  evidenceKind: AgentSessionMemorySignal['evidence_kind'] = 'source_extracted',
): AgentSessionMemorySignal {
  const content = firstSentence(text, 280);

  return {
    id: signalId('project_note', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: evidenceKind,
    signal_kind: 'project_note',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: null,
    scope_id: observation.scope_id.startsWith('personal:') ? 'workspace:default' : observation.scope_id,
    sensitivity: observation.sensitivity === 'personal' ? 'work' : observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: Math.max(observation.importance_score, evidenceKind === 'contradicts_existing' ? 0.8 : 0.65),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    scenario_source_kind: evidenceKind === 'contradicts_existing' ? 'trace_review' : 'code_event',
  };
}

function openQuestionSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  const content = firstSentence(text, 240);

  return {
    id: signalId('open_question', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: 'ambiguous',
    signal_kind: 'open_question',
    candidate_type: 'open_question',
    target_object_type: 'other',
    target_object_id: null,
    scope_id: observation.scope_id,
    sensitivity: observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: observation.importance_score,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    prompt_injection_flagged: observation.prompt_injection_flagged === true,
    scenario_source_kind: scenarioSourceKindFor(observation),
  };
}

function classifierTextFor(observation: AgentSessionCompressedObservation): string {
  const body = normalizeWhitespace([
    observation.narrative,
    ...observation.facts,
  ].join(' '));
  return body || normalizeWhitespace(observation.title);
}

function signalContentForObservation(observation: AgentSessionCompressedObservation): string {
  return firstSentence(classifierTextFor(observation), 240);
}

function isPureTaskMechanics(observation: AgentSessionCompressedObservation, text: string): boolean {
  const normalized = normalizeWhitespace(text);

  switch (observation.observation_type) {
    case 'command_run':
      return /^Ran (?:git (?:status|diff|add|commit)\b|pwd\b|ls\b|rg\b|bun (?:test\b|run typecheck\b))/i
        .test(normalized);
    case 'file_read':
      return /^Read\s+\S+/i.test(normalized);
    case 'file_write':
    case 'file_edit':
      return /^(?:Wrote|Edited|Updated|Created|Deleted|Patched|Applied patch)\s+/i.test(normalized);
    case 'tool_use':
      return /^(?:Called|Ran|Used)\s+/i.test(normalized);
    case 'search':
      return /^(?:Searched|Search(?:ed)? for)\s+/i.test(normalized);
    default:
      return false;
  }
}

function isMechanicalOutcome(outcome: string): boolean {
  const normalized = normalizeWhitespace(outcome);
  return /^Ran (?:git (?:status|diff|add|commit)\b|pwd\b|ls\b|rg\b|bun (?:test\b|run typecheck\b))/i
    .test(normalized)
    || /^(?:Read|Wrote|Edited|Updated|Created|Deleted|Patched|Applied patch|Called|Used|Searched)\s+/i
      .test(normalized)
    || /^Search(?:ed)? for\s+/i.test(normalized);
}

function isExplicitPreference(text: string): boolean {
  return /기억해|remember|prefer|preference|선호|좋아|싫어|routine|habit|습관/i.test(text);
}

function isProcedureSignal(text: string): boolean {
  return !isExplicitPreference(text)
    && /항상|always|workflow|procedure|runbook|검증 단계|release step/i.test(text);
}

function isTaskMemorySignal(observation: AgentSessionCompressedObservation, text: string): boolean {
  return observation.event_kind === 'session_stop'
    && /follow[- ]?up|next step|blocked|unresolved|후속|다음|미해결|막힘/i.test(text);
}

function isProjectNoteSignal(text: string): boolean {
  return /decision|decided|architecture|src\/|test\/|docs\/|system|repo|결정|구조|시스템/i.test(text)
    && !isExplicitPreference(text);
}

function isContradictionSignal(text: string): boolean {
  return /correction|correcting|actually|contradict|wrong|수정|정정|아니라/i.test(text);
}

function isOpenQuestion(text: string): boolean {
  return /\?|question|unclear|blocked|질문|불명확|막힘/i.test(text);
}

function scenarioSourceKindFor(observation: AgentSessionCompressedObservation): AgentSessionMemorySignal['scenario_source_kind'] {
  if (observation.observation_type === 'session_summary') return 'session_end';
  if (
    observation.observation_type === 'command_run'
    || observation.observation_type === 'file_read'
    || observation.observation_type === 'file_write'
    || observation.observation_type === 'file_edit'
  ) {
    return 'code_event';
  }
  return 'chat';
}

function firstSentence(text: string, maxLength: number): string {
  const trimmed = normalizeWhitespace(text);
  const sentence = trimmed.match(/^(.+?[.!?。！？])\s/)?.[1] ?? trimmed;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 3).trim()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function signalId(kind: string, sourceId: string, content: string): string {
  return `agent-session-signal:${createHash('sha256')
    .update([kind, sourceId, content].join('\0'))
    .digest('hex')
    .slice(0, 24)}`;
}

function dedupeSignals(signals: AgentSessionMemorySignal[]): AgentSessionMemorySignal[] {
  const deduped = new Map<string, AgentSessionMemorySignal>();
  for (const signal of signals) {
    const key = [
      signal.signal_kind,
      signal.candidate_type ?? 'none',
      signal.target_object_type ?? 'none',
      signal.scope_id,
      signal.content,
    ].join('\0');
    const existing = deduped.get(key);
    if (existing === undefined) {
      deduped.set(key, {
        ...signal,
        source_refs: dedupeValues(signal.source_refs),
      });
      continue;
    }
    const mergedSourceObservationIds = dedupeValues([
      ...(existing.dedupe_merged_source_observation_ids ?? [existing.source_observation_id]),
      signal.source_observation_id,
    ]);
    const mergedSignalCount = (existing.dedupe_merged_signal_count ?? 1) + 1;
    deduped.set(key, {
      ...existing,
      sensitivity: mostRestrictiveSensitivity(existing.sensitivity, signal.sensitivity),
      confidence_score: Math.max(existing.confidence_score, signal.confidence_score),
      importance_score: Math.max(existing.importance_score, signal.importance_score),
      source_refs: dedupeValues([...existing.source_refs, ...signal.source_refs]),
      prompt_injection_flagged: existing.prompt_injection_flagged === true || signal.prompt_injection_flagged === true,
      dedupe_merged_signal_count: mergedSignalCount,
      dedupe_merged_source_observation_ids: mergedSourceObservationIds,
    });
  }
  return [...deduped.values()];
}

function mostRestrictiveSensitivity(
  left: AgentSessionMemorySignal['sensitivity'],
  right: AgentSessionMemorySignal['sensitivity'],
): AgentSessionMemorySignal['sensitivity'] {
  return sensitivityRank(left) >= sensitivityRank(right) ? left : right;
}

function sensitivityRank(sensitivity: AgentSessionMemorySignal['sensitivity']): number {
  switch (sensitivity) {
    case 'secret':
      return 4;
    case 'personal':
      return 3;
    case 'work':
      return 2;
    case 'public':
      return 1;
    case 'unknown':
      return 0;
  }
}

function dedupeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
