/**
 * Regression: extract_atoms gated its cost cap on the CHAT model alone, but
 * the atom write site (importFromContent) also embeds inside the same
 * withBudgetTracker scope. A $0 local chat model (ollama / llama-server) kept
 * the cap on, and an unpriced embedding route — `litellm:*`, deliberately not
 * assumed free because a proxy can front a paid provider — made
 * BudgetTracker.reserve() throw BudgetExhausted(no_pricing) on the FIRST atom
 * import. `budgetExhausted` latched, every remaining item was skipped, and the
 * phase reported 0 atoms / `budget_exhausted: true` / $0 spent on every run.
 *
 * The phase also never loaded `pricing.overrides` (#4312), so the operator
 * fix its own error message advertised did nothing here.
 *
 * Pure-helper cases first; the final describe is a PGLite round-trip that
 * pins the actual defect (an unpriced embed model no longer zeroes the run).
 * No model calls anywhere — chat is stubbed via the `_chat` seam and the embed
 * transport via __setEmbedTransportForTests.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { resolveExtractAtomsCostGate } from '../src/core/cycle/extract-atoms-cost-gate.ts';
import { parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

const FREE_CHAT = 'llama-server:local-27b';
const UNPRICED_EMBED = 'litellm:nvidia/some-local-embedder';

describe('resolveExtractAtomsCostGate', () => {
  test('priced chat + priced embed → cap enforced', () => {
    expect(resolveExtractAtomsCostGate('claude-haiku-4-5-20251001', 'openai:text-embedding-3-large'))
      .toEqual({ enforceCap: true });
  });

  test('free local chat + no embedding configured → cap enforced (nothing unpriced bills)', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, null)).toEqual({ enforceCap: true });
  });

  test('free local chat + free local embed → cap enforced at $0', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, 'ollama:nomic-embed-text')).toEqual({ enforceCap: true });
  });

  test('unpriced chat model disables the cap and names the chat model', () => {
    expect(resolveExtractAtomsCostGate('groq:llama-3.3-70b', 'openai:text-embedding-3-large')).toEqual({
      enforceCap: false,
      unpricedModel: 'groq:llama-3.3-70b',
      unpricedKind: 'chat',
    });
  });

  test('free local chat + UNPRICED embed disables the cap and names the embed model (the defect)', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED)).toEqual({
      enforceCap: false,
      unpricedModel: UNPRICED_EMBED,
      unpricedKind: 'embed',
    });
  });

  test('an operator pricing override for the embed model restores the cap', () => {
    const overrides = parsePricingOverrides(JSON.stringify({ [UNPRICED_EMBED]: 0 }));
    expect(overrides).toBeDefined();
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides)).toEqual({ enforceCap: true });
  });

  test('override lookup is case-insensitive, matching BudgetTracker.reserve()', () => {
    const overrides = parsePricingOverrides(JSON.stringify({ [UNPRICED_EMBED.toUpperCase()]: 0 }));
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides)).toEqual({ enforceCap: true });
  });

  // An operator who SET `cycle.extract_atoms.budget_usd` asked for a ceiling.
  // This used to keep the cap and bill the unpriced embed route at $0 (Codex
  // P1). Garry's explicit-cap rule (2026-10-02) supersedes that: a cap the user
  // set refuses an unpriced route and tells the agent to look the price up and
  // register it, rather than assume $0.
  test('an explicit operator budget refuses an unpriced embed route with no_pricing guidance', () => {
    const gate = resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, undefined, { explicitBudget: true });
    expect(gate).toMatchObject({ enforceCap: true, unpricedModel: UNPRICED_EMBED, unpricedKind: 'embed' });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: UNPRICED_EMBED, kind: 'embed', units: ['usd_per_1m_tokens'] });
    expect(gate.refusal!.register_command).toStartWith(`foresights pricing set ${UNPRICED_EMBED} --rate`);
  });

  test('an explicit budget never invents a $0 embed row; other overrides are left as they were', () => {
    // Superseded by the explicit-cap rule: the gate used to merge a $0 row for
    // the embed route into the operator's overrides. It now returns no
    // overrides at all and refuses, so the operator map is never rewritten.
    const overrides = parsePricingOverrides(JSON.stringify({ 'litellm:gpt-4o': { input: 2.5, output: 10 } }))!;
    const gate = resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides, { explicitBudget: true });
    expect(gate.refusal?.model).toBe(UNPRICED_EMBED);
    expect('pricingOverrides' in gate).toBe(false);
    expect(overrides).toEqual({ 'litellm:gpt-4o': { input: 2.5, output: 10 } });
  });

  test('an explicit budget refuses an unpriced CHAT model instead of dropping the cap', () => {
    // Used to drop the cap and run uncapped. Superseded by Garry's explicit-cap
    // rule (2026-10-02): a spending cap you set blocks an unpriced model and
    // tells the agent to look up the price and register it.
    const gate = resolveExtractAtomsCostGate('groq:llama-3.3-70b', UNPRICED_EMBED, undefined, { explicitBudget: true });
    expect(gate).toMatchObject({ enforceCap: true, unpricedModel: 'groq:llama-3.3-70b', unpricedKind: 'chat' });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: 'groq:llama-3.3-70b', provider: 'groq', kind: 'chat' });
  });

  test('without an explicit budget the unpriced embed still drops the (default) cap', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, undefined, { explicitBudget: false })).toEqual({
      enforceCap: false,
      unpricedModel: UNPRICED_EMBED,
      unpricedKind: 'embed',
    });
  });
});

describe('extract_atoms with a $0 chat model and an unpriced embedding model (PGLite round-trip)', () => {
  let engine: PGLiteEngine;
  const DIMS = 1536; // matches the preload's schema width

  beforeAll(async () => {
    // Hermetic: keyless env, an embedding model with NO pricing entry, and a
    // stubbed embed transport so isAvailable('embedding') is true and the atom
    // import really embeds — under the phase's BudgetTracker — without a network.
    configureGateway({
      embedding_model: UNPRICED_EMBED,
      embedding_dimensions: DIMS,
      env: {},
    });
    // Same shape as the ai-sdk embedMany result the gateway consumes (see
    // test/asymmetric-encoding-contract.test.ts).
    __setEmbedTransportForTests((async (args: any) => ({
      embeddings: (args.values as string[]).map(() => Array.from({ length: DIMS }, () => 0.01)),
      usage: { tokens: 10 * (args.values as string[]).length },
    })) as any);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('models.dream.extract_atoms', FREE_CHAT);
  });
  afterAll(async () => {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
  });
  afterEach(async () => {
    await engine.unsetConfig('pricing.overrides');
    await engine.unsetConfig('cycle.extract_atoms.budget_usd');
  });

  const chat = async (_o: ChatOpts): Promise<ChatResult> => ({
    text: `[{"title":"Embedded atom","atom_type":"insight","body":"Local inference costs electricity, not tokens."}]`,
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: FREE_CHAT,
    providerId: 'llama-server',
  });

  test('the unpriced embed no longer zeroes the run: 1 atom, budget not exhausted', async () => {
    expect(isAvailable('embedding')).toBe(true);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting-a.txt', content: 'transcript content a', contentHash: 'a1b2c3d4e5f60718' }],
      _pages: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.budget_exhausted).toBe(false);
    expect(result.details?.transcripts_skipped_budget).toBe(0);
  }, 60000);

  // Used to run with the embed route billed at $0 (Codex P1). Superseded by
  // Garry's explicit-cap rule (2026-10-02): the run is refused, makes no model
  // call, and reports the no_pricing guidance.
  test('an explicit cycle.extract_atoms.budget_usd refuses the unpriced embed route: no model call, guidance in details', async () => {
    let chatCalls = 0;
    await engine.setConfig('cycle.extract_atoms.budget_usd', '0.05');
    const stderr: string[] = [];
    const savedError = console.error;
    console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
    let result;
    try {
      result = await runPhaseExtractAtoms(engine, {
        _transcripts: [{ filePath: '/fake/meeting-c.txt', content: 'transcript content c', contentHash: 'c1b2c3d4e5f60718' }],
        _pages: [],
        _chat: async (o) => { chatCalls++; return chat(o); },
      });
    } finally {
      console.error = savedError;
    }
    expect(result.status).toBe('warn');
    expect(chatCalls).toBe(0);
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.budget_usd).toBe(0.05);
    expect(result.details?.no_pricing).toMatchObject({ model: UNPRICED_EMBED, kind: 'embed' });
    const joined = stderr.join('\n');
    // The cap was NOT dropped — the operator asked for one.
    expect(joined).not.toContain('running without a cost gate');
    // ...and the run names the embed model and the registration command.
    expect(joined).toContain(`foresights pricing set ${UNPRICED_EMBED} --rate`);
  }, 60000);

  test('with a $0 pricing override for the embed model the cap stays on and the run still extracts', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ [UNPRICED_EMBED]: 0 }));
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting-b.txt', content: 'transcript content b', contentHash: 'b1b2c3d4e5f60718' }],
      _pages: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.budget_exhausted).toBe(false);
  }, 60000);
});
