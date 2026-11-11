/**
 * #7352 — a claude-cli tool loop must let turn N+1 read turn N's prompt
 * cache. The CLI caches at content-block boundaries, so a prompt sent as one
 * growing text block never shares a boundary with the previous turn and every
 * turn re-writes the whole transcript to the cache. The adapter sends one
 * block per conversation message (`--input-format stream-json`), so turn N's
 * blocks are an unchanged prefix of turn N+1's, and reads the CLI's
 * stream-json (NDJSON) output. Hermetic: a stub binary records stdin and argv.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `claude-cli-cache-stub-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const stdinLog = join(stubDir, 'stdin.log');
const argvLog = join(stubDir, 'argv.log');
const responsePath = join(stubDir, 'response.txt');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, ['#!/bin/sh', `cat > "${stdinLog}"`, `printf "%s\\n" "$@" > "${argvLog}"`, `cat "${responsePath}"`].join('\n'));
  chmodSync(stubBin, 0o755);
});

afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

const result = (text: string) => ({
  type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
  session_id: 's', num_turns: 1, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 20 },
});

/** What the real CLI prints under --output-format stream-json --verbose: one event per line. */
function streamJson(text: string): string {
  return [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: null }, parent_tool_use_id: null, session_id: 's' },
    result(text),
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
}

async function generate(prompt: LanguageModelV2CallOptions['prompt']) {
  const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
  return new ClaudeCliLanguageModel('claude-sonnet-5-5').doGenerate({ prompt } as LanguageModelV2CallOptions);
}

function sentBlocks(): string[] {
  const lines = readFileSync(stdinLog, 'utf8').split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  const msg = JSON.parse(lines[0]!);
  expect(msg).toMatchObject({ type: 'user', message: { role: 'user' } });
  return msg.message.content.map((b: { type: string; text: string }) => { expect(b.type).toBe('text'); return b.text; });
}

const turnN: LanguageModelV2CallOptions['prompt'] = [
  { role: 'system', content: 'You are a test agent.' },
  { role: 'user', content: [{ type: 'text', text: 'Find the page.' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { query: 'acme-example' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'text', value: 'companies/acme-example' } }] },
] as LanguageModelV2CallOptions['prompt'];
const turnN1 = [...turnN,
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'get_page', input: { slug: 'companies/acme-example' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'get_page', output: { type: 'text', value: 'Acme Example page' } }] },
] as LanguageModelV2CallOptions['prompt'];

describe('claude-cli tool loops reuse the previous turn prompt cache (#7352)', () => {
  test('one block per message; turn N is an unchanged prefix of turn N+1', async () => {
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      writeFileSync(responsePath, streamJson('ok'));
      await generate(turnN);
      const first = sentBlocks();
      await generate(turnN1);
      const second = sentBlocks();
      expect(first.length).toBe(3);
      expect(second.length).toBe(5);
      expect(second.slice(0, first.length)).toEqual(first);
      expect(first[0]).toBe('User: Find the page.');
      const argv = readFileSync(argvLog, 'utf8').split('\n');
      expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json');
      expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(argv).toContain('--verbose');
    });
  });

  test('the stream-json result event is read: text and cache usage', async () => {
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      writeFileSync(responsePath, streamJson('the answer'));
      const res = await generate(turnN);
      expect(res.content).toEqual([{ type: 'text', text: 'the answer' }]);
      expect(res.usage.cachedInputTokens).toBe(900);
      expect(res.usage.inputTokens).toBe(930);
    });
  });

  test('a lone surrogate (a page cut mid-emoji) reaches the CLI as U+FFFD, as the raw stdin write did', async () => {
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      writeFileSync(responsePath, streamJson('ok'));
      await generate([{ role: 'user', content: [{ type: 'text', text: 'ship it \ud83d' }] }] as LanguageModelV2CallOptions['prompt']);
      expect(sentBlocks()).toEqual(['User: ship it \ufffd']);
      expect(readFileSync(stdinLog, 'utf8')).not.toContain('\\ud83d');
    });
  });

  test('an error result in the stream still surfaces as a typed error', async () => {
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      writeFileSync(responsePath, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
        + JSON.stringify({ ...result('API Error: rate limited'), is_error: true, subtype: 'error', api_error_status: 429 }) + '\n');
      await expect(generate(turnN)).rejects.toMatchObject({ name: 'ClaudeCliProcessError', apiErrorStatus: 429 });
    });
  });
});
