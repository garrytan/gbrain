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

const ALL: Recipe[] = [openai, google, anthropic, ollama, voyage, litellmProxy];

/** Map from `provider:id` key to recipe. */
export const RECIPES: Map<string, Recipe> = new Map(ALL.map(r => [r.id, r]));

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.get(id);
}

export function listRecipes(): Recipe[] {
  return [...ALL];
}
