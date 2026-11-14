/**
 * #9085: a claude-cli reply that carries XML tool-call markup (`<invoke>`)
 * instead of the `<use_tools>` JSON block must become a tool call, not a
 * clean text `stop` that dies later on require_writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `claude-cli-invoke-9085-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const responsePath = join(stubDir, 'response.json');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, ['#!/bin/sh', 'cat > /dev/null', `cat "${responsePath}"`].join('\n'));
  chmodSync(stubBin, 0o755);
});
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

describe('claude-cli parses invoke-style tool-call markup (#9085)', () => {
  test('an invoke element becomes a tool-call, not prose', async () => {
    const text = '<invoke name="brain_list_pages"><parameter name="limit">5</parameter></invoke>\n</use_tools>';
    writeFileSync(responsePath, JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
      session_id: 's', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const out = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      return new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as LanguageModelV2CallOptions);
    });
    const calls = out.content.filter(c => c.type === 'tool-call') as Array<{ toolName: string; input: string }>;
    expect(calls.map(c => c.toolName)).toEqual(['brain_list_pages']);
    expect(calls.length ? JSON.parse(calls[0]!.input) : null).toEqual({ limit: 5 });
    expect(out.finishReason).toBe('tool-calls');
    expect(out.content.some(c => c.type === 'text' && c.text.includes('invoke'))).toBe(false);
  });
});
