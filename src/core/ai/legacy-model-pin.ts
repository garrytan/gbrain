/** Legacy DB model pins are defaults, below models.* and explicit env/file pins. */
import type { GBrainConfig } from '../config.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import { providerKeyReady, resolveModelDetailed, type EffectiveModelSource } from '../model-config.ts';
import { mergedProviderEnv } from './provider-env.ts';

export async function readLegacyModelPin(
  reader: ConfigReader | null,
  key: 'chat_model' | 'expansion_model',
  effective: { source: EffectiveModelSource } | null,
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  // Never consult gateway state: it contains fabricated defaults and can still
  // contain the previous worker job's resolved model. An unservable explicit
  // file/env pin must keep its existing fallback, not expose a shadowed DB row.
  if (!reader || effective?.source !== 'tier_default' || fileCfg?.[key] !== undefined) return null;
  const raw = await reader.getConfig(key);
  if (!raw?.trim()) return null;
  const resolved = await resolveModelDetailed(reader, { configKey: key, fallback: raw });
  if (providerKeyReady(resolved.model, mergedProviderEnv(fileCfg, env))) return resolved.model;
  process.stderr.write(`[models] DB-plane ${key} has no usable provider key or provider prefix; falling back to the key-aware default. Set models.${key === 'chat_model' ? 'chat' : 'expansion'} or unset ${key}.\n`);
  return null;
}
