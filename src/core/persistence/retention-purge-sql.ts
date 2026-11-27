/**
 * The statement text of the retention purge's bookkeeping (the derived-origin parks, the owed-purge records, the
 * managed purge's failure parks, the carry's expiring-origin read and the candidate selection), in one leaf module so
 * the typed members in engine-sql/retention-purge.ts send it while their callers (persistence/derived-origin-hold.ts,
 * persistence/purge-parks.ts, persistence/purge-deleted.ts, repair/origin-carry.ts) no longer run `executeRaw`.
 *
 * Each text is byte for byte what its caller sent (pinned in test/engine-sql-caller-raw-sql-pins.test.ts). The
 * predicates the texts splice are pure functions of an alias and module constants, so a text is the same on every call;
 * the two candidate texts are functions only so this module evaluates nothing from its imports at load.
 */
import { IDENTITY_DOWNGRADE_OP } from './sync-status-sql.ts';
import { atomRetirementPurgeHold } from './atom-retirement-hold.ts';
import { derivedRetirementPurgeHold } from './derived-retirement-hold.ts';
import { derivedOriginPurgeHold } from './derived-origin-hold.ts';

/** SQL: the downgrade record `dg` is open for the page aliased `alias` (no disposition, old page still soft-deleted by that sync). */
export const identityDowngradeOpen = (alias: string): string =>
  `dg.completed_keys->0->>'disposition' IS NULL AND ${alias}.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz`;

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page has no open downgrade record. */
export function identityDowngradePurgeHold(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM op_checkpoints dg WHERE dg.op = '${IDENTITY_DOWNGRADE_OP}' AND dg.fingerprint = ${alias}.id::text
    AND ${identityDowngradeOpen(alias)})`;
}

/**
 * What keeps an expired tombstone of page `page` (source `source`) out of every managed purge: an archived source, or the
 * rename-recovery, restorable-atom, derived-retirement or derived-origin hold; `released` (an SQL int[]) lifts the
 * derived-origin hold for the parked origins a manual purge's preview counts as released.
 */
export function purgeHoldsSql(page: string, source: string, released?: string): string {
  const origin = released ? `(${derivedOriginPurgeHold(page)} OR ${page}.id = ANY(${released}))` : derivedOriginPurgeHold(page);
  return `NOT ${source}.archived AND ${identityDowngradePurgeHold(page)} AND ${atomRetirementPurgeHold(page)} AND ${derivedRetirementPurgeHold(page)} AND ${origin}`;
}

const DELETED_US = (alias: string) => `floor(extract(epoch FROM ${alias}.deleted_at)*1000000)::bigint::text`;
const OWED_TOMBSTONE = `EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL AND ${DELETED_US('p')} = o.completed_keys->0->>'deleted_us')`;
/** The park's page is still a tombstone (derived-origin-hold.ts `TOMBSTONE`). */
const TOMBSTONE = 'EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL)';
/** The failure record's tombstone still exists as recorded (purge-parks.ts `LIVE_TOMBSTONE`). */
const LIVE_TOMBSTONE = `EXISTS (SELECT 1 FROM pages p WHERE p.source_id=o.completed_keys->0->>'source_id' AND p.slug=o.completed_keys->0->>'slug'
  AND p.deleted_at IS NOT NULL AND floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text=o.completed_keys->0->>'deleted_us')`;

/** derived-origin-hold.ts releaseStaleHolds; `$1` the park op. */
export const RELEASE_STALE_HOLDS_SQL = `UPDATE op_checkpoints o SET updated_at=now(), completed_keys=jsonb_build_array((o.completed_keys->0) - 'held_request_id' - 'held_deleted_us')
    FROM pages p WHERE o.op=$1 AND o.fingerprint=p.id::text AND (o.completed_keys->0) ? 'held_deleted_us'
      AND (p.deleted_at IS NULL OR ${DELETED_US('p')} <> o.completed_keys->0->>'held_deleted_us')`;
/** derived-origin-hold.ts readOwedPurges; `$1` the owed-purge op. */
export const OWED_PURGES_SQL = `SELECT o.completed_keys->0 AS owed FROM op_checkpoints o WHERE o.op=$1 AND ${OWED_TOMBSTONE}
    ORDER BY o.fingerprint`;
/** derived-origin-hold.ts pruneOwedPurges; `$1` the owed-purge op. */
export const PRUNE_OWED_PURGES_SQL = `DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${OWED_TOMBSTONE}`;
/** derived-origin-hold.ts pruneDerivedOriginParks; `$1` the park op. */
export const PRUNE_ORIGIN_PARKS_SQL = `DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${TOMBSTONE}`;
/** purge-parks.ts prunePurgeParks; `$1` the purge park op. */
export const PRUNE_PURGE_PARKS_SQL = `DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${LIVE_TOMBSTONE}`;
/** purge-parks.ts recordPurgeFailure; `$1` op, `$2` key, `$3` the first record as `[park]` text, `$4..$7` the new fields. */
export const RECORD_PURGE_FAILURE_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)
      || jsonb_build_object('failures', COALESCE((op_checkpoints.completed_keys->0->>'failures')::int, 0) + 1, 'code', $4::text, 'reason', $5::text, 'failed_at', $6::text, 'version', $7::text))`;
