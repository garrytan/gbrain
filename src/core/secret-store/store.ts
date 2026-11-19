/**
 * The secret store (GST-2988): where a redaction keeps the original value it removed.
 *
 * `seal` encrypts a value with AES-256-GCM under the current store key (keyring.ts), with the entry id, source and
 * rule as additional authenticated data so a ciphertext cannot be moved to another entry, and returns the entry id
 * the marker `<REDACTED:<rule>:<id>>` carries. One entry per (source, value): the lookup key is an HMAC of the value
 * under a key derived from the store key. A value is never sent as a SQL parameter (a server's slow-statement log
 * would keep it); only its ciphertext and MAC are.
 *
 * `occurrence` records where the redactor put a marker. Reveal and restore act only through recorded occurrences: a
 * marker typed into another page binds to nothing.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { pageHoldsSql } from './marker-sql.ts';
import { readSegmentedBody } from '../page-body/ingest.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { currentKey, keyById, keyIdOf, macKeyOf, SECRET_STORE_KEY_ENV, storeHost, keyringDir } from './keyring.ts';

export type OccurrenceOrigin = 'repair' | 'publish_rebuild' | 'transcript' | 'archive' | 'capture';
export type EntryStatus = 'active' | 'allowed';

/** A store-backed marker; its rule part is the scanner's rule name. */
export const STORE_MARKER = /<REDACTED:([a-z0-9_]{1,64}):(ss_[0-9a-f]{12})>/g;
export const markerOf = (rule: string, id: string) => `<REDACTED:${rule}:${id}>`;
export const ENTRY_ID = /^ss_[0-9a-f]{12}$/;

interface EntryRow {
  id: string; source_id: string; rule: string; ciphertext: string; nonce: string; tag: string; key_id: string; key_host: string;
  value_mac: string; status: EntryStatus; created_at: string;
}

export interface SealResult { id: string; created: boolean; key_id: string; key_created?: string }

const aad = (id: string, sourceId: string, rule: string) => Buffer.from(`gbrain-secret-store-v1\0${id}\0${sourceId}\0${rule}`);
const macOf = (key: Buffer, value: string) => createHmac('sha256', macKeyOf(key)).update(value, 'utf8').digest('hex');

export const secretsAudit = createAuditWriter<{ ts: string } & Record<string, unknown>>({
  featureName: 'secrets', errorLabel: 'secrets-audit', errorTrailer: '; the read or write itself went ahead', fileMode: 0o600,
});

function keyMissing(keyId: string) {
  return opError('secret_store_key_missing', `The key ${keyId} that sealed this entry is not on this host (${SECRET_STORE_KEY_ENV} or ${keyringDir()}), so the original cannot be read here.`,
    `Put the key back: import its escrow copy with gbrain secrets key import <file> --passphrase-stdin, or set ${SECRET_STORE_KEY_ENV} to the key the other host uses; gbrain secrets key status lists the keys this host can read.`);
}

/** Seals one value (or returns the entry that already holds it) and returns its id. */
export async function seal(engine: BrainEngine, input: { sourceId: string; rule: string; value: string }): Promise<SealResult> {
  if (!input.value) throw opError('invalid_params', 'An empty value cannot be sealed.', 'Pass the span the scanner matched.');
  const key = currentKey({ create: true })!;
  const mac = macOf(key.key, input.value);
  const found = await engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE source_id=$1 AND value_mac=$2', [input.sourceId, mac]);
  if (found[0]) return { id: found[0].id, created: false, key_id: key.id, ...(key.created ? { key_created: key.id } : {}) };
  const id = `ss_${randomBytes(6).toString('hex')}`;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(id, input.sourceId, input.rule));
  const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  const inserted = await engine.executeRaw<{ id: string }>(`INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id,value_mac) DO NOTHING RETURNING id`,
  [id, input.sourceId, input.rule, ciphertext.toString('base64'), nonce.toString('base64'), cipher.getAuthTag().toString('base64'), key.id, storeHost(), mac]);
  const winner = inserted[0]?.id
    ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE source_id=$1 AND value_mac=$2', [input.sourceId, mac]))[0]?.id;
  if (!winner) throw opError('secret_store_unwritable', 'The secret store row could not be written or read back.', 'Run gbrain doctor --json and check the database.');
  return { id: winner, created: winner === id, key_id: key.id, ...(key.created ? { key_created: key.id } : {}) };
}

