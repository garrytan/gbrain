/**
 * #6918: Claude Code thinks by default on Claude 5 models, and the API needs
 * thinking.budget_tokens >= 1024 and below max_tokens, so every claude-cli call
 * capped at 1024 output tokens or fewer (models doctor's 16-token probe,
 * llm-intent, facts/classify, ai/decide, ...) failed with a 400. Such a call now
 * sets MAX_THINKING_TOKENS=0 in both the inline --settings env and the child
 * env, and reports `thinking: 'disabled_below_floor'` in its provider metadata.
 * A larger cap, or no cap, leaves thinking to the CLI.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN plays the CLI and records what it
 * was handed; no live CLI or provider account is used.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, result: 'OK', stop_reason: 'end_turn', session_id: 'synthetic-session', num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 } };

async function call(maxOutputTokens: number | undefined): Promise<{ env: string; settings: unknown; metadata: unknown; text: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-thinking-floor-'));
  const record = join(dir, 'record');
  const response = join(dir, 'response.json');
  writeFileSync(response, JSON.stringify(SUCCESS));
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/bin/sh',
    'cat > /dev/null',
    `printf 'env=%s\\n' "\${MAX_THINKING_TOKENS-unset}" > "${record}"`,
    'while [ $# -gt 0 ]; do',
    `  if [ "$1" = "--settings" ]; then printf '%s\\n' "$2" >> "${record}"; fi`,
    '  shift',
    'done',
    `cat "${response}"`,
  ].join('\n') + '\n');
  chmodSync(bin, 0o755);
  try {
    const out = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, MAX_THINKING_TOKENS: undefined, CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined }, () =>
      new ClaudeCliLanguageModel('claude-sonnet-5-5').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }],
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      } as LanguageModelV2CallOptions));
    const [envLine, settingsLine] = readFileSync(record, 'utf8').trimEnd().split('\n');
    return { env: envLine!.slice('env='.length), settings: JSON.parse(settingsLine!), metadata: out.providerMetadata, text: out.content };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('claude-cli turns thinking off under the 1024-token floor (#6918)', () => {
  for (const cap of [16, 200, 1024]) {
    test(`cap ${cap}: MAX_THINKING_TOKENS=0 in settings and child env, reported in metadata`, async () => {
      const r = await call(cap);
      expect(r.env).toBe('0');
      expect(r.settings).toEqual({ disableAllHooks: true, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cap), MAX_THINKING_TOKENS: '0' } });
      expect(r.metadata).toEqual({ 'claude-cli': { thinking: 'disabled_below_floor' } });
      expect(r.text).toEqual([{ type: 'text', text: 'OK' }]);
    });
  }

  for (const cap of [1025, 4000, undefined]) {
    test(`cap ${cap ?? 'none'}: thinking is left to the CLI`, async () => {
      const r = await call(cap);
      expect(r.env).toBe('unset');
      expect(r.settings).toEqual(cap === undefined ? { disableAllHooks: true } : { disableAllHooks: true, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cap) } });
      expect(r.metadata).toBeUndefined();
    });
  }
});
