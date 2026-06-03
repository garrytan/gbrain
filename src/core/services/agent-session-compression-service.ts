import { createHash } from 'crypto';
import type {
  AgentSessionCompressedObservation,
  AgentSessionNormalizedEvent,
  AgentSessionObservationType,
  AgentSessionSummary,
} from '../types.ts';
import type { AgentSessionCapturePlan } from './agent-session-memory-service.ts';

export function compressAgentSessionCapturePlan(plan: AgentSessionCapturePlan): AgentSessionCompressedObservation[] {
  validateEventChunkAlignment(plan);

  return plan.events.map((event, index) => {
    const chunk = plan.ingest_plan.chunks[index];
    const text = chunk.redacted_text;
    const files = extractFilePaths(text);
    const concepts = extractConcepts(text);

    return {
      id: stableId('agent-session-observation', plan.ingest_plan.item.id, event.event_id),
      source_item_id: plan.ingest_plan.item.id,
      source_chunk_ids: [chunk.id],
      session_id: event.session_id,
      event_ids: [event.event_id],
      event_kind: event.event_kind,
      actor: event.actor,
      observed_at: event.occurred_at,
      observation_type: observationTypeFor(event),
      title: titleFor(event, text),
      narrative: firstSentence(text, 240),
      facts: factLinesFor(text),
      concepts,
      files,
      importance_score: importanceFor(event, text),
      confidence_score: confidenceFor(event, text, chunk.redacted_text !== chunk.chunk_text),
      sensitivity: sensitivityFor(text, chunk.sensitivity_flags),
      scope_id: scopeFor(text, chunk.sensitivity_flags),
      source_refs: [`source_item:${plan.ingest_plan.item.id}`, `source_chunk:${chunk.id}`],
      prompt_injection_flagged: chunk.prompt_injection_risk !== 'none',
      generated_by: 'agent_session_capture',
    };
  });
}

export function summarizeAgentSessionObservations(
  observations: AgentSessionCompressedObservation[],
): AgentSessionSummary {
  const sessionId = observations[0]?.session_id ?? 'unknown-session';
  const sourceItemIds = dedupe(observations.map((observation) => observation.source_item_id));
  const sourceChunkIds = dedupe(observations.flatMap((observation) => observation.source_chunk_ids));
  const sourceRefs = dedupe(observations.flatMap((observation) => observation.source_refs));
  const facts = observations.flatMap((observation) => observation.facts);

  return {
    id: stableId('agent-session-summary', sessionId, ...sourceChunkIds),
    session_id: sessionId,
    source_item_ids: sourceItemIds,
    source_chunk_ids: sourceChunkIds,
    started_at: observations[0]?.observed_at ?? null,
    ended_at: observations.at(-1)?.observed_at ?? null,
    title: observations[0]?.title ?? 'Agent session summary',
    outcome: firstMatching(facts, [/completed/i, /fixed/i, /resolved/i, /완료|해결|수정/i])
      ?? firstSentence(facts.join(' '), 220),
    user_goals: facts.filter((fact) => /목표|요청|goal|want|request/i.test(fact)).slice(0, 5),
    decisions: facts.filter((fact) => /decid|decision|선택|결정/i.test(fact)).slice(0, 5),
    preferences: facts.filter((fact) => /prefer|preference|선호|좋아|싫어|기억/i.test(fact)).slice(0, 5),
    files_touched: dedupe(observations.flatMap((observation) => observation.files)).slice(0, 20),
    errors_and_fixes: facts.filter((fact) => /error|fail|fixed|failing|오류|실패|수정/i.test(fact)).slice(0, 8),
    unresolved_questions: facts.filter((fact) => /\?|question|unclear|blocked|미해결|질문|불명확/i.test(fact)).slice(0, 8),
    follow_ups: facts.filter((fact) => /follow[- ]?up|next|후속|다음|추가/i.test(fact)).slice(0, 8),
    candidate_memory_signals: facts.filter((fact) => /remember|prefer|decision|기억|선호|결정/i.test(fact)).slice(0, 10),
    source_refs: sourceRefs,
    sensitivity: summarySensitivity(observations),
    prompt_injection_flagged: observations.some((observation) => observation.prompt_injection_flagged === true),
    generated_by: 'agent_session_capture',
  };
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/\b(?:src|test|docs|scripts|skills|reference)\/[A-Za-z0-9._/-]+\b/g) ?? [];
  return dedupe(matches);
}

