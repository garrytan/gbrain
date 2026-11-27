/**
 * The secret store's statements (GST-2988) as typed members: the `secret_store` and `secret_store_occurrence` reads and
 * writes of secret-store/store.ts, restore.ts and spool.ts. Both SQL engines delegate here; the Rust store serves the
 * same members from its secret store family (rust/crates/gbrain-store/src/secret_store.rs, rust/docs/store/secret-store.md).
 * The statement texts are the ones the callers ran through `executeRaw`. Crypto stays in secret-store/keyring.ts and
 * store.ts: a member keeps the ciphertext and MACs it is given and never sees a value.
 *
 * Every member that writes runs in the caller's transaction (a repair apply, a backup restore, a purge), so each is one
 * write. A value is never a parameter: only ciphertext, nonce, tag and MAC are.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export type SecretEntryStatus = 'active' | 'allowed';
export type SecretOccurrenceOrigin = 'repair' | 'publish_rebuild' | 'transcript' | 'archive' | 'capture';

/** One `secret_store` row as the store reads it back (`created_at` is the engine's timestamp text). */
export interface SecretEntryRow {
  id: string; source_id: string; rule: string; ciphertext: string; nonce: string; tag: string; key_id: string; key_host: string;
  value_mac: string; status: SecretEntryStatus; created_at: string;
}

/** The columns a seal writes; `status` and both timestamps take their defaults. */
export interface SecretEntryInsert {
  id: string; sourceId: string; rule: string; ciphertext: string; nonce: string; tag: string; keyId: string; keyHost: string; valueMac: string;
}

/** `ON CONFLICT (source_id,value_mac)` (`value`: another id may not hold the value; an id clash still refuses) or `ON CONFLICT` on any key (`any`). */
export type SecretEntryConflict = 'value' | 'any';

export interface SecretOccurrenceInsert {
  entryId: string; sourceId: string; pageId: number | null; slug: string | null; field: string; origin: SecretOccurrenceOrigin;
  commit: string | null; path: string | null; line: number | null; preFieldSha256: string | null; createdBy: string;
}

export interface SecretOccurrenceRow {
  page_id: number | null; source_id: string; slug: string | null; field: string; origin: SecretOccurrenceOrigin; commit_sha: string | null;
  path: string | null; line: number | null; created_at: string;
}

export interface SecretEntrySummaryRow {
  id: string; source_id: string; rule: string; status: SecretEntryStatus; key_id: string; key_host: string; created_at: string;
  occurrences: number; slugs: string[];
}

export interface SecretAllowedMac { key_id: string; value_mac: string }
export interface SecretKeyInUse { key_id: string; key_host: string; entries: number }

/** An entry as a backup keeps it: every column, timestamps as UTC ISO milliseconds. */
export type SecretBackupEntryRow = SecretEntryRow & { updated_at: string };
export interface SecretBackupOccurrenceRow {
  entry_id: string; source_id: string; page_id: number | null; slug: string | null; field: string; origin: SecretOccurrenceOrigin; commit_sha: string | null;
  path: string | null; line: number | null; pre_field_sha256: string | null; created_by: string; created_at: string;
}

/** A page of the source named by a backed-up place: its id and slug, whether its body is stored in segments, and whether its stores hold the marker. */
export interface SecretHoldingPageRow { id: number; slug: string; segmented: boolean; holds: boolean }

export interface RestorePageHit { revision: string; hit: boolean }

export async function findSecretEntryByMac(exec: Raw, sourceId: string, mac: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE source_id=$1 AND value_mac=$2', [sourceId, mac]);
  return row?.id ?? null;
}

export async function secretEntryExists(exec: Raw, id: string): Promise<boolean> {
  return (await exec.executeRaw('SELECT 1 FROM secret_store WHERE id=$1', [id])).length > 0;
}

const INSERT_ENTRY_SQL = `INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id,value_mac) DO NOTHING RETURNING id`;
const INSERT_ENTRY_ANY_SQL = `INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`;

/** Writes one entry; the id when this call wrote it, null when the conflict clause skipped it. */
export async function insertSecretEntry(exec: Raw, row: SecretEntryInsert, conflict: SecretEntryConflict): Promise<string | null> {
  const [inserted] = await exec.executeRaw<{ id: string }>(conflict === 'value' ? INSERT_ENTRY_SQL : INSERT_ENTRY_ANY_SQL,
    [row.id, row.sourceId, row.rule, row.ciphertext, row.nonce, row.tag, row.keyId, row.keyHost, row.valueMac]);
  return inserted?.id ?? null;
}

