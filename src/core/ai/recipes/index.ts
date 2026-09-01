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
import { claudeCli } from './claude-cli.ts';
import { ollama } from './ollama.ts';
import { openrouter } from './openrouter.ts';
import { voyage } from './voyage.ts';
import { litellmProxy } from './litellm-proxy.ts';
import { deepseek } from './deepseek.ts';
import { groq } from './groq.ts';
import { together } from './together.ts';
import { llamaServer } from './llama-server.ts';
import { lmstudio } from './lmstudio.ts';
import { minimax } from './minimax.ts';
import { dashscope } from './dashscope.ts';
import { dashscopeRerank } from './dashscope-rerank.ts';
import { zhipu } from './zhipu.ts';
import { azureOpenAI } from './azure-openai.ts';
import { zeroentropyai } from './zeroentropyai.ts';
import { llamaServerReranker } from './llama-server-reranker.ts';
import { nan } from './nan.ts';
import { moonshot } from './moonshot.ts';
import { mistral } from './mistral.ts';
import { nvidia } from './nvidia.ts';
import { perplexity } from './perplexity.ts';

const ALL: Recipe[] = [
  openai,
  google,
  anthropic,
  claudeCli,
  ollama,
  openrouter,
  voyage,
  litellmProxy,
  deepseek,
  groq,
  together,
  llamaServer,
  llamaServerReranker,
  lmstudio,
  minimax,
  dashscope,
  dashscopeRerank,
  zhipu,
  azureOpenAI,
  zeroentropyai,
  nan,
  moonshot,
  mistral,
  nvidia,
  perplexity,
];

/** Map from `provider:id` key to recipe. */
export const RECIPES: Map<string, Recipe> = new Map(ALL.map(r => [r.id, r]));

/**
 * Test-only seam. Synthetic recipes appended to the registry so tests can
 * exercise registry-walking logic — notably gateway.ts's missing-batch-cap
 * startup warning — against a recipe that intentionally omits a field,
 * without editing the shipped `ALL` array. Every real embedding recipe now
 * declares a cap (token budget, `no_batch_cap`, or item cap), so a synthetic
 * cap-less recipe is the only way to cover the warn-fires path. Empty in
 * production (nothing in `src/` calls the setter); pass `[]` to reset.
 */
let _testRecipes: Recipe[] = [];
export function __setTestRecipesForTests(recipes: Recipe[]): void {
  _testRecipes = recipes;
}

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.get(id) ?? _testRecipes.find(r => r.id === id);
}

export function listRecipes(): Recipe[] {
  return _testRecipes.length > 0 ? [...ALL, ..._testRecipes] : [...ALL];
}