function extractConcepts(text: string): string[] {
  const concepts: string[] = [];
  if (/memory|메모리/i.test(text)) concepts.push('memory');
  if (/profile|preference|prefer|선호/i.test(text)) concepts.push('profile memory');
  if (/episode|session|세션/i.test(text)) concepts.push('personal episode');
  if (/plan|플랜|spec/i.test(text)) concepts.push('planning');
  if (/test|fail|pass|검증/i.test(text)) concepts.push('verification');
  return dedupe(concepts);
}

function observationTypeFor(event: AgentSessionNormalizedEvent): AgentSessionObservationType {
  switch (event.event_kind) {
    case 'tool_failure':
      return 'tool_failure';
    case 'tool_call':
    case 'tool_result':
      return 'tool_use';
    case 'file_read':
      return 'file_read';
    case 'file_write':
      return 'file_write';
    case 'file_edit':
      return 'file_edit';
    case 'command_run':
      return 'command_run';
    case 'search':
      return 'search';
    case 'subagent_result':
      return 'subagent';
    case 'session_stop':
      return 'session_summary';
    case 'user_prompt':
    case 'assistant_response':
    case 'explicit_memory_note':
      return 'conversation';
    default:
      return 'other';
  }
}

function titleFor(event: AgentSessionNormalizedEvent, text: string): string {
  if (event.event_kind === 'explicit_memory_note') return 'explicit memory note';
  if (event.event_kind === 'session_stop') return 'session outcome';
  if (event.event_kind === 'command_run') {
    return firstSentence(text.replace(/^.*command_run\s*/m, ''), 80);
  }
  return firstSentence(text, 80);
}

function factLinesFor(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const withoutHeader = lines[0] !== undefined && isFormattedEventHeader(lines[0]) ? lines.slice(1) : lines;
  return withoutHeader.slice(0, 5);
}

function importanceFor(event: AgentSessionNormalizedEvent, text: string): number {
  if (event.event_kind === 'explicit_memory_note') return 0.85;
  if (/기억|remember|decision|결정|preference|prefer|선호/i.test(text)) return 0.8;
  if (event.event_kind === 'session_stop') return 0.7;
  if (/fail|error|fixed|failing|실패|수정/i.test(text)) return 0.65;
  return 0.45;
}

function confidenceFor(event: AgentSessionNormalizedEvent, text: string, redacted: boolean): number {
  if (redacted) return 0.45;
  if (event.actor === 'user') return 0.85;
  if (event.event_kind === 'tool_result' || event.event_kind === 'command_run') return 0.75;
  if (/inferred|추론/i.test(text)) return 0.5;
  return 0.65;
}

function sensitivityFor(text: string, flags: string[]): AgentSessionCompressedObservation['sensitivity'] {
  if (flags.includes('secret')) return 'secret';
  if (/personal|private|prefer|preference|선호|개인|routine|habit|health|family|기억해/i.test(text)) {
    return 'personal';
  }
  if (/public/i.test(text)) return 'public';
  return 'work';
}

function scopeFor(text: string, flags: string[]): string {
  return sensitivityFor(text, flags) === 'personal' ? 'personal:default' : 'workspace:default';
}

function summarySensitivity(observations: AgentSessionCompressedObservation[]): AgentSessionCompressedObservation['sensitivity'] {
  if (observations.some((observation) => observation.sensitivity === 'secret')) return 'secret';
  if (observations.some((observation) => observation.sensitivity === 'personal')) return 'personal';
  if (observations.some((observation) => observation.sensitivity === 'work')) return 'work';
  if (observations.some((observation) => observation.sensitivity === 'public')) return 'public';
  return 'unknown';
}

function validateEventChunkAlignment(plan: AgentSessionCapturePlan): void {
  if (plan.events.length !== plan.ingest_plan.chunks.length) {
    throw new Error('agent session capture plan event/chunk count mismatch');
  }
  for (const [index, chunk] of plan.ingest_plan.chunks.entries()) {
    if (chunk.chunk_index !== index) {
      throw new Error('agent session capture plan chunk order mismatch');
    }
  }
}

function firstSentence(text: string, maxLength: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const sentence = trimmed.match(/^(.+?[.!?。！？])\s/)?.[1] ?? trimmed;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 3).trim()}...`;
}

function firstMatching(values: string[], patterns: RegExp[]): string | null {
  return values.find((value) => patterns.some((pattern) => pattern.test(value))) ?? null;
}

function isFormattedEventHeader(line: string): boolean {
  return /^\[[^\]]+\]\s+\w+\s+\w+$/.test(line);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
