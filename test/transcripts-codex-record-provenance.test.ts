/**
 * Protects archive/hook agreement on item-only answers, speaker attribution,
 * copied parent history and genuine repetitions. Legacy tests cover message
 * records, but not these combinations. Reverting the reader loses answers and
 * falsely treats agent prompts as human turns. No test-only production seams;
 * every record below is synthetic and both consumers use their public parsers.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const row = (type: string, payload: Record<string, unknown>, ordinal?: number) => ({
  timestamp: '2026-10-01T12:00:00.000Z', type, payload, ...(ordinal === undefined ? {} : { ordinal }),
});
const meta = (extra: Record<string, unknown> = {}, ordinal?: number) => row('session_meta', { id: 'synthetic-session', cwd: '/synthetic-workspace', ...extra }, ordinal);
const event = (type: string, extra: Record<string, unknown> = {}, ordinal?: number) => row('event_msg', { type, ...extra }, ordinal);
const user = (text: string, ordinal?: number) => event('user_message', { message: text }, ordinal);
const said = (text: string, id: string) => row('response_item', { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] });
const item = (type: string, text: string, id: string) => event('item_completed', { item: { type, id, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] } });

async function parse(lines: ReturnType<typeof row>[], check: (sessions: ParsedSession[], hook: ReturnType<typeof parseCodexHookTranscript>, diag: unknown) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-provenance-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const sessions: ParsedSession[] = [];
    const generator = codexAdapter.parse(path);
    let next = await generator.next();
    while (!next.done) {
      sessions.push(next.value);
      next = await generator.next();
    }
    check(sessions, parseCodexHookTranscript(path, { collectToolCalls: true }), next.value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectTurns(sessions: ParsedSession[], hook: ReturnType<typeof parseCodexHookTranscript>, texts: string[]) {
  expect(sessions[0]!.messages.map((m) => m.text)).toEqual(texts);
  expect(hook.turns.map((m) => m.text)).toEqual(texts);
}

describe('Codex record provenance', () => {
  test('imports an item-only answer and final-only fallback, with one copy across routes', async () => {
    await parse([
      meta(), event('task_started'), user('Question'), item('UserMessage', 'Question', 'u1'),
      said('Checking', 'm1'), item('AgentMessage', 'Checking', 'a1'),
      item('AgentMessage', 'The result', 'a2'), event('task_complete', { last_agent_message: 'The  result\n', turn_id: 't1' }),
      event('task_started'), user('Next question'), event('task_complete', { last_agent_message: 'Fallback answer', turn_id: 't2' }),
    ], (sessions, hook) => {
      expectTurns(sessions, hook, ['Question', 'Checking', 'The result', 'Next question', 'Fallback answer']);
      expect(hook.genuineUserTurnIndexes).toEqual([0, 3]);
    });
  });

  test('preserves same-route repeated prompts and answers, and repeats in later tasks', async () => {
    await parse([
      meta(), event('task_started'), user('Repeat'), user('Repeat'),
      said('Same answer', 'm1'), said('Same answer', 'm2'),
      item('AgentMessage', 'Same answer', 'a1'), item('AgentMessage', 'Same answer', 'a2'),
      event('task_started'), user('Repeat'), item('AgentMessage', 'Same answer', 'a3'),
    ], (sessions, hook) => expectTurns(sessions, hook, ['Repeat', 'Repeat', 'Same answer', 'Same answer', 'Repeat', 'Same answer']));
  });

  test('legacy rollouts preserve repeated input after an answer without task-start markers', async () => {
    await parse([
      meta(), user('Again'), item('UserMessage', 'Again', 'u1'), said('Reply', 'm1'),
      item('UserMessage', 'Again', 'u2'), said('Reply', 'm2'),
    ], (sessions, hook) => expectTurns(sessions, hook, ['Again', 'Reply', 'Again', 'Reply']));
  });

  test('labels inter-agent input and keeps it out of genuine human prompt indexes', async () => {
    await parse([
      meta(), row('response_item', { type: 'agent_message', author: '/root/worker', id: 'agent-1', content: [{ type: 'input_text', text: 'Review this result' }] }),
      user('Human follow-up'), said('Reviewed', 'm1'),
    ], (sessions, hook) => {
      expectTurns(sessions, hook, ['Review this result', 'Human follow-up', 'Reviewed']);
      expect(sessions[0]!.messages[0]!.speaker).toBe('Agent /root/worker');
      expect(hook.genuineUserTurnIndexes).toEqual([1]);
      expect(toCorpusText(hook.turns)).toStartWith('[user: Agent /root/worker]\nReview this result');
    });
  });

  test('uses structural program origin, preserving literal prompt text', async () => {
    await parse([meta({ originator: 'codex_exec' }), user('<heartbeat>literal quoted input</heartbeat>')], (sessions, hook) => {
      expect(sessions[0]!.messages[0]!.speaker).toBe('Program (codex_exec)');
      expect(hook.genuineUserTurnIndexes).toEqual([]);
      expect(hook.turns[0]!.text).toBe('<heartbeat>literal quoted input</heartbeat>');
    });
  });

  test('unknown origins and injected preambles preserve the prior human selection contract', async () => {
    await parse([
      meta({ originator: 'unknown-client' }),
      row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Private instructions' }] }),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected context' }] }),
      user('Human request'),
    ], (sessions, hook) => {
      expectTurns(sessions, hook, ['Human request']);
      expect(sessions[0]!.messages[0]!.speaker).toBeUndefined();
      expect(hook.genuineUserTurnIndexes).toEqual([0]);
    });
  });

  test('skips proven parent history while retaining child identity and tool positions', async () => {
    await parse([
      meta({ id: 'child', source: { subagent: {} }, subagent_history_start_ordinal: 4 }, 0),
      meta({ id: 'parent' }, 1), user('Copied parent input', 2),
      row('response_item', { type: 'custom_tool_call', name: 'old_tool', input: '{}' }, 3),
      user('Child input', 4), row('response_item', { type: 'custom_tool_call', name: 'new_tool', input: '{"synthetic":true}' }, 5),
    ], (sessions, hook) => {
      expectTurns(sessions, hook, ['Child input']);
      expect(sessions[0]!.meta.sessionId).toBe('child');
      expect(hook.sessionId).toBe('child');
      expect(hook.toolCalls).toEqual([{ name: 'new_tool', input: { synthetic: true } }]);
      expect(hook.toolCallTurnIndexes).toEqual([1]);
    });
  });

  test('a boundary without copied parent evidence never drops valid input', async () => {
    await parse([meta({ source: { subagent: {} }, subagent_history_start_ordinal: 100 }, 0), user('Keep this input', 1)], (sessions, hook) => expectTurns(sessions, hook, ['Keep this input']));
  });

  test('understood realtime-only imports are empty, while unknown record types still signal drift', async () => {
    await parse([meta(), row('realtime_item', { type: 'realtime_session_started' })], (sessions, _hook, diag) => {
      expect(sessions).toEqual([]);
      expect(diag).toMatchObject({ sessions: 0, expectedEmpty: true, skippedLines: 0 });
    });
    await parse([meta(), row('unknown_record', {})], (sessions, _hook, diag) => {
      expect(sessions).toEqual([]);
      expect(diag).toMatchObject({ sessions: 0 });
      expect(diag).not.toMatchObject({ expectedEmpty: true });
    });
  });
});
