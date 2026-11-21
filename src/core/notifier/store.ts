/**
 * GBRA-133 PR 2a: the commit notifier's durable state (migration v262).
 *
 * - Wanted markers (`sync_wanted_markers`): one row per source and intent class.
 *   `freshness` asks for the checkout's HEAD to become searchable (never pulls);
 *   `pull` asks for an upstream pull; `full` for a full walk. Explicit intents
 *   never coalesce into freshness: each class is its own row. Every upsert bumps
 *   `generation` and keeps `first_due_at`; a drainer deletes a row only WHERE
 *   generation equals the value it read, so a request that lands while the
 *   drainer's run is going survives it and starts one more run.
 * - The notifier lease (`sync_notifier_leases`): one owner per host. A claim
 *   succeeds when the row is free, expired or already ours; a takeover bumps
 *   the fencing token, which the owner re-checks before each start.
 * - Per-source notifier state and coverage (`sync_notifier_sources`): due /
 *   running / retry (next_retry_at) / operator_blocked, first_due_at kept until
 *   verified convergence, the last error with its trace file, the classic
 *   syncer host, and the observation the freshness notice reads.
 *
 * Callers on a brain whose schema predates v262 catch `missingTable` and treat
 * it as "no markers, nothing monitored".
 */
import type { BrainEngine } from '../engine.ts';
import { hostIdFor } from '../persistence/identity.ts';
import type { Coverage, MarkerIntent, NotifierLeaseClaim, NotifierLeaseClaimInput, NotifierLeaseHolder, NotifierSourceRow, StatePatch, WantedMarker, WantedMarkerInput } from '../engine-sql/notifier.ts';

export type { Coverage, DetectionMode, NotifierSourceRow, NotifierState, StatePatch } from '../engine-sql/notifier.ts';

export { MARKER_INTENTS } from '../engine-sql/notifier.ts';
export type { MarkerIntent, MarkerRequester, WantedMarker } from '../engine-sql/notifier.ts';

/** True when the error says a v262 table does not exist yet (a brain mid-upgrade). */
export function missingTable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === '42P01' || /relation "sync_(wanted_markers|notifier_leases|notifier_sources)" does not exist/.test(String(e?.message ?? ''));
}

// ── Wanted markers ───────────────────────────────────────────────────────────

/**
 * Records (or re-records) what a source should reach. A re-record keeps first_due_at (unless the source was re-created)
 * and bumps generation; `wanted_head` takes the newer value (null: whatever the checkout or upstream holds at run time).
 */
export async function upsertMarker(engine: Pick<BrainEngine, 'upsertWantedMarker'>, m: WantedMarkerInput): Promise<WantedMarker> {
  const marker = await engine.upsertWantedMarker(m);
  if (!marker) throw new Error(`source ${m.sourceId} does not exist; no wanted marker recorded`);
  return marker;
}

/** Names the queued job that will drain a marker, only while the marker is still the generation the submitter wrote. */
export async function attachMarkerJob(engine: Pick<BrainEngine, 'attachWantedMarkerJob'>, sourceId: string, intent: MarkerIntent, generation: number, jobId: number): Promise<void> {
  await engine.attachWantedMarkerJob(sourceId, intent, generation, jobId);
}

export async function readMarkers(engine: Pick<BrainEngine, 'readWantedMarkers'>, sourceIds?: string[]): Promise<WantedMarker[]> {
  return engine.readWantedMarkers(sourceIds ?? null);
}

/**
 * Markers that still ask for work: every pull/full marker, and a freshness marker whose wanted_head differs from the
 * source's last_commit (a null wanted_head is due until a run drains it). No ancestry assumption.
 */
export async function readDueMarkers(engine: Pick<BrainEngine, 'readDueWantedMarkers'>, sourceIds?: string[]): Promise<WantedMarker[]> {
  return engine.readDueWantedMarkers(sourceIds ?? null);
}

/**
 * Deletes freshness and pull markers that name a head the source already reached (a CLI sync, a refresh or another
 * resident got there first). State-based, so a newer request naming a newer head is never matched.
 */
export async function pruneSatisfiedMarkers(engine: Pick<BrainEngine, 'pruneSatisfiedWantedMarkers'>, sourceIds: string[]): Promise<void> {
  await engine.pruneSatisfiedWantedMarkers(sourceIds);
}

/** Deletes the marker only when nobody re-recorded it since `generation` was read. */
export async function clearMarker(engine: Pick<BrainEngine, 'clearWantedMarker'>, sourceId: string, intent: MarkerIntent, generation: number): Promise<boolean> {
  return engine.clearWantedMarker(sourceId, intent, generation);
}

