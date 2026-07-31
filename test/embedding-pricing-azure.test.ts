/**
 * Azure OpenAI embedding pricing — table coverage + recipe drift guard.
 *
 * Two separate failures are pinned here.
 *
 * 1. COVERAGE. `budget-tracker.ts:lookupPricing` returns null when a
 *    `provider:model` key is missing from EMBEDDING_PRICING, and its caller
 *    hard-throws `BudgetExhausted(reason:'no_pricing')`. Before these rows
 *    landed, the table had ZERO `azure-openai:` keys, so every
 *    `--max-cost`-bounded embed against an Azure OpenAI deployment failed
 *    outright — not mis-costed, failed. Any model the recipe advertises must
 *    have a price.
 *
 * 2. DRIFT. The recipe's `cost_per_1m_tokens_usd` used to be a literal
 *    `0.13` sitting a directory away from the table that owns embedding
 *    prices. CLAUDE.md's canonical-pricing invariant exists to make exactly
 *    that impossible: one table, every other surface derived. This asserts
 *    the recipe's number still equals what the table says, so a price
 *    correction can't leave the recipe quoting a stale figure.
 */

import { describe, test, expect } from 'bun:test';
import { EMBEDDING_PRICING, lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import {
  azureOpenAI,
  AZURE_OPENAI_EMBEDDING_MODELS,
  AZURE_OPENAI_EMBEDDING_COST_PER_MTOK,
} from '../src/core/ai/recipes/azure-openai.ts';

describe('EMBEDDING_PRICING — azure-openai coverage', () => {
  test('every model the recipe advertises has a pricing row', () => {
    for (const model of AZURE_OPENAI_EMBEDDING_MODELS) {
      const hit = lookupEmbeddingPrice(`azure-openai:${model}`);
      expect(hit.kind).toBe('known');
    }
  });

  test('text-embedding-3-small resolves (the model the Azure deployment uses)', () => {
    const hit = lookupEmbeddingPrice('azure-openai:text-embedding-3-small');
    expect(hit).toEqual({
      kind: 'known',
      pricePerMTok: 0.02,
      key: 'azure-openai:text-embedding-3-small',
    });
  });

  test('at OpenAI-list parity — azure rows match their openai siblings', () => {
    for (const model of AZURE_OPENAI_EMBEDDING_MODELS) {
      expect(EMBEDDING_PRICING[`azure-openai:${model}`]).toEqual(
        EMBEDDING_PRICING[`openai:${model}`]!,
      );
    }
  });

  test('an unregistered azure model still reports unknown (no silent $0)', () => {
    const hit = lookupEmbeddingPrice('azure-openai:text-embedding-9-imaginary');
    expect(hit.kind).toBe('unknown');
  });
});

describe('azure-openai recipe — pricing drift guard', () => {
  test('recipe cost_per_1m_tokens_usd is derived, not hand-copied', () => {
    expect(azureOpenAI.touchpoints.embedding?.cost_per_1m_tokens_usd).toBe(
      AZURE_OPENAI_EMBEDDING_COST_PER_MTOK,
    );
  });

  test('the derived figure is the MAX over advertised models (over-quote, never under)', () => {
    const prices = AZURE_OPENAI_EMBEDDING_MODELS.map(
      m => EMBEDDING_PRICING[`azure-openai:${m}`]!.pricePerMTok,
    );
    expect(AZURE_OPENAI_EMBEDDING_COST_PER_MTOK).toBe(Math.max(...prices));
    for (const p of prices) {
      expect(AZURE_OPENAI_EMBEDDING_COST_PER_MTOK).toBeGreaterThanOrEqual(p);
    }
  });

  test('recipe model list and the exported constant agree', () => {
    expect(azureOpenAI.touchpoints.embedding?.models).toEqual([
      ...AZURE_OPENAI_EMBEDDING_MODELS,
    ]);
  });
});
