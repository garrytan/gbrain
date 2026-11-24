/**
 * Doctor checkpoint reads: the statements `gbrain doctor` checks (and the readers they share) ran through `executeRaw`
 * over `op_checkpoints` and `ingest_log`, each with the same text and parameters, on the engine's own `executeRaw`;
 * only their home moved. PGLite and Postgres run these exact statements. Nothing here is composed: the constants the
 * old sites spliced in (`TOMBSTONE`, `LIVE_TOMBSTONE`, `identityDowngradeOpen('p')`) are inlined, and
 * test/doctor-checkpoints-sql.test.ts pins each inlined text against its original.
 *
 * The Rust engine answers each member in one of two ways (rust/docs/store/cli-reads-doctor-checkpoints.md):
 *  - served from its store: the doctor last-known pair, the latest connector receipt and the facts-absorb failure
 *    groups (`ingest_log`), and the sync-admission setting (the config value; the store keeps no dating row);
 *  - empty, no writer: every other `op_checkpoints` operation is written only through `executeRaw`, which a Rust
 *    brain refuses, so no such row exists there. The Rust member answers the empty value (`[]`, `null`) in TypeScript
 *    without a store call, which is what the same read finds on a brain nothing has written to.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { CandidateRecord } from '../fence-repair/census-store.ts';
import type { DerivedOriginPark } from '../persistence/derived-origin-hold.ts';
import type { PurgePark } from '../persistence/purge-parks.ts';
import type { ManagedSyncFailure } from '../persistence/sync-failures.ts';
import type { ManagedSyncPassValue } from '../persistence/sync-pass-row.ts';
import type { managedSyncResumeArgs } from '../sync-reconcile.ts';
import type { IdentityDowngrade } from '../sync-identity-downgrades.ts';
import type { HeldManagedAtom } from '../persistence/atom-maintenance.ts';
import type { CredentialResealHold } from '../page-state/credential-reseal.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_CHECKPOINT_MEMBERS: readonly string[] = [
  'listFenceCandidateRecords', 'listDerivedOriginParks', 'listPurgeParks', 'readSoakCounterRows',
  'listUnfinishedManagedSyncCursors', 'listManagedSyncPassStops', 'listManagedSyncBacklogHeaders', 'readManagedSyncPassRow',
  'listLiveManagedSyncPassRows', 'listCheckpointBlockedSources', 'listOpenIdentityDowngrades', 'listHeldManagedAtomRows',
  'readDoctorLastKnown', 'writeDoctorLastKnown', 'readSyncAdmissionSettingRow', 'readLatestConnectorReceipt',
  'listFactsAbsorbFailureGroups', 'listCredentialResealHoldRows',
];

/** A timestamp column as an engine returns it: a Date, or the text a driver without a timestamp codec gives. */
type Stamp = Date | string;

/** The managed-sync backlog header: the first element of a `managed-sync` cursor row. */
export interface ManagedSyncBacklogHeader {
  sourceId: string; index: number; total: number; done?: boolean; discoveredAt?: string;
  progress?: { startedAt: number; startIndex: number; lastAt: number; lastIndex: number };
  counts?: { held?: number };
  processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean };
  syncOptions?: Parameters<typeof managedSyncResumeArgs>[0]['syncOptions'];
}

