import { describe, expect, test } from 'bun:test';
import { classifyAgentSessionMemorySignals } from '../src/core/services/agent-session-classifier-service.ts';
import type { AgentSessionCompressedObservation, AgentSessionSummary } from '../src/core/types.ts';

describe('agent session signal classifier', () => {
  test('classifies explicit user preference memory notes as profile memory signals', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:preference',
      observation_type: 'conversation',
      title: 'explicit memory note',
      narrative: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
      facts: ['The user prefers a short implementation plan before code changes.'],
      importance_score: 0.85,
      confidence_score: 0.9,
      sensitivity: 'personal',
      scope_id: 'personal:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      source_observation_id: observation.id,
      content: '기억해 주세요.',
      evidence_kind: 'direct_user_statement',
      signal_kind: 'profile_memory',
      candidate_type: 'profile_update',
      target_object_type: 'profile_memory',
      target_object_id: null,
      scope_id: 'personal:default',
      sensitivity: 'personal',
      profile_type: 'preference',
      profile_subject: 'implementation planning',
      scenario_source_kind: 'chat',
    });
    expect(signals[0]?.confidence_score).toBeGreaterThanOrEqual(0.8);
    expect(signals[0]?.importance_score).toBeGreaterThanOrEqual(0.75);
  });

  test('propagates prompt-injection risk onto profile memory signals', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:prompt-injection-profile',
      observation_type: 'conversation',
      title: 'explicit memory note',
      narrative: 'Remember that I prefer short implementation plans.',
      facts: ['The user prefers short implementation plans.'],
      prompt_injection_flagged: true,
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      signal_kind: 'profile_memory',
      prompt_injection_flagged: true,
    });
  });

  test('adds a personal episode signal for a session stop outcome', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:session-stop',
      observation_type: 'session_summary',
      title: 'session outcome',
      narrative: 'Completed deterministic classifier tests.',
      facts: ['Completed deterministic classifier tests.'],
      importance_score: 0.7,
      confidence_score: 0.8,
    });
    const summary = buildSummary({
      title: 'Agent session classifier implementation',
      outcome: 'Completed deterministic classifier tests.',
      sensitivity: 'personal',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary,
    });

    expect(signals).toContainEqual(expect.objectContaining({
      source_observation_id: summary.id,
      evidence_kind: 'source_extracted',
      signal_kind: 'personal_episode',
      candidate_type: 'fact',
      target_object_type: 'personal_episode',
      scope_id: 'personal:default',
      sensitivity: 'personal',
      personal_episode_title: summary.title,
      personal_episode_source_kind: 'chat',
      scenario_source_kind: 'session_end',
      confidence_score: 0.7,
      importance_score: 0.55,
    }));
  });

  test('raises personal episode importance when summary has decisions or follow ups', () => {
    const observation = buildObservation({
      observation_type: 'session_summary',
      narrative: 'Completed deterministic classifier tests.',
      facts: ['Completed deterministic classifier tests.'],
    });
    const summary = buildSummary({
      outcome: 'Completed deterministic classifier tests.',
      decisions: ['Decision: keep deterministic routing.'],
      follow_ups: ['Follow-up: rerun typecheck.'],
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary,
    });

    expect(signals.find((signal) => signal.signal_kind === 'personal_episode')).toMatchObject({
      confidence_score: 0.7,
      importance_score: 0.75,
    });
  });

  test('does not create personal episodes without a session summary observation', () => {
    const observation = buildObservation({
      observation_type: 'conversation',
      event_kind: 'assistant_response',
      actor: 'assistant',
      narrative: 'The user prefers concise implementation planning checkpoints.',
      facts: ['The user prefers concise implementation planning checkpoints.'],
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({
        outcome: 'The user prefers concise implementation planning checkpoints.',
      }),
    });

    expect(signals.some((signal) => signal.signal_kind === 'personal_episode')).toBe(false);
  });

  test('classifies pure command run mechanics as no write and skips noisy episodes', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:git-status',
      observation_type: 'command_run',
      title: 'Ran git status --short.',
      narrative: 'Ran git status --short.',
      facts: ['Ran git status --short.'],
      importance_score: 0.45,
      confidence_score: 0.75,
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: 'Ran git status --short.' }),
    });

    expect(signals[0]).toMatchObject({
      source_observation_id: observation.id,
      evidence_kind: 'task_mechanics',
      signal_kind: 'no_write',
      candidate_type: null,
      target_object_type: null,
    });
    expect(signals.some((signal) => signal.signal_kind === 'personal_episode')).toBe(false);
  });

  test('classifies broadened mechanics as no write and suppresses personal episodes', () => {
    const observations = [
      buildObservation({
        id: 'agent-session-observation:typecheck',
        observation_type: 'command_run',
        title: 'Ran bun run typecheck.',
        narrative: 'Ran bun run typecheck.',
        facts: ['Ran bun run typecheck.'],
        sensitivity: 'work',
        scope_id: 'workspace:default',
      }),
      buildObservation({
        id: 'agent-session-observation:file-read',
        observation_type: 'file_read',
        title: 'Read classifier service.',
        narrative: 'Read src/core/services/agent-session-classifier-service.ts.',
        facts: ['Read src/core/services/agent-session-classifier-service.ts.'],
        sensitivity: 'work',
        scope_id: 'workspace:default',
      }),
      buildObservation({
        id: 'agent-session-observation:search',
        observation_type: 'search',
        title: 'Searched tests.',
        narrative: 'Searched for agent-session classifier tests.',
        facts: ['Searched for agent-session classifier tests.'],
        sensitivity: 'work',
        scope_id: 'workspace:default',
      }),
    ];

    const signals = classifyAgentSessionMemorySignals({
      observations,
      summary: buildSummary({ outcome: 'Ran bun run typecheck.' }),
    });

    expect(signals.map((signal) => signal.signal_kind)).toEqual(['no_write', 'no_write', 'no_write']);
  });

  test('suppresses mechanical summary outcomes in mixed sessions', () => {
    const preferenceObservation = buildObservation({
      id: 'agent-session-observation:mixed-preference',
      observation_type: 'conversation',
      narrative: 'Remember that I prefer short implementation plans.',
      facts: ['The user prefers short implementation plans.'],
      sensitivity: 'personal',
      scope_id: 'personal:default',
    });
    const mechanicsObservation = buildObservation({
      id: 'agent-session-observation:mixed-typecheck',
      observation_type: 'command_run',
      title: 'Ran bun run typecheck.',
      narrative: 'Ran bun run typecheck.',
      facts: ['Ran bun run typecheck.'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [preferenceObservation, mechanicsObservation],
      summary: buildSummary({ outcome: 'Ran bun run typecheck.' }),
    });

    expect(signals.map((signal) => signal.signal_kind)).toEqual(['profile_memory', 'no_write']);
    expect(signals.some((signal) => signal.signal_kind === 'personal_episode')).toBe(false);
  });

  test('uses body text so noisy command titles do not become durable signals', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:noisy-title',
      observation_type: 'command_run',
      title: 'Remember workflow',
      narrative: '',
      facts: ['Ran git status --short.'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: 'Ran git status --short.' }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_kind: 'no_write',
      evidence_kind: 'task_mechanics',
    });
  });

  test('keeps profile signals secret when the source observation is secret', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:secret-preference',
      observation_type: 'conversation',
      title: 'explicit memory note',
      narrative: 'Remember that I prefer discussing the redacted secret workflow privately.',
      facts: ['The user prefers the redacted secret workflow to stay private.'],
      importance_score: 0.85,
      confidence_score: 0.9,
      sensitivity: 'secret',
      scope_id: 'personal:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '', sensitivity: 'secret' }),
    });

    expect(signals[0]).toMatchObject({
      signal_kind: 'profile_memory',
      sensitivity: 'secret',
    });
  });

  test('classifies procedure signals from non-preference workflow text', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:procedure',
      observation_type: 'conversation',
      title: 'Procedure',
      narrative: 'Always run the focused test before typecheck.',
      facts: ['Always run the focused test before typecheck.'],
      confidence_score: 0.85,
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      evidence_kind: 'source_extracted',
      signal_kind: 'procedure',
      candidate_type: 'procedure',
      target_object_type: 'procedure',
    });
  });

  test('classifies open question signals', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:question',
      observation_type: 'conversation',
      title: 'Question',
      narrative: 'Blocked: should this runtime use direct writeback?',
      facts: ['Blocked: should this runtime use direct writeback?'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      evidence_kind: 'ambiguous',
      signal_kind: 'open_question',
      candidate_type: 'open_question',
      target_object_type: 'other',
    });
  });

  test('classifies follow-up session stop text as task memory', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:task-memory',
      event_kind: 'session_stop',
      observation_type: 'session_summary',
      actor: 'system',
      narrative: 'Follow-up: run activation tests and verify CI checks.',
      facts: ['Next step: run activation tests and verify CI checks.'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      evidence_kind: 'code_sensitive',
      signal_kind: 'task_memory',
      candidate_type: 'rationale',
      target_object_type: 'other',
      scope_id: 'workspace:default',
      sensitivity: 'work',
      scenario_source_kind: 'code_event',
    });
  });

  test('classifies project decisions as project note candidates', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:project-note',
      observation_type: 'conversation',
      narrative: 'Decision: keep agent session compression deterministic in src/core services.',
      facts: ['Decision: keep agent session compression deterministic in src/core services.'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      evidence_kind: 'source_extracted',
      signal_kind: 'project_note',
      candidate_type: 'note_update',
      target_object_type: 'curated_note',
      scope_id: 'workspace:default',
      sensitivity: 'work',
      scenario_source_kind: 'code_event',
    });
  });

  test('routes correction language as contradictory project note review', () => {
    const observation = buildObservation({
      id: 'agent-session-observation:contradiction',
      observation_type: 'conversation',
      narrative: 'Correction: the previous mbrain note about direct canonical writes was wrong.',
      facts: ['The previous mbrain note about direct canonical writes was wrong.'],
      sensitivity: 'work',
      scope_id: 'workspace:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      evidence_kind: 'contradicts_existing',
      signal_kind: 'project_note',
      candidate_type: 'note_update',
      target_object_type: 'curated_note',
      scope_id: 'workspace:default',
      scenario_source_kind: 'trace_review',
    });
  });

  test('keeps personal episode signals secret when the summary is secret', () => {
    const observation = buildObservation({
      observation_type: 'session_summary',
      narrative: 'Completed secret session work.',
      facts: ['Completed secret session work.'],
      sensitivity: 'secret',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({
        outcome: 'Completed secret session work.',
        sensitivity: 'secret',
      }),
    });

    expect(signals.find((signal) => signal.signal_kind === 'personal_episode')).toMatchObject({
      sensitivity: 'secret',
    });
  });

  test('keeps profile source kind chat even for code-event observations', () => {
    const observation = buildObservation({
      observation_type: 'file_edit',
      narrative: 'Remember that I prefer concise review fixes.',
      facts: ['The user prefers concise review fixes.'],
      sensitivity: 'personal',
      scope_id: 'personal:default',
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [observation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals[0]).toMatchObject({
      signal_kind: 'profile_memory',
      scenario_source_kind: 'chat',
    });
  });

  test('dedupes by merging sensitivity, source refs, and scores', () => {
    const personalObservation = buildObservation({
      id: 'agent-session-observation:personal-duplicate',
      narrative: 'Remember that I prefer short implementation plans.',
      facts: ['The user prefers short implementation plans.'],
      sensitivity: 'personal',
      source_refs: ['source_chunk:personal'],
      confidence_score: 0.82,
      importance_score: 0.76,
    });
    const secretObservation = buildObservation({
      id: 'agent-session-observation:secret-duplicate',
      narrative: 'Remember that I prefer short implementation plans.',
      facts: ['The user prefers short implementation plans.'],
      sensitivity: 'secret',
      source_refs: ['source_chunk:secret'],
      confidence_score: 0.9,
      importance_score: 0.85,
    });

    const signals = classifyAgentSessionMemorySignals({
      observations: [personalObservation, secretObservation],
      summary: buildSummary({ outcome: '' }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_kind: 'profile_memory',
      sensitivity: 'secret',
      source_refs: ['source_chunk:personal', 'source_chunk:secret'],
      confidence_score: 0.9,
      importance_score: 0.85,
    });
  });
});

function buildObservation(
  overrides: Partial<AgentSessionCompressedObservation> = {},
): AgentSessionCompressedObservation {
  return {
    id: 'agent-session-observation:default',
    source_item_id: 'source-item:session-1',
    source_chunk_ids: ['source-chunk:1'],
    session_id: 'session-1',
    event_ids: ['agent-session-event:1'],
    event_kind: 'user_prompt',
    actor: 'user',
    observed_at: '2026-06-03T01:00:00.000Z',
    observation_type: 'conversation',
    title: 'Agent session observation',
    narrative: 'The session produced an observation.',
    facts: ['The session produced an observation.'],
    concepts: [],
    files: [],
    importance_score: 0.65,
    confidence_score: 0.75,
    sensitivity: 'personal',
    scope_id: 'personal:default',
    source_refs: ['source_item:source-item:session-1', 'source_chunk:source-chunk:1'],
    generated_by: 'agent_session_capture',
    ...overrides,
  };
}

function buildSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'agent-session-summary:session-1',
    session_id: 'session-1',
    source_item_ids: ['source-item:session-1'],
    source_chunk_ids: ['source-chunk:1'],
    started_at: '2026-06-03T01:00:00.000Z',
    ended_at: '2026-06-03T01:10:00.000Z',
    title: 'Agent session summary',
    outcome: 'The session completed.',
    user_goals: [],
    decisions: [],
    preferences: [],
    files_touched: [],
    errors_and_fixes: [],
    unresolved_questions: [],
    follow_ups: [],
    candidate_memory_signals: [],
    source_refs: ['source_item:source-item:session-1', 'source_chunk:source-chunk:1'],
    sensitivity: 'personal',
    generated_by: 'agent_session_capture',
    ...overrides,
  };
}
