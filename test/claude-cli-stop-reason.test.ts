/**
 * claude-cli provider: the CLI's `stop_reason` reaches the AI SDK finish
 * reason (#6260). Before, every answer finished `stop`, so a response cut
 * off at the output cap looked complete to callers that refuse to commit a
 * clipped answer (extract_atoms, synthesize_concepts).
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN emits a scripted JSON envelope.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `claude-cli-stop-reason-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const responsePath = join(stubDir, 'response.json');
const stdinPath = join(stubDir, 'stdin.txt');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, ['#!/bin/sh', `cat > "${stdinPath}"`, `cat "${responsePath}"`].join('\n'));
  chmodSync(stubBin, 0o755);
});
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

async function finishFor(stopReason: string | null, result = 'partial answer'): Promise<string> {
  writeFileSync(responsePath, JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result, stop_reason: stopReason,
    session_id: 's', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 },
  }));
  return withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
    const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
    const out = await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as LanguageModelV2CallOptions);
    return out.finishReason;
  });
}

describe('claude-cli finish reason follows the CLI stop_reason (#6260)', () => {
  test('max_tokens finishes as length', async () => {
    expect(await finishFor('max_tokens')).toBe('length');
  });
  test('refusal finishes as content-filter', async () => {
    expect(await finishFor('refusal')).toBe('content-filter');
  });
  test('end_turn and a missing stop_reason still finish as stop', async () => {
    expect(await finishFor('end_turn')).toBe('stop');
    expect(await finishFor(null)).toBe('stop');
  });
  test('a parsed tool call finishes as tool-calls unless the answer was cut off', async () => {
    const call = '<use_tools>\n[{"id": "t1", "name": "search", "input": {"q": "x"}}]\n</use_tools>';
    expect(await finishFor('end_turn', call)).toBe('tool-calls');
    expect(await finishFor('max_tokens', call)).toBe('length');
  });
});

describe('claude-cli replays earlier tool calls with their arguments (#6236)', () => {
  test('a replayed tool call renders its input as JSON, not [object Object]', async () => {
    await finishFor('end_turn', 'ok');
    writeFileSync(responsePath, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn',
      session_id: 's', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'find it' }] },
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'brain_get_page', input: { slug: 'wiki/personal/patterns/x' } }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'brain_get_page', output: { type: 'text', value: 'page' } }] },
        ],
      } as LanguageModelV2CallOptions);
    });
    const sent = readFileSync(stdinPath, 'utf8');
    expect(sent).toContain('[tool_use brain_get_page({"slug":"wiki/personal/patterns/x"})]');
    expect(sent).not.toContain('[object Object]');
  });
});