/** A pass row as stored: the record, its write time and the engine clock at the read. */
export interface ManagedSyncPassRowRecord { value: ManagedSyncPassValue | null; updated_at: Stamp; read_at: Stamp }
/** A live source's pass row, with the source it belongs to. */
export interface LiveManagedSyncPassRowRecord { source_id: string; value: ManagedSyncPassValue; updated_at: Stamp; read_at: Stamp }
/** A managed-sync failure row of a live source incarnation with no cursor row, with its write time. */
export interface ManagedSyncPassStopRow { fingerprint: string; updated_at: Stamp; failure: ManagedSyncFailure }
/** An open identity-downgrade record and the live slugs at its new path. */
export interface OpenIdentityDowngradeRow { record: IdentityDowngrade; new_slugs: string[] | null }
/** A purge-park row: its key (the fingerprint) and record. */
export interface PurgeParkRow { fingerprint: string; park: PurgePark }
/** A held managed atom as stored (text columns; `attempts` and `held_at` are converted by the caller). */
export type HeldManagedAtomRow = Omit<HeldManagedAtom, 'attempts' | 'held_at'> & { attempts: string | number; held_at: Stamp };
/** One last-known row to store: the doctor entry name and its value. */
export interface DoctorLastKnownRow { entry: string; value: unknown }
/** The sync-admission setting columns: the stored config value, the dating row's value and its `set_at`. */
export interface SyncAdmissionSettingRecord { stored: string | null; row_value: string | null; set_at: string | null }
/** A live credential re-chunk hold and whether its page is segmented (its retry command differs). */
export interface CredentialResealHoldRow { hold: CredentialResealHold; segmented: boolean }
/** The `facts:absorb` rows of the last 24 hours grouped by source and reason. */
export interface FactsAbsorbFailureGroup { source_id: string; reason: string; n: string | number; newest: Stamp }

const parsed = <T>(value: T | string): T => (typeof value === 'string' ? JSON.parse(value) as T : value);

const LIST_FENCE_CANDIDATE_RECORDS_SQL = `SELECT c.completed_keys->0 AS record FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'source_id' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
    WHERE c.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) ORDER BY c.fingerprint COLLATE "C"`;

/** The fence candidate records of live source incarnations (one source's when `sourceIds` is given), by fingerprint. */
export async function listFenceCandidateRecords(raw: EngineRawRead, op: string, sourceIds?: readonly string[]): Promise<CandidateRecord[]> {
  const rows = await raw<{ record: CandidateRecord }>(LIST_FENCE_CANDIDATE_RECORDS_SQL, [op, sourceIds ? [...sourceIds] : null]);
  return rows.map(row => row.record);
}

export const LIST_DERIVED_ORIGIN_PARKS_SQL = `SELECT o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL) ORDER BY o.updated_at, o.fingerprint COLLATE "C"`;

/** Every derived-origin park whose page is still a tombstone, oldest first. */
export async function listDerivedOriginParks(raw: EngineRawRead, op: string): Promise<DerivedOriginPark[]> {
  const rows = await raw<{ park: DerivedOriginPark | string }>(LIST_DERIVED_ORIGIN_PARKS_SQL, [op]);
  return rows.map(row => parsed(row.park));
}

export const LIST_PURGE_PARKS_SQL = `SELECT o.fingerprint, o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=o.completed_keys->0->>'source_id' AND p.slug=o.completed_keys->0->>'slug'
  AND p.deleted_at IS NOT NULL AND floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text=o.completed_keys->0->>'deleted_us') ORDER BY o.fingerprint COLLATE "C"`;

/** Every purge-failure record whose tombstone still exists as recorded, by fingerprint. */
export async function listPurgeParks(raw: EngineRawRead, op: string): Promise<PurgeParkRow[]> {
  const rows = await raw<{ fingerprint: string; park: PurgePark | string }>(LIST_PURGE_PARKS_SQL, [op]);
  return rows.map(row => ({ fingerprint: row.fingerprint, park: parsed(row.park) }));
}

const READ_SOAK_COUNTER_ROWS_SQL = 'SELECT completed_keys->0 AS counts FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])';

/** The counter record of each of the given UTC days (a day with none is absent). */
export async function readSoakCounterRows(raw: EngineRawRead, op: string, days: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const rows = await raw<{ counts: Record<string, unknown> }>(READ_SOAK_COUNTER_ROWS_SQL, [op, [...days]]);
  return rows.map(row => row.counts);
}

const LIST_UNFINISHED_MANAGED_SYNC_CURSORS_SQL = `
    SELECT c.fingerprint FROM op_checkpoints c LEFT JOIN op_checkpoints f ON f.op='managed-sync-failure' AND f.fingerprint=c.fingerprint
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND (f.updated_at IS NULL OR f.updated_at>=c.updated_at)`;

