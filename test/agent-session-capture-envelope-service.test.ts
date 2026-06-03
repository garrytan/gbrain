import { describe, expect, test } from 'bun:test';
import {
  normalizeAgentSessionCaptureEnvelope,
  parseAgentSessionEventJsonl,
} from '../src/core/services/agent-session-capture-envelope-service.ts';

describe('agent session capture envelope service', () => {
  test('normalizes a hook-friendly JSON envelope into operation params', () => {
    const result = normalizeAgentSessionCaptureEnvelope({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      captured_at: '2026-06-04T01:02:03.000Z',
      events: [{
        event_kind: 'explicit_memory_note',
        text: 'Remember that the user prefers concise implementation checkpoints.',
      }],
    });

    expect(result).toMatchObject({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      now: '2026-06-04T01:02:03.000Z',
    });
    expect(result.events).toEqual([expect.objectContaining({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      actor: 'user',
      event_kind: 'explicit_memory_note',
    })]);
  });

  test('parses JSONL event payloads with inherited session metadata', () => {
    const events = parseAgentSessionEventJsonl([
      JSON.stringify({ event_kind: 'user_prompt', text: 'Please continue the memory implementation.' }),
      JSON.stringify({ event_kind: 'command_run', text: 'bun test test/agent-session-memory-sqlite.test.ts' }),
    ].join('\n'), {
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event_kind: 'user_prompt',
      actor: 'user',
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
    });
    expect(events[1]).toMatchObject({
      event_kind: 'command_run',
      actor: 'tool',
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
    });
  });

  test('fails closed on invalid event kinds and non-object JSONL rows', () => {
    expect(() => normalizeAgentSessionCaptureEnvelope({
      source_kind: 'codex_session',
      session_id: 'bad-session',
      events: [{ event_kind: 'observer_note', text: 'bad' }],
    })).toThrow('event_kind');

    expect(() => parseAgentSessionEventJsonl('"not an object"', {
      source_kind: 'codex_session',
      session_id: 'bad-jsonl',
    })).toThrow('JSONL line 1 must be an object');
  });
});
