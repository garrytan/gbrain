/**
 * Provenance of the gateway's engine-resolved expansion and chat models.
 *
 * `reconfigureGatewayWithEngine` walks the resolution chain for both models
 * and records here which step won (`ResolveSource`, or `file_config` when
 * the servable config.json pin supplied it) plus a key-name origin. Each
 * record carries the model it describes; a getter answers only while the
 * gateway still routes to that model, so a later `configureGateway` with a
 * different model reads as unknown instead of inheriting stale provenance.
 */

import { describeResolveOrigin, type EffectiveModelSource, type ResolvedModel, type ResolveSource } from '../model-config.ts';

export type GatewayModelSourceKind = ResolveSource | 'file_config';

export interface GatewayModelSource {
  source: GatewayModelSourceKind;
  origin: string;
}

type GatewayTouchpoint = 'expansion' | 'chat';

const records = new Map<GatewayTouchpoint, GatewayModelSource & { model: string }>();

const RESOLUTION: Record<GatewayTouchpoint, { configKey: string; tier: 'utility' | 'reasoning'; pinKey: string; pinEnv: string }> = {
  expansion: { configKey: 'models.expansion', tier: 'utility', pinKey: 'expansion_model', pinEnv: 'GBRAIN_EXPANSION_MODEL' },
  chat: { configKey: 'models.chat', tier: 'reasoning', pinKey: 'chat_model', pinEnv: 'GBRAIN_CHAT_MODEL' },
};

/**
 * Provenance for one reconfigure resolution. `effective` is the file-plane
 * fallback result, present only when the engine chain fell through to a
 * default and the effective resolver picked the model instead. A file pin
 * that `loadConfig` folded in from `GBRAIN_EXPANSION_MODEL` /
 * `GBRAIN_CHAT_MODEL` is attributed to the env var.
 */
export function gatewayModelSource(
  touchpoint: GatewayTouchpoint,
  detailed: ResolvedModel,
  effective: { source: EffectiveModelSource } | null,
): GatewayModelSource {
  const r = RESOLUTION[touchpoint];
  if (!effective) {
    return { source: detailed.source, origin: describeResolveOrigin(detailed.source, { configKey: r.configKey, tier: r.tier }) };
  }
  if (effective.source === 'env_model') return { source: 'env', origin: 'GBRAIN_MODEL' };
  if (effective.source === 'file_pin') {
    return process.env[r.pinEnv]?.trim()
      ? { source: 'env', origin: r.pinEnv }
      : { source: 'file_config', origin: `${r.pinKey} (config.json)` };
  }
  return { source: 'tier_default', origin: 'built-in default' };
}

export function setGatewayModelSource(touchpoint: GatewayTouchpoint, model: string, source: GatewayModelSource): void {
  records.set(touchpoint, { model, ...source });
}

/** Provenance of `model` on `touchpoint`, or undefined when unrecorded or stale. */
export function getGatewayModelSource(touchpoint: GatewayTouchpoint, model: string): GatewayModelSource | undefined {
  const r = records.get(touchpoint);
  return r && r.model === model ? { source: r.source, origin: r.origin } : undefined;
}

export function clearGatewayModelSources(): void {
  records.clear();
}