/**
 * After a completed run: clears every marker of the source the run satisfied, generation-checked against `read` (the
 * rows the drainer read before it started), and returns the markers that are still due afterwards.
 *  - freshness clears when last_commit equals its wanted_head (or the marker named no head), or when the drainer saw
 *    the checkout's HEAD equal last_commit after the run (`checkoutHead`): nothing is left to import, whatever head
 *    the marker named (#7941: a head the source had passed kept every later run queuing a follow-up);
 *  - pull clears when the run pulled (`pulled`), full when the run was a full walk (`full`).
 */
export async function settleMarkers(engine: Pick<BrainEngine, 'settleFreshnessMarker' | 'clearWantedMarker' | 'readDueWantedMarkers'>, sourceId: string, read: WantedMarker[], run: { pulled: boolean; full: boolean; checkoutHead?: string | null }): Promise<WantedMarker[]> {
  for (const m of read) {
    if (m.source_id !== sourceId) continue;
    if (m.intent === 'pull' && !run.pulled) continue;
    if (m.intent === 'full' && !run.full) continue;
    if (m.intent === 'freshness') {
      await engine.settleFreshnessMarker(sourceId, m.generation, run.checkoutHead ?? null);
      continue;
    }
    await clearMarker(engine, sourceId, m.intent, m.generation);
  }
  return readDueMarkers(engine, [sourceId]);
}

// ── Notifier lease ───────────────────────────────────────────────────────────

export type LeaseHolder = NotifierLeaseHolder;

/** Claims or renews the host's notifier lease: the fencing token when this resident owns it, else the current holder. */
export async function claimLease(engine: Pick<BrainEngine, 'claimNotifierLease'>, l: NotifierLeaseClaimInput): Promise<NotifierLeaseClaim> {
  return engine.claimNotifierLease(l);
}

export async function readLease(engine: Pick<BrainEngine, 'readNotifierLease'>, hostId: string): Promise<LeaseHolder | null> {
  return engine.readNotifierLease(hostId);
}

/** The fencing check before a start: still the owner, with the token this resident claimed, and unexpired. */
export async function holdsLease(engine: Pick<BrainEngine, 'holdsNotifierLease'>, hostId: string, ownerId: string, fence: number): Promise<boolean> {
  return engine.holdsNotifierLease(hostId, ownerId, fence);
}

/** Releases the lease only while this resident still holds it, so a clean stop hands over at once. */
export async function releaseLease(engine: Pick<BrainEngine, 'releaseNotifierLease'>, hostId: string, ownerId: string): Promise<void> {
  await engine.releaseNotifierLease(hostId, ownerId);
}

// ── Per-source state and coverage ────────────────────────────────────────────

export async function readNotifierSources(engine: Pick<BrainEngine, 'readNotifierSources'>, sourceIds?: string[]): Promise<NotifierSourceRow[]> {
  return engine.readNotifierSources(sourceIds ?? null);
}

/** One write per transition, never per poll. */
export async function writeState(engine: Pick<BrainEngine, 'writeNotifierState'>, sourceId: string, p: StatePatch): Promise<void> {
  await engine.writeNotifierState(sourceId, p);
}

/** The coverage record, written when HEAD, mode or owner changed (the notifier compares before calling). */
export async function writeCoverage(engine: Pick<BrainEngine, 'writeNotifierCoverage'>, sourceId: string, c: Coverage): Promise<void> {
  await engine.writeNotifierCoverage(sourceId, c);
}

/** Records the host that advanced a classic source's last_commit; a no-op write when it did not change. */
export async function recordSyncerHost(engine: Pick<BrainEngine, 'recordNotifierSyncerHost'>, sourceId: string, hostId: string): Promise<void> {
  await engine.recordNotifierSyncerHost(sourceId, hostId);
}

/**
 * Called where a sync advances a source's last_commit (sync-anchor.ts writeSyncAnchor): records this host as the
 * source's syncer, so this host's resident notifier watches it, and clears the markers that head satisfies. Best effort: a sync never fails on it.
 */
export async function recordLocalSyncer(engine: Pick<BrainEngine, 'recordNotifierSyncerHost' | 'pruneSatisfiedWantedMarkers'>, sourceId: string): Promise<void> {
  try { await recordSyncerHost(engine, sourceId, hostIdFor(engine)); } catch { /* the notifier reports the source as unrecorded */ }
  // The CLI's re-check (GBRA-133 PR 2a.3): a run that reached a marker's head clears it, whoever ran it.
  try { await pruneSatisfiedMarkers(engine, [sourceId]); } catch { /* the residents' marker scan prunes it */ }
}
