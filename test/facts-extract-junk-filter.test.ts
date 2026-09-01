/**
 * #3852 — config-driven extraction prompt appendix + deterministic junk gate.
 *
 * The junk gate: assistant plan narration, provider error strings, and
 * meta-chatter must not survive extraction; durable operational knowledge
 * must pass untouched. The gate is deliberately narrow — these tests pin both
 * directions so pattern edits can't silently widen it — and carries a
 * kill-switch (`facts.extraction_junk_filter false`).
 *
 * The appendix: `facts.extraction_prompt_appendix` composes with BOTH
 * honest-notability prompt variants (the #4298-era renderExtractorSystem
 * ADMITS_LOW/SKIPS_LOW split), so an operator rubric never forks the
 * admission wiring.
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  buildExtractorSystem,
  extractFactsFromTurn,
  getFactsExtractionPromptAppendix,
  isJunkFact,
  isJunkFilterEnabled,
  JUNK_FACT_PATTERNS,
} from '../src/core/facts/extract.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('isJunkFact — rejects the audited junk classes', () => {
  const junk = [
    // Assistant plan narration.
    'Now let me write an independent oracle that recomputes the totals',
    "Let's check the logs for retry markers",
    "I'll create a cron job to monitor the tokens",
    'I am going to refactor the session handler next',
    'About to restart the gateway service',
    'Offered to create a cron job to automatically monitor repl tokens',
    'Proceeding to delete the stale lockfile',
    // Meta-narration about the conversation / concurrent state.
    'The user is asking about the deploy status',
    'Another agent is concurrently rewriting src/core/facts/extract.ts',
    // Provider billing / rate-limit error text stored as a "fact".
    "You've hit your org's monthly spend limit.",
    'Extraction stopped because the monthly spend limit was reached',
    'Provider rate limit exceeded during the sweep',
  ];
  for (const text of junk) {
    test(`rejects: ${text.slice(0, 60)}`, () => {
      expect(isJunkFact(text)).toBe(true);
    });
  }

  test('rejects empty/whitespace text', () => {
    expect(isJunkFact('')).toBe(true);
    expect(isJunkFact('   ')).toBe(true);
  });
});

describe('isJunkFact — passes durable operational knowledge', () => {
  const durable = [
    'acme-example API rate limit measured at 7 RPS; bottleneck is the API, not CPU',
    'hls.js 1.6.16 fetchSetup does not apply to master playlist requests',
    'Correct model name is example/model-v2-pro, not example/model-2-pro',
    'Bug in gateway/session.py line 812: float unix timestamp compared to datetime',
    'User prefers detached nohup jobs over run_in_background',
    'alice-example decided to migrate the agent fork to the new host',
    // Near-miss phrasings that must NOT trip the narrow patterns.
    'Nowadays the pipeline only uses port 4000 for local inference',
    'Rate limiting is implemented via a token bucket in middleware.py',
    'The letter template lives in templates/letters/',
  ];
  for (const text of durable) {
    test(`passes: ${text.slice(0, 60)}`, () => {
      expect(isJunkFact(text)).toBe(false);
    });
  }
});

describe('isJunkFact — the provider-error arm is anchored to the error-sentence shape', () => {
  // Ship-review fix: the arm used to be an unanchored substring match
  // (`\bmonthly spend limit\b`, `\brate limit exceeded\b`), so genuine
  // knowledge that merely MENTIONS a limit was deleted as junk. The fact must
  // BE the error message (optionally led by an error/status token or a
  // "<step> stopped because …" narration), not just contain the words.
  const genuine = [
    'Alice wants a monthly spend limit of $200 on AI tools',
    "Bob's API rate limit exceeded 1000 rpm during the launch",
    'The team agreed to raise the monthly spend limit to $500 for Q3',
    'acme-example raised our rate limit to 5000 rpm after the launch',
  ];
  for (const text of genuine) {
    test(`survives: ${text}`, () => {
      expect(isJunkFact(text)).toBe(false);
      expect(isJunkFact(text, 'fact')).toBe(false);
    });
  }

  // The provider error strings themselves — verbatim shapes from the wild —
  // are still junk, with or without a leading status/error token.
  const providerErrors = [
    "You've hit your org's monthly spend limit.",
    'Monthly spend limit reached for this organization',
    'Rate limit exceeded. Please retry after 20 seconds.',
    'Spend cap reached',
    '429: rate limit hit',
    'Error: your rate limit was exceeded',
  ];
  for (const text of providerErrors) {
    test(`still junk: ${text}`, () => {
      expect(isJunkFact(text)).toBe(true);
    });
  }
});

describe('isJunkFact — first-person commitments are NOT plan narration', () => {
  // The plan-narration pattern ("I'll / I will / I'm going to …") is meant to
  // catch the ASSISTANT narrating its next step. A first-person COMMITMENT is
  // the one kind the loop engine exists to capture — the same surface text
  // survives when the extractor classified it as a commitment.
  const commitments = [
    "I'll send the deck by Friday",
    'I will follow up with the fund-a partner after the board meeting',
    "I'm going to ship the migration before the offsite",
  ];
  for (const text of commitments) {
    test(`commitment survives: ${text}`, () => {
      expect(isJunkFact(text, 'commitment')).toBe(false);
    });
    test(`same text with no kind (or a non-commitment kind) is still gated: ${text}`, () => {
      expect(isJunkFact(text)).toBe(true);
      expect(isJunkFact(text, 'fact')).toBe(true);
    });
  }

  test('the exemption is narrow: meta-narration and provider errors stay junk even as "commitment"', () => {
    expect(isJunkFact('The user is asking about the deploy status', 'commitment')).toBe(true);
    expect(isJunkFact("You've hit your org's monthly spend limit.", 'commitment')).toBe(true);
    expect(isJunkFact('   ', 'commitment')).toBe(true);
  });
});

describe('isJunkFilterEnabled — off tokens + fail-open', () => {
  for (const off of ['0', 'no', ' OFF ', 'False', 'false']) {
    test(`'${off}' disables the gate`, async () => {
      expect(await isJunkFilterEnabled(stubEngine({ 'facts.extraction_junk_filter': off }))).toBe(false);
    });
  }
  for (const on of ['true', '1', 'yes', 'anything-else', '']) {
    test(`'${on}' keeps the gate on`, async () => {
      expect(await isJunkFilterEnabled(stubEngine({ 'facts.extraction_junk_filter': on }))).toBe(true);
    });
  }
  test('unset key and no engine both default ON', async () => {
    expect(await isJunkFilterEnabled(stubEngine({}))).toBe(true);
    expect(await isJunkFilterEnabled(undefined)).toBe(true);
  });
  test('a rejecting getConfig fails OPEN: junk gate on, appendix null', async () => {
    const throwing = {
      getConfig: async () => { throw new Error('config table unavailable'); },
    } as unknown as BrainEngine;
    expect(await isJunkFilterEnabled(throwing)).toBe(true);
    expect(await getFactsExtractionPromptAppendix(throwing)).toBeNull();
  });
});

test('pattern list stays narrow (no accidental broad additions)', () => {
  // Widen deliberately, with tests, or not at all.
  expect(JUNK_FACT_PATTERNS.length).toBeLessThanOrEqual(6);
});

test('both config keys are registered in KNOWN_CONFIG_KEYS', () => {
  expect(KNOWN_CONFIG_KEYS).toContain('facts.extraction_prompt_appendix');
  expect(KNOWN_CONFIG_KEYS).toContain('facts.extraction_junk_filter');
});

// ─── Extraction-path wiring (gateway transport seam, stub engine) ──────────

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

/** Minimal engine stub: only getConfig is consulted by the extract helpers. */
function stubEngine(config: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => config[key] ?? null,
  } as unknown as BrainEngine;
}

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene (same rationale as facts-extract-idea-kind.test.ts): restore
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

