/**
 * #6188: the Tier 3 fence-repair model. An explicit `models.fence_repair`
 * always runs (new and unpriced models included). Unset, it is the first
 * model the fence-repair eval measured as accurate enough
 * (`FENCE_REPAIR_MEASURED_MODELS`) whose provider key the brain has
 * (environment or config file; `env` replaces both, for tests), and none when
 * there is no such key, so model repair stays off (`no_measured_model`) until
 * the user picks a model.
 */
import type { BrainEngine } from '../engine.ts';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { mergedProviderEnv } from '../ai/provider-env.ts';
import { providerKeyReady, resolveModel, TIER_DEFAULTS } from '../model-config.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from './measured.ts';

export const FENCE_REPAIR_MODEL_KEY = 'models.fence_repair';

export async function resolveFenceRepairModelWithSource(engine: Pick<BrainEngine, 'getConfig'>, env?: Record<string, string | undefined>): Promise<{ model: string | null; source: 'config' | 'measured' }> {
  const explicit = await engine.getConfig(FENCE_REPAIR_MODEL_KEY).catch(() => null);
  if (explicit?.trim()) return { model: await resolveModel(engine, { configKey: FENCE_REPAIR_MODEL_KEY, tier: 'deep', fallback: TIER_DEFAULTS.deep }), source: 'config' };
  const keys = env ? Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !!e[1])) : mergedProviderEnv(fileConfig(), process.env);
  return { model: FENCE_REPAIR_MEASURED_MODELS.find(model => providerKeyReady(model, keys)) ?? null, source: 'measured' };
}

export async function resolveFenceRepairModel(engine: Pick<BrainEngine, 'getConfig'>, env?: Record<string, string | undefined>): Promise<string | null> {
  return (await resolveFenceRepairModelWithSource(engine, env)).model;
}

function fileConfig(): GBrainConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}
