import type { GBrainConfig } from '../config.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import { resolveEffectiveChatModel, resolveModelDetailed } from '../model-config.ts';
import { gatewayModelSource } from './gateway-model-sources.ts';
import { readLegacyModelPin } from './legacy-model-pin.ts';
import type { AIGatewayConfig } from './types.ts';

export const DEFAULT_CHAT_MODEL = 'anthropic:claude-sonnet-4-6';

/** Resolve the configured chat route without changing gateway state or contacting a provider. */
export async function resolveGatewayChatRoute(reader: ConfigReader | null, cfg: AIGatewayConfig,
  readFileConfig: () => GBrainConfig | null) {
  const fallback = cfg.chat_model ?? DEFAULT_CHAT_MODEL;
  const detailed = await resolveModelDetailed(reader, { configKey: 'models.chat', tier: 'reasoning', fallback });
  const env = cfg.env;
  let fileCfg: GBrainConfig | null = null;
  if (detailed.source === 'tier_default' || detailed.source === 'fallback') {
    try { fileCfg = readFileConfig(); } catch { fileCfg = null; }
  }
  const effective = detailed.source === 'tier_default' || detailed.source === 'fallback' ? resolveEffectiveChatModel(fileCfg, env) : null;
  const dbPin = await readLegacyModelPin(reader, 'chat_model', effective, fileCfg, env);
  const model = dbPin ?? effective?.model ?? detailed.model;
  return { model: model.includes(':') ? model : prefixWithProviderFrom(fallback, model),
    source: dbPin ? { source: 'config_key' as const, origin: 'chat_model' } : gatewayModelSource('chat', detailed, effective) };
}

/** Carry over the provider prefix from `original` when `bare` lacks one. */
export function prefixWithProviderFrom(original: string, bare: string): string {
  const colon = original.indexOf(':');
  if (colon === -1) return bare;
  return `${original.slice(0, colon)}:${bare}`;
}
