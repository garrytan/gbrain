import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
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
const defaultGrant = (): LocalGrant => ({ sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
export function persistenceHome(): string { return join(configDir(), 'persistence'); }

function flushRegistrationDirectory(): void {
  let fd: number | undefined;
  try { fd = openSync(persistenceHome(), 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

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
export function localHostId(): string {
  const value = privateJson<{ version: number; id: string }>(join(persistenceHome(), 'host.json'), () => ({ version: 1, id: randomUUID() }));
  if (value.version !== 1 || typeof value.id !== 'string') throw new OperationError('writer_identity_invalid', 'The local writer identity is invalid.');
  return value.id;
}
async function brainIdentity(engine: SqlEngine): Promise<string> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) throw new OperationError('writer_not_initialized', 'Persistence metadata has not been initialized.');
  return brain.brain_id;
}
export async function registerLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant = defaultGrant(), replace = false): Promise<LocalRegistration> {
  const brain = await brainIdentity(engine);
  const path = join(persistenceHome(), `${brain}.${lane}.json`);
  if (!replace) return ensureLocalWriter(engine, lane, grant, path);
  const lock = await acquireNativeLock(join(persistenceHome(), 'locks', `${brain}.${lane}.registration.lock`), { timeoutMs: 5000 });
  if (!lock) throw new OperationError('writer_lock_unavailable', 'Local writer registration is busy.');
  try {
    if (existsSync(path)) return await rotateLocalWriter(engine, lane, grant, path);
    return await ensureLocalWriter(engine, lane, grant, path);
  } finally { await lock.release(); }
}

async function ensureLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant: LocalGrant, path: string): Promise<LocalRegistration> {
  const local = privateJson<LocalRegistration>(path, () => ({ id: randomUUID(), credential: randomBytes(32).toString('hex'), lane }));
  if (local.lane !== lane || typeof local.credential !== 'string' || typeof local.id !== 'string') throw new OperationError('writer_identity_invalid', 'Local writer registration is invalid.');
  const [existing] = await engine.executeRaw<{ revoked_at: unknown; credential_hash: string; lane: string }>(
    'SELECT revoked_at,credential_hash,lane FROM persistence_local_writers WHERE id=$1::uuid', [local.id]);
  if (existing?.revoked_at != null) throw new OperationError('permission_denied', 'This local writer registration was revoked.', 'Explicitly register a new writer to authorize future work.');
  if (existing && (existing.lane !== lane || existing.credential_hash !== sha256(local.credential))) throw new OperationError('permission_denied', 'Local writer credential does not match this registration.');
  await engine.executeRaw(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
    VALUES($1::uuid,$2,$3,$4::text::jsonb) ON CONFLICT(id) DO NOTHING`, [local.id, lane, sha256(local.credential), JSON.stringify(grant)]);
  return local;
}

/** Commit replacement and revocation together, then atomically publish the private credential. */
async function rotateLocalWriter(engine: BrainEngine, lane: 'cli' | 'stdio', grant: LocalGrant, path: string): Promise<LocalRegistration> {
  const old = JSON.parse(readFileSync(path, 'utf8')) as LocalRegistration;
  if (old.lane !== lane || typeof old.id !== 'string' || typeof old.credential !== 'string') {
    throw new OperationError('writer_identity_invalid', 'Local writer registration is invalid.');
  }
  const next: LocalRegistration = { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane };
  const pending = `${path}.pending.${next.id}`;
  const fd = openSync(pending, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
  flushRegistrationDirectory();
  let durable = false;
  try {
    await engine.transaction(async tx => {
      const [prior] = await tx.executeRaw<{ credential_hash: string; lane: string }>(
        'SELECT credential_hash,lane FROM persistence_local_writers WHERE id=$1::uuid FOR UPDATE', [old.id]);
      if (prior && (prior.lane !== lane || prior.credential_hash !== sha256(old.credential))) {
        throw new OperationError('permission_denied', 'Local writer credential does not match this registration.');
      }
      await tx.executeRaw(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
        VALUES($1::uuid,$2,$3,$4::text::jsonb)`, [next.id, lane, sha256(next.credential), JSON.stringify(grant)]);
      await tx.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid', [old.id]);
    });
    durable = true;
    linkSync(path, `${path}.revoked.${next.id}`);
    renameSync(pending, path); // readers always see one complete credential document
    flushRegistrationDirectory();
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
    throw new OperationError('permission_denied', 'Local writer registration is unavailable or revoked.');
  }
  return { principal: { kind: row.lane === 'cli' ? 'local_cli' : 'local_stdio', id: local.id }, grant: row.grant_ceiling, remote: row.lane !== 'cli' };
}
export async function revokeLocalWriter(engine: BrainEngine, id: string): Promise<boolean> {
  const rows = await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid RETURNING id', [id]);
  return rows.length === 1;
}
