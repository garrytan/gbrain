/**
 * Consistency guard: every cross-modal DEFAULT_SLOTS model must be listed
 * in its recipe's chat touchpoint. `openai:gpt-4o` drifted out of the
 * OpenAI recipe while remaining the slot-A default — the gateway then
 * rejected slot A ("not listed for OpenAI chat") on every install, and the
 * 3-slot judge panel could never reach its 2-model quorum without a Google
 * key, pinning every batch verdict at inconclusive (which the nightly
 * quality probe surfaces as a doctor WARN).
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_SLOTS,
  DEFAULT_DIMENSIONS,
  buildPrompt,
  dimensionScoreKey,
} from '../src/core/cross-modal-eval/runner.ts';
import { substituteUnavailableDefaultSlots } from '../src/commands/eval-cross-modal.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('cross-modal DEFAULT_SLOTS ↔ recipe consistency', () => {
  test('every default slot model is listed in its recipe chat touchpoint', () => {
    for (const slot of DEFAULT_SLOTS) {
      const { provider, model } = splitProviderModelId(slot.model);
      expect(provider).not.toBeNull();
      const recipe = getRecipe(provider!);
      expect(recipe, `slot ${slot.id}: unknown recipe "${provider}"`).toBeDefined();
      const chatModels = recipe!.touchpoints.chat?.models ?? [];
      expect(
        chatModels,
        `slot ${slot.id}: "${model}" not listed for ${provider} chat — the judge slot can never run`,
      ).toContain(model);
    }
  });

  test('every default slot model has a canonical pricing entry', () => {
    // Without one, estimateCost silently drops the slot from the
    // --max-usd pre-flight and est_cost_usd audit rows (~1/3 under-count).
    for (const slot of DEFAULT_SLOTS) {
      expect(
        canonicalLookup(slot.model),
        `slot ${slot.id}: "${slot.model}" missing from CANONICAL_PRICING`,
      ).toBeDefined();
    }
  });

  test('slots span three distinct providers (uncorrelated blind spots)', () => {
    const providers = new Set(DEFAULT_SLOTS.map(s => splitProviderModelId(s.model).provider));
    expect(providers.size).toBe(3);
  });
});

// #4636 — a single-provider install can never serve three distinct frontier
// defaults; unusable defaults substitute the configured chat model so the
// nightly probe reports provider reachability truthfully.
describe('cross-modal slot substitution for unavailable default providers (#4636)', () => {
  const NO_EXPLICIT = { A: undefined, B: undefined, C: undefined };

  afterEach(() => {
    resetGateway();
  });

  test('single-provider install: unusable frontier defaults fall back to the configured chat model', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'sk-test-openai-only' },
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(['openai:gpt-5.2', 'openai:gpt-5.2', 'openai:gpt-5.2']);
    expect(out.map(s => s.id)).toEqual(['A', 'B', 'C']);
  });

  test('explicit --slot-*-model overrides always win, even when their provider has no key', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'sk-test-openai-only' },
    });
    const slots = [
      { id: 'A', model: 'openai:gpt-5.2' },
      { id: 'B', model: 'anthropic:claude-opus-4-7' },
      { id: 'C', model: 'deepseek:deepseek-v4-pro' },
    ];
    const out = substituteUnavailableDefaultSlots(slots, {
      A: undefined, B: 'anthropic:claude-opus-4-7', C: undefined,
    });
    expect(out.map(s => s.model)).toEqual([
      'openai:gpt-5.2',
      'anthropic:claude-opus-4-7', // explicit — untouched
      'openai:gpt-5.2',
    ]);
  });

  test('all three default providers keyed: slots are untouched', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: {
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        DEEPSEEK_API_KEY: 'sk-ds-test',
      },
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });

  test('no usable configured chat model: defaults stay (existing error path owns messaging)', () => {
    configureGateway({
      chat_model: 'anthropic:claude-opus-4-7',
      env: {},
    });
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });

  test('gateway unconfigured: defaults stay', () => {
    resetGateway();
    const out = substituteUnavailableDefaultSlots([...DEFAULT_SLOTS], NO_EXPLICIT);
    expect(out.map(s => s.model)).toEqual(DEFAULT_SLOTS.map(s => s.model));
  });
});

// #3491 (the #4338 approach): the judge prompt pins the exact "scores" keys.
// The pre-fix "dim_1_name" placeholder let each judge invent its own
// spelling/casing, splitting one dimension into per-model singletons at
// aggregation; aggregate.ts's trim+lowercase normalization is the backstop.
describe('cross-modal judge-key pinning', () => {
  test('dimensionScoreKey takes the label before the em-dash', () => {
    expect(dimensionScoreKey('GOAL_ACHIEVEMENT — Does it work?')).toBe('GOAL_ACHIEVEMENT');
    expect(dimensionScoreKey('  custom dimension without separator ')).toBe(
      'custom dimension without separator',
    );
  });

  test('buildPrompt enumerates every dimension key verbatim (no placeholder)', () => {
    const prompt = buildPrompt('task', DEFAULT_DIMENSIONS, 'output');
    for (const dim of DEFAULT_DIMENSIONS) {
      expect(prompt).toContain(`"${dimensionScoreKey(dim)}": { "score": N, "feedback": "..." },`);
    }
    expect(prompt).not.toContain('dim_1_name');
    expect(prompt).toContain('using EXACTLY these keys under "scores"');
  });
});
