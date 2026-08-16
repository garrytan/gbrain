/**
 * Picker unit tests — exercise the pure paths (env filtering, caveat
 * messaging, null returns on bad input). The real TTY-input flow (menu
 * rendering, typed selection, persistence) is covered by the real-PTY
 * serial test at test/init-picker-pty.serial.test.ts; mocking readLineSafe
 * at the unit boundary would leak across files in the shard process per
 * CLAUDE.md test-isolation rules.
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
    // return and a sensible payload shape. probeLocal is stubbed unreachable
    // so ollama drops out and the unit test never touches the network.
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: { OPENAI_API_KEY: 'sk-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
      probeLocal: async () => ({ reachable: false }),
    });
    expect(got).not.toBeNull();
    if (got) {
      expect(got.fullModel).toMatch(/:/);  // provider:model shape
      expect(got.dim).toBeGreaterThan(0);  // embedding always has dims
      expect(stderr).toContain('Pick an embedding provider');
      // Keyless is always an explicit option for embedding.
      expect(stderr).toContain('0) none — continue keyless');
    }
  });

  test('keyless machine (no keys, ollama daemon down) → keyless default, returns null', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: {},
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
      probeLocal: async () => ({ reachable: false }),
    });
    // No keyed provider ready → default is 0 (keyless) → null return; the
    // caller continues keyless. A bare Enter can no longer select a broken
    // local daemon. (readLineSafe resolves the default in bun:test's
    // non-stdin-TTY mode, so the null return IS the default-path proof.)
    expect(got).toBeNull();
    expect(stderr).toContain('0) none — continue keyless');
  });

  test('ollama daemon up but model not pulled → annotated with the pull fix, keyless still default', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: {},
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
      probeLocal: async () => ({
        reachable: true,
        models_endpoint_valid: true,
        models: ['some-other-model'],
      }),
    });
    expect(stderr).toContain('model not pulled — run: ollama pull');
    // Daemon-up-model-missing must NOT be the bare-Enter default: with no
    // keyed provider ready, the default resolves to 0 (keyless) → null.
    expect(got).toBeNull();
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
      probeLocal: async () => ({ reachable: false }),
    });
    expect(stderr).toContain('embedding provider');
  });
});

describe('pickProvider — v0.46.3 sunset filter + canonical default_model', () => {
  test('a sunset-only key offers NO provider rows (ZE filtered out)', async () => {
    // Only ZEROENTROPY_API_KEY set: the sunset filter drops ZE from the
    // offered list, keyless becomes the default choice, and readLineSafe's
    // non-TTY-stdin default ('0' when no keyed provider is ready) returns
    // null → the caller continues keyless.
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: { ZEROENTROPY_API_KEY: 'ze-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
      probeLocal: async () => ({ reachable: false }),
    });
    expect(got).toBeNull();
    // The dying provider must not be offered as a numbered choice.
    expect(stderr).not.toMatch(/\d\) zeroentropyai/);
  });

  test('voyage pick resolves the canonical default_model (voyage-4, not models[0])', async () => {
    let stderr = '';
    const got = await pickProvider({
      touchpoint: 'embedding',
      env: { VOYAGE_API_KEY: 'pa-test' },
      isTTY: true,
      writeStderr: (s) => { stderr += s; },
      probeLocal: async () => ({ reachable: false }),
    });
    expect(got).not.toBeNull();
    if (got) {
      expect(got.fullModel).toBe('voyage:voyage-4');
      expect(got.modelId).toBe('voyage-4');
    }
    // The displayed row must match what a pick selects — canonical, not the
    // quality-sorted array head.
    expect(stderr).toContain('voyage-4');
    expect(stderr).not.toContain('voyage-4-large');
  });
});
