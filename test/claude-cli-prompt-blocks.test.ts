/**
 * claude-cli provider: the prompt reaches `claude --print` as one stream-json
 * user message with one text block per conversation message, so a tool loop's
 * next turn reads the previous turn's prompt cache. Prompt caching matches at
 * block boundaries only; the former single text block re-wrote the whole
 * transcript to cache on every turn and never read it back.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN records argv and stdin and
 * prints scripted stream-json (NDJSON) stdout. No provider is called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `claude-cli-prompt-blocks-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const responsePath = join(stubDir, 'response.ndjson');
const stdinPath = join(stubDir, 'stdin.txt');
const argvPath = join(stubDir, 'argv.txt');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, ['#!/bin/sh', `printf '%s\\n' "$@" > "${argvPath}"`, `cat > "${stdinPath}"`, `cat "${responsePath}"`].join('\n'));
  chmodSync(stubBin, 0o755);
});
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

const ndjson = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const init = { type: 'system', subtype: 'init', session_id: 's' };
const result = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', session_id: 's', num_turns: 1,
  usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 14_307, cache_creation_input_tokens: 14_248 }, ...extra,
});
const assistant = (id: string, text: string, stopReason: string) => ({
  type: 'assistant', parent_tool_use_id: null, session_id: 's',
  message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: stopReason },
});

async function generate(prompt: LanguageModelV2Prompt, stdout = ndjson([init, assistant('m1', 'ok', 'end_turn'), result('ok')]), maxOutputTokens?: number) {
  writeFileSync(responsePath, stdout);
  const out = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, () =>
    new ClaudeCliLanguageModel('claude-haiku-5-5').doGenerate({ prompt, maxOutputTokens } as LanguageModelV2CallOptions));
  return { out, sent: readFileSync(stdinPath, 'utf8'), argv: readFileSync(argvPath, 'utf8').trimEnd().split('\n') };
}

const turn1: LanguageModelV2Prompt = [
  { role: 'system', content: 'You audit documents.' },
  { role: 'user', content: [{ type: 'text', text: 'Start the audit.' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read_chunk', input: { n: 1 } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_chunk', output: { type: 'text', value: 'chunk one' } }] },
];
const turn2: LanguageModelV2Prompt = [
  ...turn1,
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'read_chunk', input: { n: 2 } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'read_chunk', output: { type: 'text', value: 'chunk two' } }] },
];

function blocksOf(sent: string): string[] {
  const message = JSON.parse(sent) as { type: string; message: { role: string; content: Array<{ type: string; text: string }> } };
  expect(message.type).toBe('user');
  expect(message.message.role).toBe('user');
  return message.message.content.map(block => {
    expect(block.type).toBe('text');
    return block.text;
  });
}

describe('claude-cli sends one content block per conversation message', () => {
  test('stdin is one stream-json user message, one text block per message, system prompt on the flag', async () => {
    const { sent, argv } = await generate(turn1);
    expect(sent.endsWith('\n')).toBe(true);
    expect(sent.trimEnd().split('\n')).toHaveLength(1);
    expect(blocksOf(sent)).toEqual([
      'User: Start the audit.',
      '\n\nAssistant: [tool_use read_chunk({"n":1})]',
      '\n\nUser: [tool_result {"type":"text","value":"chunk one"}]',
    ]);
    expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You audit documents.');
  });

  test('the next turn replays every earlier block unchanged, so it reads the previous turn\'s cache entry', async () => {
    const first = blocksOf((await generate(turn1)).sent);
    const second = blocksOf((await generate(turn2)).sent);
    expect(second).toHaveLength(first.length + 2);
    expect(second.slice(0, first.length)).toEqual(first);
  });
});

describe('claude-cli reads stream-json stdout', () => {
  test('the result event supplies text and usage; cache reads stay a subset of input', async () => {
    const { out } = await generate(turn1, ndjson([init, assistant('m1', 'DONE', 'end_turn'), { type: 'rate_limit_event' }, result('DONE')]));
    expect(out.content).toEqual([{ type: 'text', text: 'DONE' }]);
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ inputTokens: 2 + 14_307 + 14_248, outputTokens: 5, totalTokens: 2 + 14_307 + 14_248 + 5, cachedInputTokens: 14_307 });
  });

  test('a stream that ends after the init event reports the missing result event', async () => {
    await expect(generate(turn1, ndjson([init]))).rejects.toThrow('no "result" event');
  });

  test('a continued answer is rebuilt from the streamed assistant events (#6791)', async () => {
    const stdout = ndjson([
      init,
      assistant('m1', 'first half, ', 'max_tokens'),
      { type: 'user', parent_tool_use_id: null, session_id: 's', message: { role: 'user', content: [{ type: 'text', text: 'Output token limit hit. Resume directly.' }] } },
      assistant('m2', 'second half', 'end_turn'),
      result('second half', { num_turns: 2 }),
    ]);
    const { out } = await generate(turn1, stdout, 4000);
    expect(out.content).toEqual([{ type: 'text', text: 'first half, second half' }]);
    expect(out.finishReason).toBe('stop');
  });
});