export async function insertSecretOccurrence(exec: Raw, o: SecretOccurrenceInsert): Promise<void> {
  await exec.executeRaw(`INSERT INTO secret_store_occurrence (entry_id,source_id,page_id,slug,field,origin,commit_sha,path,line,pre_field_sha256,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [o.entryId, o.sourceId, o.pageId, o.slug, o.field, o.origin, o.commit, o.path, o.line, o.preFieldSha256, o.createdBy]);
}

export async function readSecretEntry(exec: Raw, id: string): Promise<SecretEntryRow | null> {
  const [row] = await exec.executeRaw<SecretEntryRow>('SELECT id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,created_at::text AS created_at FROM secret_store WHERE id=$1', [id]);
  return row ?? null;
}

/** The recorded places of one entry, in recording order. */
export async function listSecretOccurrences(exec: Raw, entryId: string): Promise<SecretOccurrenceRow[]> {
  return exec.executeRaw<SecretOccurrenceRow>(`SELECT page_id,source_id,slug,field,origin,commit_sha,path,line,created_at::text AS created_at
    FROM secret_store_occurrence WHERE entry_id=$1 ORDER BY id`, [entryId]);
}

/** Entries with how often and where each occurs, never a value; oldest first. */
export async function listSecretEntrySummaries(exec: Raw, filter: { sourceId: string | null; slug: string | null; limit: number }): Promise<SecretEntrySummaryRow[]> {
  const rows = await exec.executeRaw<Omit<SecretEntrySummaryRow, 'occurrences' | 'slugs'> & { occurrences: number | string; slugs: string[] | null }>(
    `SELECT s.id,s.source_id,s.rule,s.status,s.key_id,s.key_host,s.created_at::text AS created_at,
       (SELECT count(*) FROM secret_store_occurrence o WHERE o.entry_id=s.id) AS occurrences,
       (SELECT array_agg(DISTINCT o.slug) FROM secret_store_occurrence o WHERE o.entry_id=s.id AND o.slug IS NOT NULL) AS slugs
     FROM secret_store s
     WHERE ($1::text IS NULL OR s.source_id=$1)
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id AND o.slug=$2))
     ORDER BY s.created_at, s.id LIMIT $3`, [filter.sourceId, filter.slug, filter.limit]);
  return rows.map(row => ({ ...row, occurrences: Number(row.occurrences), slugs: row.slugs ?? [] }));
}

/** Entries and occurrences per rule, never a value. */
export async function countSecretsByRule(exec: Raw, sourceId: string | null): Promise<Array<{ rule: string; entries: number; occurrences: number }>> {
  const rows = await exec.executeRaw<{ rule: string; entries: number | string; occurrences: number | string }>(
    `SELECT s.rule, count(DISTINCT s.id) AS entries, count(o.entry_id) AS occurrences
     FROM secret_store s LEFT JOIN secret_store_occurrence o ON o.entry_id=s.id
     WHERE ($1::text IS NULL OR s.source_id=$1) GROUP BY s.rule ORDER BY s.rule`, [sourceId]);
  return rows.map(row => ({ rule: row.rule, entries: Number(row.entries), occurrences: Number(row.occurrences) }));
}

/** The key and MAC of every value the owner restored: of one source, or (no source) of every source in key order (the spool's mirror). */
export async function listAllowedSecretMacs(exec: Raw, sourceId: string | null): Promise<SecretAllowedMac[]> {
  if (sourceId === null) return exec.executeRaw<SecretAllowedMac>("SELECT key_id,value_mac FROM secret_store WHERE status='allowed' ORDER BY key_id,value_mac");
  return exec.executeRaw<SecretAllowedMac>("SELECT key_id,value_mac FROM secret_store WHERE source_id=$1 AND status='allowed'", [sourceId]);
}

/** Key ids entries were sealed with, by host. */
export async function listSecretKeysInUse(exec: Raw): Promise<SecretKeyInUse[]> {
  const rows = await exec.executeRaw<{ key_id: string; key_host: string; entries: number | string }>(
    'SELECT key_id,key_host,count(*) AS entries FROM secret_store GROUP BY key_id,key_host ORDER BY key_id,key_host');
  return rows.map(row => ({ ...row, entries: Number(row.entries) }));
}

/**
 * Every entry row as stored and every occurrence row, from one statement (one snapshot). A place on a page carries the
 * slug of the page its page_id names now (secret-store/store.ts storeSnapshot).
 */
export async function readSecretStoreSnapshot(exec: Raw): Promise<{ entries: SecretBackupEntryRow[]; occurrences: SecretBackupOccurrenceRow[] }> {
  const [row] = await exec.executeRaw<{ entries: string; occurrences: string }>(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)::text FROM (SELECT id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at FROM secret_store) e) AS entries,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) - 'ord' ORDER BY o.ord), '[]'::jsonb)::text FROM (SELECT oc.id AS ord,oc.entry_id,oc.source_id,oc.page_id,
      CASE WHEN oc.commit_sha IS NULL THEN coalesce(p.slug, oc.slug) ELSE oc.slug END AS slug,oc.field,oc.origin,oc.commit_sha,oc.path,oc.line,
      oc.pre_field_sha256,oc.created_by,to_char(oc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at FROM secret_store_occurrence oc
      LEFT JOIN pages p ON p.id = oc.page_id AND p.source_id = oc.source_id) o) AS occurrences`);
  return { entries: JSON.parse(row!.entries) as SecretBackupEntryRow[], occurrences: JSON.parse(row!.occurrences) as SecretBackupOccurrenceRow[] };
}

