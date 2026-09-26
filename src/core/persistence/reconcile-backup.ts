import { constants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { containsPath } from './ownership.ts';
import { acquireNativeLock } from './native-lock.ts';
import { digest, jsonBytes, stableJson } from './digest.ts';
import { readJournalLimits } from './limits.ts';
import { capacityError, intentDigest } from './journal.ts';
import type { ReconcileArtifact } from './reconcile-state.ts';
import { isTerminal, type Principal, type WriteAuthority, type WriteRequest } from './model.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from './ipc.ts';
import { authorizeStoredRequest } from './authority.ts';

const backupPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}\.json$/;
const backupReference = (brain: string, principal: Principal, requestId: string) => `${requestId}.${digest({ brain, principal, requestId })}.json`;
const backupDirectory = () => join(canonicalFilesystemPath(configDir()), 'reconciliation-previews');
const privatePermissions = (stat: Stats) => process.platform === 'win32' ||
  (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());

export async function assertReconcileOutputPath(engine: BrainEngine, sourceId: string, path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new OperationError('invalid_params', 'The private preview output must be an absolute local path.');
  const roots = await engine.executeRaw<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL
    UNION SELECT local_path FROM persistence_host_bindings WHERE local_path IS NOT NULL`);
  const resolved = canonicalFilesystemPath(path);
  if (roots.some(row => containsPath(canonicalFilesystemPath(row.local_path), resolved))) {
    throw new OperationError('permission_denied', 'Private reconciliation artifacts must be stored outside every canonical source and worktree.');
  }
}
function privateDirectory(path: string): void {
  if (!existsSync(path)) { mkdirSync(path, { mode: 0o700, recursive: true }); flushDirectory(dirname(path)); }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privatePermissions(stat)) {
    throw new OperationError('permission_denied', 'The reconciliation backup directory must be private, owned, and free of symlinks.');
  }
}
function flushDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export async function assertReconcileSize(engine: BrainEngine, artifact: ReconcileArtifact): Promise<void> {
  const limits = await readJournalLimits(engine);
  if (jsonBytes(artifact) + 65536 > Math.min(PERSISTENCE_IPC_MAX_BYTES, limits.principalIntentBytes, limits.brainIntentBytes, limits.worktreeRecoveryBytes, limits.brainRecoveryBytes)) {
    throw new OperationError('request_too_large', 'The complete reconciliation artifact exceeds the configured request/recovery capacity.');
  }
}
export async function retainReconcileBackup(engine: BrainEngine, artifact: ReconcileArtifact, principal: Principal, requestId: string): Promise<string> {
  const directory = backupDirectory();
  await assertReconcileOutputPath(engine, artifact.preconditions.source_id, directory);
  privateDirectory(directory);
  const lock = await acquireNativeLock(join(directory, '.capacity.lock'), { timeoutMs: 5000 });
  if (!lock) throw new OperationError('writer_lock_unavailable', 'Reconciliation backup capacity is busy.');
  try {
    privateDirectory(directory);
    const limits = await readJournalLimits(engine);
    const reference = backupReference(artifact.preconditions.brain_id, principal, requestId);
    const path = join(directory, reference);
    const value = stableJson({ format_version: 1, retention: 'pre_admission_or_terminal', principal, request_id: requestId, preview: artifact });
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privatePermissions(stat) || readFileSync(path, 'utf8') !== value) {
        throw new OperationError('idempotency_conflict', 'A different or unsafe retained backup already owns this request ID.');
      }
      return reference;
    }
    let count = 0, bytes = 0;
    for (const name of readdirSync(directory)) {
      if (name === '.capacity.lock') continue;
      const stat = lstatSync(join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new OperationError('storage_error', 'Unexpected content in the private reconciliation backup directory.');
      count++; bytes += stat.size;
    }
    if (count + 1 > limits.brainLifetimeIds || bytes + Buffer.byteLength(value) > limits.brainRecoveryBytes) throw capacityError('retained reconciliation backups');
    const temporary = join(directory, `${reference}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); flushDirectory(directory); }
    finally { unlinkSync(temporary); flushDirectory(directory); }
    return reference;
  } finally { await lock.release(); }
}
export function verifyReconcileBackup(reference: string, artifact: ReconcileArtifact): void {
  if (!backupPattern.test(reference)) throw new OperationError('storage_error', 'Invalid reconciliation backup reference.');
  try {
    const directory = backupDirectory();
    privateDirectory(directory);
    const path = join(directory, reference), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privatePermissions(stat) ||
      digest(JSON.parse(readFileSync(path, 'utf8')).preview) !== digest(artifact)) throw new Error('backup changed');
  } catch {
    throw new OperationError('storage_error', 'The retained reconciliation preimages are missing or changed.');
  }
}

