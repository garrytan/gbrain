import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { GrokCliLanguageModel, GrokCliProcessError } from '../src/core/ai/providers/grok-cli-language-model.ts';

const priorBin = process.env.GBRAIN_GROK_CLI_BIN;
afterEach(() => {
  if (priorBin === undefined) delete process.env.GBRAIN_GROK_CLI_BIN;
  else process.env.GBRAIN_GROK_CLI_BIN = priorBin;
});

function fakeGrok(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-grok-cli-test-'));
  const bin = join(dir, 'grok');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const options = (text: string) => ({
  prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
} as any);

describe('grok-cli recipe', () => {
  test('is keyless, subscription-backed, and zero-cost', () => {
    const recipe = getRecipe('grok-cli')!;
    expect(recipe.auth_env?.required).toEqual([]);
    expect(recipe.touchpoints.chat?.models).toContain('grok-4.7');
    expect(recipe.touchpoints.chat?.cost_per_1m_input_usd).toBe(0);
  });

  test('returns plain output and passes a single non-interactive prompt', async () => {
    process.env.GBRAIN_GROK_CLI_BIN = fakeGrok('printf %s "ok"');
    const result = await new GrokCliLanguageModel('grok-cli:grok-4.7').doGenerate(options('hello'));
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  test('recovers fenced JSON text without failing the structured caller', async () => {
    process.env.GBRAIN_GROK_CLI_BIN = fakeGrok("printf '%b' '```json\\n{\"atoms\":[]}\\n```'");
    const result = await new GrokCliLanguageModel('grok-4.7').doGenerate(options('json'));
    expect(result.content[0]).toEqual({ type: 'text', text: '{"atoms":[]}' });
  });

  test('maps logged-out output to a typed non-retryable auth status', async () => {
    process.env.GBRAIN_GROK_CLI_BIN = fakeGrok("echo 'Not signed in. Run grok login.' >&2; exit 1");
    let caught: unknown;
    try { await new GrokCliLanguageModel('grok-4.7').doGenerate(options('hello')); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GrokCliProcessError);
    expect((caught as GrokCliProcessError).apiErrorStatus).toBe(401);
    expect((caught as Error).message).toContain('authentication required');
  });
});
