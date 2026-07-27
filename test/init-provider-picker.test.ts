/**
 * Picker unit tests — exercise the pure paths (env filtering, caveat
 * messaging, null returns on bad input). TTY-input flows (numbered
 * selection happy path, Ctrl-D, timeout) are covered E2E via
 * cli-pty-runner.ts because mocking readLineSafe at the unit boundary
 * leaks across files in the shard process per CLAUDE.md test-isolation
 * rules.
 */

import { describe, test, expect } from 'bun:test';
import {
  pickProvider,
  printSubagentAnthropicCaveat,
} from '../src/commands/init-provider-picker.ts';

describe('printSubagentAnthropicCaveat', () => {
  test('writes the canonical D7 caveat lines', () => {
    let buf = '';
    printSubagentAnthropicCaveat((s) => { buf += s; });
    expect(buf).toContain('subagent features');
    expect(buf).toContain('gbrain dream');
    expect(buf).toContain('gbrain agent run');
    expect(buf).toContain('gbrain autopilot');
    expect(buf).toContain('ANTHROPIC_API_KEY');
    // The caveat must clarify chat alone is fine without it.
    expect(buf).toContain('Chat alone');
  });
});

describe('pickProvider — defensive paths', () => {
  test('non-TTY returns null without prompting', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: {},
      isTTY: false,
      writeStderr: (s) => { stderr += s; },
    });
    expect(got).toBeNull();
    expect(stderr).toBe('');
  });

  test('TTY happy path — env-ready provider proceeds to prompt + returns first choice', async () => {
    // OPENAI_API_KEY set → openai is env-ready. readLineSafe returns the
    // default '1' in non-stdin-TTY bun:test mode, so picker picks the first
    // ready recipe deterministically. We mostly want to verify NO null
    // return and a sensible payload shape.
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: { OPENAI_API_KEY: 'sk-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
    });
    expect(got).not.toBeNull();
    if (got) {
      expect(got.fullModel).toMatch(/:/);  // provider:model shape
      expect(got.dim).toBeGreaterThan(0);  // embedding always has dims
      expect(stderr).toContain('Pick a embedding provider');
    }
  });

  test('caveat fires when picking non-Anthropic chat without ANTHROPIC_API_KEY', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'chat',
      // OpenAI is chat-capable; Anthropic key missing → caveat must fire.
      env: { OPENAI_API_KEY: 'sk-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
    });
    expect(got).not.toBeNull();
    if (got) {
      expect(got.recipeId).toBe('openai');
      // The caveat printed somewhere in stderr.
      expect(stderr).toContain('subagent features');
      expect(stderr).toContain('ANTHROPIC_API_KEY');
    }
  });

  test('caveat does NOT fire when picking Anthropic for chat', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'chat',
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
    });
    expect(got).not.toBeNull();
    if (got) {
      expect(got.recipeId).toBe('anthropic');
      // No subagent caveat in stderr.
      expect(stderr).not.toContain('subagent features');
    }
  });

  test('caveat does NOT fire when picking non-Anthropic chat WITH ANTHROPIC_API_KEY also set', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'chat',
      env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
    });
    expect(got).not.toBeNull();
    if (got) {
      // Both are ready; first-by-listRecipes order wins; readLineSafe
      // returns default '1'. Either openai or anthropic — we just verify
      // no caveat fires either way (anthropic set, no subagent surprise).
      expect(stderr).not.toContain('subagent features');
    }
  });

  test('embedding touchpoint label printed in prompt', async () => {
    let stderr = '';
    await pickProvider({
      touchpoint: 'embedding',
      env: { OPENAI_API_KEY: 'sk-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
    });
    expect(stderr).toContain('embedding provider');
  });
});
