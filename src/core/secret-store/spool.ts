/**
 * The secret store's local spool (GST-2988 D9). A publish that redacts unpushed commits keeps each original in the
 * secret store; when the store cannot be written (no brain on this machine, a PGLite brain another process holds, a
 * database that refuses the row), the original goes here instead, encrypted with the same store key: one file per entry
 * at ~/.gbrain/secret-store/spool/<id>.json (directory 0700, file 0600, written by rename), with the checkout it came
 * from and every place its marker went. The push then goes. drainSpool moves entries into the store under the same id
 * (maintenance and a publish that has the database both run it); an entry stays until the store holds it. A value the
 * store already holds under another id (a redaction elsewhere sealed it first) cannot take a second row, so its file
 * stays and gbrain secrets reveal reads it from here.
 *
 * A publish seals here first, always: it runs without the database (a child process, or a PGLite brain the owner
 * holds), and the owner drains the spool right after the push. Values the owner restored (store status `allowed`) are
 * mirrored in allowed.json beside the spool (key id and value MAC only), refreshed by every restore and every drain, so
 * a publish without the database still leaves them alone.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { gbrainPath } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { currentKey, keyById, macKeyOf } from './keyring.ts';

export const spoolDir = () => gbrainPath('secret-store', 'spool');
const allowedFile = () => gbrainPath('secret-store', 'allowed.json');

export interface SpoolOccurrence { commit: string | null; path: string | null; line: number | null; field: string }
export interface SpoolEntry {
  v: 1; id: string; root: string; source_id: string | null; rule: string; key_id: string; nonce: string; tag: string; ciphertext: string;
  value_mac: string; occurrences: SpoolOccurrence[]; created_at: string; duplicate_of?: string;
}

const aad = (id: string, root: string, rule: string) => Buffer.from(`gbrain-secret-spool-v1\0${id}\0${root}\0${rule}`);
const macOf = (key: Buffer, value: string) => createHmac('sha256', macKeyOf(key)).update(value, 'utf8').digest('hex');
const fileOf = (id: string) => join(spoolDir(), `${id}.json`);

export function readSpool(): SpoolEntry[] {
  let names: string[] = [];
  try { names = readdirSync(spoolDir()).filter(name => /^ss_[0-9a-f]{12}\.json$/.test(name)).sort(); } catch { return []; }
  return names.flatMap(name => {
    try { const entry = JSON.parse(readFileSync(join(spoolDir(), name), 'utf8')) as SpoolEntry; return entry?.v === 1 ? [entry] : []; }
    catch { return []; }
  });
}

function writeEntry(entry: SpoolEntry): void {
  mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(entry.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  renameSync(tmp, fileOf(entry.id));
}

/**
 * Spools one value from checkout root (one entry per root and value) and returns its id. Throws secret_store_unwritable
 * when no file can be written (D9a: the caller holds the push).
 */
