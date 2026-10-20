/**
 * #6858 ask 3: the managed sync runs that are stopped, not draining. An unfinished cursor whose stop is recorded (a
 * `managed-sync-failure` row under its key) or whose pending page receipt ended without committing resumes nothing by
 * itself; doctor `managed_sync_blocked` and get_brain_health read it. An unfinished cursor waiting on a queued or
 * running request (`sync_incomplete`) is draining and not listed, and neither is a cursor saved after its recorded stop:
 * the failure row stays until the whole run finishes, so a resumed run that is moving again would otherwise still read
 * as blocked. A failure whose cursor is gone is an orphan (`gbrain repair managed-sync-orphans`), not a blocked run.
 * #6712 PR 4b (design v3.2 §3.7): a non-company source has a pass row instead; it is blocked while its passes keep
 * stopping (`passHealth`: the newest ended `blocked`, a `not_converged` streak, a `settle_mismatch` streak), with the
 * newest pass's stop reason as `code`, its pass id as `run_id` and `stuck_since` as `blocked_since`. A source listed by
 * its pass is not listed again by a legacy cursor.
 * GBRA-133 S-61: a pass that threw records its stop under a pass failure key (`passFailureKeys`) with no cursor, and its pass
 * row stays `open`, so neither rule above saw it: a discovery-phase stop (path `<discovery>`) or an entry's stop read as
 * nothing blocked while the source indexed nothing. Such a stop is listed while it is newer than the pass row (no pass has
 * started since; a converged or idle pass clears it).
 */
import type { BrainEngine } from '../engine.ts';
import { readManagedSyncFailures } from './sync-failures.ts';
import { passFingerprint } from './sync-pass-row.ts';
import { passFailureKeys } from './sync-cursor-key.ts';
import type { ManagedSyncFailure } from './sync-failures.ts';

/** A run blocked longer than this fails doctor `managed_sync_blocked` and turns get_brain_health to `attention`. */
export const MANAGED_SYNC_BLOCKED_FAIL_MS = 60 * 60_000;

export interface BlockedManagedSync { source_id: string; code: string; run_id: string; blocked_since: string }

export async function readBlockedManagedSyncs(engine: BrainEngine, sourceIds?: string[]): Promise<BlockedManagedSync[]> {
  const cursors = new Set((await engine.executeRaw<{ fingerprint: string }>(`
    SELECT c.fingerprint FROM op_checkpoints c LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND (f.updated_at IS NULL OR f.updated_at>=c.updated_at)`)).map(row => row.fingerprint));
  const { readPassReadings, passStopCode, passStuck, passStuckSince } = await import('./sync-pass-readers.ts');
  const failures = await readManagedSyncFailures(engine, sourceIds);
  // A pass blocked by a failed write names that write's code (its failure row is keyed by the pass fingerprint), as a cursor did.
  const passFailure = (sourceId: string, incarnation: string) => failures.find(failure => failure.cursor_key === passFingerprint(sourceId, incarnation) && failure.code !== 'sync_incomplete');
  const readings = await readPassReadings(engine, { sourceIds, head: false });
  const passes: BlockedManagedSync[] = readings.filter(reading => passStuck(reading.health))
    .map(reading => {
      const failure = passStopCode(reading) === 'blocked_by_failures' ? passFailure(reading.source_id, reading.row.value.incarnation) : undefined;
      return { source_id: reading.source_id, code: failure?.code ?? passStopCode(reading), run_id: reading.row.value.telemetry.pass_id, blocked_since: failure?.first_seen ?? passStuckSince(reading.row) };
    });
  const passSources = new Set(passes.map(blocked => blocked.source_id));
  const passRowAt = new Map(readings.map(reading => [reading.source_id, Date.parse(reading.row.updated_at)]));
  const passStops = (await engine.executeRaw<{ fingerprint: string; updated_at: string | Date; failure: ManagedSyncFailure }>(`
    SELECT f.fingerprint, f.updated_at, f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`, [sourceIds ?? null]))
    .filter(({ fingerprint, updated_at, failure }) => !passSources.has(failure.source_id) && failure.code !== 'sync_incomplete'
      && passFailureKeys(failure.source_id, failure.source_incarnation).includes(fingerprint) && new Date(updated_at).getTime() >= (passRowAt.get(failure.source_id) ?? 0))
    .map(({ failure }) => ({ source_id: failure.source_id, code: failure.code, run_id: failure.run_id, blocked_since: failure.first_seen }));
  return [...failures
    .filter(failure => failure.code !== 'sync_incomplete' && cursors.has(failure.cursor_key) && !passSources.has(failure.source_id))
    .map(failure => ({ source_id: failure.source_id, code: failure.code, run_id: failure.run_id, blocked_since: failure.first_seen })), ...passes, ...passStops];
}
