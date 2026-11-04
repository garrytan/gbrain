/**
 * The AI gateway configuration of an engine `openEngine` opened, built from `settings.ai` and `settings.embedding`
 * alone: no `process.env` key, no `~/.gbrain/config.json` and no process-wide gateway reaches it. The gateway
 * (gateway.ts) reads it for every call that runs in that engine's scope (engine-scope.ts).
 */
import { createHash } from 'node:crypto';
import { opError } from '../ops/contract.ts';
import { embeddedSettingsRecord, releasedEngineKeys, type EngineAISettings, type EngineSettings } from '../embedded-engine.ts';

type EngineAIProvider = EngineAISettings['providers'][string];
import { embeddedEngineInScope, unscopedInEmbeddedProcess } from '../engine-scope.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './defaults.ts';
import { getRecipe } from './recipes/index.ts';
import type { AIGatewayConfig, Recipe } from './types.ts';
import { dropQueryEmbeddingsTagged } from './query-embed-cache.ts';

/** Each native SDK reads its base URL from this env name when it is not given one, so an engine always gives one. */
const NATIVE_BASE_URL: Partial<Record<Recipe['implementation'], { env: string; url: string }>> = {
  'native-openai': { env: 'OPENAI_BASE_URL', url: 'https://api.openai.com/v1' },
  'native-anthropic': { env: 'ANTHROPIC_BASE_URL', url: 'https://api.anthropic.com/v1' },
  'native-google': { env: 'GOOGLE_GENERATIVE_AI_BASE_URL', url: 'https://generativelanguage.googleapis.com/v1beta' },
};

/** The env name the gateway reads a recipe's API key from; undefined for a recipe that takes none. */
export function recipeKeyEnv(recipe: Recipe): string | undefined {
  return recipe.auth_env?.required[0] ?? recipe.auth_env?.optional?.find(name => !/_(BASE_)?URL$/.test(name));
}

/**
 * Why `id` cannot be an engine provider, or null when it can. The local Claude CLI runs under this process's own
 * login, and Azure OpenAI reads its endpoint and deployment from the environment, so neither takes its settings
 * as values.
 */
export function engineProviderProblem(id: string): string | null {
  const recipe = getRecipe(id);
  if (!recipe) return `${id} is not a known provider.`;
  if (recipe.implementation === 'claude-cli') return `${id} runs the local Claude CLI under this process's login, so an engine cannot use it.`;
  if (recipe.resolveOpenAICompatConfig) return `${id} reads its endpoint from the environment, so an engine cannot use it yet.`;
  return null;
}

/** The gateway env entries a provider fills: its key and, for a native SDK, its endpoint. */
function providerEnv(id: string, provider: EngineAIProvider): [string, string][] {
  const recipe = getRecipe(id)!;
  const keyEnv = recipeKeyEnv(recipe);
  const native = NATIVE_BASE_URL[recipe.implementation];
  return [...(provider.apiKey && keyEnv ? [[keyEnv, provider.apiKey] as [string, string]] : []), ...(native ? [[native.env, provider.baseUrl ?? native.url] as [string, string]] : [])];
}

/** Why two providers cannot share this engine (they read one env entry with different values), or null. Names no value. */
export function sharedProviderEnvConflict(providers: Record<string, EngineAIProvider>): string | null {
  const owners = new Map<string, [string, string]>();
  for (const [id, provider] of Object.entries(providers)) {
    for (const [name, value] of providerEnv(id, provider)) {
      const prior = owners.get(name);
      if (prior && prior[1] !== value) return `${prior[0]} and ${id} both read ${name}, so they take the same ${name.endsWith('_URL') ? 'baseUrl' : 'apiKey'}.`;
      owners.set(name, [id, value]);
    }
  }
  return null;
}

/** The gateway config and the providers an engine's calls may reach. Keys live only in `config.env`. */
export function engineGatewayInput(settings: EngineSettings): { config: AIGatewayConfig; providers: ReadonlySet<string> } {
  const env: Record<string, string> = {};
  const base_urls: Record<string, string> = {};
  const providers = settings.ai?.providers ?? {};
  for (const [id, provider] of Object.entries(providers)) {
    for (const [name, value] of providerEnv(id, provider)) env[name] = value;
    if (provider.baseUrl && !NATIVE_BASE_URL[getRecipe(id)!.implementation]) base_urls[id] = provider.baseUrl;
  }
  const models = settings.ai?.models ?? {};
  return {
    providers: new Set(Object.keys(providers)),
    config: {
      embedding_model: settings.embedding?.model ?? DEFAULT_EMBEDDING_MODEL,
      embedding_identity_unverified: false,
      embedding_dimensions: settings.embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
      expansion_model: models.expansion,
      chat_model: models.chat,
      reranker_model: models.reranker,
      base_urls,
      env,
    },
  };
}

/**
 * The config a gateway call uses, the clients built from it and what its calls taught the gateway. `providers` is set
 * only on an embedded engine's state; the process keeps its own (gateway.ts), so one engine's lessons never reach another.
 */