/**
 * Moves a spooled original (spool.ts) into the store under the id its markers already carry. `exists`: the row is
 * there (an earlier drain); `duplicate`: the store holds this value under another id, so this one cannot take a row.
 */
export async function sealWithId(engine: BrainEngine, input: { id: string; sourceId: string; rule: string; value: string }): Promise<{ kind: 'inserted' | 'exists' } | { kind: 'duplicate'; existing: string }> {
  if (!ENTRY_ID.test(input.id) || !input.value) throw opError('invalid_params', 'A spooled entry needs an ss_ id and a value.', 'Leave the spool file as it is.');
  const key = currentKey({ create: true })!;
  const mac = macOf(key.key, input.value);
  if ((await engine.executeRaw('SELECT 1 FROM secret_store WHERE id=$1', [input.id])).length) return { kind: 'exists' };
  const [held] = await engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE source_id=$1 AND value_mac=$2', [input.sourceId, mac]);
  if (held) return { kind: 'duplicate', existing: held.id };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(input.id, input.sourceId, input.rule));
  const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  const inserted = await engine.executeRaw<{ id: string }>(`INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
  [input.id, input.sourceId, input.rule, ciphertext.toString('base64'), nonce.toString('base64'), cipher.getAuthTag().toString('base64'), key.id, storeHost(), mac]);
  if (inserted.length) return { kind: 'inserted' };
  const [winner] = await engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE source_id=$1 AND value_mac=$2', [input.sourceId, mac]);
  return winner && winner.id !== input.id ? { kind: 'duplicate', existing: winner.id } : { kind: 'exists' };
}

export interface OccurrenceInput {
  entryId: string; sourceId: string; pageId?: number | null; slug?: string | null; field: string; origin: OccurrenceOrigin;
  commit?: string | null; path?: string | null; line?: number | null; preFieldSha256?: string | null; createdBy?: string;
}

export async function recordOccurrence(engine: BrainEngine, o: OccurrenceInput): Promise<void> {
  await engine.executeRaw(`INSERT INTO secret_store_occurrence (entry_id,source_id,page_id,slug,field,origin,commit_sha,path,line,pre_field_sha256,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [o.entryId, o.sourceId, o.pageId ?? null, o.slug ?? null, o.field, o.origin, o.commit ?? null, o.path ?? null, o.line ?? null, o.preFieldSha256 ?? null, o.createdBy ?? '']);
}

export async function entryRow(engine: BrainEngine, id: string): Promise<EntryRow> {
  if (!ENTRY_ID.test(id)) throw opError('invalid_params', `${JSON.stringify(id)} is not a secret store id (ss_ followed by 12 hex).`, 'Copy the id (ss_ then 12 hex) from the end of the marker in the page, or from gbrain secrets list.');
  const [row] = await engine.executeRaw<EntryRow>('SELECT id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,created_at::text AS created_at FROM secret_store WHERE id=$1', [id]);
  if (!row) throw opError('not_found', `No secret store entry ${id}.`, 'gbrain secrets list shows the entries this brain holds.');
  return row;
}

/** Decrypts one entry. Refuses with the key that is missing, or as a mismatch when the bytes do not authenticate. */
export function openEntry(row: EntryRow): string {
  const key = keyById(row.key_id);
  if (!key) throw keyMissing(row.key_id);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(row.id, row.source_id, row.rule));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const value = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    if (macOf(key, value) !== row.value_mac) throw new Error('mac');
    return value;
  } catch {
    throw opError('secret_store_key_mismatch', `Entry ${row.id} does not authenticate under key ${row.key_id}: the row was changed or moved, so its original is not returned.`,
      'Check the entry with gbrain secrets list --json; an entry restored from a backup must keep its id, source and rule.');
  }
}

