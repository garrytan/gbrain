/**
 * `gbrain models doctor` chat/expansion probe timeout — defect fix.
 *
 * Pre-fix, `probeModel()` hardcoded a flat 5000ms abort for every provider.
 * `claude-cli:` dispatches through a `claude --print` subprocess (CLI cold
 * start + user-level CLAUDE.md load), which routinely takes 5-6s even when
 * the CLI and subscription are perfectly healthy — so the doctor probe
 * always aborted and reported `'unknown — claude-cli adapter aborted'`,
 * not because anything was actually broken. `chat()` itself succeeds fine
 * at normal call sites; only the probe's flat 5s budget was too tight.
 *
 * `resolveChatProbeTimeoutMs()` now reads `touchpoints.<kind>.default_timeout_ms`
 * off the resolved recipe (mirrors the reranker probe's recipe-default
 * fallback in `resolveLiveRerankerTimeoutMs` / mode.ts) before falling back
 * to the historical 5000ms. These fast, zero-wait tests pin the resolution
 * logic: (1) claude-cli's declared 30s override, (2) every other provider
 * keeps the unchanged 5000ms default, (3) an unresolvable model string
 * still degrades to 5000ms rather than throwing. The end-to-end wall-clock
 * proof that `probeModel` actually honors the resolved timeout lives in
 * `models-doctor-chat-probe-timeout.slow.test.ts` (per `docs/TESTING.md`,
 * tests with real multi-second waits belong in `*.slow.test.ts`, not the
 * fast unit loop).
 */

import { describe, test, expect } from 'bun:test';
import { resolveChatProbeTimeoutMs } from '../src/commands/models.ts';

describe('resolveChatProbeTimeoutMs', () => {
  test('claude-cli chat touchpoint resolves to its declared 30s override', async () => {
    const ms = await resolveChatProbeTimeoutMs('claude-cli:claude-sonnet-5', 'chat');
    expect(ms).toBe(30_000);
  });

  test('Ollama chat allows a local cold start', async () => {
    const ms = await resolveChatProbeTimeoutMs('ollama:qwen3:8b', 'chat');
    expect(ms).toBe(180_000);
  });

  test('a provider without a declared default_timeout_ms keeps the historical 5000ms', async () => {
    const ms = await resolveChatProbeTimeoutMs('anthropic:claude-sonnet-4-6', 'chat');
    expect(ms).toBe(5000);
  });

  test('expansion touchpoint on a provider with no override keeps 5000ms', async () => {
    const ms = await resolveChatProbeTimeoutMs('openai:gpt-5-mini', 'expansion');
    expect(ms).toBe(5000);
  });

  test('an unresolvable model string degrades to 5000ms instead of throwing', async () => {
    const ms = await resolveChatProbeTimeoutMs('not-a-real-provider:nope', 'chat');
    expect(ms).toBe(5000);
  });
});
