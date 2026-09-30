import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSessionFile, parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function transcript(entries: Record<string, unknown>[]): string {
  dir = mkdtempSync(join(tmpdir(), 'gb-jsonl-origin-'));
  const path = join(dir, 'synthetic.jsonl');
  writeFileSync(path, entries.map((entry, index) => JSON.stringify({
    sessionId: 'synthetic-origin-session',
    timestamp: `2026-08-01T10:00:${String(index).padStart(2, '0')}.000Z`,
    ...entry,
  })).join('\n') + '\n');
  return path;
}

function user(content: unknown, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content }, ...fields };
}

describe('Claude Code structured user origins', () => {
  test('hook and archive exclude root metadata and non-human text, retaining the human prompt and assistant', async () => {
    const path = transcript([
      user('synthetic metadata text', { isMeta: true, origin: { kind: 'human' } }),
      user('synthetic compact summary', { isCompactSummary: true, origin: { kind: 'human' } }),
      user('synthetic automation text', { origin: { kind: 'hook' } }),
      user('synthetic human prompt', { origin: { kind: 'human' } }),
      { type: 'assistant', origin: { kind: 'agent' }, message: { role: 'assistant', content: 'synthetic assistant reply' } },
    ]);
    const expected = [
      { role: 'user' as const, text: 'synthetic human prompt' },
      { role: 'assistant' as const, text: 'synthetic assistant reply' },
    ];
    const hook = parseTranscript(path);
    expect(hook.turns).toEqual(expected);
    expect(hook.genuineUserTurnIndexes).toEqual([0]);
    expect(hook.parsedLines).toBe(5);
    expect(hook.skippedLines).toBe(0);

    const archive = parseClaudeSessionFile(path);
    expect(archive.turns.map(({ role, text }) => ({ role, text }))).toEqual(expected);
    expect(archive.startedAt).toBe('2026-08-01T10:00:03.000Z');
    const result = await claudeCodeAdapter.parse(path).next();
    expect(result.done).toBe(false);
    if (!result.done) expect(result.value.messages.map(({ role, text }) => ({ role, text }))).toEqual(expected);
  });

  test.each(['isMeta', 'isCompactSummary'])('%s is only honored at the root and when exactly true', (flag) => {
    const values = [undefined, false, 'true', 1, null];
    const entries = values.map((value, index) => user(`synthetic prompt ${index}`, { [flag]: value }));
    entries.push({
      type: 'user',
      message: { role: 'user', content: 'synthetic nested marker', [flag]: true },
    });
    entries.push(user('synthetic excluded prompt', { [flag]: true }));
    const path = transcript(entries);
    const expected = [...values.map((_, index) => `synthetic prompt ${index}`), 'synthetic nested marker'];
    expect(parseTranscript(path).turns.map((turn) => turn.text)).toEqual(expected);
    expect(parseClaudeSessionFile(path).turns.map((turn) => turn.text)).toEqual(expected);
    expect(parseTranscript(path).genuineUserTurnIndexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('missing or unstructured origins stay compatible without guessing from message text', () => {
    const origins = [undefined, null, 'hook', {}, { kind: null }, { kind: 1 }, { kind: '' }, { kind: 'human' }];
    const text = 'synthetic hook output mentioning origin.kind and isMeta: true';
    const path = transcript(origins.map((origin) => user(text, { origin })));
    const hook = parseTranscript(path);
    expect(hook.turns.map((turn) => turn.text)).toEqual(origins.map(() => text));
    expect(hook.genuineUserTurnIndexes).toEqual(origins.map((_, index) => index));
    expect(parseClaudeSessionFile(path).turns.map((turn) => turn.text)).toEqual(origins.map(() => text));
  });

  test('explicit non-human origins filter text blocks but preserve placeholders and opt-in tool results', () => {
    const path = transcript([
      user('synthetic prompt', { origin: { kind: 'human' } }),
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'synthetic-tool', name: 'Read', input: { file_path: '/synthetic/example.txt' } },
      ] } },
      user([
        { type: 'text', text: 'synthetic hook text' },
        { type: 'tool_result', tool_use_id: 'synthetic-tool', content: 'synthetic result payload', is_error: true },
        { type: 'image', source: { data: 'synthetic image payload' } },
      ], { origin: { kind: 'hook' } }),
      user([{ type: 'text', text: 'synthetic task text' }], { origin: { kind: 'task' } }),
      user('synthetic future-origin text', { origin: { kind: 'future-automation' } }),
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'assistant', message: { role: 'assistant', content: 'synthetic final reply' } },
    ]);
    const hook = parseTranscript(path, { collectToolCalls: true });
    expect(hook.turns.map((turn) => turn.text)).toEqual([
      'synthetic prompt', '[tool: Read]', '[tool result]\n[image]', 'synthetic final reply',
    ]);
    expect(hook.genuineUserTurnIndexes).toEqual([0]);
    expect(hook.boundaryTurnIndexes).toEqual([3]);
    expect(hook.toolCallTurnIndexes).toEqual([1]);
    expect(hook.toolCalls).toEqual([
      { name: 'Read', input: { file_path: '/synthetic/example.txt' }, result: { ok: false } },
    ]);
    expect(parseTranscript(path).toolCalls).toEqual([]);
    expect(parseClaudeSessionFile(path).turns.map((turn) => turn.text)).toEqual(hook.turns.map((turn) => turn.text));
  });

  test('assistant-only output does not count as an accepted user prompt in compatibility mode', () => {
    const path = transcript([
      user('synthetic hook text', { origin: { kind: 'hook' } }),
      { type: 'assistant', message: { role: 'assistant', content: 'synthetic assistant reply' } },
    ]);
    const hook = parseTranscript(path);
    expect(hook.turns).toEqual([{ role: 'assistant', text: 'synthetic assistant reply' }]);
    expect(hook.genuineUserTurnIndexes).toEqual([]);
    expect(parseClaudeSessionFile(path).turns.map((turn) => turn.text)).toEqual(['synthetic assistant reply']);
  });

  test('root metadata entries cannot contribute orphaned tool calls or results', () => {
    const path = transcript([
      { type: 'assistant', isMeta: true, message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'synthetic-meta-tool', name: 'Read', input: { file_path: '/synthetic/meta.txt' } },
      ] } },
      { type: 'assistant', origin: { kind: 'agent' }, message: { role: 'assistant', content: [
        { type: 'text', text: 'synthetic assistant text' },
        { type: 'tool_use', id: 'synthetic-tool', name: 'Read', input: { file_path: '/synthetic/example.txt' } },
      ] } },
      user([{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: 'synthetic summary result' }], { isCompactSummary: true }),
    ]);
    const hook = parseTranscript(path, { collectToolCalls: true });
    expect(hook.turns).toEqual([{ role: 'assistant', text: 'synthetic assistant text\n[tool: Read]' }]);
    expect(hook.toolCalls).toEqual([{ name: 'Read', input: { file_path: '/synthetic/example.txt' } }]);
    expect(hook.toolCallTurnIndexes).toEqual([0]);
    expect(parseClaudeSessionFile(path).turns.map((turn) => turn.text)).toEqual(hook.turns.map((turn) => turn.text));
  });

  test('intentionally filtered files are expected empty, while unrecognized human content still signals drift', async () => {
    const path = transcript([
      user('synthetic metadata text', { isMeta: true }),
      user('synthetic compact summary', { isCompactSummary: true }),
      user('synthetic hook text', { origin: { kind: 'hook' } }),
      user([{ type: 'text', text: 'synthetic task text' }], { origin: { kind: 'task' } }),
    ]);
    expect(parseTranscript(path).genuineUserTurnIndexes).toEqual([]);
    expect(parseClaudeSessionFile(path).turnShapedLines).toBe(0);
    const empty = await claudeCodeAdapter.parse(path).next();
    expect(empty.done).toBe(true);
    if (empty.done) {
      expect(empty.value.sessions).toBe(0);
      expect(empty.value.expectedEmpty).toBe(true);
    }

    writeFileSync(path, JSON.stringify(user({ unrecognized: 'synthetic human content' }, { origin: { kind: 'human' } })) + '\n');
    expect(parseClaudeSessionFile(path).turnShapedLines).toBe(1);
    const drift = await claudeCodeAdapter.parse(path).next();
    expect(drift.done).toBe(true);
    if (drift.done) {
      expect(drift.value.sessions).toBe(0);
      expect(drift.value.expectedEmpty).toBeUndefined();
    }
  });
});
