import type { GBrainConfig } from '../config.ts';
import type { AIGatewayConfig } from './types.ts';

/** Build the process-local AI gateway config from PMBrain's canonical file config. */
export function buildGatewayConfig(config: GBrainConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (config.openai_api_key) envFromConfig.OPENAI_API_KEY = config.openai_api_key;
  if (config.custom_openai_api_key) envFromConfig.CUSTOM_OPENAI_API_KEY = config.custom_openai_api_key;
  if (config.mimo_api_key) envFromConfig.MIMO_API_KEY = config.mimo_api_key;
  if (config.zhipu_api_key) envFromConfig.ZHIPUAI_API_KEY = config.zhipu_api_key;
  if (config.deepseek_api_key) envFromConfig.DEEPSEEK_API_KEY = config.deepseek_api_key;
  if (config.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = config.anthropic_api_key;
  if (config.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = config.zeroentropy_api_key;

  const envBaseUrls: Record<string, string> = {};
  if (process.env.CUSTOM_OPENAI_BASE_URL) envBaseUrls['custom-openai'] = process.env.CUSTOM_OPENAI_BASE_URL;
  if (process.env.LLAMA_SERVER_BASE_URL) envBaseUrls['llama-server'] = process.env.LLAMA_SERVER_BASE_URL;
  if (process.env.LLAMA_SERVER_RERANKER_BASE_URL) envBaseUrls['llama-server-reranker'] = process.env.LLAMA_SERVER_RERANKER_BASE_URL;
  if (process.env.OLLAMA_BASE_URL) envBaseUrls.ollama = process.env.OLLAMA_BASE_URL;
  if (process.env.LMSTUDIO_BASE_URL) envBaseUrls.lmstudio = process.env.LMSTUDIO_BASE_URL;
  if (process.env.LITELLM_BASE_URL) envBaseUrls.litellm = process.env.LITELLM_BASE_URL;
  if (process.env.OPENROUTER_BASE_URL) envBaseUrls.openrouter = process.env.OPENROUTER_BASE_URL;

  return {
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    embedding_multimodal_model: config.embedding_multimodal_model,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: { ...envBaseUrls, ...(config.provider_base_urls ?? {}) },
    touchpoint_base_urls: config.provider_touchpoint_base_urls,
    touchpoint_api_keys: config.provider_touchpoint_api_keys,
    env: { ...envFromConfig, ...process.env },
  };
}