export interface Occurrence { page_id: number | null; source_id: string; slug: string | null; field: string; origin: OccurrenceOrigin; commit_sha: string | null; path: string | null; line: number | null; created_at: string }

export async function occurrencesOf(engine: BrainEngine, id: string): Promise<Occurrence[]> {
  return engine.executeRaw<Occurrence>(`SELECT page_id,source_id,slug,field,origin,commit_sha,path,line,created_at::text AS created_at
    FROM secret_store_occurrence WHERE entry_id=$1 ORDER BY id`, [id]);
}

export interface RevealResult { id: string; source_id: string; rule: string; status: EntryStatus; value: string; occurrences: Occurrence[] }

/** The original value of one entry with where it was redacted. The caller decides who may call it (ops/secrets.ts). */
export async function reveal(engine: BrainEngine, id: string, actor: string): Promise<RevealResult> {
  let row: EntryRow;
  try { row = await entryRow(engine, id); } catch (error) {
    // An original a publish spooled (no store at hand) reads from this host's spool until maintenance moves it in.
    const spooled = (error as { code?: string }).code === 'not_found' ? (await import('./spool.ts')).openSpooled(id) : null;
    if (!spooled) throw error;
    const { entry, value } = spooled;
    secretsAudit.log({ ts: new Date().toISOString(), event: 'reveal', id, source_id: entry.source_id, rule: entry.rule, actor, spooled: true, slugs: [] });
    return { id, source_id: entry.source_id ?? '', rule: entry.rule, status: 'active', value, occurrences: entry.occurrences.map(o => ({ page_id: null, source_id: entry.source_id ?? '',
      slug: null, field: o.field, origin: 'publish_rebuild' as const, commit_sha: o.commit, path: o.path, line: o.line, created_at: entry.created_at })) };
  }
  const value = openEntry(row);
  const occurrences = await occurrencesOf(engine, id);
  secretsAudit.log({ ts: new Date().toISOString(), event: 'reveal', id, source_id: row.source_id, rule: row.rule, actor,
    slugs: [...new Set(occurrences.map(o => o.slug).filter(Boolean))] });
  return { id, source_id: row.source_id, rule: row.rule, status: row.status, value, occurrences };
}

export interface EntrySummary { id: string; source_id: string; rule: string; status: EntryStatus; key_id: string; key_host: string; created_at: string; occurrences: number; slugs: string[]; readable: boolean }

/** Entries and where they occur, never a value. */
export async function listEntries(engine: BrainEngine, filter: { sourceId?: string; slug?: string; limit?: number }): Promise<EntrySummary[]> {
  const rows = await engine.executeRaw<Omit<EntrySummary, 'readable' | 'slugs' | 'occurrences'> & { occurrences: number | string; slugs: string[] | null }>(
    `SELECT s.id,s.source_id,s.rule,s.status,s.key_id,s.key_host,s.created_at::text AS created_at,
       (SELECT count(*) FROM secret_store_occurrence o WHERE o.entry_id=s.id) AS occurrences,
       (SELECT array_agg(DISTINCT o.slug) FROM secret_store_occurrence o WHERE o.entry_id=s.id AND o.slug IS NOT NULL) AS slugs
     FROM secret_store s
     WHERE ($1::text IS NULL OR s.source_id=$1)
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id AND o.slug=$2))
     ORDER BY s.created_at, s.id LIMIT $3`, [filter.sourceId ?? null, filter.slug ?? null, filter.limit ?? 1000]);
  return rows.map(row => ({ ...row, occurrences: Number(row.occurrences), slugs: (row.slugs ?? []).filter(Boolean).sort(), readable: keyById(row.key_id) !== null }));
}

