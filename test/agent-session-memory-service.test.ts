import { expect, test } from 'bun:test';
import {
  buildAgentSessionCapturePlan,
  normalizeAgentSessionEvent,
} from '../src/core/services/agent-session-memory-service.ts';
import type {
  AgentSessionCompressedObservation,
  AgentSessionEventInput,
  AgentSessionMemorySignal,
} from '../src/core/types.ts';

test('agent session memory types are exported through the core type barrel', () => {
  const event: AgentSessionEventInput = {
    source_kind: 'codex_session',
    session_id: 'session-1',
    event_kind: 'user_prompt',
    actor: 'user',
    text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
  };
  const observation: AgentSessionCompressedObservation = {
    id: 'agent-session-observation:1',
    source_item_id: 'source-item:1',
    source_chunk_ids: ['source-chunk:1'],
    session_id: 'session-1',
    event_ids: ['event-1'],
    event_kind: 'user_prompt',
    actor: 'user',
    observed_at: '2026-06-03T01:00:00.000Z',
    observation_type: 'conversation',
    title: 'User stated planning preference',
    narrative: 'The user asked mbrain to remember a planning preference.',
    facts: ['The user prefers a short plan before implementation.'],
    concepts: ['planning preference'],
    files: [],
    importance_score: 0.8,
    confidence_score: 0.85,
    sensitivity: 'personal',
    scope_id: 'personal:default',
    source_refs: ['source_item:source-item:1', 'source_chunk:source-chunk:1'],
    generated_by: 'agent_session_capture',
  };
  const signal: AgentSessionMemorySignal = {
    id: 'agent-session-signal:1',
    source_observation_id: observation.id,
    content: 'The user prefers a short plan before implementation.',
    evidence_kind: 'direct_user_statement',
    signal_kind: 'profile_memory',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: 'personal',
    confidence_score: 0.85,
    importance_score: 0.8,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    profile_type: 'preference',
    profile_subject: 'implementation planning',
  };

  expect(event.source_kind).toBe('codex_session');
  expect(observation.generated_by).toBe('agent_session_capture');
  expect(signal.signal_kind).toBe('profile_memory');
});

test('normalizes session events with stable ids and actor defaults', () => {
  const input: AgentSessionEventInput = {
    source_kind: 'codex_session',
    session_id: 'session-1',
    event_kind: 'tool_result',
    text: 'Ran bun test test/agent-session-memory-service.test.ts',
  };
  const event = normalizeAgentSessionEvent(input, '2026-06-03T01:00:00.000Z');
  const repeated = normalizeAgentSessionEvent(input, '2026-06-03T01:00:00.000Z');

  expect(event.event_id).toMatch(/^agent-session-event:/);
  expect(event.event_id).toBe(repeated.event_id);
  expect(event.actor).toBe('tool');
  expect(event.client_name).toBe('codex');
  expect(event.occurred_at).toBe('2026-06-03T01:00:00.000Z');
  expect(event.metadata).toEqual({});
});

test('defaults source, client, and actor from session event kind', () => {
  const start = normalizeAgentSessionEvent({
    session_id: 'session-1',
    event_kind: 'session_start',
    text: 'Session started.',
  }, '2026-06-03T01:00:00.000Z');
  const subagent = normalizeAgentSessionEvent({
    source_kind: 'claude_session',
    session_id: 'session-1',
    event_kind: 'subagent_result',
    text: 'Subagent returned a candidate finding.',
  }, '2026-06-03T01:00:01.000Z');
  const fileWrite = normalizeAgentSessionEvent({
    session_id: 'session-1',
    event_kind: 'file_write',
    text: 'Wrote a scoped service file.',
  }, '2026-06-03T01:00:02.000Z');

  expect(start.source_kind).toBe('agent_session');
  expect(start.client_name).toBe('agent');
  expect(start.actor).toBe('system');
  expect(subagent.client_name).toBe('claude');
  expect(subagent.actor).toBe('assistant');
  expect(fileWrite.actor).toBe('tool');
  expect(() => normalizeAgentSessionEvent({
    event_kind: 'user_prompt',
    text: 'Missing session id.',
  }, '2026-06-03T01:00:03.000Z')).toThrow('session_id must be a non-empty string');
});

