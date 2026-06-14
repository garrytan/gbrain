import { buildAgentSessionCapturePlan } from './agent-session-memory-service.ts';
import type {
  EpisodeCaptureCategory,
  EpisodeCaptureDecision,
  EpisodeCapturePreview,
  EpisodeCapturePreviewDecision,
  EpisodeCapturePreviewInput,
  EpisodeCaptureTargetHint,
} from '../types.ts';

export function buildEpisodeCapturePreview(
  input: EpisodeCapturePreviewInput,
): EpisodeCapturePreview {
  const capture = buildAgentSessionCapturePlan(input);
  const decisions = capture.events.map((event, index): EpisodeCapturePreviewDecision => {
    const chunk = capture.ingest_plan.chunks[index];
    const redactedText = redactedEventText(chunk?.redacted_text ?? event.text);
    const category = classifyCaptureCategory(redactedText, event.event_kind);
    const unsafeReasonCodes = safetyReasonCodes(capture, index);
    const decision = decideCapture(category, unsafeReasonCodes.length > 0, input.allow_broad_raw_capture === true);

    return {
      event_id: event.event_id,
      event_kind: event.event_kind,
      category,
      decision,
      activation_label: decision === 'exclude' ? 'audit_only' : 'hint_only',
      authority: 'provenance_only',
      preview_text: redactedText,
      source_refs: [
        `source_item:${capture.ingest_plan.item.id}`,
        ...(chunk ? [`source_chunk:${chunk.id}`] : []),
      ],
      safety: {
        secret_risk: (chunk?.secret_risk ?? 'none') === 'none' ? 'none' : 'flagged',
        prompt_injection_flagged: (chunk?.prompt_injection_risk ?? 'none') !== 'none',
        redacted: Boolean(chunk && chunk.redacted_text !== chunk.chunk_text),
      },
      target_hint: targetHint(category, input),
      reason_codes: [
        `category:${category}`,
        ...unsafeReasonCodes,
        ...(decision === 'exclude' ? ['broad_raw_capture_disabled'] : ['allowlisted_capture']),
      ],
    };
  });

  return {
    raw_capture_enabled: input.allow_broad_raw_capture === true,
    source_refs: capture.source_refs,
    allowed_count: decisions.filter((decision) => decision.decision !== 'exclude').length,
    excluded_count: decisions.filter((decision) => decision.decision === 'exclude').length,
    safety: capture.safety,
    decisions,
  };
}

function classifyCaptureCategory(
  text: string,
  eventKind: EpisodeCapturePreviewDecision['event_kind'],
): EpisodeCaptureCategory {
  const normalized = text.toLowerCase();
  if (/\b(decided|decision|choose|chosen|adopt|결정|선택)\b/i.test(text)) return 'decision';
  if (eventKind === 'tool_failure' || /\b(failed|failure|error|exception|실패|오류)\b/i.test(text)) return 'failed_attempt';
  if (eventKind === 'session_stop' || /\b(resume|continue|next step|follow[- ]?up|이어|다음)\b/i.test(text)) return 'task_resume_state';
  if (/\b(stale code|code claim|reverify|verify code|symbol|content hash|재검증)\b/i.test(text)) return 'code_claim_revalidation';
  if (
    eventKind === 'explicit_memory_note'
    || /\b(remember|preference|prefer|기억|선호)\b/i.test(text)
  ) {
    return 'explicit_user_preference';
  }
  if (normalized.includes('source:') || /\bproject fact\b/i.test(text)) return 'source_backed_project_fact';
  return 'other';
}

function decideCapture(
  category: EpisodeCaptureCategory,
  unsafe: boolean,
  allowBroadRawCapture: boolean,
): EpisodeCaptureDecision {
  if (unsafe) return 'exclude';
  switch (category) {
    case 'decision':
    case 'failed_attempt':
    case 'code_claim_revalidation':
    case 'explicit_user_preference':
    case 'source_backed_project_fact':
      return 'capture_candidate';
    case 'task_resume_state':
      return 'capture_trace_only';
    case 'other':
      return allowBroadRawCapture ? 'capture_trace_only' : 'exclude';
  }
}

function targetHint(
  category: EpisodeCaptureCategory,
  input: EpisodeCapturePreviewInput,
): EpisodeCaptureTargetHint {
  switch (category) {
    case 'explicit_user_preference':
      return { target_object_type: 'profile_memory', target_object_id: null };
    case 'decision':
    case 'source_backed_project_fact':
      return { target_object_type: 'curated_note', target_object_id: input.workspace_id ?? null };
    case 'failed_attempt':
    case 'task_resume_state':
    case 'code_claim_revalidation':
      return { target_object_type: 'other', target_object_id: input.repo_path ?? input.workspace_id ?? null };
    case 'other':
      return { target_object_type: null, target_object_id: null };
  }
}

function safetyReasonCodes(
  capture: ReturnType<typeof buildAgentSessionCapturePlan>,
  index: number,
): string[] {
  const chunk = capture.ingest_plan.chunks[index];
  if (!chunk) return [];
  return [
    ...(chunk.secret_risk !== 'none' ? ['secret_redacted_review_required'] : []),
    ...(chunk.prompt_injection_risk !== 'none' ? ['prompt_injection_review_required'] : []),
  ];
}

function redactedEventText(redactedChunkText: string): string {
  const lines = redactedChunkText.split(/\r?\n/);
  return (lines.length > 1 ? lines.slice(1).join('\n') : redactedChunkText).trim();
}
