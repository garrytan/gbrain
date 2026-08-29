/**
 * `gbrain models doctor` chat probe timeout — end-to-end wall-clock proof.
 *
 * Companion to `models-doctor-chat-probe-timeout.test.ts` (the fast,
 * zero-wait unit tests for `resolveChatProbeTimeoutMs`). These two tests
 * each inject a `deps.chat` mock that stalls ~5.5s — comfortably past the
 * old hardcoded 5000ms probe budget — to prove `probeModel()` actually
 * wires the resolved timeout through end-to-end, not just that the
 * resolver function returns the right number in isolation:
 *
 *   - claude-cli: now succeeds (its recipe declares 30_000ms).
 *   - every other provider: UNCHANGED, still aborts at the historical
 *     5000ms (pinned by asserting the exact abort message).
 *
 * Per `docs/TESTING.md`, real multi-second waits belong in `*.slow.test.ts`
 * (run via `bun run test:slow`), not the fast unit loop that
 * `scripts/run-unit-shard.sh` fans out on every inner-loop run.
 */

import { describe, test, expect } from 'bun:test';
import { probeModel } from '../src/commands/models.ts';

type ChatFn = typeof import('../src/core/ai/gateway.ts').chat;

function stallingChat(ms: number): ChatFn {
  return (async (opts: { abortSignal?: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      opts.abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(opts.abortSignal!.reason ?? new Error('aborted'));
      });
    });
    return {} as Awaited<ReturnType<ChatFn>>;
  }) as unknown as ChatFn;
}

describe('probeModel — honors the resolved timeout end-to-end', () => {
  // Explicit per-test timeout: empirically, a bare `bun test <file>` (no
  // --timeout flag) enforces bun's built-in 5000ms per-test default even
  // though bunfig.toml declares `[test].timeout = 60_000` — verified
  // locally (a standalone 5.5s-wait test times out at 5005ms without this
  // override). scripts/run-unit-*.sh pass --timeout=60000 explicitly, but
  // pin it here too so this test doesn't depend on invocation method.
  test('claude-cli: a >5s chat call (realistic subprocess cold start) succeeds instead of false-failing at the old 5s budget', async () => {
    const r = await probeModel('claude-cli:claude-sonnet-5', 'chat', { chat: stallingChat(5500) });
    expect(r.status).toBe('ok');
    expect(r.message).toBe('reachable');
  }, 15_000);

  test('non-claude-cli provider: a >5s stall still aborts at the unchanged 5000ms budget', async () => {
    const r = await probeModel('anthropic:claude-sonnet-4-6', 'chat', { chat: stallingChat(5500) });
    expect(r.status).not.toBe('ok');
    expect(r.message).toBe('probe timed out after 5000ms');
  }, 15_000);
});
