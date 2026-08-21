import type { BrainEngine } from '../engine.ts';
import { NIGHTLY_PROBE_SEARCH_CONFIG_KEYS } from './nightly-quality-probe.ts';

export async function resolveNightlyProbeSearchConfigSnapshot(
  engine: BrainEngine,
): Promise<Record<string, string>> {
  try {
    const snapshot: Record<string, string> = {};
    for (const key of NIGHTLY_PROBE_SEARCH_CONFIG_KEYS) {
      const value = await engine.getConfig(key);
      if (value != null) snapshot[key] = value;
    }
    return snapshot;
  } catch (err) {
    throw new Error(
      `nightly-quality-probe: could not read live search config snapshot: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
