/**
 * F5 — 'idea' fact kind + honest notability split.
 *
 * The extractor/DB taxonomy gained 'idea' (a novel idea, frame, thesis, or
 * mental model the speaker articulates). The frozen MEMORY_VERBS remember
 * enum did NOT (docs/protocol/MEMORY_VERBS_v1.md) — that absence is pinned
 * in memory-verbs-conformance.test.ts.
 *
 * Pins:
 *   - taxonomy coercion: known kinds survive verbatim, 'idea' is accepted as
 *     'idea' (previously coerced to 'fact' — that behavior is gone), unknown
 *     kinds still coerce to 'fact'
 *   - prompt shape: buildExtractorSystem(true) vs (false) differ in EXACTLY
 *     one clause (the low-tier line); both carry the idea definition and the
 *     widened kind enum; the "fact" catch-all stays last
 *   - admission wiring: high-only admission → skip-low prompt variant; no
 *     admission (batch path) or a low-admitting admission → label-honestly
 *     variant
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */
import { afterAll, describe, test, expect, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { extractFactsFromTurn, buildExtractorSystem } from '../src/core/facts/extract.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene (same rationale as facts-extract-truncation.test.ts): restore
// the legacy 1536-d embedding pin so later fresh-schema files in this shard
// don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

describe('taxonomy coercion — idea is a first-class extractor kind', () => {
  test("known kinds survive verbatim, 'idea' stays 'idea', unknown kinds coerce to 'fact'", async () => {
    const raw = JSON.stringify({
      facts: [
        { fact: 'promised to ship the wave', kind: 'commitment', notability: 'high' },
        { fact: 'thinks agents will eat SaaS', kind: 'belief', notability: 'medium' },
        { fact: 'memory should work like a database', kind: 'idea', notability: 'medium' },
        { fact: 'chose the embedded engine', kind: 'decision', notability: 'medium' },
      ],
    });
    __setChatTransportForTests(async () => chatResult(raw, 'end'));
    const facts = await extractFactsFromTurn({
      turnText: 'a turn with four differently-kinded claims',
      source: 'test:idea-kind',
    });
    // 'idea' as 'idea' pins that the old coerce-to-'fact' behavior is gone;
    // 'decision' (unknown) pins that the catch-all coercion still holds.
    expect(facts.map(f => f.kind)).toEqual(['commitment', 'belief', 'idea', 'fact']);
  });
});

describe('buildExtractorSystem — prompt shape', () => {
  test('the two variants differ in EXACTLY one clause (the low-tier line)', () => {
    const admit = buildExtractorSystem(true).split('\n');
    const skip = buildExtractorSystem(false).split('\n');
    expect(admit.length).toBe(skip.length);
    const diffs = admit
      .map((line, i) => ({ admit: line, skip: skip[i]! }))
      .filter(d => d.admit !== d.skip);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.admit).toContain('Label honestly');
    expect(diffs[0]!.admit).toContain('the caller decides storage');
    expect(diffs[0]!.skip).toContain('Skip entirely — not worth storing.');
  });

  test('both variants carry the idea definition + widened kind enum; "fact" stays the catch-all', () => {
    for (const admitsLow of [true, false]) {
      const system = buildExtractorSystem(admitsLow);
      expect(system).toContain('"kind":"event|preference|commitment|belief|fact|idea"');
      expect(system).toContain(
        '- "idea": a novel idea, frame, thesis, or mental model the speaker articulates.',
      );
      // The "fact" catch-all definition stays LAST in the kind list.
      expect(system.indexOf('- "idea":')).toBeLessThan(
        system.indexOf('- "fact": objective claim'),
      );
    }
  });

  test('variants are precomputed — repeat calls return the identical string (prompt-cache friendly)', () => {
    expect(buildExtractorSystem(true)).toBe(buildExtractorSystem(true));
    expect(buildExtractorSystem(false)).toBe(buildExtractorSystem(false));
    expect(buildExtractorSystem(true)).not.toBe(buildExtractorSystem(false));
  });
});

describe('admission wiring — which prompt variant each caller gets', () => {
  const HIGH_JSON = JSON.stringify({
    facts: [{ fact: 'user gave up alcohol', kind: 'commitment', notability: 'high' }],
  });

  async function systemSentFor(
    notabilityAdmission?: { allowed: readonly ('high' | 'medium' | 'low')[]; invalid: 'drop' },
  ): Promise<string> {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(HIGH_JSON, 'end');
    });
    await extractFactsFromTurn({
      turnText: 'I gave up alcohol.',
      source: 'test:admission-wiring',
      notabilityAdmission,
    });
    expect(seen).toHaveLength(1);
    return seen[0]!.system ?? '';
  }

  test('no admission (batch path) → label-honestly variant', async () => {
    expect(await systemSentFor(undefined)).toBe(buildExtractorSystem(true));
  });

  test("high-only admission (sync's filter) → skip-low variant", async () => {
    expect(await systemSentFor({ allowed: ['high'], invalid: 'drop' }))
      .toBe(buildExtractorSystem(false));
  });

  test("an admission that allows 'low' → label-honestly variant", async () => {
    expect(await systemSentFor({ allowed: ['high', 'medium', 'low'], invalid: 'drop' }))
      .toBe(buildExtractorSystem(true));
  });
});
