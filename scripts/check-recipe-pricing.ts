#!/usr/bin/env bun
/**
 * X1 recipe pricing coverage guard (D22). Every model id a recipe lists in a
 * touchpoint (chat and expansion price as chat, embedding as embed, reranker
 * as rerank, decide as decide) must resolve to a price through the same
 * resolver the cost caps use (`isModelPriceable`), or be named in the
 * recipe's `unpriced_models`. A marker on a model that now prices, or that no
 * touchpoint lists, is stale and fails too. This is the class that hid the
 * DeepSeek S1: a recipe gained `deepseek-flash` while the table never did.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root). There the recipes come from
 * `<root>/recipes.json` (an array of `{ id, unpriced_models?, touchpoints }`);
 * prices still come from the real tables.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRecipes } from '../src/core/ai/recipes/index.ts';
import { isModelPriceable, type BudgetKind } from '../src/core/budget/reservation-cost.ts';

interface RecipeLike {
  id: string;
  unpriced_models?: string[];
  touchpoints: Record<string, { models?: string[] } | undefined>;
}

const KIND: Record<string, BudgetKind> = { chat: 'chat', expansion: 'chat', embedding: 'embed', reranker: 'rerank', decide: 'decide' };

const root = process.env.GBRAIN_GUARD_ROOT;
const recipes: RecipeLike[] = root
  ? JSON.parse(readFileSync(join(root, 'recipes.json'), 'utf8'))
  : listRecipes() as unknown as RecipeLike[];

const failures: string[] = [];
for (const recipe of recipes) {
  const marked = new Set(recipe.unpriced_models ?? []);
  const listed = new Set<string>();
  for (const [touchpoint, tp] of Object.entries(recipe.touchpoints)) {
    const kind = KIND[touchpoint];
    if (!kind) continue;
    for (const model of tp?.models ?? []) {
      listed.add(model);
      const priced = isModelPriceable(`${recipe.id}:${model}`, kind);
      if (!priced && !marked.has(model)) {
        failures.push(`${recipe.id}:${model} (${touchpoint}) has no price. Add a verified row (src/core/model-pricing.ts or src/core/embedding-pricing.ts) or name it in the recipe's unpriced_models.`);
      }
      if (priced && marked.has(model)) {
        failures.push(`${recipe.id}:${model} (${touchpoint}) is priced but still listed in unpriced_models; remove the stale marker.`);
      }
    }
  }
  for (const model of marked) {
    if (!listed.has(model)) failures.push(`${recipe.id}: unpriced_models names "${model}", which no touchpoint lists; remove the stale marker.`);
  }
}

if (failures.length > 0) {
  console.error(`check:recipe-pricing: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check:recipe-pricing: every recipe model is priced or marked unpriced (${recipes.length} recipes).`);