/** Entries and occurrences per rule, never a value. */
export async function countsByRule(engine: BrainEngine, sourceId?: string): Promise<Record<string, { entries: number; occurrences: number }>> {
  const rows = await engine.executeRaw<{ rule: string; entries: number | string; occurrences: number | string }>(
    `SELECT s.rule, count(DISTINCT s.id) AS entries, count(o.entry_id) AS occurrences
     FROM secret_store s LEFT JOIN secret_store_occurrence o ON o.entry_id=s.id
     WHERE ($1::text IS NULL OR s.source_id=$1) GROUP BY s.rule ORDER BY s.rule`, [sourceId ?? null]);
  return Object.fromEntries(rows.map(row => [row.rule, { entries: Number(row.entries), occurrences: Number(row.occurrences) }]));
}

/** Whether a value is one the owner restored in this source (status allowed): redactors leave it alone. One read for many values. */
export async function allowedMatcher(engine: BrainEngine, sourceId: string): Promise<(value: string) => boolean> {
  const rows = await engine.executeRaw<{ key_id: string; value_mac: string }>("SELECT key_id,value_mac FROM secret_store WHERE source_id=$1 AND status='allowed'", [sourceId]);
  return value => rows.some(row => { const key = keyById(row.key_id); return key !== null && macOf(key, value) === row.value_mac; });
}

/** True when this value is an entry the owner restored (status allowed): redactors leave it alone. */
export async function isAllowed(engine: BrainEngine, sourceId: string, value: string): Promise<boolean> {
  return (await allowedMatcher(engine, sourceId))(value);
}

/** Key ids entries were sealed with, by host, so a host can tell when another host sharing the database uses another key. */
export async function keysInUse(engine: BrainEngine): Promise<Array<{ key_id: string; key_host: string; entries: number }>> {
  const rows = await engine.executeRaw<{ key_id: string; key_host: string; entries: number | string }>(
    'SELECT key_id,key_host,count(*) AS entries FROM secret_store GROUP BY key_id,key_host ORDER BY key_id,key_host');
  return rows.map(row => ({ ...row, entries: Number(row.entries) }));
}

export type BackupEntryRow = EntryRow & { updated_at: string };
export interface BackupOccurrenceRow {
  entry_id: string; source_id: string; page_id: number | null; slug: string | null; field: string; origin: OccurrenceOrigin; commit_sha: string | null;
  path: string | null; line: number | null; pre_field_sha256: string | null; created_by: string; created_at: string;
}

/**
 * Every entry row as stored (ciphertext, never a value) and every occurrence row, for an encrypted backup (backup.ts).
 * One statement reads both, so they come from one snapshot: an entry sealed while the backup reads is in neither list.
 * A place on a page carries the slug of the page its page_id names now (a rename before occurrences moved with their
 * page left an older slug on the row), so a restore finds that page.
 */
