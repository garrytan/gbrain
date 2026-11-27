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
import { purgeSecretOccurrences } from '../engine-sql/secret-store.ts';
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
  const found = await engine.findSecretEntryByMac(input.sourceId, mac);
  if (found) return { id: found, created: false, key_id: key.id, ...(key.created ? { key_created: key.id } : {}) };
  const id = `ss_${randomBytes(6).toString('hex')}`;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(id, input.sourceId, input.rule));
  const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  const inserted = await engine.insertSecretEntry({ id, sourceId: input.sourceId, rule: input.rule, ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), keyId: key.id, keyHost: storeHost(), valueMac: mac }, 'value');
  const winner = inserted ?? await engine.findSecretEntryByMac(input.sourceId, mac);
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
  if (await engine.secretEntryExists(input.id)) return { kind: 'exists' };
  const held = await engine.findSecretEntryByMac(input.sourceId, mac);
  if (held) return { kind: 'duplicate', existing: held };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(input.id, input.sourceId, input.rule));
  const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  const inserted = await engine.insertSecretEntry({ id: input.id, sourceId: input.sourceId, rule: input.rule, ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), keyId: key.id, keyHost: storeHost(), valueMac: mac }, 'any');
  if (inserted) return { kind: 'inserted' };
  const winner = await engine.findSecretEntryByMac(input.sourceId, mac);
  return winner && winner !== input.id ? { kind: 'duplicate', existing: winner } : { kind: 'exists' };
}

export interface OccurrenceInput {
  entryId: string; sourceId: string; pageId?: number | null; slug?: string | null; field: string; origin: OccurrenceOrigin;
  commit?: string | null; path?: string | null; line?: number | null; preFieldSha256?: string | null; createdBy?: string;
}

export async function recordOccurrence(engine: BrainEngine, o: OccurrenceInput): Promise<void> {
  await engine.insertSecretOccurrence({ entryId: o.entryId, sourceId: o.sourceId, pageId: o.pageId ?? null, slug: o.slug ?? null, field: o.field, origin: o.origin,
    commit: o.commit ?? null, path: o.path ?? null, line: o.line ?? null, preFieldSha256: o.preFieldSha256 ?? null, createdBy: o.createdBy ?? '' });
}

export async function entryRow(engine: BrainEngine, id: string): Promise<EntryRow> {
  if (!ENTRY_ID.test(id)) throw opError('invalid_params', `${JSON.stringify(id)} is not a secret store id (ss_ followed by 12 hex).`, 'Copy the id (ss_ then 12 hex) from the end of the marker in the page, or from gbrain secrets list.');
  const row = await engine.readSecretEntry(id);
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
  return engine.listSecretOccurrences(id);
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
  const rows = await engine.listSecretEntrySummaries({ sourceId: filter.sourceId ?? null, slug: filter.slug ?? null, limit: filter.limit ?? 1000 });
  return rows.map(row => ({ ...row, slugs: row.slugs.filter(Boolean).sort(), readable: keyById(row.key_id) !== null }));
}

/** Entries and occurrences per rule, never a value. */
export async function countsByRule(engine: BrainEngine, sourceId?: string): Promise<Record<string, { entries: number; occurrences: number }>> {
  const rows = await engine.countSecretsByRule(sourceId ?? null);
  return Object.fromEntries(rows.map(row => [row.rule, { entries: row.entries, occurrences: row.occurrences }]));
}

/** Whether a value is one the owner restored in this source (status allowed): redactors leave it alone. One read for many values. */
export async function allowedMatcher(engine: BrainEngine, sourceId: string): Promise<(value: string) => boolean> {
  const rows = await engine.listAllowedSecretMacs(sourceId);
  return value => rows.some(row => { const key = keyById(row.key_id); return key !== null && macOf(key, value) === row.value_mac; });
}

/** True when this value is an entry the owner restored (status allowed): redactors leave it alone. */
export async function isAllowed(engine: BrainEngine, sourceId: string, value: string): Promise<boolean> {
  return (await allowedMatcher(engine, sourceId))(value);
}

/** Key ids entries were sealed with, by host, so a host can tell when another host sharing the database uses another key. */
export async function keysInUse(engine: BrainEngine): Promise<Array<{ key_id: string; key_host: string; entries: number }>> {
  return engine.listSecretKeysInUse();
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
  return engine.readSecretStoreSnapshot();
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
      const inserted = anchored || holding.size ? await tx.insertBackupSecretEntry(row) : false;
      if (inserted) written++;
      else {
        const same = await tx.readBackupEntryHold(row.id, row.source_id, row.value_mac);
        if (same === null && !anchored && !holding.size) skippedNoPage++;
        if (!same) continue;
      }
      for (const o of own) {
        if (await tx.insertBackupSecretOccurrence(o, o.slug === null ? null : holding.get(o.slug) ?? null)) occ++;
      }
      if (!inserted || anchored) continue;
      if (await tx.deleteUnreferencedSecretEntry(row.id)) {
        written--;
        skippedNoPage++;
      }
    }
  });
  return { entries: written, occurrences: occ, skipped_no_page: skippedNoPage };
}

/**
 * The backed-up slugs whose page in the source holds entry `id`'s marker now: the page's inline columns, raw data, timeline entries, takes, link contexts and facts (engine-sql/secret-store.ts listSecretHoldingPages),
 * and for a page whose body is stored in segments, its segments read in order (a marker split across two is found).
 */
async function holdingSlugs(tx: BrainEngine, sourceId: string, slugs: string[], id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!slugs.length) return out;
  const rows = await tx.listSecretHoldingPages(sourceId, slugs, id);
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
  return purgeSecretOccurrences(engine, sourceId, slugs, onPages);
}

/** Entries no page or commit references any more (doctor). */
export async function unreferencedEntryCount(engine: BrainEngine): Promise<number> {
  return engine.countUnreferencedSecretEntries();
}

export { keyIdOf };
