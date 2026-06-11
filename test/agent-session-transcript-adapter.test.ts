import { describe, expect, test } from 'bun:test';
import { parseClaudeCodeTranscript } from '../src/core/services/agent-session-capture-envelope-service.ts';

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseClaudeCodeTranscript', () => {
  test('maps user/assistant messages with content blocks to capture events', () => {
    const transcript = [
      line({
        type: 'user',
        uuid: 'uuid-1',
        timestamp: '2026-06-12T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Remember: I prefer concise replies.' }] },
      }),
      line({
        type: 'assistant',
        uuid: 'uuid-2',
        timestamp: '2026-06-12T01:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Noted — concise replies.' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ].join('\n');

    const result = parseClaudeCodeTranscript(transcript, { session_id: 'session-1' });

    expect(result.parsed_events).toBe(2);
    expect(result.skipped_lines).toBe(0);
    expect(result.input.source_kind).toBe('claude_session');
    expect(result.input.session_id).toBe('session-1');
    expect(result.input.client_name).toBe('claude');

    const [first, second] = result.input.events;
    expect(first.event_kind).toBe('user_prompt');
    expect(first.actor).toBe('user');
    expect(first.text).toBe('Remember: I prefer concise replies.');
    expect(first.event_id).toBe('uuid-1');
    expect(first.occurred_at).toBe('2026-06-12T01:00:00.000Z');
    expect(second.event_kind).toBe('assistant_response');
    expect(second.text).toBe('Noted — concise replies.');
  });

  test('accepts plain string content and bare role/content lines', () => {
    const transcript = [
      line({ message: { role: 'user', content: 'plain string prompt' } }),
      line({ role: 'assistant', content: 'bare-shape reply' }),
    ].join('\n');

    const result = parseClaudeCodeTranscript(transcript, { session_id: 's' });

    expect(result.parsed_events).toBe(2);
    expect(result.input.events[0].text).toBe('plain string prompt');
    expect(result.input.events[1].text).toBe('bare-shape reply');
  });

  test('skips meta lines, tool-only messages, and malformed JSON without failing', () => {
    const transcript = [
      'not json at all {',
      line({ type: 'summary', summary: 'Session about testing' }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'big output' }] },
      }),
      line({ message: { role: 'user', content: [{ type: 'text', text: 'real signal' }] } }),
      line(['an', 'array']),
    ].join('\n');

    const result = parseClaudeCodeTranscript(transcript, { session_id: 's' });

    expect(result.parsed_events).toBe(1);
    expect(result.skipped_lines).toBe(4);
    expect(result.input.events[0].text).toBe('real signal');
  });

  test('truncates oversized event text and caps total event count keeping the newest', () => {
    const big = 'x'.repeat(20_000);
    const lines: string[] = [line({ message: { role: 'user', content: big } })];
    for (let i = 0; i < 2_100; i += 1) {
      lines.push(line({ message: { role: 'assistant', content: `reply ${i}` } }));
    }

    const result = parseClaudeCodeTranscript(lines.join('\n'), { session_id: 's' });

    expect(result.parsed_events).toBe(2_000);
    // 101 events dropped by the cap (2101 parsed-capable lines - 2000 kept).
    expect(result.skipped_lines).toBe(101);
    const last = result.input.events[result.input.events.length - 1];
    expect(last.text).toBe('reply 2099');
    expect(result.input.events.every((event) => event.text.length <= 16_100)).toBe(true);
  });

  test('returns zero events for an empty or non-conversational transcript', () => {
    const result = parseClaudeCodeTranscript('', { session_id: 's' });
    expect(result.parsed_events).toBe(0);
    expect(result.input.events).toEqual([]);
  });
});