/** Writes a backed-up entry unless the id or the (source, value) is held, and only for a source this brain has; true when written. */
export async function insertBackupSecretEntry(exec: Raw, row: SecretBackupEntryRow): Promise<boolean> {
  const inserted = await exec.executeRaw<{ id: string }>(`INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,created_at,updated_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz WHERE EXISTS (SELECT 1 FROM sources WHERE id=$2)
        ON CONFLICT DO NOTHING RETURNING id`,
  [row.id, row.source_id, row.rule, row.ciphertext, row.nonce, row.tag, row.key_id, row.key_host, row.value_mac, row.status, row.created_at, row.updated_at]);
  return inserted.length > 0;
}

/** Whether the row stored under `id` holds this (source, value): null when no row has the id. */
export async function readBackupEntryHold(exec: Raw, id: string, sourceId: string, mac: string): Promise<boolean | null> {
  const [held] = await exec.executeRaw<{ same: boolean }>('SELECT (source_id=$2 AND value_mac=$3) AS same FROM secret_store WHERE id=$1', [id, sourceId, mac]);
  return held ? held.same : null;
}

/**
 * Writes a backed-up occurrence once: the page it names is the one holding `pageId` (or, with none, the page at its slug),
 * a page place needs that page to hold the slug, and an identical row (to the millisecond) is not written twice. True when written.
 */
export async function insertBackupSecretOccurrence(exec: Raw, o: SecretBackupOccurrenceRow, pageId: number | null): Promise<boolean> {
  return (await exec.executeRaw(`INSERT INTO secret_store_occurrence (entry_id,source_id,page_id,slug,field,origin,commit_sha,path,line,pre_field_sha256,created_by,created_at)
          SELECT $1,$2,COALESCE($12::bigint,(SELECT id FROM pages WHERE source_id=$2 AND slug=$3)),$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz
          WHERE ($6::text IS NOT NULL OR $3::text IS NULL OR EXISTS (SELECT 1 FROM pages p WHERE p.id=$12::bigint AND p.source_id=$2 AND p.slug=$3))
            AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence x WHERE x.entry_id=$1 AND x.source_id=$2 AND x.slug IS NOT DISTINCT FROM $3 AND x.field=$4
              AND x.commit_sha IS NOT DISTINCT FROM $6 AND x.path IS NOT DISTINCT FROM $7 AND x.line IS NOT DISTINCT FROM $8::integer AND x.origin=$5
              AND x.pre_field_sha256 IS NOT DISTINCT FROM $9 AND x.created_by=$10 AND date_trunc('milliseconds', x.created_at) = $11::timestamptz) RETURNING 1`,
  [o.entry_id, o.source_id, o.slug, o.field, o.origin, o.commit_sha, o.path, o.line, o.pre_field_sha256, o.created_by, o.created_at, pageId])).length > 0;
}

/** Deletes an entry no occurrence references; true when it did. */
export async function deleteUnreferencedSecretEntry(exec: Raw, id: string): Promise<boolean> {
  return (await exec.executeRaw('DELETE FROM secret_store s WHERE s.id=$1 AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id) RETURNING 1', [id])).length > 0;
}

