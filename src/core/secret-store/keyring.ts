/**
 * The secret store's keys (GST-2988). A key never enters the database, the repository or a backup bucket.
 *
 * Self-hosted brains keep a keyring at `~/.gbrain/secret-store/keys/<key_id>.key` (32 random bytes, base64, mode
 * 0600) with `current` naming the key new entries use. A key file is created exclusively and never overwritten:
 * when the current key is missing, unreadable or readable by others, a new key is added and becomes current, and the
 * old file stays where it is, so entries it sealed read again once it is fixed or its escrow copy is imported.
 * `GBRAIN_SECRET_STORE_KEY` (32 bytes, base64) overrides the keyring for containers, fleets that share one database
 * and hosted deployments; with it set, the keyring is never written.
 *
 * `key_id` is the first 16 hex of HMAC-SHA256(key, "gbrain-secret-store-key-id"); entries record it so a wrong or
 * missing key is named instead of failing as corrupt data. The value MAC key is derived from the store key with
 * HKDF, so the database holds no unkeyed hash of a value. Escrow export wraps one key with a passphrase (scrypt
 * N=2^15, r=8, p=1, AES-256-GCM; the parameters of src/core/creds/export.ts).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { gbrainPath } from '../config.ts';
import { opError } from '../ops/contract.ts';

export const SECRET_STORE_KEY_ENV = 'GBRAIN_SECRET_STORE_KEY';
const KEY_BYTES = 32;
const KEY_ID = /^[0-9a-f]{16}$/;

export interface StoreKey { id: string; key: Buffer; origin: 'env' | 'keyring' }
export interface KeyringStatus {
  origin: 'env' | 'keyring' | 'none';
  current: string | null;
  keys: Array<{ id: string; readable: boolean; mode_ok: boolean }>;
  dir: string;
}

export const keyringDir = () => gbrainPath('secret-store', 'keys');
export const keyIdOf = (key: Buffer) => createHmac('sha256', key).update('gbrain-secret-store-key-id').digest('hex').slice(0, 16);
export const macKeyOf = (key: Buffer) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'gbrain-secret-store-value-mac', 32));
export const storeHost = () => hostname().slice(0, 200);

function envKey(): StoreKey | null {
  const raw = process.env[SECRET_STORE_KEY_ENV]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw opError('secret_store_key_missing', `${SECRET_STORE_KEY_ENV} is set but is not 32 bytes of base64, so no secret could be sealed or read with it.`,
      `Set ${SECRET_STORE_KEY_ENV} to the base64 of 32 random bytes (openssl rand -base64 32), or unset it to use the keyring at ${keyringDir()}.`);
  }
  return { id: keyIdOf(key), key, origin: 'env' };
}

/** A keyring file's key, or null when it is missing, unreadable, malformed or readable by group or others. */
function readKeyFile(id: string): Buffer | null {
  const file = join(keyringDir(), `${id}.key`);
  try {
    const mode = statSync(file).mode;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) return null;
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    return key.length === KEY_BYTES && keyIdOf(key) === id ? key : null;
  } catch { return null; }
}

function currentId(): string | null {
  try {
    const id = readFileSync(join(keyringDir(), 'current'), 'utf8').trim();
    return KEY_ID.test(id) ? id : null;
  } catch { return null; }
}

/** Writes a new key file exclusively (never over an existing file) and points `current` at it. */
function addKey(key: Buffer): string {
  const dir = keyringDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = keyIdOf(key);
  const file = join(dir, `${id}.key`);
  if (!existsSync(file)) {
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, `${key.toString('base64')}\n`); } finally { closeSync(fd); }
  }
  atomicWriteFileSync(join(dir, 'current'), `${id}\n`);
  return id;
}

/**
 * The key new entries are sealed with. With `create`, a keyring whose current key is missing or unusable gets a new
 * key (D9: the push goes on); `created` then names it so the caller reports it.
 */
export function currentKey(opts: { create: boolean }): (StoreKey & { created?: true }) | null {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  const id = currentId();
  const key = id ? readKeyFile(id) : null;
  if (id && key) return { id, key, origin: 'keyring' };
  if (!opts.create) return null;
  const fresh = randomBytes(KEY_BYTES);
  return { id: addKey(fresh), key: fresh, origin: 'keyring', created: true };
}

