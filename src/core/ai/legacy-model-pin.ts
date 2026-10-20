/**
 * #6795: a DB-plane `chat_model` / `expansion_model` (`gbrain config set`)
 * is a default below every `models.*` key, `GBRAIN_MODEL` and an explicit
 * file or env pin. The gateway consults it only when its resolution fell to
 * the tier default with no pin, reading the same config snapshot, never gateway
 * state (which holds fabricated defaults and the previous job's model).
 */
import type { GBrainConfig } from '../config.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import { providerKeyReady, resolveModelDetailed, type EffectiveModelSource } from '../model-config.ts';
import { mergedProviderEnv } from './provider-env.ts';

const unservableWarned = new Set<string>();

export async function readLegacyModelPin(
  reader: ConfigReader | null,
  key: 'chat_model' | 'expansion_model',
  effective: { source: EffectiveModelSource } | null,
  fileCfg: GBrainConfig | null,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!reader || effective?.source !== 'tier_default' || fileCfg?.[key] !== undefined) return null;
  const raw = await reader.getConfig(key);
  if (!raw?.trim()) return null;
  const resolved = await resolveModelDetailed(reader, { configKey: key, fallback: raw });
  if (providerKeyReady(resolved.model, mergedProviderEnv(fileCfg, env))) return resolved.model;
  if (!unservableWarned.has(`${key}=${resolved.model}`)) {
    unservableWarned.add(`${key}=${resolved.model}`);
    process.stderr.write(`[models] DB-plane ${key} has no usable provider key or provider prefix; falling back to the key-aware default. Set the provider's key, or gbrain config unset ${key}.\n`);
  }
  return null;
}