const HOLDING_PAGES_SQL = `SELECT p.id, p.slug, p.body_storage = 'segmented' AS segmented, ((p.title || ' ' || coalesce(p.compiled_truth, '') || ' ' || coalesce(p.timeline, '') || ' ' || p.frontmatter::text) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>')
    OR EXISTS (SELECT 1 FROM raw_data hr WHERE hr.page_id = p.id AND (hr.data::text) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>'))
    OR EXISTS (SELECT 1 FROM timeline_entries ht WHERE (ht.page_id = p.id OR ht.event_page_id = p.id) AND (ht.summary || ' ' || ht.detail || ' ' || ht.source) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>'))
    OR EXISTS (SELECT 1 FROM takes hk WHERE hk.page_id = p.id AND (coalesce(hk.claim, '') || ' ' || coalesce(hk.source, '') || ' ' || coalesce(hk.resolved_source, '')) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>'))
    OR EXISTS (SELECT 1 FROM links hl WHERE hl.from_page_id = p.id AND (hl.context) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>'))
    OR EXISTS (SELECT 1 FROM facts hf WHERE hf.source_id = p.source_id AND (hf.source_markdown_slug = p.slug OR (hf.source_markdown_slug IS NULL AND hf.entity_slug = p.slug))
      AND (coalesce(hf.fact, '') || ' ' || coalesce(hf.context, '') || ' ' || coalesce(hf.value::text, '')) ~ ('<REDACTED:[a-z0-9_]{1,64}:' || $3 || '>'))) AS holds FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) FOR SHARE OF p`;

/**
 * The pages of the source at these slugs (a tombstone included), each with whether its inline stores hold entry `id`'s
 * marker (the predicate `pageHoldsSql` was: the page's inline columns, raw data, timeline entries, takes, outgoing link contexts and facts, each matched against `<REDACTED:rule:id>`); the pages are locked FOR SHARE so a purge cannot take one while a restore ties an
 * original to it.
 */
export async function listSecretHoldingPages(exec: Raw, sourceId: string, slugs: readonly string[], id: string): Promise<SecretHoldingPageRow[]> {
  const rows = await exec.executeRaw<{ id: number | string; slug: string; segmented: boolean; holds: boolean }>(HOLDING_PAGES_SQL, [sourceId, [...slugs], id]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/**
 * The purge cascade (secret-store/store.ts purgeSecretsForSlugs): removes the page occurrences of the slugs (and the
 * occurrences `onPages` names by id) that no live page outside the purged set owns, then every entry they pointed at that
 * no occurrence references. Returns how many of each it removed.
 */
export async function purgeSecretOccurrences(exec: Raw, sourceId: string, slugs: readonly string[], onPages: readonly string[]): Promise<{ occurrences: number; entries: number }> {
  const gone = await exec.executeRaw<{ entry_id: string }>(
    `DELETE FROM secret_store_occurrence o WHERE o.source_id=$1 AND o.commit_sha IS NULL AND (o.id::text = ANY($3::text[]) OR (o.slug = ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = o.page_id AND NOT (p.source_id = $1 AND p.slug = ANY($2::text[]))))) RETURNING o.entry_id`, [sourceId, [...slugs], [...onPages]]);
  if (!gone.length) return { occurrences: 0, entries: 0 };
  const ids = [...new Set(gone.map(g => g.entry_id))].sort();
  await exec.executeRaw('SELECT id FROM secret_store WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
  const entries = await exec.executeRaw(`DELETE FROM secret_store s WHERE s.id = ANY($1::text[])
    AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id) RETURNING 1`, [ids]);
  return { occurrences: gone.length, entries: entries.length };
}

/** Entries no page or commit references any more (doctor). */
export async function countUnreferencedSecretEntries(exec: Raw): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number | string }>(
    'SELECT count(*) AS n FROM secret_store s WHERE NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id)');
  return Number(row?.n ?? 0);
}

/** `gbrain secrets restore` preview: the live page's revision, and whether the marker is still in its stores (a segmented body counts as a hit). Null when no live page has the slug. */
export async function readRestorePageHit(exec: Raw, sourceId: string, slug: string, marker: string): Promise<RestorePageHit | null> {
  const [page] = await exec.executeRaw<RestorePageHit>(
    `SELECT knowledge_revision::text AS revision, (position($3 in coalesce(title,'') || coalesce(compiled_truth,'') || coalesce(timeline,'') || coalesce(frontmatter::text,'')) > 0
         OR body_storage = 'segmented') AS hit FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [sourceId, slug, marker]);
  return page ?? null;
}

/** Marks an entry restored: redactors leave its value alone from then on. */
export async function markSecretEntryAllowed(exec: Raw, id: string): Promise<void> {
  await exec.executeRaw("UPDATE secret_store SET status='allowed', updated_at=now() WHERE id=$1", [id]);
}
