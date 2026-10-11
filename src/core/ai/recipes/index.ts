/**
 * Static recipe registry. Bun-compile-safe: every provider is a static import.
 *
 * Adding a new openai-compatible provider = add a file here + register below.
 * Adding a new native provider = ALSO wire the factory in gateway.ts.
 */

import type { Recipe } from '../types.ts';
import { openai } from './openai.ts';
import { google } from './google.ts';
import { anthropic } from './anthropic.ts';
import { ollama } from './ollama.ts';
import { openrouter } from './openrouter.ts';
import { voyage } from './voyage.ts';
import { litellmProxy } from './litellm-proxy.ts';
import { deepseek } from './deepseek.ts';
import { groq } from './groq.ts';
import { together } from './together.ts';
import { llamaServer } from './llama-server.ts';
import { minimax } from './minimax.ts';
import { dashscope } from './dashscope.ts';
import { zhipu } from './zhipu.ts';
import { azureOpenAI } from './azure-openai.ts';
import { zeroentropyai } from './zeroentropyai.ts';
import { llamaServerReranker } from './llama-server-reranker.ts';
import { mimo } from './mimo.ts';
import { customOpenAI } from './custom-openai.ts';

const ALL: Recipe[] = [
  openai,
  google,
  anthropic,
  ollama,
  openrouter,
  voyage,
  litellmProxy,
  deepseek,
  groq,
  together,
  llamaServer,
  llamaServerReranker,
  minimax,
  dashscope,
  zhipu,
  azureOpenAI,
  zeroentropyai,
  mimo,
  customOpenAI,
];

/** Map from `provider:id` key to recipe. */
export const RECIPES: Map<string, Recipe> = new Map(ALL.map(r => [r.id, r]));

export function getRecipe(id: string): Recipe | undefined {
  if (/^service-[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    return { ...customOpenAI, id, name: id, auth_env: { required: [], optional: [`PMBRAIN_${id.replace(/-/g, '_').toUpperCase()}_API_KEY`] } };
  }
  return RECIPES.get(id);
}

export function listRecipes(): Recipe[] {
  return [...ALL];
}