/** The key with this id from the env override or the keyring, or null. */
export function keyById(id: string): Buffer | null {
  if (!KEY_ID.test(id)) return null;
  const fromEnv = envKey();
  if (fromEnv?.id === id) return fromEnv.key;
  return readKeyFile(id);
}

export function keyringStatus(): KeyringStatus {
  const dir = keyringDir();
  const fromEnv = envKey();
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => /^[0-9a-f]{16}\.key$/.test(name)); } catch { /* no keyring yet */ }
  const keys = names.sort().map(name => {
    const id = name.slice(0, 16);
    let modeOk = false;
    try { modeOk = process.platform === 'win32' || (statSync(join(dir, name)).mode & 0o077) === 0; } catch { /* unreadable */ }
    return { id, readable: readKeyFile(id) !== null, mode_ok: modeOk };
  });
  return { origin: fromEnv ? 'env' : currentId() ? 'keyring' : 'none', current: fromEnv?.id ?? currentId(), keys, dir };
}

const ESCROW_KIND = 'gbrain-secret-store-key';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

export interface KeyEscrow { kind: typeof ESCROW_KIND; version: 1; key_id: string; salt: string; iv: string; tag: string; ciphertext: string }

export function exportKeyEscrow(id: string, passphrase: string): KeyEscrow {
  const key = keyById(id);
  if (!key) throw opError('secret_store_key_missing', `No readable key ${id} in ${SECRET_STORE_KEY_ENV} or the keyring, so nothing was exported.`, 'Run gbrain secrets key status to see the keys this host can read.');
  if (passphrase.length < 12) throw opError('invalid_params', 'The escrow passphrase must be at least 12 characters; nothing was exported.', 'Pipe a longer passphrase on stdin.');
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, SCRYPT), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${ESCROW_KIND}:${id}`));
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return { kind: ESCROW_KIND, version: 1, key_id: id, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/** Records that a key's escrow copy was exported (a stamp file beside the keyring), so doctor stops warning about it. */
export function markEscrowExported(id: string): void {
  if (!KEY_ID.test(id)) return;
  mkdirSync(keyringDir(), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(keyringDir(), `${id}.escrowed`), `${new Date().toISOString()}\n`);
}

/** Key ids whose escrow copy this host exported. */
export function escrowExported(): Set<string> {
  try { return new Set(readdirSync(keyringDir()).filter(name => /^[0-9a-f]{16}\.escrowed$/.test(name)).map(name => name.slice(0, 16))); } catch { return new Set(); }
}

/** Adds an escrowed key to the keyring (never over an existing file) and returns its id; it becomes current only when none is. */
export function importKeyEscrow(escrow: KeyEscrow, passphrase: string): string {
  if (escrow?.kind !== ESCROW_KIND || escrow.version !== 1 || !KEY_ID.test(escrow.key_id)) {
    throw opError('invalid_params', 'Not a gbrain secret-store key escrow file; nothing was imported.', 'Pass the file gbrain secrets key export wrote.');
  }
  let key: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(escrow.salt, 'base64'), 32, SCRYPT), Buffer.from(escrow.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${ESCROW_KIND}:${escrow.key_id}`));
    decipher.setAuthTag(Buffer.from(escrow.tag, 'base64'));
    key = Buffer.concat([decipher.update(Buffer.from(escrow.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw opError('invalid_params', 'Wrong passphrase or a damaged escrow file; nothing was imported.', 'Check the passphrase and the file, then run the import again.');
  }
  if (key.length !== KEY_BYTES || keyIdOf(key) !== escrow.key_id) throw opError('invalid_params', 'The escrow file holds a different key than it names; nothing was imported.', 'Use the original file gbrain secrets key export wrote.');
  const dir = keyringDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${escrow.key_id}.key`);
  if (!existsSync(file)) {
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, `${key.toString('base64')}\n`); } finally { closeSync(fd); }
  }
  if (!currentId()) atomicWriteFileSync(join(dir, 'current'), `${escrow.key_id}\n`);
  return escrow.key_id;
}
