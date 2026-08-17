/**
 * Parse and validate `provider:model` strings against the recipe registry.
 */

import type { ParsedModelId, Recipe, TouchpointKind, ChatTouchpoint, EmbeddingTouchpoint, ExpansionTouchpoint, RerankerTouchpoint } from './types.ts';
import { getRecipe, RECIPES } from './recipes/index.ts';
import { AIConfigError } from './errors.ts';

/**
 * Split "openai:text-embedding-3-large" or "openai/text-embedding-3-large"
 * into { providerId, modelId }. Colon takes precedence so OpenRouter nested
 * ids like "openrouter:anthropic/claude-sonnet-4-6" route as
 * { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4-6' }.
 *
 * v0.41.21.0: slash form added so users typing `anthropic/claude-sonnet-4-6`
 * (the form OpenRouter recipes emit and CLI `--judge-model` accepts) reach
 * the gateway successfully. Pre-fix the colon-only check threw at every
 * gateway entry point (chat / embed / rerank), so a slash-form id passed
 * pricing checks via splitProviderModelId in `src/core/model-id.ts` and
 * then died here at the gateway resolver. Closes the end-to-end bug class.
 *
 * Bare names without ANY separator still throw — `claude-sonnet-4-6` alone
 * doesn't tell us which provider to route through.
 */
export function parseModelId(id: string): ParsedModelId {
  if (!id || typeof id !== 'string') {
    throw new AIConfigError(
      `Invalid model id: ${JSON.stringify(id)}`,
      'Expected format: provider:model (e.g. openai:text-embedding-3-large)',
    );
  }
  // Colon wins over slash (OpenRouter nested-id semantic).
  const colon = id.indexOf(':');
  let sepIdx: number;
  if (colon !== -1) {
    sepIdx = colon;
  } else {
    const slash = id.indexOf('/');
    if (slash === -1) {
      throw new AIConfigError(
        `Model id "${id}" is missing a provider prefix.`,
        'Use format provider:model (preferred) or provider/model, e.g. openai:text-embedding-3-large',
      );
    }
    sepIdx = slash;
  }
  const providerId = id.slice(0, sepIdx).trim().toLowerCase();
  const modelId = id.slice(sepIdx + 1).trim();
  if (!providerId || !modelId) {
    throw new AIConfigError(
      `Model id "${id}" has empty provider or model.`,
      'Use format provider:model, e.g. openai:text-embedding-3-large',
    );
  }
  return { providerId, modelId };
}

/**
 * Resolve a `provider:model` string to a Recipe + canonical modelId.
 * Honors `recipe.aliases` (Codex F-OV-5) so users can pass undated forms.
 * Throws AIConfigError if unknown provider.
 */
export function resolveRecipe(modelId: string): { parsed: ParsedModelId; recipe: Recipe } {
  const parsed = parseModelId(modelId);
  const recipe = getRecipe(parsed.providerId);
  if (!recipe) {
    throw new AIConfigError(
      `Unknown provider: "${parsed.providerId}"`,
      `Known providers: ${[...knownProviderIds()].join(', ')}. Add a new recipe at src/core/ai/recipes/.`,
    );
  }
  // Apply alias if the modelId matches an alias key. Canonical wins.
  const canonical = recipe.aliases?.[parsed.modelId];
  if (canonical) {
    return { parsed: { providerId: parsed.providerId, modelId: canonical }, recipe };
  }
  return { parsed, recipe };
}

type KnownTouchpointKey = 'embedding' | 'expansion' | 'chat' | 'reranker';

function getTouchpoint(recipe: Recipe, touchpoint: TouchpointKind): EmbeddingTouchpoint | ExpansionTouchpoint | ChatTouchpoint | RerankerTouchpoint | undefined {
  if (touchpoint === 'embedding' || touchpoint === 'expansion' || touchpoint === 'chat' || touchpoint === 'reranker') {
    return recipe.touchpoints[touchpoint as KnownTouchpointKey];
  }
  return undefined;
}

/**
 * Assert the resolved recipe actually offers the requested touchpoint.
 *
 * This checks the PROVIDER's capability (anthropic has no embeddings; voyage
 * has no chat), never the model id. Recipe `models:` arrays are informational
 * — defaults for `--model <provider>` shorthand, guard-test fixtures for the
 * repo's own hardcoded defaults, display in `gbrain providers list` — not a
 * runtime allowlist. Frontier models ship weekly; any id the user names goes
 * to the provider, and a nonexistent one surfaces as the provider's own
 * `model_not_found` at call time (`gbrain models doctor` probes the configured
 * models live for a pre-flight check).
 */
export function assertTouchpoint(
  recipe: Recipe,
  touchpoint: TouchpointKind,
  modelId: string,
): void {
  const tp = getTouchpoint(recipe, touchpoint);
  if (!tp) {
    throw new AIConfigError(
      `Provider "${recipe.id}" does not support touchpoint "${touchpoint}".`,
      touchpoint === 'embedding' && recipe.id === 'anthropic'
        ? 'Anthropic has no embedding model. Use openai or google for embeddings.'
        : touchpoint === 'chat' && (recipe.id === 'voyage' || recipe.id === 'ollama')
          ? `${recipe.name} is configured here only for embeddings. Use openai/anthropic/google/deepseek/groq/together for chat.`
          : undefined,
    );
  }
}

export function knownProviderIds(): string[] {
  return [...RECIPES.keys()];
}

/**
 * Native embedding width for `modelId` under `recipe`.
 *
 * Resolution: the recipe's `model_dims` entry for this model, else the
 * recipe-wide `default_dims`. Returns 0 when neither is known (the
 * user-provided-model recipes declare `default_dims: 0` to force an explicit
 * `--embedding-dimensions`), so callers keep their existing falsy checks.
 *
 * Accepts a bare model id (`bge-m3`) or a qualified one (`ollama:bge-m3`);
 * the provider prefix is stripped before lookup so call sites can pass
 * whichever they hold.
 *
 * Fixes #2051: a recipe-wide default silently picked 768 for every Ollama
 * model, so `init --embedding-model ollama:bge-m3` built a 768-wide column
 * for a model that emits 1024 and only failed at first insert.
 */
export function embeddingDimsForModel(
  recipe: Recipe,
  modelId: string | undefined,
): number {
  const tp = recipe.touchpoints.embedding;
  if (!tp) return 0;
  if (!modelId) return tp.default_dims ?? 0;
  // Strip a leading `provider:` so both forms resolve. Slash-form ids
  // (openrouter nested) are left intact — they're the model id.
  const colon = modelId.indexOf(':');
  const bare = colon === -1 ? modelId : modelId.slice(colon + 1);
  // #4123: fold BOTH sides — configured ids arrive cased (`ollama:Qwen3-Embed-8B`)
  // and user-editable recipe model_dims tables can carry cased keys too.
  // Exact match first (zero behavior change for today's all-lowercase
  // tables), then a case-insensitive scan. Without this, a cased id fell
  // through to default_dims and `gbrain init` built a wrong-width column.
  let declared = tp.model_dims?.[bare];
  if (typeof declared !== 'number' && tp.model_dims) {
    const bareFolded = bare.toLowerCase();
    for (const [k, v] of Object.entries(tp.model_dims)) {
      if (k.toLowerCase() === bareFolded) { declared = v; break; }
    }
  }
  if (typeof declared === 'number' && declared > 0) return declared;
  return tp.default_dims ?? 0;
}