describe('extraction_prompt_appendix — composes with BOTH prompt variants (#3852)', () => {
  const APPENDIX = 'Durable-vs-ephemeral rubric: work-session narration is never a fact.';

  async function systemSentFor(
    engine: BrainEngine,
    notabilityAdmission?: { allowed: readonly ('high' | 'medium' | 'low')[]; invalid: 'drop' },
  ): Promise<string> {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(JSON.stringify({
        facts: [{ fact: 'user gave up alcohol', kind: 'commitment', notability: 'high' }],
      }), 'end');
    });
    await extractFactsFromTurn({
      turnText: 'I gave up alcohol.',
      source: 'test:appendix-wiring',
      engine,
      notabilityAdmission,
    });
    expect(seen).toHaveLength(1);
    return seen[0]!.system ?? '';
  }

  test('label-honestly variant (no admission) gets the appendix appended verbatim', async () => {
    const engine = stubEngine({ 'facts.extraction_prompt_appendix': APPENDIX });
    expect(await systemSentFor(engine)).toBe(`${buildExtractorSystem(true)}\n\n${APPENDIX}`);
  });

  test('skip-low variant (high-only admission) gets the SAME appendix', async () => {
    const engine = stubEngine({ 'facts.extraction_prompt_appendix': APPENDIX });
    expect(await systemSentFor(engine, { allowed: ['high'], invalid: 'drop' }))
      .toBe(`${buildExtractorSystem(false)}\n\n${APPENDIX}`);
  });

  test('unset / empty appendix leaves the precomputed prompt untouched', async () => {
    expect(await systemSentFor(stubEngine({}))).toBe(buildExtractorSystem(true));
    expect(await systemSentFor(stubEngine({ 'facts.extraction_prompt_appendix': '   ' })))
      .toBe(buildExtractorSystem(true));
  });
});

