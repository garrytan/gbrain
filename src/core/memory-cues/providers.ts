import { chat, embed, getChatModel, configureGatewayIfUninitialized } from '../ai/gateway.ts';
import { canonicalLookup } from '../model-pricing.ts';
import type { BrainEngine } from '../engine.ts';
import type { MemoryCueProviders } from './types.ts';
import { loadConfigWithEngine } from '../config.ts';
import { parseTree } from 'jsonc-parser';
import { CUE_SYSTEM_PROMPT, formatCueEvidence, resolveCueEvidence } from './evidence.ts';
export { CUE_SYSTEM_PROMPT } from './evidence.ts';

export async function cueGenerationModel(engine: BrainEngine): Promise<string> {
  const value = (await loadConfigWithEngine(engine))?.chat_model;
  if (value) return value;
  configureGatewayIfUninitialized();
  return getChatModel();
}

export const liveMemoryCueProviders: MemoryCueProviders = {
  async generate({ evidence, includeBridge, model, signal }) {
    configureGatewayIfUninitialized();
    const formatted = formatCueEvidence(evidence, includeBridge);
    const response = await chat({ model, system: CUE_SYSTEM_PROMPT, maxTokens: 1200, temperature: 0,
      messages: [{ role: 'user', content: formatted.content }], abortSignal: signal });
    if (response.stopReason !== 'end') throw new Error(response.stopReason === 'refusal' ? 'provider_refusal' : 'incomplete_output');
    const price = canonicalLookup(response.model);
    if (!price || response.model !== model) throw new Error('generation_model_changed');
    const text = response.text.trim();
    const fence = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    const json = fence?.[1] ?? text;
    const parsed = JSON.parse(json);
    if (parseTree(json)?.children?.some(cue => cue.type === 'object' && cue.children?.length !== 4)) throw new Error('invalid_output');
    return { output: resolveCueEvidence(parsed, formatted.excerpts), actualUsd: (response.usage.input_tokens * price.input + response.usage.output_tokens * price.output
      + response.usage.cache_read_tokens * (price.cache_read ?? price.input) + response.usage.cache_creation_tokens * (price.cache_write ?? price.input * 2)) / 1e6 };
  },
  async embed(texts, column, signal) {
    configureGatewayIfUninitialized();
    return embed(texts, { embeddingModel: column.embeddingModel, dimensions: column.dimensions, inputType: 'document', maxRetries: 0, abortSignal: signal });
  },
};