export async function storeSnapshot(engine: BrainEngine): Promise<{ entries: BackupEntryRow[]; occurrences: BackupOccurrenceRow[] }> {
  const ts = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const [row] = await engine.executeRaw<{ entries: string; occurrences: string }>(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)::text FROM (SELECT id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,
      ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at FROM secret_store) e) AS entries,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) - 'ord' ORDER BY o.ord), '[]'::jsonb)::text FROM (SELECT oc.id AS ord,oc.entry_id,oc.source_id,oc.page_id,
      CASE WHEN oc.commit_sha IS NULL THEN coalesce(p.slug, oc.slug) ELSE oc.slug END AS slug,oc.field,oc.origin,oc.commit_sha,oc.path,oc.line,
      oc.pre_field_sha256,oc.created_by,${ts('oc.created_at')} AS created_at FROM secret_store_occurrence oc
      LEFT JOIN pages p ON p.id = oc.page_id AND p.source_id = oc.source_id) o) AS occurrences`);
  return { entries: JSON.parse(row!.entries) as BackupEntryRow[], occurrences: JSON.parse(row!.occurrences) as BackupOccurrenceRow[] };
}

/**
 * Writes backed-up entries the store does not hold (by id, and never over a row that holds the same value, so a local
 * row changed since the backup stays as it is), with the occurrences of the entries it wrote or already holds. A place
 * on a page (a slug and no commit) comes back only when the page at that slug holds the entry's marker (its segments
 * read when its body is stored in segments; locked FOR SHARE, and the place takes that checked page's id only while it
 * still holds the slug), so a restore never ties an original to a page that merely took its old slug. An
 * entry recorded only on pages is written only while one of those pages holds its marker, and an entry whose places
 * all failed to land (its page purged while the restore ran) is taken back out; otherwise it is not written
 * (`skipped_no_page`): the page was purged, is not synced yet, or was renamed before the backup named it by its
 * current slug, and a restore cannot tell which, so it never brings back an original a page purge removed. Sync the
 * pages, then run the same restore again; it adds what it skipped. An occurrence's page_id is the id of the page that
 * holds its slug now, never the backed-up number (a rebuilt brain numbers its pages in another order, and the purge
 * cascade trusts page_id); entries of a source this brain no longer has are skipped.
 */
export async function insertBackupRows(engine: BrainEngine, entries: BackupEntryRow[], occurrences: BackupOccurrenceRow[]): Promise<{ entries: number; occurrences: number; skipped_no_page: number }> {
  let written = 0, occ = 0, skippedNoPage = 0;
  const onPage = (o: BackupOccurrenceRow) => o.commit_sha === null && o.slug !== null;
  const byEntry = new Map<string, BackupOccurrenceRow[]>();
  for (const o of occurrences) byEntry.set(o.entry_id, [...(byEntry.get(o.entry_id) ?? []), o]);
  await engine.transaction(async tx => {
    for (const row of entries) {
      const own = byEntry.get(row.id) ?? [];
      const anchored = own.length === 0 || own.some(o => !onPage(o));
      const holding = await holdingSlugs(tx, row.source_id, [...new Set(own.filter(onPage).map(o => o.slug as string))], row.id);
      const inserted = anchored || holding.size ? await tx.executeRaw<{ id: string }>(`INSERT INTO secret_store (id,source_id,rule,ciphertext,nonce,tag,key_id,key_host,value_mac,status,created_at,updated_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz WHERE EXISTS (SELECT 1 FROM sources WHERE id=$2)
        ON CONFLICT DO NOTHING RETURNING id`,
      [row.id, row.source_id, row.rule, row.ciphertext, row.nonce, row.tag, row.key_id, row.key_host, row.value_mac, row.status, row.created_at, row.updated_at]) : [];
      if (inserted.length) written++;
      else {
        const [held] = await tx.executeRaw<{ same: boolean }>('SELECT (source_id=$2 AND value_mac=$3) AS same FROM secret_store WHERE id=$1', [row.id, row.source_id, row.value_mac]);
        if (!held && !anchored && !holding.size) skippedNoPage++;
        if (!held?.same) continue;
      }
      for (const o of own) {
        occ += (await tx.executeRaw(`INSERT INTO secret_store_occurrence (entry_id,source_id,page_id,slug,field,origin,commit_sha,path,line,pre_field_sha256,created_by,created_at)
          SELECT $1,$2,COALESCE($12::bigint,(SELECT id FROM pages WHERE source_id=$2 AND slug=$3)),$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz
          WHERE ($6::text IS NOT NULL OR $3::text IS NULL OR EXISTS (SELECT 1 FROM pages p WHERE p.id=$12::bigint AND p.source_id=$2 AND p.slug=$3))
            AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence x WHERE x.entry_id=$1 AND x.source_id=$2 AND x.slug IS NOT DISTINCT FROM $3 AND x.field=$4
              AND x.commit_sha IS NOT DISTINCT FROM $6 AND x.path IS NOT DISTINCT FROM $7 AND x.line IS NOT DISTINCT FROM $8::integer AND x.origin=$5
              AND x.pre_field_sha256 IS NOT DISTINCT FROM $9 AND x.created_by=$10 AND date_trunc('milliseconds', x.created_at) = $11::timestamptz) RETURNING 1`,
        [o.entry_id, o.source_id, o.slug, o.field, o.origin, o.commit_sha, o.path, o.line, o.pre_field_sha256, o.created_by, o.created_at, o.slug === null ? null : holding.get(o.slug) ?? null])).length;
      }
      if (!inserted.length || anchored) continue;
      if ((await tx.executeRaw('DELETE FROM secret_store s WHERE s.id=$1 AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id) RETURNING 1', [row.id])).length) {
        written--;
        skippedNoPage++;
      }
    }
  });
  return { entries: written, occurrences: occ, skipped_no_page: skippedNoPage };
}

/**
 * The backed-up slugs whose page in the source holds entry `id`'s marker now: pageHoldsSql for every store SQL reads,
 * and for a page whose body is stored in segments, its segments read in order (a marker split across two is found).
 */
async function holdingSlugs(tx: BrainEngine, sourceId: string, slugs: string[], id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!slugs.length) return out;
  const rows = await tx.executeRaw<{ id: number | string; slug: string; segmented: boolean; holds: boolean }>(
    `SELECT p.id, p.slug, p.body_storage = 'segmented' AS segmented, ${pageHoldsSql('p', '$3')} AS holds FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) FOR SHARE OF p`,
    [sourceId, slugs, id]);
  const holds = (text: string) => [...text.matchAll(/<REDACTED:[a-z0-9_]{1,64}:([^<>]+)>/g)].some((m) => m[1] === id);
  for (const page of rows) {
    if (page.holds) { out.set(page.slug, Number(page.id)); continue; }
    if (!page.segmented) continue;
    const decoder = new TextDecoder();
    let carry = '';
    for await (const part of readSegmentedBody(tx, Number(page.id), sourceId)) {
      const text = carry + decoder.decode(part.bytes, { stream: true });
      if (holds(text)) { out.set(page.slug, Number(page.id)); break; }
      carry = text.slice(-96);
    }
  }
  return out;
}

/**
 * The purge cascade: a page purged for good takes its sealed originals with it. Removes the page's occurrences (those
 * recorded on the page itself, not the ones a publish recorded on a commit), then every entry those occurrences pointed
 * at that no other page or commit still references. Called inside every hard delete (persistence/purge-slug-stores.ts).
 * An occurrence whose page_id names a live page outside the purged set stays: its slug is stale (a rename before
 * moveSlugBindings moved occurrence slugs), and the original belongs to that page.
 */
export async function purgeSecretsForSlugs(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slugs: readonly string[], onPages: readonly string[] = []): Promise<{ occurrences: number; entries: number }> {
  const gone = await engine.executeRaw<{ entry_id: string }>(
    `DELETE FROM secret_store_occurrence o WHERE o.source_id=$1 AND o.commit_sha IS NULL AND (o.id::text = ANY($3::text[]) OR (o.slug = ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = o.page_id AND NOT (p.source_id = $1 AND p.slug = ANY($2::text[]))))) RETURNING o.entry_id`, [sourceId, [...slugs], [...onPages]]);
  if (!gone.length) return { occurrences: 0, entries: 0 };
  const ids = [...new Set(gone.map(g => g.entry_id))].sort();
  await engine.executeRaw('SELECT id FROM secret_store WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
  const entries = await engine.executeRaw(`DELETE FROM secret_store s WHERE s.id = ANY($1::text[])
    AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id) RETURNING 1`, [ids]);
  return { occurrences: gone.length, entries: entries.length };
}

/** Entries no page or commit references any more (doctor). */
export async function unreferencedEntryCount(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(
    'SELECT count(*) AS n FROM secret_store s WHERE NOT EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.entry_id=s.id)');
  return Number(row?.n ?? 0);
}

export { keyIdOf };