export function spoolValue(input: { root: string; sourceId: string | null; rule: string; value: string }): string {
  try {
    const key = currentKey({ create: true })!;
    const mac = macOf(key.key, input.value);
    const found = readSpool().find(entry => entry.root === input.root && entry.key_id === key.id && entry.value_mac === mac);
    if (found) return found.id;
    const id = `ss_${randomBytes(6).toString('hex')}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(id, input.root, input.rule));
    const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
    writeEntry({ v: 1, id, root: input.root, source_id: input.sourceId, rule: input.rule, key_id: key.id, nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), value_mac: mac, occurrences: [], created_at: new Date().toISOString() });
    return id;
  } catch (error) {
    if ((error as { code?: string }).code === 'secret_store_key_missing') throw error;
    throw opError('secret_store_unwritable', `Neither the secret store nor its local spool (${spoolDir()}) could keep an original value, so nothing was redacted or pushed.`,
      `Check that ${spoolDir()} is writable by this user and the disk has room (${(error as Error).message.slice(0, 200)}), then retry the push.`);
  }
}

/** Mirrors the store's restored values (key id and value MAC, never a value) for publishes without the database. */
export async function refreshAllowedCache(engine: BrainEngine): Promise<void> {
  const rows = await engine.listAllowedSecretMacs(null);
  mkdirSync(gbrainPath('secret-store'), { recursive: true, mode: 0o700 });
  const tmp = `${allowedFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows.map(r => ({ key_id: r.key_id, value_mac: r.value_mac })))}\n`, { mode: 0o600 });
  renameSync(tmp, allowedFile());
}

/** True when the owner restored this value (the allowed.json mirror); false when there is no mirror. */
export function allowedLocally(value: string): boolean {
  let rows: Array<{ key_id: string; value_mac: string }> = [];
  try { rows = JSON.parse(readFileSync(allowedFile(), 'utf8')); } catch { return false; }
  return Array.isArray(rows) && rows.some(row => { const key = keyById(row.key_id); return key !== null && macOf(key, value) === row.value_mac; });
}

/** Adds occurrences (the rebuilt commit and path a marker landed in) to a spooled entry. */
export function addSpoolOccurrences(id: string, occurrences: SpoolOccurrence[]): void {
  const entry = readSpool().find(e => e.id === id);
  if (entry && occurrences.length) writeEntry({ ...entry, occurrences: [...entry.occurrences, ...occurrences] });
}

/** Spooled originals not yet in the store (a duplicate of a stored value is not counted). */
export function undrainedCount(): number {
  return readSpool().filter(entry => !entry.duplicate_of).length;
}

/** The original of one spooled entry, or null when this host has no such entry. */
export function openSpooled(id: string): { entry: SpoolEntry; value: string } | null {
  const entry = readSpool().find(e => e.id === id);
  if (!entry) return null;
  const key = keyById(entry.key_id);
  if (!key) throw opError('secret_store_key_missing', `The key ${entry.key_id} that sealed spooled entry ${id} is not on this host.`, 'Run gbrain secrets key status to see the keys this host can read.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(entry.id, entry.root, entry.rule));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    const value = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    if (macOf(key, value) !== entry.value_mac) throw new Error('mac');
    return { entry, value };
  } catch {
    throw opError('secret_store_key_mismatch', `Spooled entry ${id} does not authenticate under key ${entry.key_id}, so its original is not returned.`, `Check ${fileOf(id)}; a spool file must not be edited or moved.`);
  }
}

/**
 * Moves every spooled entry whose checkout a source of this brain uses into the store under its own id, with its
 * occurrences, and deletes the file. Returns how many moved and how many stay (a key this host lacks, a checkout no
 * source uses; a value the store holds under another id stays as a duplicate and is not counted).
 */
export async function drainSpool(engine: BrainEngine): Promise<{ moved: number; remaining: number }> {
  const entries = readSpool().filter(entry => !entry.duplicate_of);
  if (!entries.length) return { moved: 0, remaining: 0 };
  await refreshAllowedCache(engine).catch(() => undefined);
  const { sealWithId, recordOccurrence, entryRow, openEntry } = await import('./store.ts');
  const { sourceForPath } = await import('../git/redact-finish.ts');
  let moved = 0;
  for (const entry of entries) {
    let opened: ReturnType<typeof openSpooled>;
    try { opened = openSpooled(entry.id); } catch { continue; }
    if (!opened) continue;
    const sourceId = entry.source_id ?? await sourceForPath(engine, entry.root, entry.occurrences.find(o => o.line !== null)?.path ?? null);
    if (!sourceId) continue;
    const outcome = await sealWithId(engine, { id: entry.id, sourceId, rule: entry.rule, value: opened.value });
    if (outcome.kind === 'duplicate') {
      for (const o of entry.occurrences) {
        await recordOccurrence(engine, { entryId: outcome.existing, sourceId, field: o.field, origin: 'publish_rebuild', commit: o.commit, path: o.path, line: o.line, createdBy: 'publish redact (spooled)' });
      }
      writeEntry({ ...entry, duplicate_of: outcome.existing });
      continue;
    }
    if (outcome.kind === 'inserted') {
      for (const o of entry.occurrences) {
        await recordOccurrence(engine, { entryId: entry.id, sourceId, field: o.field, origin: 'publish_rebuild', commit: o.commit, path: o.path, line: o.line, createdBy: 'publish redact (spooled)' });
      }
    }
    // The file goes only once the store row reads back and opens to the same original.
    let stored: string;
    try { stored = openEntry(await entryRow(engine, entry.id)); } catch { continue; }
    if (stored !== opened.value) continue;
    try { unlinkSync(fileOf(entry.id)); } catch { /* already gone */ }
    moved++;
  }
  return { moved, remaining: readSpool().filter(entry => !entry.duplicate_of).length };
}