/** purge-parks.ts clearPurgePark; `$1` op, `$2` key. */
export const CLEAR_PURGE_PARK_SQL = 'DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2';
/** purge-parks.ts notePurgeSourceWriter (writer not active); `$1` op, `$2` source id. */
export const MARK_PURGE_PARKS_INACTIVE_SQL = `UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) || '{"inactive_seen":true}'::jsonb)
      WHERE op=$1 AND completed_keys->0->>'source_id'=$2 AND completed_keys->0->>'inactive_seen' IS NULL`;
/** purge-parks.ts notePurgeSourceWriter (writer active again); `$1` op, `$2` source id. */
export const DROP_REARMED_PURGE_PARKS_SQL = `DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2
    AND completed_keys->0->>'inactive_seen'='true' RETURNING 1`;

/** purge-deleted.ts selectPurgeCandidates (no managed persistence): the parked origins the run frees; `$1` release, `$2` exclude ids, `$3` hours. */
export function releasedPurgeOriginsSql(): string {
  return `SELECT p.slug, p.source_id, p.deleted_at FROM pages p
      WHERE p.id = ANY($1::int[]) AND p.id <> ALL($2::int[]) AND p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($3 || ' hours')::interval
        AND ${identityDowngradePurgeHold('p')} AND ${atomRetirementPurgeHold('p')} AND ${derivedRetirementPurgeHold('p')}`;
}

/** purge-deleted.ts selectPurgeCandidates (managed): the expired tombstones under every hold; `$1` hours, `$2` release, `$3` hold. */
export function managedPurgeCandidatesSql(): string {
  return `SELECT p.id, p.source_id, p.slug, (now() - ($1 || ' hours')::interval)::text AS cutoff,
      floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text AS deleted_us FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND ${purgeHoldsSql('p', 's', '$2::int[]')} AND p.id <> ALL($3::int[])
      ORDER BY p.deleted_at ASC, p.source_id COLLATE "C" ASC, p.slug COLLATE "C" ASC`;
}

/** purge-deleted.ts readRederiveHeldConcepts: the concept tombstones a purge input hid, whose re-derive mark is at their delete. */
export const REDERIVE_HELD_CONCEPTS_SQL = `SELECT p.id FROM pages p WHERE p.deleted_at IS NOT NULL AND p.type = 'concept'
    AND EXISTS (SELECT 1 FROM needs_rederive n WHERE n.derived_table = 'pages' AND n.derived_id = p.id::text AND n.marked_at = p.deleted_at)`;
/** purge-deleted.ts purgeExpired (the `only` filter's read); `$1` hours. */
export const EXPIRED_PAGES_SQL = `SELECT id, source_id, slug FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' hours')::interval`;
/** purge-deleted.ts purgeExpired (the in-purge recheck's read); `$1` hours. */
export const EXPIRED_PAGE_IDS_SQL = `SELECT id FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' hours')::interval`;

/** purge-deleted.ts purgeOwedPages: the owed pages expired past `$2` hours under every page hold; `$1` the page ids. */
export function owedExpiredPagesSql(): string {
  return `SELECT p.id, p.source_id, p.slug FROM pages p WHERE p.id = ANY($1::int[])
    AND p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($2 || ' hours')::interval AND ${identityDowngradePurgeHold('p')} AND ${atomRetirementPurgeHold('p')}
    AND ${derivedRetirementPurgeHold('p')} AND ${derivedOriginPurgeHold('p')} ORDER BY p.deleted_at, p.id`;
}
