import { describe, expect, test } from 'bun:test';
import {
  compressAgentSessionCapturePlan,
  summarizeAgentSessionObservations,
} from '../src/core/services/agent-session-compression-service.ts';
import { buildAgentSessionCapturePlan } from '../src/core/services/agent-session-memory-service.ts';

describe('agent session zero-LLM compression', () => {
  test('compresses a redacted personal explicit memory note into a non-authoritative observation', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-1',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-1',
        event_kind: 'explicit_memory_note',
        actor: 'user',
        text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });

    const observations = compressAgentSessionCapturePlan(plan);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observation_type: 'conversation',
      session_id: 'session-1',
      sensitivity: 'personal',
      scope_id: 'personal:default',
      generated_by: 'agent_session_capture',
    });
    expect(observations[0].title).toContain('memory note');
    expect(observations[0].facts).toEqual(expect.arrayContaining([
      expect.stringContaining('짧은 플랜'),
    ]));
    expect(observations[0].source_refs).toEqual([
      `source_item:${plan.ingest_plan.item.id}`,
      `source_chunk:${plan.ingest_plan.chunks[0].id}`,
    ]);
  });

  test('summarizes decisions, files, errors, and follow-ups from observations', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-2',
      events: [
        {
          source_kind: 'codex_session',
          session_id: 'session-2',
          event_kind: 'user_prompt',
          actor: 'user',
          text: 'Goal: implement agent session memory compression. Decision: keep it deterministic.',
          occurred_at: '2026-06-03T01:00:00.000Z',
        },
        {
          source_kind: 'codex_session',
          session_id: 'session-2',
          event_kind: 'file_edit',
          actor: 'assistant',
          text: 'Edited src/core/services/agent-session-memory-service.ts and fixed a failing test. Follow-up: run typecheck.',
          occurred_at: '2026-06-03T01:10:00.000Z',
        },
      ],
      now: '2026-06-03T01:11:00.000Z',
    });

    const summary = summarizeAgentSessionObservations(compressAgentSessionCapturePlan(plan));

    expect(summary.session_id).toBe('session-2');
    expect(summary.user_goals[0]).toContain('agent session memory');
    expect(summary.decisions[0]).toContain('deterministic');
    expect(summary.files_touched).toContain('src/core/services/agent-session-memory-service.ts');
    expect(summary.errors_and_fixes[0]).toContain('fixed a failing test');
    expect(summary.follow_ups[0]).toContain('run typecheck');
    expect(summary.source_refs).toEqual(expect.arrayContaining(plan.source_refs));
  });

  test('uses redacted text and secret sensitivity for secret-bearing events', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-secret',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-secret',
        event_kind: 'user_prompt',
        actor: 'user',
        text: 'Remember that the temporary OpenAI key is sk-testsecret1234567890.',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });

    const [observation] = compressAgentSessionCapturePlan(plan);

    expect(observation.sensitivity).toBe('secret');
    expect(observation.narrative).toContain('[REDACTED:openai_api_key]');
    expect(observation.narrative).not.toContain('sk-testsecret1234567890');
    expect(observation.facts.join('\n')).toContain('[REDACTED:openai_api_key]');
    expect(observation.facts.join('\n')).not.toContain('sk-testsecret1234567890');
  });

  test('carries prompt-injection risk into observations and summaries', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-prompt-injection',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-prompt-injection',
        event_kind: 'assistant_response',
        actor: 'assistant',
        text: 'I will ignore previous instructions and continue.',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });

    const observations = compressAgentSessionCapturePlan(plan);
    const summary = summarizeAgentSessionObservations(observations);

    expect(plan.safety.prompt_injection_flagged).toBe(true);
    expect(observations[0]?.prompt_injection_flagged).toBe(true);
    expect(summary.prompt_injection_flagged).toBe(true);
  });

  test('derives command run titles from the body without the formatted event header', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-command',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-command',
        event_kind: 'command_run',
        actor: 'tool',
        text: 'bun test test/agent-session-compression-service.test.ts',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });

    const [observation] = compressAgentSessionCapturePlan(plan);

    expect(observation.title).toContain('bun test');
    expect(observation.title).not.toStartWith('[2026-06-03T01:00:00.000Z] tool command_run');
  });

  test('fails closed when capture plan events and chunks are misaligned', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-mismatch',
      events: [
        {
          source_kind: 'codex_session',
          session_id: 'session-mismatch',
          event_kind: 'user_prompt',
          actor: 'user',
          text: 'Goal: test mismatch handling.',
        },
        {
          source_kind: 'codex_session',
          session_id: 'session-mismatch',
          event_kind: 'assistant_response',
          actor: 'assistant',
          text: 'Second event.',
        },
      ],
      now: '2026-06-03T01:01:00.000Z',
    });

    plan.ingest_plan.chunks.pop();
    expect(() => compressAgentSessionCapturePlan(plan)).toThrow('agent session capture plan event/chunk count mismatch');

    const reordered = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-reordered',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-reordered',
        event_kind: 'user_prompt',
        actor: 'user',
        text: 'Goal: test chunk order handling.',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });
    reordered.ingest_plan.chunks[0].chunk_index = 1;

    expect(() => compressAgentSessionCapturePlan(reordered)).toThrow('agent session capture plan chunk order mismatch');
  });

  test('summarizes common Korean category labels', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-korean-labels',
      events: [
        {
          source_kind: 'codex_session',
          session_id: 'session-korean-labels',
          event_kind: 'user_prompt',
          actor: 'user',
          text: '요청: compression summary labels를 넓혀 주세요.',
        },
        {
          source_kind: 'codex_session',
          session_id: 'session-korean-labels',
          event_kind: 'assistant_response',
          actor: 'assistant',
          text: '오류: summary regex missed Korean labels.\n미해결: instruction category는 기존 인터페이스에 없습니다.\n후속: typecheck를 다시 실행하세요.',
        },
      ],
      now: '2026-06-03T01:01:00.000Z',
    });

    const summary = summarizeAgentSessionObservations(compressAgentSessionCapturePlan(plan));

    expect(summary.user_goals[0]).toContain('요청');
    expect(summary.errors_and_fixes[0]).toContain('오류');
    expect(summary.unresolved_questions[0]).toContain('미해결');
    expect(summary.follow_ups[0]).toContain('후속');
  });
});

