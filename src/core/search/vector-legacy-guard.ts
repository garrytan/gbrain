/**
 * #5824 one-release rollback switch. When on, the vector statement keeps the
 * content-freshness guard inside the HNSW candidate CTE (the pre-fix shape,
 * which large Postgres brains plan as a sequential scan). Retired in the next
 * wave.
 *
 * Read from `GBRAIN_VECTOR_LEGACY_GUARD` (wins when set) or the config key
 * `search.vector_legacy_guard`, resolved once per engine by the caller that
 * builds search options, so the owning service (serve, autopilot, worker)
 * picks a change up on restart and the hot path never re-reads config.
 */
import type { GBrainConfig } from '../config.ts';
import { engineKey } from '../engine-key.ts';

export const VECTOR_LEGACY_GUARD_ENV = 'GBRAIN_VECTOR_LEGACY_GUARD';
export const VECTOR_LEGACY_GUARD_KEY = 'search.vector_legacy_guard';

export interface VectorLegacyGuardSetting {
  enabled: boolean;
  via: 'env' | 'config' | null;
}

function parseFlag(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return undefined;
}

/** What the setting says right now (doctor reports it; search uses the per-engine latch). */
export function readVectorLegacyGuard(cfg: Pick<GBrainConfig, 'search'> | null | undefined, env: NodeJS.ProcessEnv = process.env): VectorLegacyGuardSetting {
  const fromEnv = parseFlag(env[VECTOR_LEGACY_GUARD_ENV]);
  if (fromEnv !== undefined) return { enabled: fromEnv, via: 'env' };
  if (cfg?.search?.vector_legacy_guard === true) return { enabled: true, via: 'config' };
  return { enabled: false, via: null };
}

let resolved = new WeakMap<object, boolean>();
let logged = false;

/** The first call for an engine decides for that engine; logs once per process when the guard is active. */
export function resolveVectorLegacyGuard(engine: object, cfg: Pick<GBrainConfig, 'search'> | null | undefined): boolean {
  const key = engineKey(engine);
  const known = resolved.get(key);
  if (known !== undefined) return known;
  const setting = readVectorLegacyGuard(cfg);
  resolved.set(key, setting.enabled);
  if (setting.enabled && !logged) {
    logged = true;
    console.error(`[gbrain] vector legacy guard active (${setting.via === 'env' ? VECTOR_LEGACY_GUARD_ENV : VECTOR_LEGACY_GUARD_KEY}): `
      + 'vector search keeps the pre-#5824 freshness guard inside the HNSW candidate scan; remove it after upgrading.');
  }
  return setting.enabled;
}

/** @internal test seam */
export function _resetVectorLegacyGuardForTests(): void {
  resolved = new WeakMap();
  logged = false;
}
