/**
 * The retention purge's bookkeeping statements as typed members (persistence/derived-origin-hold.ts releaseStaleHolds,
 * readOwedPurges, pruneOwedPurges and pruneDerivedOriginParks; persistence/purge-parks.ts prunePurgeParks,
 * recordPurgeFailure, clearPurgePark and notePurgeSourceWriter; persistence/purge-deleted.ts selectPurgeCandidates;
 * repair/origin-carry.ts expiringOrigins). Each ran through `executeRaw` in its caller; the text is unchanged
 * (persistence/retention-purge-sql.ts, pinned in test/engine-sql-caller-raw-sql-pins.test.ts), and the Rust store
 * serves the same members (src/core/rust-engine/store-members/retention-purge.ts).
 *
 * The records are `op_checkpoints` rows: the derived-origin park (op `derived-origin-park`) and owed-purge record
 * (op `owed-page-purge`) keyed by page id, and the managed purge's failure park (op `purge-deleted-park`) keyed by
 * `[source, slug, deleted_us]`. Every function runs on the engine (or transaction) it is given, so inside a purge
 * transaction the write is part of it.
 *
 * `listExpiringOriginPages` reads the privacy rules (`privacyPartSql`), which follow the process's alias-honoring
 * setting (`readHonorAliases`): the caller reads it first, as before.
 */
import type { BrainEngine } from '../engine.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import {
  CLEAR_PURGE_PARK_SQL, DROP_REARMED_PURGE_PARKS_SQL, MARK_PURGE_PARKS_INACTIVE_SQL, OWED_PURGES_SQL, PRUNE_ORIGIN_PARKS_SQL,
  PRUNE_OWED_PURGES_SQL, PRUNE_PURGE_PARKS_SQL, RECORD_PURGE_FAILURE_SQL, RELEASE_STALE_HOLDS_SQL, managedPurgeCandidatesSql,
  releasedPurgeOriginsSql,
} from '../persistence/retention-purge-sql.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The ops of the three record kinds; the members take them from their callers' constants. */
export type OriginParkOp = string;

/** One owed-purge record as stored (`completed_keys -> 0`): the source, the page id, its tombstone and the owner's request. */
export interface OwedPurgeRecord { source_id: string; page_id: number | string; deleted_us: string; request_id: string }

/** One managed purge candidate: an expired tombstone no hold keeps, with the cutoff and its tombstone time as text. */
export interface ManagedPurgeCandidate { id: number | string; source_id: string; slug: string; cutoff: string; deleted_us: string }

/** One parked origin a manual purge's preview counts as released. */
export interface ReleasedPurgeOrigin { slug: string; source_id: string; deleted_at: Date | string }

/** One soft-deleted origin page the carry judges. */
export interface ExpiringOrigin { id: number; source_id: string; slug: string }

/** The new fields a failure record takes (purge-parks.ts recordPurgeFailure). */
export interface PurgeFailureRow { op: string; key: string; first: string; code: string | null; reason: string; failedAt: string; version: string }

/** Drops the owner purge a park of `op` holds once its page's tombstone is not the one the hold was recorded for. */
export async function releaseStaleOriginParkHolds(exec: Raw, op: OriginParkOp): Promise<void> {
  await exec.executeRaw(RELEASE_STALE_HOLDS_SQL, [op]);
}

/** Every owed-purge record of `op` whose tombstone still exists as recorded, by fingerprint. */
export async function listOwedPurgeRecords(exec: Raw, op: string): Promise<Array<{ owed: OwedPurgeRecord | string }>> {
  return exec.executeRaw<{ owed: OwedPurgeRecord | string }>(OWED_PURGES_SQL, [op]);
}

/** Drops the owed-purge records of `op` whose tombstone was removed, restored or deleted again. */
export async function pruneOwedPurgeRecords(exec: Raw, op: string): Promise<void> {
  await exec.executeRaw(PRUNE_OWED_PURGES_SQL, [op]);
}

/** Drops the parks of `op` whose page was restored or purged. */
export async function pruneOriginParkRecords(exec: Raw, op: OriginParkOp): Promise<void> {
  await exec.executeRaw(PRUNE_ORIGIN_PARKS_SQL, [op]);
}

/** Drops the failure records of `op` whose tombstone was purged, restored or deleted again. */
export async function prunePurgeParkRecords(exec: Raw, op: string): Promise<void> {
  await exec.executeRaw(PRUNE_PURGE_PARKS_SQL, [op]);
}

/** Records one more failure of a tombstone (the first stores `first`, the `[park]` text; a repeat bumps `failures`). */
export async function recordPurgeFailureRecord(exec: Raw, row: PurgeFailureRow): Promise<void> {
  await exec.executeRaw(RECORD_PURGE_FAILURE_SQL, [row.op, row.key, row.first, row.code, row.reason, row.failedAt, row.version]);
}

/** Removes the failure record `key` of `op`. */
export async function deletePurgeParkRecord(exec: Raw, op: string, key: string): Promise<void> {
  await exec.executeRaw(CLEAR_PURGE_PARK_SQL, [op, key]);
}

/** Marks the failure records of `sourceId` seen while its writer was not active (`inactive_seen`), once each. */
export async function markPurgeParksInactive(exec: Raw, op: string, sourceId: string): Promise<void> {
  await exec.executeRaw(MARK_PURGE_PARKS_INACTIVE_SQL, [op, sourceId]);
}

/** Drops the failure records of `sourceId` marked while its writer was not active (the rearm), and how many it dropped. */
export async function dropRearmedPurgeParks(exec: Raw, op: string, sourceId: string): Promise<number> {
  return (await exec.executeRaw(DROP_REARMED_PURGE_PARKS_SQL, [op, sourceId])).length;
}

/** The parked origins among `release` (none of `excludeIds`) expired past `hours`, under the purge's other holds. */
export async function listReleasedPurgeOrigins(exec: Raw, release: readonly number[], excludeIds: readonly number[], hours: string): Promise<ReleasedPurgeOrigin[]> {
  return exec.executeRaw<ReleasedPurgeOrigin>(releasedPurgeOriginsSql(), [[...release], [...excludeIds], hours]);
}

/** The managed purge's candidates: expired past `hours`, no hold (with `release` lifting the origin hold), none of `hold`. */
export async function listManagedPurgeCandidates(exec: Raw, hours: string, release: readonly number[], hold: readonly number[]): Promise<ManagedPurgeCandidate[]> {
  return exec.executeRaw<ManagedPurgeCandidate>(managedPurgeCandidatesSql(), [hours, [...release], [...hold]]);
}

const bounded = { timeoutMs: 120_000, jitOff: true, prepare: false };

/** The soft-deleted privacy origins (an atom, or a page the privacy rules hide) expired past `hours`, by id. */
export async function listExpiringOriginPages(exec: Raw, hours: string): Promise<ExpiringOrigin[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - (${hours} || ' hours')::interval AND (p.type = 'atom' OR NOT ${trustedSql(privacyPartSql('p'))}) ORDER BY p.id`);
  const rows = await exec.executeRaw<{ id: number; source_id: string; slug: string }>(text, params, bounded);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug }));
}