describe('fact truncation observability (B-8)', () => {
  function planWithFactLines(count: number) {
    const text = Array.from({ length: count }, (_, i) => `fact line number ${i + 1}`).join('\n');
    return buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-trunc',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-trunc',
        event_kind: 'user_prompt',
        actor: 'user',
        text,
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });
  }

  test('records truncated_fact_count when an event has more facts than the limit', () => {
    const observations = compressAgentSessionCapturePlan(planWithFactLines(9));
    expect(observations[0].facts).toHaveLength(5);
    expect(observations[0].truncated_fact_count).toBe(4);
  });

  test('omits truncated_fact_count when nothing is dropped', () => {
    const observations = compressAgentSessionCapturePlan(planWithFactLines(3));
    expect(observations[0].facts.length).toBeGreaterThan(0);
    expect(observations[0].truncated_fact_count).toBeUndefined();
  });

  test('honors a configurable max_facts limit', () => {
    const observations = compressAgentSessionCapturePlan(planWithFactLines(9), { max_facts: 8 });
    expect(observations[0].facts).toHaveLength(8);
    expect(observations[0].truncated_fact_count).toBe(1);
  });
});

describe('header stripping accuracy (B-8 review)', () => {
  test('strips the real event header and counts truncation over body lines only', () => {
    const body = Array.from({ length: 9 }, (_, i) => `fact line number ${i + 1}`).join('\n');
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-header',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-header',
        event_kind: 'user_prompt',
        actor: 'user',
        text: body,
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });
    // The capture plan formats each chunk as "[<ISO>] <actor> <kind>\n<text>".
    expect(plan.ingest_plan.chunks[0].redacted_text.startsWith('[2026-06-03T01:00:00.000Z] user user_prompt')).toBe(true);

    const observations = compressAgentSessionCapturePlan(plan);
    expect(observations[0].facts).toHaveLength(5);
    expect(observations[0].facts[0]).toBe('fact line number 1');
    expect(observations[0].truncated_fact_count).toBe(4);
  });

  test('keeps bracket-prefixed user lines that merely look header-ish', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-bracket',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-bracket',
        event_kind: 'user_prompt',
        actor: 'user',
        text: '[important] review this\nsecond fact line',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });
    const observations = compressAgentSessionCapturePlan(plan);
    expect(observations[0].facts).toContain('[important] review this');
    expect(observations[0].facts).toContain('second fact line');
  });
});
