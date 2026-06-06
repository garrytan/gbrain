import { describe, expect, test } from 'bun:test';
import { buildEpisodeCapturePreview } from '../src/core/services/episode-capture-service.ts';

describe('episode capture preview service', () => {
  test('allowlists durable agent-session categories and excludes broad raw chat', () => {
    const preview = buildEpisodeCapturePreview({
      source_kind: 'codex_session',
      session_id: 'phase5-session',
      now: '2026-06-06T00:00:00.000Z',
      events: [
        { event_kind: 'assistant_response', text: 'We decided to keep canonical reads as the answer boundary.' },
        { event_kind: 'tool_failure', text: 'bun test failed with missing_dependency under branch phase5.' },
        { event_kind: 'session_stop', text: 'Resume by running the focused phase5 tests next.' },
        { event_kind: 'tool_result', text: 'Stale code claim: reverify src/core/operations.ts before citing it.' },
        { event_kind: 'explicit_memory_note', text: 'Remember: I prefer short implementation plans.' },
        { event_kind: 'user_prompt', text: 'Source: user direct message. Project fact: Phase 5 stays preview-first.' },
        { event_kind: 'assistant_response', text: 'I read files and prepared a response.' },
      ],
    });

    expect(preview.raw_capture_enabled).toBe(false);
    expect(preview.decisions.map((decision) => decision.category)).toEqual([
      'decision',
      'failed_attempt',
      'task_resume_state',
      'code_claim_revalidation',
      'explicit_user_preference',
      'source_backed_project_fact',
      'other',
    ]);
    expect(preview.decisions.slice(0, 6).every((decision) => decision.decision !== 'exclude')).toBe(true);
    expect(preview.decisions[6]).toMatchObject({
      decision: 'exclude',
      activation_label: 'audit_only',
    });
    expect(preview.allowed_count).toBe(6);
    expect(preview.excluded_count).toBe(1);
  });

  test('redacts or rejects secret-bearing input before exposing preview text', () => {
    const preview = buildEpisodeCapturePreview({
      source_kind: 'codex_session',
      session_id: 'secret-session',
      now: '2026-06-06T00:00:00.000Z',
      events: [{
        event_kind: 'explicit_memory_note',
        text: 'Remember this token sk-testsecret1234567890 for later.',
      }],
    });

    const [decision] = preview.decisions;
    expect(decision.preview_text).toContain('[REDACTED:openai_api_key]');
    expect(decision.preview_text).not.toContain('sk-testsecret1234567890');
    expect(decision).toMatchObject({
      decision: 'exclude',
      safety: {
        redacted: true,
        secret_risk: 'flagged',
      },
    });
    expect(decision.reason_codes).toContain('secret_redacted_review_required');
  });

  test('marks raw episode capture as provenance or hint only, never answer ground', () => {
    const preview = buildEpisodeCapturePreview({
      source_kind: 'codex_session',
      session_id: 'authority-session',
      now: '2026-06-06T00:00:00.000Z',
      events: [
        { event_kind: 'assistant_response', text: 'Decision: use read_context before answering.' },
        { event_kind: 'assistant_response', text: 'Ordinary narration with no durable signal.' },
      ],
    });

    expect(preview.decisions.map((decision) => decision.activation_label)).toEqual([
      'hint_only',
      'audit_only',
    ]);
    expect(preview.decisions.every((decision) => decision.activation_label !== 'answer_ground')).toBe(true);
    expect(preview.decisions.every((decision) => decision.authority === 'provenance_only')).toBe(true);
  });
});
