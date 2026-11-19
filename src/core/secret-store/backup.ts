/**
 * Encrypted backups of the secret store (GST-2988 PR 3).
 *
 * The store lives in the brain's database, so every database backup already carries it. When the owner configured a
 * `storage` backend for files (Supabase, S3 or local, src/core/storage.ts), `gbrain secrets backup` and the maintenance
 * pass after new entries also upload one encrypted export there: every entry row (already sealed, never a value) and
 * its occurrence metadata, as one JSON document sealed again with AES-256-GCM under the current store key, so no slug,
 * path or rule reaches the bucket in clear. The key never goes there: a backup restores only on a host whose keyring
 * holds the key it names (import the escrow copy first). A failed upload never stops a push; the next maintenance pass
 * tries again, and doctor reports the last success. With no backend nothing is uploaded and doctor says the database
 * backup carries the store.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { gbrainPath, loadConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import type { StorageBackend, StorageConfig } from '../storage.ts';
import { currentKey, keyById, storeHost } from './keyring.ts';
import { insertBackupRows, openEntry, storeSnapshot, type BackupEntryRow, type BackupOccurrenceRow } from './store.ts';

export const BACKUP_OBJECT_PREFIX = 'gbrain-secret-store/';
const KIND = 'gbrain-secret-store-backup';

interface BackupDocument { kind: typeof KIND; version: 1; key_id: string; created_at: string; host: string; nonce: string; tag: string; ciphertext: string }
interface BackupBody { entries: BackupEntryRow[]; occurrences: BackupOccurrenceRow[] }

export interface BackupStatus {
  last_success: { at: string; object: string; entries: number; occurrences: number; key_id: string; high_water?: string | null; places?: string; backend?: string } | null;
  last_failure: { at: string; message: string } | null;
}

export const backupStatusFile = () => gbrainPath('secret-store', 'backup-status.json');

export function readBackupStatus(): BackupStatus {
  try {
    const parsed = JSON.parse(readFileSync(backupStatusFile(), 'utf8')) as Partial<BackupStatus>;
    return { last_success: parsed.last_success ?? null, last_failure: parsed.last_failure ?? null };
  } catch { return { last_success: null, last_failure: null }; }
}

function writeBackupStatus(status: BackupStatus): void {
  mkdirSync(dirname(backupStatusFile()), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(backupStatusFile(), JSON.stringify(status, null, 2) + '\n');
  chmodSync(backupStatusFile(), 0o600);
}

const aad = (keyId: string, createdAt: string) => Buffer.from(`${KIND}-v1\0${keyId}\0${createdAt}`);

/**
 * Names a storage backend by kind, bucket and where it lives (endpoint or project host, local path), never by its
 * credentials, so the backup status can tell a backend it wrote to from one it never did.
 */
export function storageIdentity(config: Pick<StorageConfig, 'backend' | 'bucket'> & Partial<Pick<StorageConfig, 'endpoint' | 'projectUrl' | 'localPath'>>): string {
  const host = (url?: string) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
  return [config.backend, config.bucket, host(config.endpoint) || host(config.projectUrl), config.localPath ?? ''].join(':').replace(/:+$/, '');
}

/** The storage backend the owner configured for files with its identity, or null when there is none. */
export async function configuredStorage(): Promise<{ storage: StorageBackend; identity: string } | null> {
  const config = loadConfig()?.storage as StorageConfig | undefined;
  if (!config) return null;
  const { createStorage } = await import('../storage.ts');
  return { storage: await createStorage(config), identity: storageIdentity(config) };
}

export interface BackupResult { object: string; entries: number; occurrences: number; key_id: string }

function recordFailure(error: unknown): void {
  writeBackupStatus({ ...readBackupStatus(), last_failure: { at: new Date().toISOString(), message: (error instanceof Error ? error.message : String(error)).slice(0, 300) } });
}

/**
 * The maintenance step: with a storage backend configured and the store changed since the last success to it, uploads
 * one backup. A host with no store key skips (it never makes one just to back up; doctor says why). Returns whether it
 * uploaded; a failure (the backend included) is recorded for doctor and the next pass tries again.
 */
export async function backupIfDue(engine: BrainEngine): Promise<boolean> {
  let configured: Awaited<ReturnType<typeof configuredStorage>>;
  try { configured = await configuredStorage(); } catch (error) { recordFailure(error); return false; }
  if (!configured || !currentKey({ create: false }) || !await backupDue(engine, configured.identity)) return false;
  try { await backupStore(engine, configured.storage, configured.identity); return true; } catch { return false; }
}

/**
 * Uploads one encrypted export of the whole store, sealed under this host's current key, and records it as the last
 * success to `backend` (or the failure, then throws). It never creates a key: a host without one is refused.
 */