/** The fingerprints of unfinished managed-sync cursors with no newer-than-cursor failure row ahead of them. */
export async function listUnfinishedManagedSyncCursors(raw: EngineRawRead): Promise<string[]> {
  return (await raw<{ fingerprint: string }>(LIST_UNFINISHED_MANAGED_SYNC_CURSORS_SQL)).map(row => row.fingerprint);
}

const LIST_MANAGED_SYNC_PASS_STOPS_SQL = `
    SELECT f.fingerprint, f.updated_at, f.completed_keys->0 AS failure FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation'
    WHERE f.op='managed-sync-failure' AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint)`;

/** The failure rows of live source incarnations that have no cursor row (the stops a pass left). */
export async function listManagedSyncPassStops(raw: EngineRawRead, sourceIds?: readonly string[]): Promise<ManagedSyncPassStopRow[]> {
  return raw<ManagedSyncPassStopRow>(LIST_MANAGED_SYNC_PASS_STOPS_SQL, [sourceIds ?? null]);
}

const LIST_MANAGED_SYNC_BACKLOG_HEADERS_SQL = `SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'
      AND EXISTS (SELECT 1 FROM sources s WHERE s.id = completed_keys->0->>'sourceId'
        AND s.incarnation::text = COALESCE(completed_keys->0->>'incarnation', s.incarnation::text))`;

/** The headers of unfinished managed-sync cursors of registered sources (the current incarnation, or one that recorded none). */
export async function listManagedSyncBacklogHeaders(raw: EngineRawRead): Promise<ManagedSyncBacklogHeader[]> {
  return (await raw<{ header: ManagedSyncBacklogHeader }>(LIST_MANAGED_SYNC_BACKLOG_HEADERS_SQL)).map(row => row.header);
}

const READ_MANAGED_SYNC_PASS_ROW_SQL = 'SELECT completed_keys->0 AS value, updated_at, now() AS read_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2';

/** One pass row (its record, write time and the engine clock at the read), or null when there is none. */
export async function readManagedSyncPassRow(raw: EngineRawRead, op: string, fingerprint: string): Promise<ManagedSyncPassRowRecord | null> {
  const [row] = await raw<ManagedSyncPassRowRecord>(READ_MANAGED_SYNC_PASS_ROW_SQL, [op, fingerprint]);
  return row ?? null;
}

const LIST_LIVE_MANAGED_SYNC_PASS_ROWS_SQL = `SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at, now() AS read_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`;

/** The pass rows of the sources' live incarnations (every source when `sourceIds` is omitted). */
export async function listLiveManagedSyncPassRows(raw: EngineRawRead, op: string, sourceIds?: readonly string[]): Promise<LiveManagedSyncPassRowRecord[]> {
  return raw<LiveManagedSyncPassRowRecord>(LIST_LIVE_MANAGED_SYNC_PASS_ROWS_SQL, [op, sourceIds ? [...sourceIds] : null]);
}

const LIST_CHECKPOINT_BLOCKED_SOURCES_SQL = `SELECT DISTINCT o.completed_keys->0->>'sourceId' AS source_id FROM op_checkpoints o
    JOIN sources s ON s.id=o.completed_keys->0->>'sourceId' AND s.archived IS NOT TRUE
    WHERE o.op='managed-sync' AND o.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND COALESCE(o.completed_keys->0->>'done','false')<>'true'
      AND ($1::text[] IS NULL OR o.completed_keys->0->>'sourceId'=ANY($1::text[]))`;

/** The non-archived sources whose unfinished managed-sync cursor waits at its checkpoint step. */
export async function listCheckpointBlockedSources(raw: EngineRawRead, sourceIds?: readonly string[]): Promise<string[]> {
  return (await raw<{ source_id: string }>(LIST_CHECKPOINT_BLOCKED_SOURCES_SQL, [sourceIds ? [...sourceIds] : null])).map(row => row.source_id);
}

