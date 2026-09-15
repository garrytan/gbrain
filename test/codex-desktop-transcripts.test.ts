import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const message = (text: string, role = 'user') => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
});
const event = (text: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });

async function check(rows: unknown[], expected: string[]) {
  dir = mkdtempSync(join(tmpdir(), 'codex-desktop-'));
  const path = join(dir, 'rollout.jsonl');
  const timestamp = '2026-09-01T12:00:00.000Z';
  writeFileSync(path, [
    { type: 'session_meta', payload: { id: 'synthetic-desktop', timestamp } }, ...rows,
  ].map(row => JSON.stringify({ timestamp, ...row as object })).join('\n'));
  const sessions = [];
  for await (const session of codexAdapter.parse(path)) sessions.push(session);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].messages.map(m => m.text)).toEqual(expected);
  expect(sessions[0].messages[0].timestamp).toBe(timestamp);
  expect(parseCodexHookTranscript(path).turns.map(m => m.text)).toEqual(expected);
}

test('desktop user input survives alongside known runtime envelopes', async () => {
  await check([
    message('Developer instructions', 'developer'),
    message('# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>Runtime rules</INSTRUCTIONS>'),
    message('<environment_context>Runtime environment</environment_context>'),
    message('<recommended_plugins>Plugin list</recommended_plugins>\n<app-context>Runtime context</app-context>\nSummarize this note.'),
    message('Here is the summary.', 'assistant'),
    message('<example>Keep user-authored markup.</example>'),
  ], ['Summarize this note.', 'Here is the summary.', '<example>Keep user-authored markup.</example>']);
});

test('paired CLI records appear once, but repeated user requests survive', async () => {
  await check([
    event('Try again.'), message('Try again.'),
    message('Trying.', 'assistant'),
    message('Try again.'), event('Try again.'),
    message('Try again.'), message('Try again.'),
  ], ['Try again.', 'Trying.', 'Try again.', 'Try again.', 'Try again.']);
});

test('mixed event and desktop turns retain app context and genuine requests', async () => {
  const withApp = '<appshot app="Editor">Visible document</appshot>\n## My request:\nExplain this.';
  await check([
    event('First question.'), message('First answer.', 'assistant'),
    message('<codex_internal_context>Runtime state</codex_internal_context>'),
    message('<subagent_notification>Background status</subagent_notification>'),
    message(withApp), message('Second answer.', 'assistant'),
  ], ['First question.', 'First answer.', withApp, 'Second answer.']);
});