describe('extraction_junk_filter — end-to-end gate + kill-switch (#3852)', () => {
  const MIXED_JSON = JSON.stringify({
    facts: [
      { fact: 'Now let me write an oracle that recomputes the totals', kind: 'fact', notability: 'low' },
      { fact: 'User prefers detached nohup jobs over run_in_background', kind: 'preference', notability: 'medium' },
      { fact: "You've hit your org's monthly spend limit.", kind: 'fact', notability: 'low' },
    ],
  });

  test('junk candidates are dropped from the extraction result (default on)', async () => {
    __setChatTransportForTests(async () => chatResult(MIXED_JSON, 'end'));
    const facts = await extractFactsFromTurn({
      turnText: 'a work-session turn',
      source: 'test:junk-gate',
      engine: stubEngine({}),
    });
    expect(facts.map(f => f.fact)).toEqual([
      'User prefers detached nohup jobs over run_in_background',
    ]);
  });

  test("a first-person COMMITMENT survives the gate; assistant narration tagged as a fact is still dropped", async () => {
    // Pre-fix the plan-narration pattern deleted "I'll send the deck by
    // Friday" — the one kind of fact the loop engine exists to capture.
    const json = JSON.stringify({
      facts: [
        { fact: "I'll send the deck by Friday", kind: 'commitment', notability: 'medium' },
        { fact: "I'll write the oracle next and then rerun the totals", kind: 'fact', notability: 'low' },
        { fact: 'Now let me write an oracle that recomputes the totals', kind: 'fact', notability: 'low' },
        { fact: "You've hit your org's monthly spend limit.", kind: 'commitment', notability: 'low' },
      ],
    });
    __setChatTransportForTests(async () => chatResult(json, 'end'));
    const facts = await extractFactsFromTurn({
      turnText: 'a work-session turn',
      source: 'test:junk-gate-commitment',
      engine: stubEngine({}),
    });
    expect(facts.map(f => [f.fact, f.kind])).toEqual([
      ["I'll send the deck by Friday", 'commitment'],
    ]);
  });

  test('kill-switch: facts.extraction_junk_filter=false lets everything through', async () => {
    __setChatTransportForTests(async () => chatResult(MIXED_JSON, 'end'));
    const facts = await extractFactsFromTurn({
      turnText: 'a work-session turn',
      source: 'test:junk-gate-off',
      engine: stubEngine({ 'facts.extraction_junk_filter': 'false' }),
    });
    expect(facts).toHaveLength(3);
  });

  test('no engine (best-effort callers) still defaults the gate ON', async () => {
    __setChatTransportForTests(async () => chatResult(MIXED_JSON, 'end'));
    const facts = await extractFactsFromTurn({
      turnText: 'a work-session turn',
      source: 'test:junk-gate-engineless',
    });
    expect(facts).toHaveLength(1);
  });
});