export async function manageReconcileBackups(engine: BrainEngine, authority: WriteAuthority, slug: string,
  params: { action: 'list' | 'remove'; backup_reference?: string; after?: string; limit?: number }): Promise<Record<string, unknown>> {
  const directory = backupDirectory();
  const principal = authority.principal;
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const limit = params.limit ?? 100;
  if (params.action === 'list') {
    const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
      AND source_id=$3 AND slug=$4 AND ($5::uuid IS NULL OR request_id>$5::uuid)
      AND operation='put_page' ORDER BY request_id LIMIT $6`,
      [principal.kind, principal.id, authority.sourceId, slug, params.after ?? null, limit + 1]);
    const backups: Record<string, unknown>[] = [];
    for (const row of rows.slice(0, limit)) {
      await authorizeStoredRequest(engine, row);
      const reference = backupReference(brain.brain_id, principal, row.request_id);
      const path = join(directory, reference);
      if (!existsSync(path) && row.outcome?.backup_reference !== reference && row.intent?.backup_reference !== reference) continue;
      let bytes: number | null = null;
      if (existsSync(path)) {
        privateDirectory(directory);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privatePermissions(stat)) throw new OperationError('storage_error', 'A retained backup is not a private ordinary file.');
        bytes = stat.size;
      }
      backups.push({ backup_reference: reference, request_id: row.request_id, state: row.state, retained: bytes !== null, bytes,
        removable: bytes !== null && isTerminal(row) && row.recovery === null });
    }
    const limits = await readJournalLimits(engine);
    return { source_id: authority.sourceId, slug, backups, next_after: rows.length > limit ? rows[limit - 1].request_id : null,
      capacity: { max_retained_bytes: limits.brainRecoveryBytes, max_retained_count: limits.brainLifetimeIds } };
  }
  const reference = params.backup_reference!;
  if (!backupPattern.test(reference)) throw new OperationError('invalid_params', 'An exact private backup reference is required.');
  const requestId = reference.slice(0, 36);
  if (reference !== backupReference(brain.brain_id, principal, requestId)) throw new OperationError('permission_denied', 'The backup reference belongs to another caller or brain.');
  await assertReconcileOutputPath(engine, authority.sourceId, directory);
  privateDirectory(directory);
  const lock = await acquireNativeLock(join(directory, '.capacity.lock'), { timeoutMs: 5000 });
  if (!lock) throw new OperationError('writer_lock_unavailable', 'Reconciliation backup capacity is busy.');
  try {
    return await engine.transaction(async tx => {
      const [row] = await tx.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
        AND source_id=$3 AND slug=$4 AND request_id=$5::uuid AND operation='put_page' FOR UPDATE`,
        [principal.kind, principal.id, authority.sourceId, slug, requestId]);
      if (!row) throw new OperationError('permission_denied', 'No caller-bound accepted request authorizes removal of this backup.');
      await authorizeStoredRequest(tx, row, true);
      if (!isTerminal(row) || row.recovery !== null) throw new OperationError('recovery_required', 'The backup still protects a nonterminal or recovering request.');
      const path = join(directory, reference);
      if (!existsSync(path)) return { removed: false, backup_reference: reference, request_id: row.request_id };
      privateDirectory(directory);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privatePermissions(stat)) throw new OperationError('storage_error', 'The backup is not a private ordinary file.');
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { preview: ReconcileArtifact; principal: Principal; request_id: string };
      if (stored.request_id !== row.request_id || digest(stored.principal) !== digest(principal) ||
        intentDigest({ operation: 'put_page', sourceId: row.source_id, slug: row.slug, callerIntent: { kind: 'canonical_reconcile', preview: stored.preview } }) !== row.digest) {
        throw new OperationError('storage_error', 'The retained backup does not match its immutable request.');
      }
      unlinkSync(path); flushDirectory(directory);
      return { removed: true, backup_reference: reference, request_id: row.request_id, bytes: stat.size };
    });
  } finally { await lock.release(); }
}