export const LIST_OPEN_IDENTITY_DOWNGRADES_SQL = `SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug COLLATE "C") AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND dg.completed_keys->0->>'disposition' IS NULL AND p.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at' COLLATE "C", dg.fingerprint COLLATE "C"`;

/** The open identity-downgrade records (no disposition, old page still soft-deleted by that sync), oldest first, with the live slugs at the new path. */
export async function listOpenIdentityDowngrades(raw: EngineRawRead, op: string, sourceIds?: readonly string[]): Promise<OpenIdentityDowngradeRow[]> {
  const rows = await raw<{ record: IdentityDowngrade | string; new_slugs: string[] | null }>(LIST_OPEN_IDENTITY_DOWNGRADES_SQL, [op, sourceIds ? [...sourceIds] : null]);
  return rows.map(row => ({ record: parsed(row.record), new_slugs: row.new_slugs }));
}

const LIST_HELD_MANAGED_ATOM_ROWS_SQL = `SELECT DISTINCT ON (h.completed_keys->0->>'requestId')
        h.completed_keys->0->>'sourceId' AS source_id, h.completed_keys->0->>'kind' AS kind,
        h.completed_keys->0->>'locator' AS locator, h.completed_keys->0->>'requestId' AS request_id,
        h.completed_keys->0->>'failure' AS failure, h.completed_keys->0->>'attempts' AS attempts, h.updated_at AS held_at
       FROM op_checkpoints h JOIN sources s ON s.id=h.completed_keys->0->>'sourceId' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      WHERE h.op='managed-atoms' AND h.completed_keys->0->>'held'='true'
        AND ($1::text[] IS NULL OR s.id=ANY($1::text[])) AND s.config->>'role' IS DISTINCT FROM $2
        AND (h.completed_keys->0->>'kind'<>'page' OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id=s.id
          AND p.id::text=h.completed_keys->0->>'pageId' AND p.content_hash=h.completed_keys->0->>'contentHash' AND p.deleted_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'failure' IS NULL
          AND ac.completed_keys->0->>'sourceId'=s.id AND ac.completed_keys->0->>'incarnation'=s.incarnation::text
          AND ac.completed_keys->0->>'kind'=h.completed_keys->0->>'kind'
          AND (CASE WHEN h.completed_keys->0->>'kind'='page' THEN ac.completed_keys->0->>'pageId'=h.completed_keys->0->>'pageId'
            ELSE ac.completed_keys->0->>'locator'=h.completed_keys->0->>'locator' END)
          AND ac.completed_keys->0->>'contentHash'=h.completed_keys->0->>'contentHash')
      ORDER BY h.completed_keys->0->>'requestId', h.updated_at`;

/** The held managed-atom rows of the sources' current incarnations that no later run completed, excluding sources of storage role `excludedRole`. */
export async function listHeldManagedAtomRows(raw: EngineRawRead, sourceIds: readonly string[] | undefined, excludedRole: string): Promise<HeldManagedAtomRow[]> {
  return raw<HeldManagedAtomRow>(LIST_HELD_MANAGED_ATOM_ROWS_SQL, [sourceIds ?? null, excludedRole]);
}

const READ_DOCTOR_LAST_KNOWN_SQL = 'SELECT fingerprint, completed_keys->0 AS entry FROM op_checkpoints WHERE op = $1';

/** The stored last-known entries of one operation: the entry name and its value. */
export async function readDoctorLastKnown(raw: EngineRawRead, op: string): Promise<Array<{ fingerprint: string; entry: unknown }>> {
  const rows = await raw<{ fingerprint: string; entry: unknown }>(READ_DOCTOR_LAST_KNOWN_SQL, [op]);
  return rows.map(row => ({ fingerprint: row.fingerprint, entry: parsed(row.entry) }));
}

const WRITE_DOCTOR_LAST_KNOWN_SQL = `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       SELECT $1, e->>'entry', jsonb_build_array(e->'value'), now() FROM jsonb_array_elements($2::text::jsonb) AS e
       ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = EXCLUDED.updated_at`;

