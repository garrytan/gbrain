/**
 * Model Tier Resolver
 *
 * Maps abstract tiers (`smart`, `fast`, `embedding`) to concrete model IDs
 * per provider. Supports user overrides in config.
 */

import type { GBrainConfig } from '../../core/config.ts';

export type ModelTier = 'smart' | 'fast' | 'embedding';

export interface TierMapping {
  smart: string;
  fast: string;
  embedding: string;
}

export const DEFAULT_TIERS: Record<string, TierMapping> = {
  anthropic: {
    smart: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5',
    embedding: 'text-embedding-3-large',
  },
  openai: {
    smart: 'gpt-4o',
    fast: 'gpt-4o-mini',
    embedding: 'text-embedding-3-large',
  },
  deepseek: {
    smart: 'deepseek-chat',
    fast: 'deepseek-reasoner',
    embedding: 'bge-small-en-v1.5',
  },
};

/**
 * Resolve a concrete model ID for the given provider and tier.
 * Falls back to the OpenAI default if the provider is unknown.
 */
export function resolveModel(
  provider: string,
  tier: ModelTier,
  config: GBrainConfig,
): string {
  const overrideKey = `${tier}_model` as keyof GBrainConfig;
  const override = config[overrideKey] as string | undefined;
  if (override) return override;

  const mapping = DEFAULT_TIERS[provider];
  if (mapping) return mapping[tier];

  // Unknown provider — fall back to OpenAI defaults so the user can
  // still run if they supply explicit model names in config.
  return DEFAULT_TIERS.openai[tier];
}
