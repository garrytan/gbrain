import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { flushDirectory } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { sha256 } from './digest.ts';
import type { Principal, SqlEngine } from './model.ts';
import { acquireNativeLock } from './native-lock.ts';

export interface LocalRegistration { id: string; credential: string; lane: 'cli' | 'stdio'; }
export interface LocalGrant { sourceIds: string[]; operations: string[] | null; scopes: string[]; slugPrefixes: string[] | null; }
export interface VerifiedLocalWriter { principal: Principal; grant: LocalGrant; remote: boolean; }
const verifiedLocalWriter = new AsyncLocalStorage<VerifiedLocalWriter>();
export function currentVerifiedLocalWriter(): VerifiedLocalWriter | undefined { return verifiedLocalWriter.getStore(); }
/** Only the server's credential verifier enters this context; wire data cannot set trust. */
export async function withVerifiedLocalRegistration<T>(engine: SqlEngine, registration: LocalRegistration,
  run: (writer: VerifiedLocalWriter) => Promise<T>): Promise<T> {
  const writer = await verifyLocalWriter(engine, registration);
  return verifiedLocalWriter.run(writer, () => run(writer));
}
const registrationsFix = () => readFix('Lists this brain\'s local writer registrations with lane, grant and revocation state, read-only.',
  { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] });
const doctorFix = (why: string) => readFix(why, { argv: ['gbrain', 'doctor', '--json'] });
function invalidIdentityFile(message: string, path: string, what: string): OperationError {
  return opError('writer_identity_invalid', message,
    `${path} is not a valid ${what} document, so gbrain cannot use it; nothing was changed. Do not delete or regenerate it to force progress: a new identity orphans the ownership and pending writes recorded for the old one. Show the user the path; restoring it from a backup is their decision.`,
    { fix: doctorFix('Checks this installation\'s persistence identity and owner state without changing anything.') });
}
const credentialMismatch = (path: string, id: string, lane: string) => opError('permission_denied', 'Local writer credential does not match this registration.',
  `The private credential in ${path} does not match registration ${id} in this brain's database (the file was copied from another brain or host, or the database was restored), so nothing was registered. Do not overwrite either side: show the user the path; moving the file aside and running gbrain auth local-writer register ${lane} for a new principal is their decision.`,
  { fix: registrationsFix() });