/** Upserts one last-known row per entry (the fingerprint is the entry name; `completed_keys` holds its value). */
export async function writeDoctorLastKnown(raw: EngineRawRead, op: string, rows: readonly DoctorLastKnownRow[]): Promise<void> {
  await raw(WRITE_DOCTOR_LAST_KNOWN_SQL, [op, JSON.stringify(rows)]);
}

const READ_SYNC_ADMISSION_SETTING_ROW_SQL = `SELECT c.value AS stored, o.completed_keys->0->>'value' AS row_value, o.completed_keys->0->>'set_at' AS set_at
       FROM (SELECT 1) one LEFT JOIN config c ON c.key=$1 LEFT JOIN op_checkpoints o ON o.op=$2 AND o.fingerprint=$3`;

/** The sync-admission setting: the config value at `key` and the dating row's value and `set_at` (all null when none). */
export async function readSyncAdmissionSettingRow(raw: EngineRawRead, key: string, op: string, fingerprint: string): Promise<SyncAdmissionSettingRecord> {
  const [row] = await raw<SyncAdmissionSettingRecord>(READ_SYNC_ADMISSION_SETTING_ROW_SQL, [key, op, fingerprint]);
  return row ?? { stored: null, row_value: null, set_at: null };
}

const READ_LATEST_CONNECTOR_RECEIPT_SQL = "SELECT summary FROM ingest_log WHERE source_type = 'connector' ORDER BY created_at DESC, id DESC LIMIT 1";

/** The summary of the newest connector receipt in the ingest log, or null when there is none. */
export async function readLatestConnectorReceipt(raw: EngineRawRead): Promise<string | null> {
  const [row] = await raw<{ summary: string }>(READ_LATEST_CONNECTOR_RECEIPT_SQL);
  return row ? row.summary : null;
}

const LIST_FACTS_ABSORB_FAILURE_GROUPS_SQL = `SELECT
         source_id,
         split_part(summary, ':', 1) AS reason,
         COUNT(*)::text AS n,
         MAX(created_at) AS newest
       FROM ingest_log
       WHERE source_type = 'facts:absorb'
         AND created_at >= now() - INTERVAL '24 hours'
       GROUP BY source_id, split_part(summary, ':', 1)
       ORDER BY source_id COLLATE "C", COUNT(*) DESC`;

/** The `facts:absorb` ingest rows of the last 24 hours grouped by source and reason (the first `:` field of the summary), by source then count. */
export async function listFactsAbsorbFailureGroups(raw: EngineRawRead): Promise<FactsAbsorbFailureGroup[]> {
  return raw<FactsAbsorbFailureGroup>(LIST_FACTS_ABSORB_FAILURE_GROUPS_SQL);
}

/**
 * The statement readCredentialResealHolds composed, with the chunker generation (`producer`) bound as $1 instead of
 * spliced in, and the optional source filter as $2.
 */
export const LIST_CREDENTIAL_RESEAL_HOLD_ROWS_SQL = `SELECT h.completed_keys->0 AS hold, p.body_storage IS NOT DISTINCT FROM 'segmented' AS segmented
    FROM op_checkpoints h JOIN pages p ON p.id = (h.completed_keys->0->>'page_id')::int WHERE h.op='credential-reseal-hold' AND p.deleted_at IS NULL AND p.knowledge_revision::text = h.completed_keys->0->>'revision'
  AND h.completed_keys->0->>'producer' = $1 AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision AND ($2::text[] IS NULL OR p.source_id=ANY($2::text[])) ORDER BY p.id`;

/** The credential re-chunk holds that still apply at chunker generation `producer` (optionally for some sources), oldest page first. */
export async function listCredentialResealHoldRows(raw: EngineRawRead, producer: string, sourceIds?: readonly string[]): Promise<CredentialResealHoldRow[]> {
  const rows = await raw<{ hold: CredentialResealHold | string; segmented: boolean }>(LIST_CREDENTIAL_RESEAL_HOLD_ROWS_SQL, [producer, sourceIds ? [...sourceIds] : null]);
  return rows.map(row => ({ hold: parsed(row.hold), segmented: row.segmented === true }));
}