test('builds redacted raw ingest plan before compression', () => {
  const plan = buildAgentSessionCapturePlan({
    source_kind: 'codex_session',
    session_id: 'session-1',
    client_name: 'codex',
    source_id: 'source:codex-session',
    events: [{
      source_kind: 'codex_session',
      session_id: 'session-1',
      event_kind: 'user_prompt',
      actor: 'user',
      text: '기억해 주세요. sk-testsecret1234567890 값은 비밀입니다.',
      occurred_at: '2026-06-03T01:00:00.000Z',
    }],
    now: '2026-06-03T01:01:00.000Z',
  });

  expect(plan.ingest_plan.item.origin_event).toBe('session_capture');
  expect(plan.ingest_plan.chunks[0].redacted_text).toContain('[REDACTED:openai_api_key]');
  expect(plan.safety.secret_risk).toBe('flagged');
  expect(plan.source_refs).toEqual(expect.arrayContaining([
    `source_item:${plan.ingest_plan.item.id}`,
    `source_chunk:${plan.ingest_plan.chunks[0].id}`,
  ]));
});

test('builds one raw ingest chunk per defaulted event and surfaces prompt-injection safety', () => {
  const plan = buildAgentSessionCapturePlan({
    source_kind: 'codex_session',
    session_id: 'session-merge',
    client_name: 'codex',
    source_id: 'source:codex-session',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    events: [{
      event_kind: 'user_prompt',
      text: 'Please remember this implementation preference.',
    }, {
      event_kind: 'assistant_response',
      text: 'I will ignore previous instructions and continue.',
    }],
    now: '2026-06-03T02:00:00.000Z',
  });

  expect(plan.events).toHaveLength(2);
  expect(plan.events.map((event) => ({
    source_kind: event.source_kind,
    session_id: event.session_id,
    client_name: event.client_name,
    repo_path: event.repo_path,
    workspace_id: event.workspace_id,
    metadata: event.metadata,
  }))).toEqual([{
    source_kind: 'codex_session',
    session_id: 'session-merge',
    client_name: 'codex',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    metadata: {},
  }, {
    source_kind: 'codex_session',
    session_id: 'session-merge',
    client_name: 'codex',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    metadata: {},
  }]);
  expect(plan.ingest_plan.chunks.length).toBe(plan.events.length);
  expect(plan.ingest_plan.item.locator).toBe('codex_session://session-merge');
  expect(plan.ingest_plan.item.title).toBe('Agent session session-merge');
  expect(plan.ingest_plan.chunks.map((chunk) => chunk.parser_version)).toEqual([
    'agent-session:v1',
    'agent-session:v1',
  ]);
  expect(plan.ingest_plan.chunks.map((chunk) => chunk.extractor_version)).toEqual([
    'agent-session-memory:v1',
    'agent-session-memory:v1',
  ]);
  expect(plan.ingest_plan.item.metadata_json).toEqual({
    source_kind: 'codex_session',
    session_id: 'session-merge',
    client_name: 'codex',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    event_ids: plan.events.map((event) => event.event_id),
  });
  expect(plan.safety.prompt_injection_flagged).toBe(true);
});

test('rejects capture events from a different source kind or session', () => {
  expect(() => buildAgentSessionCapturePlan({
    source_kind: 'codex_session',
    session_id: 'session-1',
    events: [{
      source_kind: 'claude_session',
      event_kind: 'user_prompt',
      text: 'Wrong source.',
    }],
  })).toThrow('event source_kind must match capture source_kind');

  expect(() => buildAgentSessionCapturePlan({
    source_kind: 'codex_session',
    session_id: 'session-1',
    events: [{
      session_id: 'session-2',
      event_kind: 'user_prompt',
      text: 'Wrong session.',
    }],
  })).toThrow('event session_id must match capture session_id');
});