export async function backupStore(engine: BrainEngine, storage: StorageBackend, backend?: string): Promise<BackupResult> {
  const key = currentKey({ create: false });
  if (!key) {
    throw opError('secret_store_key_missing', 'This host has no secret store key, so nothing was backed up (a backup is sealed under an existing key and never makes one).',
      'Import the key the store uses with gbrain secrets key import <file> --passphrase-stdin, or set GBRAIN_SECRET_STORE_KEY, then run the backup again.');
  }
  try {
    const body: BackupBody = await storeSnapshot(engine);
    const createdAt = new Date().toISOString();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(key.id, createdAt));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
    const doc: BackupDocument = { kind: KIND, version: 1, key_id: key.id, created_at: createdAt, host: storeHost(), nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const object = `${BACKUP_OBJECT_PREFIX}${createdAt.replace(/[:.]/g, '-')}.json`;
    await storage.upload(object, Buffer.from(JSON.stringify(doc) + '\n', 'utf8'), 'application/json');
    const result = { object, entries: body.entries.length, occurrences: body.occurrences.length, key_id: key.id };
    const highWater = [...body.entries.flatMap(row => [row.created_at, row.updated_at]), ...body.occurrences.map(o => o.created_at)]
      .reduce<string | null>((max, t) => (!max || t > max ? t : max), null);
    writeBackupStatus({ last_success: { at: createdAt, ...result, high_water: highWater, places: placesOf(body.occurrences), ...(backend ? { backend } : {}) }, last_failure: null });
    return result;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

/**
 * True when no backup ever succeeded to `backend` (the last success went to another backend, or names none), or the
 * store changed since: an entry or an occurrence (a new place an existing original was redacted) newer than the newest
 * row that backup held, or a different number of entries or occurrences, or an occurrence moved (a rename). Both sides are database timestamps, so a host
 * clock ahead of the database's does not hide a change.
 */
/** A digest of where every occurrence is, so a rename (which moves occurrences and changes no count or time) is a change. */
function placesOf(occurrences: BackupOccurrenceRow[]): string {
  return createHash('sha256').update(occurrences.map(o => [o.entry_id, o.source_id, o.slug, o.commit_sha, o.path, o.line, o.field].join('\u0000')).sort().join('\n')).digest('hex');
}

export async function backupDue(engine: BrainEngine, backend?: string): Promise<boolean> {
  const { entries, occurrences } = await storeSnapshot(engine);
  if (!entries.length) return false;
  const success = readBackupStatus().last_success;
  const last = success ? success.high_water ?? success.at : undefined;
  if (!success || !last || (backend !== undefined && success.backend !== backend)) return true;
  if (entries.length !== success.entries || occurrences.length !== success.occurrences || success.places !== placesOf(occurrences)) return true;
  return entries.some(row => row.created_at > last || row.updated_at > last) || occurrences.some(o => o.created_at > last);
}

export interface RestoreResult { object: string; key_id: string; inserted: number; existing: number; skipped_no_page: number; unreadable: string[]; occurrences: number }

export const SKIPPED_NO_PAGE_TEXT = 'skipped because no page in this brain holds their marker (purged, or not synced yet)';
export const SKIPPED_NO_PAGE_NEXT = 'Sync the pages, then run the same restore again.';

/**
 * Imports the entries of one backup object that the store does not hold. Each row must authenticate under a key on
 * this host before it is written; a row that does not is listed and skipped, never written. A backup whose every entry
 * is skipped because its page is not in this brain (a rebuilt brain before sync) refuses, so a script never reads it as a
 * finished restore.
 */
export async function restoreBackup(engine: BrainEngine, storage: StorageBackend, object: string): Promise<RestoreResult> {
  if (!object.startsWith(BACKUP_OBJECT_PREFIX) || object.includes('..')) {
    throw opError('invalid_params', `${JSON.stringify(object)} is not a secret store backup object; nothing was restored.`, `Pass an object name under ${BACKUP_OBJECT_PREFIX} that gbrain secrets backup printed.`);
  }
  let doc: BackupDocument;
  try { doc = JSON.parse((await storage.download(object)).toString('utf8')) as BackupDocument; } catch (error) {
    throw opError('not_found', `Backup ${object} could not be read from the storage backend (${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}); nothing was restored.`,
      'Check the object name and the storage backend in the gbrain config, then run the restore again.');
  }
  if (doc?.kind !== KIND || doc.version !== 1) throw opError('invalid_params', `${object} is not a gbrain secret store backup; nothing was restored.`, 'Pass an object gbrain secrets backup wrote.');
  const key = keyById(doc.key_id);
  if (!key) {
    throw opError('secret_store_key_missing', `Backup ${object} is sealed with key ${doc.key_id}, which is not on this host; nothing was restored.`,
      'Import that key first with gbrain secrets key import <file> --passphrase-stdin, then run the restore again.');
  }
  let body: BackupBody;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(doc.key_id, doc.created_at));
    decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
    body = JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as BackupBody;
  } catch {
    throw opError('secret_store_key_mismatch', `Backup ${object} does not authenticate under key ${doc.key_id}: it was changed or damaged, so nothing was restored.`, 'Restore an older backup object.');
  }
  const unreadable: string[] = [];
  const verified = body.entries.filter(row => {
    try { openEntry(row); return true; } catch { unreadable.push(row.id); return false; }
  });
  const written = await insertBackupRows(engine, verified, body.occurrences);
  if (body.entries.length && written.skipped_no_page === body.entries.length) {
    throw opError('invalid_params', `Nothing was restored from ${object}: all ${written.skipped_no_page} entr${written.skipped_no_page === 1 ? 'y was' : 'ies were'} ${SKIPPED_NO_PAGE_TEXT}.`, SKIPPED_NO_PAGE_NEXT);
  }
  return { object, key_id: doc.key_id, inserted: written.entries, existing: verified.length - written.entries - written.skipped_no_page, skipped_no_page: written.skipped_no_page, unreadable, occurrences: written.occurrences };
}