export interface GatewayState {
  config: AIGatewayConfig | null; modelCache: Map<string, any>; providers?: ReadonlySet<string>; cacheTag: string;
  /** Batch shrink-on-miss factor by recipe id (gateway.ts effectiveSafetyFactor). */
  shrink: Map<string, { factor: number; consecutiveSuccesses: number }>;
  /** Reranker models whose missing key already wrote its one no_key audit row. */
  noKeyNoticed: Set<string>;
  /** Recipes that rejected json_schema at call time, so their structured calls go straight to the text path. */
  structuredOutputRejected: Set<string>;
}

/** A gateway state that has learned nothing yet. */
export function freshGatewayState(config: AIGatewayConfig | null, cacheTag: string, providers?: ReadonlySet<string>): GatewayState {
  return { config, modelCache: new Map(), ...(providers ? { providers } : {}), cacheTag, shrink: new Map(), noKeyNoticed: new Set(), structuredOutputRejected: new Set() };
}

/** Keyed by the settings the engine holds, so a disconnect (which drops them) drops the state; see releasedKeyEnv. */
const states = new WeakMap<EngineSettings, GatewayState>();
const CLOSED = {} as EngineSettings;

/**
 * The state of the embedded engine the current call runs for (its page transactions, views and proxies share it), or
 * undefined outside one. `normalize` is the gateway's own config defaults. A disconnected engine has no providers.
 */
export function scopedGatewayState(normalize: (config: AIGatewayConfig) => AIGatewayConfig): GatewayState | undefined {
  const engine = embeddedEngineInScope();
  if (!engine) return undefined;
  const settings = embeddedSettingsRecord(engine) ?? CLOSED;
  let state = states.get(settings);
  if (!state) {
    const { config, providers } = engineGatewayInput(settings);
    state = freshGatewayState(normalize(config), queryCacheTag(settings), providers);
    states.set(settings, state);
  }
  return state;
}

/**
 * The query-embedding cache tag: unique to this engine object, or, with `settings.cache_namespace`, the namespace plus
 * the provider-configuration generation (provider ids, base URLs and a fingerprint of each key; the key itself never
 * enters the tag), so a reopened brain hits and a replaced key or endpoint starts cold.
 */
function queryCacheTag(settings: EngineSettings): string {
  if (!settings.cache_namespace) return `engine:${crypto.randomUUID()}:`;
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const generation = Object.entries(settings.ai?.providers ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, provider]) => [id, provider.baseUrl ?? '', provider.apiKey ? sha(provider.apiKey) : '']);
  return `ns:${sha(JSON.stringify([settings.cache_namespace, generation]))}:`;
}

/** At an embedded engine's close, before its settings go: drop the query embeddings it cached, unless a namespace keeps them for its next open. */
export function releaseEngineGatewayState(engine: object): void {
  const settings = embeddedSettingsRecord(engine);
  const state = settings && states.get(settings);
  if (state && !settings.cache_namespace) dropQueryEmbeddingsTagged(state.cacheTag);
}

/** Provider keys of a disconnected engine in scope, as env entries, so a call still in flight scrubs them from its error. */
export function releasedKeyEnv(): Record<string, string> {
  const engine = embeddedEngineInScope();
  return Object.fromEntries((engine ? releasedEngineKeys(engine) : []).map((value, i) => [`RELEASED_${i}_API_KEY`, value]));
}

/**
 * The refusal for an AI call that entered no scope in a process holding open embedded engines. It decides by scope
 * presence alone: a process gateway the host configured never opens it.
 */
export function engineScopeRequired(): Error {
  return opError('engine_scope_required', 'An AI call ran outside any engine scope in a process that holds engines opened from settings.',
    'Its brain is unknown, so no process.env key, ~/.gbrain/config.json or process gateway is used and nothing was sent. Run it inside withEngineScope(engine, fn) for the engine it belongs to, or withLocalScope(fn) for a call that belongs to the process gateway.');
}

/** Every gateway AI call starts here: with no scope in a process holding open embedded engines it refuses `engine_scope_required`. */
export function refuseUnscoped(): void {
  if (unscopedInEmbeddedProcess()) throw engineScopeRequired();
}

/** In an embedded engine's scope, its settings.ai.models.reranker; search uses it in place of the mode bundle's default. */
export function engineRerankerModel(): string | undefined {
  const engine = embeddedEngineInScope();
  return engine ? embeddedSettingsRecord(engine)?.ai?.models?.reranker : undefined;
}

/** The refusal for a call whose provider the engine was not given. Names the provider and touchpoint, never a key. */
export function engineScopeMissing(provider: string, touchpoint: string): Error {
  return opError('engine_scope_missing', `This engine has no AI provider ${provider} for ${touchpoint}.`,
    `An engine opened from settings calls only the providers in settings.ai.providers, never a process.env key, ~/.gbrain/config.json or the process-wide gateway, so nothing was sent. Pass settings.ai.providers.${provider} (apiKey, and baseUrl when it is not the default) to openEngine, or point settings.ai.models (or settings.embedding) at a provider the engine has.`);
}
