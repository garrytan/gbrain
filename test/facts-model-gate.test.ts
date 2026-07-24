/**
 * #3206 (silent-zero half) — the facts chat-availability gates must check the
 * model the call will ACTUALLY use, not the global chat default.
 *
 * Repro class: a brain configured against a self-hosted OpenAI-compatible
 * endpoint (litellm recipe, no auth required) with no ANTHROPIC_API_KEY. The
 * extraction/classifier model resolves correctly to the self-hosted provider,
 * but the pre-fix gate `isAvailable('chat')` consulted `getChatModel()` — the
 * (unavailable) Anthropic default — and silently returned zero facts /
 * cosine-fallback with no error.
 *
 * Hermetic: `__setGenerateTextTransportForTests` stubs the SDK call AFTER
 * provider resolution, so the litellm recipe + auth check stay live while no
 * network is touched. (`__setChatTransportForTests` can't be used here — it
 * makes `isAvailable('chat')` unconditionally true, which would hide the bug.)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';
import { classifyAgainstCandidates } from '../src/core/facts/classify.ts';
import type { FactRow } from '../src/core/engine.ts';

function installTextTransport(text: string): void {
  __setGenerateTextTransportForTests(async () => ({
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 10 },
  }) as any);
}

beforeEach(() => {
  resetGateway();
  // No API keys at all: the Anthropic default chat model is UNAVAILABLE,
  // while the auth-free litellm recipe is available.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('#3206 — facts gates check the model actually used', () => {
  test('extractFactsFromTurn extracts via a non-default provider when the global chat default is unavailable', async () => {
    installTextTransport(JSON.stringify({
      facts: [{ fact: 'User moved to Tokyo', kind: 'event', confidence: 1.0, notability: 'high' }],
    }));

    const facts = await extractFactsFromTurn({
      turnText: 'I moved to Tokyo last month and it changed everything.',
      source: 'test:model-gate',
      model: 'litellm:qwen-test',
    });

    // Pre-fix: isAvailable('chat') consulted the unavailable Anthropic
    // default and this silently returned [].
    expect(facts.length).toBe(1);
    expect(facts[0]!.fact).toContain('Tokyo');
  });

  test('extractFactsFromTurn still bails when the model it would use is unavailable', async () => {
    installTextTransport(JSON.stringify({ facts: [{ fact: 'x', kind: 'event' }] }));

    const facts = await extractFactsFromTurn({
      turnText: 'Some meaningful turn text about a life event.',
      source: 'test:model-gate',
      model: 'anthropic:claude-sonnet-4-6', // requires ANTHROPIC_API_KEY — absent
    });

    expect(facts).toEqual([]);
  });

  test('classifyAgainstCandidates runs the classifier via a non-default provider when the chat default is unavailable', async () => {
    installTextTransport('{"decision":"duplicate","matched_id":7}');

    const candidate = {
      id: 7,
      fact: 'User lives in Tokyo',
      kind: 'fact',
      embedding: null,
    } as unknown as FactRow;

    const result = await classifyAgainstCandidates(
      { fact: 'User moved to Tokyo', kind: 'fact', embedding: null },
      [candidate],
      { model: 'litellm:qwen-test' },
    );

    // Pre-fix: the gate consulted the unavailable Anthropic default and this
    // degraded to reason 'cosine_fallback' (decision 'independent', since no
    // embeddings) instead of running the classifier.
    expect(result.reason).toBe('classifier');
    expect(result.decision).toBe('duplicate');
  });
});
