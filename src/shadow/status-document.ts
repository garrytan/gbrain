/**
 * The shadow status document: the one object `gbrain engine shadow status --json` prints and the engine swap reads
 * (src/core/engine-swap/readiness.ts `ShadowStatus` names the fields the swap uses; every other field is ignored).
 * One builder, so the swap never reads a second format.
 */
import { existsSync } from 'node:fs';
import type { EngineConfig } from '../core/types.ts';
import { buildFollowStatus } from './follow-status.ts';
import { readFaults, readShadowSummary } from './ledger.ts';
import { readShadowState, shadowBrainKey, shadowDirFor, shadowStatePath } from './state.ts';

export type ShadowStatusDocument = ReturnType<typeof shadowStatusDocument>;

/** Builds the status document for one shadow directory from the files the shadow writes. */
export function shadowStatusDocument(brain: { key: string; dir: string }, now: Date = new Date()) {
  const state = readShadowState(brain.dir);
  const summary = existsSync(brain.dir) ? readShadowSummary(brain.dir) : null;
  const faults = existsSync(brain.dir) ? readFaults(brain.dir, 5) : [];
  const totals: Record<string, number> = {};
  for (const counts of Object.values(summary?.by_op ?? {})) {
    for (const [outcome, n] of Object.entries(counts)) totals[outcome] = (totals[outcome] ?? 0) + (n ?? 0);
  }
  return {
    schema_version: 1 as const, brain: brain.key, enabled: state?.enabled === true, state, directory: brain.dir,
    totals, by_op: summary?.by_op ?? {}, serving: summary?.primary ?? null, child_shed: summary?.child_shed ?? 0,
    children: summary?.children ?? 0, recent_faults: faults,
    ...buildFollowStatus(brain.dir, state, now),
  };
}

/**
 * The swap's reader: the status document of the configured brain's shadow, or null when no shadow was ever started
 * for it (no `state.json`), which the swap reports as `no_shadow`. A shadow that was stopped, or whose `state.json`
 * cannot be parsed, still has a document; its follower reads `stopped` and the criteria fail on that evidence.
 */
export async function readConfiguredShadowStatus(
  config: () => Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'> | null,
  now: Date = new Date(),
): Promise<ShadowStatusDocument | null> {
  const c = config();
  const key = c ? shadowBrainKey(c) : null;
  if (!key) return null;
  const dir = shadowDirFor(key);
  if (!existsSync(shadowStatePath(dir))) return null;
  return shadowStatusDocument({ key, dir }, now);
}
