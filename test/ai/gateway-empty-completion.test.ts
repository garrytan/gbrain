/**
 * #3217 — zero-token empty completions must not report success.
 *
 * Root cause: `chat()` returned `{ text: '', blocks: [] }` for a contentless
 * non-refusal completion, so an empty provider response silently propagated
 * "no result" to every caller as if it were a valid answer. Providers commonly
 * normalize omitted usage to zero output tokens, so any usage-based gate would
 * treat those responses as free successes — the guard therefore validates
 * usable CONTENT (text / tool-call blocks) independently of reported usage.
 *
 * Pinned behavior:
 *   - contentless + stop        → AITransientError (retryable provider blip)
 *   - contentless + usage omitted entirely → same (usage-independent check)
 *   - contentless + length      → AIConfigError with an actionable fix
 *     (output budget exhausted before any text — deterministic, not retryable)
 *   - refusal / content_filter  → still returned, NOT thrown (callers branch
 *     on these stop reasons; toolLoop surfaces each as its own stop reason)
 *   - non-empty text + zero usage → success (zero usage alone is not failure)
 *   - tool-call-only completion → success (a tool call IS usable content)
 *   - budget: the throw carries real usage so the catch-path record charges
 *     actual tokens, not the pessimistic maxOutputTokens ceiling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chat,
  configureGateway,
  isContentlessLengthError,
  resetGateway,
  withBudgetTracker,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';
import {
  BudgetTracker,
  _resetBudgetTrackerWarningsForTest,
} from '../../src/core/budget/budget-tracker.ts';

function installTransport(response: Record<string, unknown>): void {
  __setGenerateTextTransportForTests(async () => response as any);
}

function callChat() {
  return chat({
    model: 'anthropic:claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
  });
}

describe('#3217 — empty-completion guard in chat()', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
  });

  afterEach(() => {
    __setGenerateTextTransportForTests(null);
    resetGateway();
  });

  test('contentless completion with zero-normalized usage throws AITransientError', async () => {
    installTransport({
      content: [],
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    await expect(callChat()).rejects.toThrow(AITransientError);
  });

  test('contentless completion with usage omitted entirely still throws (check is usage-independent)', async () => {
    installTransport({
      content: [],
      finishReason: 'stop',
      // no `usage` field at all — the provider omitted it
    });
    await expect(callChat()).rejects.toThrow(AITransientError);
  });

  test('whitespace-only text is not usable content', async () => {
    installTransport({
      content: [{ type: 'text', text: '\n  \n' }],
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 3 },
    });
    await expect(callChat()).rejects.toThrow(AITransientError);
  });

  test('contentless length stop is classified distinctly as AIConfigError with a fix', async () => {
    installTransport({
      content: [],
      finishReason: 'length',
      usage: { inputTokens: 42, outputTokens: 4096 },
    });
    try {
      await callChat();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AIConfigError);
      expect((e as AIConfigError).message).toContain('output budget exhausted');
      expect((e as AIConfigError).fix).toBeDefined();
      // Callers with their own length-stop truncation handling (facts
      // extract #2113, chronicle #2606) branch on this predicate.
      expect(isContentlessLengthError(e)).toBe(true);
    }
  });

  test('isContentlessLengthError is false for the non-length empty-completion throw', async () => {
    installTransport({
      content: [],
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    try {
      await callChat();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AITransientError);
      expect(isContentlessLengthError(e)).toBe(false);
    }
  });

  test('refusal stop with empty content is returned, not thrown', async () => {
    installTransport({
      content: [],
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 0 },
      providerMetadata: { anthropic: { stopReason: 'refusal' } },
    });
    const result = await callChat();
    expect(result.stopReason).toBe('refusal');
    expect(result.text).toBe('');
  });

  test('content_filter stop with empty content is returned, not thrown', async () => {
    installTransport({
      content: [],
      finishReason: 'content-filter',
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    const result = await callChat();
    expect(result.stopReason).toBe('content_filter');
    expect(result.text).toBe('');
  });

  test('non-empty text with zero-reported usage succeeds (zero usage alone is not failure)', async () => {
    installTransport({
      content: [{ type: 'text', text: 'a real answer' }],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const result = await callChat();
    expect(result.text).toBe('a real answer');
    expect(result.usage.output_tokens).toBe(0);
  });

  test('tool-call-only completion (no text) succeeds', async () => {
    installTransport({
      content: [
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'lookup', input: { q: 'x' } },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 42, outputTokens: 12 },
    });
    const result = await callChat();
    expect(result.stopReason).toBe('tool_calls');
    expect(result.blocks).toEqual([
      { type: 'tool-call', toolCallId: 'tc_1', toolName: 'lookup', input: { q: 'x' } },
    ]);
  });
});

describe('#3217 — budget recording on the empty-completion throw', () => {
  let tmp: string;
  let auditPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-empty-completion-'));
    auditPath = join(tmp, 'budget.jsonl');
    _resetBudgetTrackerWarningsForTest();
    resetGateway();
    __setGenerateTextTransportForTests(null);
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
  });

  afterEach(() => {
    __setGenerateTextTransportForTests(null);
    resetGateway();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('throw records ACTUAL usage, not the pessimistic maxOutputTokens ceiling', async () => {
    const usage = { inputTokens: 42, outputTokens: 0 };

    // Control: a successful call with identical usage.
    installTransport({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage,
    });
    const control = new BudgetTracker({ maxCostUsd: 1.0, label: 'control', auditPath });
    await withBudgetTracker(control, async () => {
      await callChat();
    });

    // Under test: an empty completion with the same reported usage.
    installTransport({
      content: [],
      finishReason: 'stop',
      usage,
    });
    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'empty', auditPath });
    await withBudgetTracker(tracker, async () => {
      await expect(callChat()).rejects.toThrow(AITransientError);
    });

    // Same usage → same spend. If the guard threw without carrying usage, the
    // catch path would charge estimated input + the full 4096-token output
    // ceiling and this assertion would fail loudly.
    expect(tracker.totalSpent).toBe(control.totalSpent);
    expect(tracker.totalSpent).toBeGreaterThan(0);
  });

  test('omitted usage keeps the pessimistic fallback (never recorded as free)', async () => {
    // The provider omitted usage entirely. The guard must NOT attach a
    // synthesized {0,0} to the error — that would bypass
    // _extractUsageFromError's pessimistic fallback and record the failed
    // call as costing nothing.
    installTransport({
      content: [],
      finishReason: 'stop',
      // no `usage` field at all
    });
    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'omitted', auditPath });
    await withBudgetTracker(tracker, async () => {
      await expect(callChat()).rejects.toThrow(AITransientError);
    });
    // Pessimistic fallback = estimated input + full maxOutputTokens ceiling,
    // which is strictly positive. A {0,0} attach would make this exactly 0.
    expect(tracker.totalSpent).toBeGreaterThan(0);
  });
});
