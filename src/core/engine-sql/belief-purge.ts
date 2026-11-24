/**
 * The belief side of a purge: the source purge epoch, the ledger presence probe, the purge's own suppression writes and
 * the restore replay's tombstone upsert and schema probes (src/core/belief/purge.ts and purge-mirror.ts). One SQL
 * implementation for both engines. Each statement is the text its caller ran through executeRaw, byte for byte, so
 * PGLite and Postgres answer exactly as before; the decisions (when to bump, which fields to suppress or release, what a
 * replay may touch) stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** One purge suppression `registerPurgeRedaction` records: the field of a subject the purge `purgeRequest` redacted, by its text's hash. */
export interface PurgeRedactionInsert { sourceId: string; subjectKey: string; field: string; purgeRequest: string; fieldHash: string }
/** An owner release of one field of one subject: `releasedBy` is the publication, `releasedHash` the hash of the field's current text. */
export interface PurgeRedactionRelease { sourceId: string; subjectKey: string; field: string; releasedBy: string; releasedHash: string }
/** A replayed page purge's content-hash tombstones (`page_purges`). */
export interface ReplayPagePurges { sourceId: string; contentHashes: string[]; slug: string; requestId: string | null }

/**
 * What a restored archive has that the purge replay probes: the listed stores that exist, whether `page_versions` has
 * `change_reason`, and whether `persistence_brain`, `derivation_inputs` and `belief_events` exist. An archive older
 * than a store lacks it; the live schema has every one.
 */
export interface PurgeReplaySchema { stores: string[]; changeReason: boolean; persistenceBrain: boolean; derivationInputs: boolean; beliefEvents: boolean }

/** Raises the source's purge epoch by one; answers the new epoch, or null for an unknown source (no row is updated). */
export async function bumpSourcePurgeEpoch(exec: SqlExecutor, sourceId: string): Promise<number | null> {
  const [row] = await exec.executeRaw<{ purge_epoch: string | number }>('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1 RETURNING purge_epoch', [sourceId]);
  return row ? Number(row.purge_epoch) : null;
}

/** Whether the source has any belief event, of any incarnation. */
export async function hasBeliefEvents(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM belief_events WHERE source_id = $1) AS present', [sourceId]);
  return row?.present === true;
}

/** Records the suppression unless the same (source, subject, field, request, hash) is already recorded. */
export async function registerPurgeRedaction(exec: SqlExecutor, row: PurgeRedactionInsert): Promise<void> {
  await exec.executeRaw(`INSERT INTO belief_redactions (source_id, subject_key, field, purge_request, field_hash)
    SELECT $1, $2, $3, $4::uuid, $5 WHERE NOT EXISTS (SELECT 1 FROM belief_redactions WHERE source_id = $1 AND subject_key = $2 AND field = $3
      AND purge_request = $4::uuid AND field_hash = $5)`, [row.sourceId, row.subjectKey, row.field, row.purgeRequest, row.fieldHash]);
}

/**
 * Releases the field's suppressions on the subject to `releasedHash`: each one not released to that hash already whose
 * redacted text is not that hash. Answers the purge request of each released row, in no set order.
 */
export async function releasePurgeRedactionsForField(exec: SqlExecutor, row: PurgeRedactionRelease): Promise<string[]> {
  const rows = await exec.executeRaw<{ purge_request: string }>(`UPDATE belief_redactions SET released_by = $4::uuid, released_hash = $5 WHERE source_id = $1 AND subject_key = $2
      AND field = $3 AND released_hash IS DISTINCT FROM $5 AND field_hash <> $5 RETURNING purge_request::text AS purge_request`, [row.sourceId, row.subjectKey, row.field, row.releasedBy, row.releasedHash]);
  return rows.map(r => r.purge_request);
}

/**
 * The replay's page purge tombstones: one per content hash under the slug. A hash already tombstoned takes the new slug
 * and request and keeps its `purged_at` (the live purge's `upsertPagePurges` resets it).
 */
export async function replayPagePurges(exec: SqlExecutor, row: ReplayPagePurges): Promise<void> {
  await exec.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) SELECT $1,h,$3,$4::uuid FROM unnest($2::text[]) AS h
      ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id`, [row.sourceId, row.contentHashes, row.slug, row.requestId]);
}

/** The replay's schema probes, the five statements it ran, in its order; `stores` keeps the order given. */
export async function readPurgeReplaySchema(exec: LegacyUnscopedRead, stores: readonly string[]): Promise<PurgeReplaySchema> {
  const present = (await exec.executeRaw<{ name: string }>('SELECT t AS name FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NOT NULL', [[...stores]])).map(r => r.name);
  const [reasonColumn] = await exec.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'page_versions' AND column_name = 'change_reason') AS present`);
  const [brain] = await exec.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_brain') IS NOT NULL AS present");
  const [derivations] = await exec.executeRaw<{ present: boolean }>("SELECT to_regclass('derivation_inputs') IS NOT NULL AS present");
  const [ledger] = await exec.executeRaw<{ present: boolean }>("SELECT to_regclass('belief_events') IS NOT NULL AS present");
  const kept = new Set(present);
  return {
    stores: stores.filter(s => kept.has(s)), changeReason: reasonColumn?.present === true, persistenceBrain: brain?.present === true,
    derivationInputs: derivations?.present === true, beliefEvents: ledger?.present === true,
  };
}
