/**
 * `cloud_mirror` cycle phase: one incremental HydraDB mirror run
 * (src/core/hydradb-mirror.ts), so autopilot keeps a connected brain's cloud
 * copy current. Skipped unless `gbrain cloud connect` ran. It runs before
 * `purge` so soft-deletes reach the cloud inside the 72h recovery window, and
 * never fails the cycle: an unreachable cloud reports `warn` and the mirror
 * cursor stays where it was.
 */
import type { BrainEngine } from '../engine.ts';
import { shellQuote } from '../agent-output.ts';
import type { PhaseResult } from '../cycle.ts';
import { resolveHydraConnection } from '../hydradb.ts';
import { mirrorBrain } from '../hydradb-mirror.ts';

export async function runPhaseCloudMirror(engine: BrainEngine | null, opts: { dryRun: boolean; signal?: AbortSignal }): Promise<PhaseResult> {
  const base = { phase: 'cloud_mirror' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  const conn = await resolveHydraConnection(engine);
  if (!conn) return { ...base, status: 'skipped', summary: 'cloud memory is off (gbrain cloud connect)', details: { reason: 'not_configured' } };
  if (opts.dryRun) return { ...base, status: 'skipped', summary: 'dry run: nothing mirrored', details: { reason: 'dry_run' } };
  try {
    const r = await mirrorBrain(engine, conn, { signal: opts.signal });
    return { ...base, status: 'ok', summary: `${r.upserted} page(s) mirrored to HydraDB, ${r.removed} removed`, details: { ...r, database: conn.database } };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { ...base, status: 'warn', summary: `HydraDB mirror deferred: ${(e as Error).message}`, details: { reason: 'mirror_failed', fix: shellQuote(['gbrain', 'cloud', 'status']) } };
  }
}
