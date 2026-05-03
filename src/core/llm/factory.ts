import { loadConfig, type GBrainConfig } from '../config.ts';
import type { LLMClient, LLMProviderName } from './types.ts';
import { AnthropicLLMClient } from './providers/anthropic.ts';
import { OpenAILLMClient } from './providers/openai.ts';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_ANTHROPIC_VERDICT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const DEFAULT_OPENAI_VERDICT_MODEL = 'gpt-4o-mini';

export interface LLMRuntimeConfig {
  provider: LLMProviderName;
  model: string;
  verdictModel: string;
  openaiMaxInflight: number;
}

export function getLLMRuntimeConfig(config: GBrainConfig | null = loadConfig()): LLMRuntimeConfig {
  const provider = (process.env.GBRAIN_LLM_PROVIDER ?? config?.llm_provider ?? 'openai').toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`GBRAIN_LLM_PROVIDER must be anthropic or openai; got ${provider}`);
  }
  const model = process.env.GBRAIN_LLM_MODEL
    ?? config?.llm_model
    ?? (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);
  const verdictModel = process.env.GBRAIN_LLM_VERDICT_MODEL
    ?? config?.llm_verdict_model
    ?? (provider === 'openai' ? DEFAULT_OPENAI_VERDICT_MODEL : DEFAULT_ANTHROPIC_VERDICT_MODEL);
  const openaiMaxInflight = Number(process.env.GBRAIN_OPENAI_MAX_INFLIGHT ?? config?.openai_max_inflight ?? '8');
  return { provider, model, verdictModel, openaiMaxInflight: Number.isFinite(openaiMaxInflight) ? Math.max(1, openaiMaxInflight) : 8 };
}

export function hasLLMApiKey(provider = getLLMRuntimeConfig().provider, config: GBrainConfig | null = loadConfig()): boolean {
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY || config?.openai_api_key);
  return Boolean(process.env.ANTHROPIC_API_KEY || config?.anthropic_api_key);
}

export function makeLLMClient(provider = getLLMRuntimeConfig().provider, config: GBrainConfig | null = loadConfig()): LLMClient {
  return provider === 'openai' ? OpenAILLMClient.fromConfig(config ?? undefined) : AnthropicLLMClient.fromConfig(config ?? undefined);
}

export function providerRateLeaseKey(provider = getLLMRuntimeConfig().provider): string {
  return provider === 'openai' ? 'openai:chat' : 'anthropic:messages';
}