const defaultGrant = (): LocalGrant => ({ sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
export function persistenceHome(): string { return join(configDir(), 'persistence'); }

/** Exclusive create keeps simultaneous installations on one identity without replacing it. */
function privateJson<T>(path: string, create: () => T): T {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T;
  mkdirSync(persistenceHome(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    const value = create();
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd);
    // Publish a fully flushed inode without replacing an existing identity.
    // O_EXCL on the final file alone exposes a partially written JSON document.
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } finally { closeSync(fd); unlinkSync(temporary); }
}
/**
 * #6317 (I1): where a `host.json` was minted, recorded at mint time only so
 * doctor `host_identity_mismatch` can say which `HOME`/`GBRAIN_HOME` each of
 * two identities came from. Optional on the version-1 document (both readers
 * reject any other version, so the version never changes); a file minted
 * before this release reads as `minted_under: null`, reported as unknown.
 */
export interface HostIdentityMintedUnder extends Record<string, unknown> { home: string | null; gbrain_home: string | null; hostname: string; machine_id: string | null }
export interface HostIdentityFile { version: number; id: string; minted_under?: HostIdentityMintedUnder }
export interface LocalHostIdentity { id: string; path: string; persistence_home: string; minted_under: HostIdentityMintedUnder | null }
const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
/** The stable machine id of a Linux host (`/etc/machine-id`), or null where none is readable (containers, macOS). */
export function readMachineId(): string | null {
  for (const file of MACHINE_ID_FILES) {
    try { const text = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{32}$/i.test(text)) return text.toLowerCase(); } catch { /* next candidate */ }
  }
  return null;
}
function mintedUnderNow(): HostIdentityMintedUnder {
  return { home: process.env.HOME ?? null, gbrain_home: process.env.GBRAIN_HOME ?? null, hostname: hostname(), machine_id: readMachineId() };
}
function readHostIdentity(path: string, create: boolean): HostIdentityFile | null {
  if (!create && !existsSync(path)) return null;
  const value = privateJson<HostIdentityFile>(path, () => ({ version: 1, id: randomUUID(), minted_under: mintedUnderNow() }));
  if (value.version !== 1 || typeof value.id !== 'string') throw invalidIdentityFile('The local writer identity is invalid.', path, 'host identity');
  return value;
}
export function localHostId(): string {
  return readHostIdentity(join(persistenceHome(), 'host.json'), true)!.id;
}
/** This process's host identity with its file path and mint metadata (minting the file when absent, as `localHostId` does). */
export function localHostIdentity(): LocalHostIdentity {
  const home = persistenceHome();
  const path = join(home, 'host.json');
  const value = readHostIdentity(path, true)!;
  const minted = value.minted_under;
  return { id: value.id, path, persistence_home: home,
    minted_under: minted && typeof minted === 'object' ? { home: minted.home ?? null, gbrain_home: minted.gbrain_home ?? null, hostname: String(minted.hostname ?? ''), machine_id: minted.machine_id ?? null } : null };
}
export function existingLocalHostId(): string | null {
  return readHostIdentity(join(persistenceHome(), 'host.json'), false)?.id ?? null;
}
async function brainIdentity(engine: SqlEngine): Promise<string> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) throw opError('writer_not_initialized', 'Persistence metadata has not been initialized.',
    'This brain\'s database has no persistence metadata row, which the schema migrations create, so no local writer can be registered or verified; nothing changed. Run gbrain doctor --json on the brain host; if it reports pending migrations, bring the schema current with gbrain apply-migrations, then run the command again.',
    { fix: doctorFix('Reports the schema version and any pending migrations of this brain, read-only.') });
  return brain.brain_id;
}
export async function registerLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant = defaultGrant(), replace = false): Promise<LocalRegistration> {
  const brain = await brainIdentity(engine);
  const path = join(persistenceHome(), `${brain}.${lane}.json`);
  if (!replace) return ensureLocalWriter(engine, lane, grant, path);
  const lock = await acquireNativeLock(join(persistenceHome(), 'locks', `${brain}.${lane}.registration.lock`), { timeoutMs: 5000 });
  if (!lock) throw opError('writer_lock_unavailable', 'Local writer registration is busy.',
    `Another process held the ${lane} writer registration lock of this brain for 5 seconds while registering or replacing it, so nothing changed. Check the registrations with the command in fix, then run the registration again only if it is still needed.`,
    { fix: registrationsFix() });
  try {
    if (existsSync(path)) return await rotateLocalWriter(engine, lane, grant, path);
    return await ensureLocalWriter(engine, lane, grant, path);
  } finally { await lock.release(); }
}

