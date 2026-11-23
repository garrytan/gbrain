/**
 * The shadow status document: the one object `gbrain engine shadow status --json` prints and the engine swap reads
 * (src/core/engine-swap/readiness.ts `ShadowStatus` names the fields the swap uses; every other field is ignored).
 * One builder, so the swap never reads a second format.
 */
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { buildEligibilityStatus } from './eligibility.ts';
import { buildEvidenceStatus, type EvidenceStatus } from './evidence.ts';
import { readEpoch } from './evidence-epoch.ts';
import { buildFollowStatus } from './follow-status.ts';
import { readFaults, readShadowSummary } from './ledger.ts';
import { storageReport, type StorageReport } from './managed-gate.ts';
import { readSeedRecord, type SeedRecord } from './seed.ts';
import { readShadowState, shadowBrainKey, shadowDirFor, shadowStatePath } from './state.ts';

export type ShadowStatusDocument = Awaited<ReturnType<typeof shadowStatusDocument>>;

/**
 * Builds the status document for one shadow directory from the files the shadow writes. `engine` is the primary the
 * caller already holds open (the swap): only then does the document carry eligibility's writer fields, from one
 * read-only SELECT. Without it, or when that SELECT fails, they are left out and readiness reads them as missing.
 */
export async function shadowStatusDocument(brain: { key: string; dir: string }, now: Date = new Date(), engine?: BrainEngine) {
  const state = readShadowState(brain.dir);
  const summary = existsSync(brain.dir) ? readShadowSummary(brain.dir) : null;
  const faults = existsSync(brain.dir) ? readFaults(brain.dir, 5) : [];
  const totals: Record<string, number> = {};
  for (const counts of Object.values(summary?.by_op ?? {})) {
    for (const [outcome, n] of Object.entries(counts)) totals[outcome] = (totals[outcome] ?? 0) + (n ?? 0);
  }
  // The only awaited read comes first. The follower and evidence fields are then read back to back from one epoch: a
  // rotation between them (a new Rust candidate) retries, and an epoch that keeps moving leaves both out (NOT READY),
  // so criteria 1 and 7 can never pass on the previous candidate's checks.
  const eligibility = await buildEligibilityStatus({ dir: brain.dir, state, engine, now, stateRequired: true });
  const epochBound = (): { follow: ReturnType<typeof buildFollowStatus>; evidence: ReturnType<typeof buildEvidenceStatus> } | null => {
    for (let attempt = 0; attempt < EPOCH_READ_ATTEMPTS; attempt++) {
      const before = readEpoch(brain.dir)?.epoch_id ?? null;
      const follow = buildFollowStatus(brain.dir, state, now);
      const evidence = buildEvidenceStatus({ dir: brain.dir, now });
      const after = readEpoch(brain.dir)?.epoch_id ?? null;
      if (before === after && follow.epoch_id === after && (evidence.evidence?.epoch_id ?? null) === after) return { follow, evidence };
    }
    return null;
  };
  const bound = epochBound();
  return {
    schema_version: 1 as const, brain: brain.key, enabled: state?.enabled === true, state, directory: brain.dir,
    totals, by_op: summary?.by_op ?? {}, serving: summary?.primary ?? null, child_shed: summary?.child_shed ?? 0,
    children: summary?.children ?? 0, recent_faults: faults, storage: storageReport(state?.storage),
    ...(bound ? bound.follow : { ...buildFollowStatus(brain.dir, state, now), epoch_id: null, epoch_started_at: null }),
    ...(bound ? {} : { evidence_epoch_unstable: true as const }),
    seed: seedStatus(readSeedRecord(brain.dir)), // the seed block carries the recorded storage mode
    ...eligibility,
    ...(bound ? bound.evidence : ({} as EvidenceStatus)),
  };
}

/** How often the document re-reads the epoch-bound fields when the epoch rotates under it before it gives up. */
const EPOCH_READ_ATTEMPTS = 3;

/** The `seed` block of the status document: null fields until a seed finished. */
export function seedStatus(record: SeedRecord | null): {
  seed_id: string | null; finished_at: string | null; unseeded_gap_rows_total: number | null; storage: StorageReport | null;
} {
  return {
    seed_id: record?.seed_id ?? null, finished_at: record?.finished_at ?? null, unseeded_gap_rows_total: record?.unseeded_gap_rows_total ?? null,
    storage: storageReport(record?.storage),
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
  engine?: BrainEngine,
): Promise<ShadowStatusDocument | null> {
  const c = config();
  const key = c ? shadowBrainKey(c) : null;
  if (!key) return null;
  const dir = shadowDirFor(key);
  if (!existsSync(shadowStatePath(dir))) return null;
  return shadowStatusDocument({ key, dir }, now, engine);
}
