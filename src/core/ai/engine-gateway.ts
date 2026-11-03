/**
 * The AI gateway configuration of an engine `openEngine` opened, built from `settings.ai` and `settings.embedding`
 * alone: no `process.env` key, no `~/.gbrain/config.json` and no process-wide gateway reaches it. The gateway
 * (gateway.ts) reads it for every call that runs in that engine's scope (engine-scope.ts).
 */
import { opError } from '../ops/contract.ts';
import { embeddedSettingsRecord, type EngineSettings } from '../embedded-engine.ts';
import { embeddedEngineInScope } from '../engine-scope.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './defaults.ts';
import { getRecipe } from './recipes/index.ts';
import type { AIGatewayConfig, Recipe } from './types.ts';

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

/** The gateway config and the providers an engine's calls may reach. Keys live only in `config.env`. */
export function engineGatewayInput(settings: EngineSettings): { config: AIGatewayConfig; providers: ReadonlySet<string> } {
  const env: Record<string, string> = {};
  const base_urls: Record<string, string> = {};
  const providers = settings.ai?.providers ?? {};
  for (const [id, provider] of Object.entries(providers)) {
    const recipe = getRecipe(id)!;
    const keyEnv = recipeKeyEnv(recipe);
    if (provider.apiKey && keyEnv) env[keyEnv] = provider.apiKey;
    const native = NATIVE_BASE_URL[recipe.implementation];
    if (native) env[native.env] = provider.baseUrl ?? native.url;
    else if (provider.baseUrl) base_urls[id] = provider.baseUrl;
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

/** The config a gateway call uses and the clients built from it. `providers` is set only on an embedded engine's state. */
export interface GatewayState { config: AIGatewayConfig | null; modelCache: Map<string, any>; providers?: ReadonlySet<string>; cacheTag: string }

/** Keyed by the settings the engine holds, so a disconnect (which drops them) drops the state and its keys too. */
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
    state = { config: normalize(config), modelCache: new Map(), providers, cacheTag: `engine:${crypto.randomUUID()}:` };
    states.set(settings, state);
  }
  return state;
}

/** The refusal for a call whose provider the engine was not given. Names the provider and touchpoint, never a key. */
export function engineScopeMissing(provider: string, touchpoint: string): Error {
  return opError('engine_scope_missing', `This engine has no AI provider ${provider} for ${touchpoint}.`,
    `An engine opened from settings calls only the providers in settings.ai.providers, never a process.env key, ~/.gbrain/config.json or the process-wide gateway, so nothing was sent. Pass settings.ai.providers.${provider} (apiKey, and baseUrl when it is not the default) to openEngine, or point settings.ai.models (or settings.embedding) at a provider the engine has.`);
}