async function ensureLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant: LocalGrant, path: string): Promise<LocalRegistration> {
  const local = privateJson<LocalRegistration>(path, () => ({ id: randomUUID(), credential: randomBytes(32).toString('hex'), lane }));
  if (local.lane !== lane || typeof local.credential !== 'string' || typeof local.id !== 'string') throw invalidIdentityFile('Local writer registration is invalid.', path, `${lane} writer registration`);
  const [existing] = await engine.executeRaw<{ revoked_at: unknown; credential_hash: string; lane: string }>(
    'SELECT revoked_at,credential_hash,lane FROM persistence_local_writers WHERE id=$1::uuid', [local.id]);
  if (existing?.revoked_at != null) throw new OperationError('permission_denied', 'This local writer registration was revoked.', 'Explicitly register a new writer to authorize future work.');
  if (existing && (existing.lane !== lane || existing.credential_hash !== sha256(local.credential))) throw credentialMismatch(path, local.id, lane);
  // A registered writer is left as it is (the insert would conflict and do nothing).
  if (!existing) await engine.executeRaw(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
    VALUES($1::uuid,$2,$3,$4::text::jsonb) ON CONFLICT(id) DO NOTHING`, [local.id, lane, sha256(local.credential), JSON.stringify(grant)]);
  return local;
}

/** Commit replacement and revocation together, then atomically publish the private credential. */
async function rotateLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant: LocalGrant, path: string): Promise<LocalRegistration> {
  const old = JSON.parse(readFileSync(path, 'utf8')) as LocalRegistration;
  if (old.lane !== lane || typeof old.id !== 'string' || typeof old.credential !== 'string') {
    throw invalidIdentityFile('Local writer registration is invalid.', path, `${lane} writer registration`);
  }
  const next: LocalRegistration = { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane };
  const pending = `${path}.pending.${next.id}`;
  const fd = openSync(pending, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
  flushDirectory(persistenceHome());
  let durable = false;
  try {
    await engine.transaction(async tx => {
      const [prior] = await tx.executeRaw<{ credential_hash: string; lane: string }>(
        'SELECT credential_hash,lane FROM persistence_local_writers WHERE id=$1::uuid FOR UPDATE', [old.id]);
      if (prior && (prior.lane !== lane || prior.credential_hash !== sha256(old.credential))) {
        throw credentialMismatch(path, old.id, lane);
      }
      await tx.executeRaw(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
        VALUES($1::uuid,$2,$3,$4::text::jsonb)`, [next.id, lane, sha256(next.credential), JSON.stringify(grant)]);
      await tx.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid', [old.id]);
    });
    durable = true;
    linkSync(path, `${path}.revoked.${next.id}`);
    renameSync(pending, path); // readers always see one complete credential document
    flushDirectory(persistenceHome());
    return next;
  } catch (error) {
    if (!durable) unlinkSync(pending);
    else throw new OperationError('writer_identity_publish_failed', 'The replacement writer is durable but its credential file could not be published.',
      `Inspect the preserved private registration files in ${persistenceHome()} before retrying replacement.`);
    throw error;
  }
}
export async function readLocalWriter(engine: SqlEngine, lane: 'cli' | 'stdio'): Promise<LocalRegistration> {
  const brain = await brainIdentity(engine);
  const path = join(persistenceHome(), `${brain}.${lane}.json`);
  if (!existsSync(path)) throw new OperationError('writer_registration_required', 'This installation has no local writer registration.', 'Register it locally, or use authenticated HTTP access.');
  const local = JSON.parse(readFileSync(path, 'utf8')) as LocalRegistration;
  await verifyLocalWriter(engine, local);
  return local;
}
export async function verifyLocalWriter(engine: SqlEngine, local: LocalRegistration, lock = false): Promise<{ principal: Principal; grant: LocalGrant; remote: boolean }> {
  const [row] = await engine.executeRaw<{ lane: string; credential_hash: string; grant_ceiling: LocalGrant; revoked_at: unknown }>(
    `SELECT lane,credential_hash,grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=$1::uuid${lock ? ' FOR SHARE' : ''}`, [local.id]);
  const actual = Buffer.from(sha256(local.credential));
  const expected = Buffer.from(row?.credential_hash ?? '');
  if (!row || row.revoked_at != null || row.lane !== local.lane || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw opError('permission_denied', 'Local writer registration is unavailable or revoked.',
      `Local ${local.lane} writer registration ${local.id} is missing from this brain's database, revoked, or holds a different credential, so this caller is not authorized and nothing ran. Review it with the command in fix; replacing a revoked registration (gbrain auth local-writer register ${local.lane} --replace with the complete intended grant) is the user's decision.`,
      { fix: registrationsFix() });
  }
  return { principal: { kind: row.lane === 'cli' ? 'local_cli' : 'local_stdio', id: local.id }, grant: row.grant_ceiling, remote: row.lane !== 'cli' };
}
export async function revokeLocalWriter(engine: BrainEngine, id: string): Promise<boolean> {
  const rows = await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid RETURNING id', [id]);
  return rows.length === 1;
}
