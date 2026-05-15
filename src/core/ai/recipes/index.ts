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

const ALL: Recipe[] = [
  openai,
  google,
  anthropic,
  ollama,
  voyage,
  litellmProxy,
  deepseek,
  groq,
  together,
  llamaServer,
  minimax,
  dashscope,
  zhipu,
  azureOpenAI,
];

/** Map from `provider:id` key to recipe. */
export const RECIPES: Map<string, Recipe> = new Map(ALL.map(r => [r.id, r]));

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.get(id);
}

export function listRecipes(): Recipe[] {
  return [...ALL];
}

export function defaultEmbeddingDims(recipe: Recipe, modelId: string): number {
  return recipe.touchpoints.embedding?.model_dims?.[modelId]
    ?? recipe.touchpoints.embedding?.default_dims
    ?? 0;
}
