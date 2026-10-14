/**
 * `gbrain repair stuck-recovery` (#6650 §1.10, #6640 §B): resolve a page publication recovery that the owner's
 * recovery pass refuses with `unexpected_file_bytes` (a canonical file matches neither its recorded prior nor its
 * published bytes, usually a human edit made while the write was publishing). Until it is resolved its worktree
 * claims nothing, and the resident consumer re-parks it every 30 s.
 *
 * The preview starts from the head blocker's `request_recovery` ids (the recovery records on the source's
 * worktree), lists every file of each record with its prior and disk fingerprints, and writes a private diff of the
 * two into the owner host's backup directory. Its hash binds each record's identity, each file's disk bytes and the
 * page's database revision.
 *
 * Only a live (non-terminal) request is resolved: its database transaction never committed, so neither choice rolls back
 * committed bytes. `--keep prior` writes the prior bytes back through the coordinator's confined durable publication
 * (`publishPersistenceFile`, staged at the record's reserved restoration path, which `upgradeRecoveryStaging` reserves
 * and accounts for older records) and recovery finishes by its own rule (a request with no recorded failure is requeued
 * and its write publishes again; one with a failure ends terminal). `--keep disk` (#6640's `drop`) keeps the edited
 * bytes and abandons the publication: it completes the request terminal (`completeWrite`; `source_changed`, so
 * `conflict`, when it recorded no failure, else that failure by the owner's rule via `finishUnpublishedFailure`), and
 * recovery's terminal path then only cleans its staging and clears the record (`clearResolvedRecovery`), releasing its
 * reserved bytes. The record is never rewritten, so no recovery bytes move outside the accounting.
 * A terminal request whose recovery record is still set is refused (`recovery_choice_refused`): its outcome is immutable,
 * recovery never restores its canonical file, and `--keep prior` would roll back a committed write. A withdrawal-mirror
 * effect recovery blocking the worktree is listed as refused (`recovery_effect_unsupported`): it only finishes forward,
 * and either choice could put withdrawn content back on disk.
 *
 * The apply runs on the owner host under the worktree lock, so the resident recovery pass cannot interleave. Each
 * record moves through a journal (`op_checkpoints`, op `stuck-recovery-resolution`, keyed by request and preview
 * hash): `backed_up` (the disk and prior bytes are in the backup directory, always), then `written` (`--keep
 * prior`: the prior bytes are back on disk, an absent prior unlinked) or `abandoned` (`--keep disk`: the request is
 * terminal), then `done` once `recoverPublication` finished it by its unchanged rule. Every step is idempotent, so a
 * run killed at any boundary resumes, and an older resident consumer can finish a resolution this command started.
 * The finished journal row is the resolution's audit entry; a terminal receipt is never rewritten.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { catalogueError } from '../error-catalogue.ts';
import { gbrainPath } from '../config.ts';
import { mkdirPrivate } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';
import { digest, sha256 } from './digest.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, containsPath, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { completeWrite, getWriteRequestById } from './journal.ts';
import { isTerminal, recoveryFiles, type FileRecoveryRecord, type WriteRequest } from './model.ts';
import { finishUnpublishedFailure, publishPersistenceFile, recoverPublication, transientDatabaseFailure } from './coordinator.ts';
import { mayReprepare } from './semantic.ts';
import { cleanupRecoveryStaging, upgradeRecoveryStaging } from './staging.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { readHeadBlockers } from './head-blocker.ts';
import { previewChangedError } from './preview-approval.ts';
import { faultPoint } from './fault-points.ts';

export const RESOLUTION_OP = 'stuck-recovery-resolution';
export type KeepChoice = 'prior' | 'disk';

export type PriorView = { absent: true } | { absent: false; sha256: string; size: number | null; mode: number | null; stored: boolean };
export type DiskView = { deleted: true } | { deleted: false; kind: 'file' | 'symlink' | 'directory' | 'other'; sha256: string | null; size: number; mode: number };
export interface RecoveryFileView {
  path: string; root: string; relative: string; prior: PriorView; disk: DiskView;
  /** What recovery itself makes of the disk bytes: the prior, the published bytes, or neither (the blocked case). */
  matches: 'prior' | 'published' | 'neither';
  /** Preview only: the private diff and the command that reproduces it (absent for a remote caller). */
  diff_path?: string; diff_command?: string;
}
/** The identity the hash binds: the publication attempt, its owner epoch and each file's path and published hash. */
export interface RecoveryIdentity { attempt: string; owner_epoch: string; files: Array<{ path: string; after_hash: string | null }> }
export interface StuckRecovery {
  id: string; request_id: string; source_id: string; slug: string; operation: string; state: string; blocked_reason: string | null;
  worktree_id: string; sequence: string; page_revision: string | null; identity: RecoveryIdentity;
  /** The failure the request already recorded, if any: with one, either choice ends the request terminal with it. */
  recorded_error: string | null;
  /** Each file's recorded prior hash, so an apply can tell its own write from a later edit. */
  prior_hashes: Array<string | null>; files: RecoveryFileView[]; choices: Record<KeepChoice, boolean>;
  /** Digest of the identity, each file's disk bytes and the page revision: what an apply re-verifies. */
  digest: string;
}
/** A blocked terminal request or a withdrawal-mirror effect recovery: listed, never resolved (see the module comment). */
export interface RefusedRecovery { code: 'recovery_choice_refused' | 'recovery_effect_unsupported'; request_id: string; source_id: string; slug: string; state: string;
  blocked_reason: string | null; reason: string; effect_id?: string }
export interface StuckRecoveryScan { items: StuckRecovery[]; residuals: Record<string, number>; refused: RefusedRecovery[];
  heads: Array<{ source_id: string; queued_request_id: string | null; blocked_by: string | null }> }

interface Journal {
  id: string; request_id: string; source_id: string; slug: string; preview_hash: string; keep: KeepChoice;
  phase: 'backed_up' | 'written' | 'abandoned' | 'done'; backup_dir: string; original: { state: string; blocked_reason: string | null; prior_hashes: Array<string | null>; disk_hashes: Array<string | null> };
  result?: ResolutionResult;
}
export interface ResolutionResult {
  outcome: 'resolved' | 'still_blocked'; keep: KeepChoice; request_state: string; blocked_reason: string | null;
  finished_by: 'this_run' | 'another_pass'; backup_dir: string; next: string;
}

const statusFix = (sourceId: string) => readFix(`Shows source ${sourceId}'s canonical owner with its recovering write requests, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
export const stuckRecoveryPreviewCommand = (sourceIds: string[], requestId?: string) =>
  `gbrain repair stuck-recovery${sourceIds.length === 1 ? ` --source ${sourceIds[0]}` : ''}${requestId ? ` --request-id ${requestId}` : ''}`;
const backupRoot = () => gbrainPath('backups', 'stuck-recovery');
const fileMode = (mode: number) => mode & 0o777;

function identityOf(files: FileRecoveryRecord[], record: { attempt: string; ownerEpoch: string }): RecoveryIdentity {
  return { attempt: record.attempt, owner_epoch: String(record.ownerEpoch), files: files.map(file => ({ path: file.path, after_hash: file.afterHash })) };
}

function diskView(path: string): { view: DiskView; bytes: Buffer | null } {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { view: { deleted: true }, bytes: null }; throw error; }
  if (!stat.isFile()) return { view: { deleted: false, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other', sha256: null, size: stat.size, mode: fileMode(stat.mode) }, bytes: null };
  const bytes = readFileSync(path);
  return { view: { deleted: false, kind: 'file', sha256: sha256(bytes), size: bytes.length, mode: fileMode(stat.mode) }, bytes };
}

function priorBytes(record: FileRecoveryRecord): Buffer | null { return record.before === null ? null : Buffer.from(record.before, 'base64'); }
function priorView(record: FileRecoveryRecord): PriorView {
  if (record.beforeHash === null) return { absent: true };
  const bytes = priorBytes(record);
  return { absent: false, sha256: record.beforeHash, size: bytes?.length ?? null, mode: record.mode, stored: bytes !== null && sha256(bytes) === record.beforeHash };
}

/** The private backup directory, refused when it is not a private directory of this user or sits inside a canonical checkout. */
async function privateBackupDir(engine: BrainEngine, ...segments: string[]): Promise<string> {
  const root = backupRoot();
  const dir = join(root, ...segments);
  mkdirPrivate(dir, root);
  const stat = lstatSync(root);
  const owned = process.platform === 'win32' || ((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned) throw opError('permission_denied', 'The stuck-recovery backup directory must be private, owned and free of symlinks.',
    `Nothing was written. Ask the user to make ${root} a real directory they own with mode 0700 (not a symlink), then run the same command again.`);
  const roots = await engine.executeRaw<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL
    UNION SELECT local_path FROM persistence_host_bindings WHERE local_path IS NOT NULL`);
  const resolved = canonicalFilesystemPath(dir);
  if (roots.some(row => existsSync(row.local_path) && containsPath(canonicalFilesystemPath(row.local_path), resolved))) {
    throw opError('permission_denied', 'Stuck-recovery backups must be stored outside every canonical source checkout.',
      `Nothing was written: ${root} sits inside a source checkout. The user must move the gbrain config directory (GBRAIN_HOME) out of the checkout, then run the same command again.`);
  }
  return dir;
}

/** Writes `bytes` to `path` 0600 and durable, then reads it back; an existing identical file is kept. */
function writePrivateFile(path: string, bytes: Buffer): void {
  if (existsSync(path) && sha256(readFileSync(path)) === sha256(bytes)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* already gone */ } throw error; }
  flushDirectory(dirname(path));
  if (sha256(readFileSync(path)) !== sha256(bytes)) throw opError('storage_error', 'A stuck-recovery backup did not read back as written.',
    `Nothing was changed on disk or in the journal. Check free space and the filesystem under ${dirname(path)}, then run the same command again.`);
}

/** Prior and disk bytes of every unexpected file (and their diff) under `dir`; returns the paths by file index. */
function writeArtifacts(dir: string, item: { files: RecoveryFileView[] }, records: FileRecoveryRecord[], disks: Array<Buffer | null>) {
  return item.files.map((file, index) => {
    const prior = priorBytes(records[index]);
    const priorPath = prior === null ? null : join(dir, `${index}.prior`);
    const diskPath = disks[index] === null ? null : join(dir, `${index}.disk`);
    if (priorPath) writePrivateFile(priorPath, prior!);
    if (diskPath) writePrivateFile(diskPath, disks[index]!);
    const diffPath = join(dir, `${index}.diff`);
    writePrivateFile(diffPath, Buffer.from(unifiedDiff(prior?.toString('utf8') ?? '', disks[index]?.toString('utf8') ?? '',
      { oldPath: `prior/${file.relative}`, newPath: `disk/${file.relative}` })));
    return { diff_path: diffPath, diff_command: `diff -u ${priorPath ?? '/dev/null'} ${diskPath ?? '/dev/null'}` };
  });
}

/** One record's current view: its files with disk fingerprints, the page revision and the state digest. */
async function readItem(engine: BrainEngine, row: WriteRequest, binding: WorktreeBinding): Promise<{ item: StuckRecovery; records: FileRecoveryRecord[]; disks: Array<Buffer | null> }> {
  if (row.recovery?.version === 2) throw catalogueError('recovery_bundle_unsupported', `Request ${row.request_id} in source ${row.source_id} is a shared-skill bundle recovery, which gbrain repair stuck-recovery does not resolve.`,
    `Nothing was changed. Inspect it read-only with gbrain sources writer status --source ${row.source_id} --json and ask the user which version of each skill file to keep; resolve the bundle by hand, then let the resident writer finish its recovery.`);
  const records = recoveryFiles(row.recovery!);
  const [page] = await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug]);
  const disks: Array<Buffer | null> = [];
  const files = records.map(record => {
    const contained = isWriteTargetContained(record.path, record.root) && !!binding.local_path && isWriteTargetContained(record.path, binding.local_path);
    const { view, bytes } = contained ? diskView(record.path) : { view: { deleted: false, kind: 'other', sha256: null, size: 0, mode: 0 } as DiskView, bytes: null };
    disks.push(bytes);
    const hash = view.deleted ? null : view.sha256;
    const matches = (view.deleted || view.kind === 'file') && hash === record.beforeHash ? 'prior' : (view.deleted || view.kind === 'file') && hash === record.afterHash ? 'published' : 'neither';
    return { path: record.path, root: record.root, relative: relative(binding.local_path ?? record.root, record.path), prior: priorView(record), disk: view, matches } as RecoveryFileView;
  });
  const writable = (file: RecoveryFileView) => file.disk.deleted || file.disk.kind === 'file';
  const unexpected = files.filter(file => file.matches === 'neither');
  const choices = { prior: unexpected.every(file => writable(file) && (file.prior.absent || file.prior.stored)), disk: unexpected.every(writable) };
  const identity = identityOf(records, row.recovery!);
  const page_revision = page?.revision ?? null;
  return { records, disks, item: { id: row.id, request_id: row.request_id, source_id: row.source_id, slug: row.slug, operation: row.operation, state: row.state,
    blocked_reason: row.blocked_reason ?? null, worktree_id: row.worktree_id!, sequence: String(row.sequence),
    page_revision, identity, recorded_error: row.error_code ?? null, prior_hashes: records.map(record => record.beforeHash), files, choices,
    digest: digest({ v: 'stuck-recovery-item-v1', id: row.id, request_id: row.request_id, identity, prior_hashes: records.map(record => record.beforeHash),
      disk: files.map(file => file.disk), page_revision }) } };
}

function ownerBinding(binding: WorktreeBinding | null, sourceId: string, hostId: string): WorktreeBinding {
  if (binding?.owner_host_id === hostId && binding.local_path) return binding;
  throw opError('owner_unavailable', `Source ${sourceId}'s canonical worktree is not owned by this host, so its recovery files cannot be read or resolved here.`,
    `Nothing was changed. Run gbrain repair stuck-recovery --source ${sourceId} on the host that owns the source (gbrain sources writer status --source ${sourceId} --json names it).`,
    { fix: statusFix(sourceId) });
}

/**
 * The resolvable recoveries in `sourceIds` (owner host only): every non-terminal page recovery record on each
 * source's worktree that is blocked on unexpected bytes or whose file matches neither recorded version. `requestId`
 * narrows to one request. `artifacts` writes each file's private diff (a remote caller's preview never does).
 */
export async function scanStuckRecoveries(engine: BrainEngine, sourceIds: string[], opts: { requestId?: string; artifacts?: boolean; hostId?: string } = {}): Promise<StuckRecoveryScan> {
  const hostId = opts.hostId ?? localHostId();
  const scan: StuckRecoveryScan = { items: [], residuals: {}, refused: [], heads: [] };
  const residual = (key: string) => { scan.residuals[key] = (scan.residuals[key] ?? 0) + 1; };
  for (const sourceId of sourceIds) {
    const found = await getWorktreeBinding(engine, sourceId, hostId);
    if (!found?.worktree_id) continue;
    const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL ORDER BY sequence', [found.worktree_id]);
    const effects = await engine.executeRaw<{ id: string; request_id: string | null; kind: string; state: string; slug: string | null }>(`SELECT e.id::text,r.request_id::text,e.kind,e.state,
      COALESCE(e.recovery->>'slug',r.slug) AS slug FROM persistence_effects e LEFT JOIN persistence_requests r ON r.id=e.request_id
      WHERE e.worktree_id=$1::uuid AND e.recovery IS NOT NULL ORDER BY e.id`, [found.worktree_id]);
    for (const effect of effects) {
      if (opts.requestId && effect.request_id !== opts.requestId) continue;
      const refused: RefusedRecovery = { code: 'recovery_effect_unsupported', request_id: effect.request_id ?? '', effect_id: effect.id, source_id: sourceId, slug: effect.slug ?? '',
        state: effect.state, blocked_reason: null, reason: effectReason(effect.kind) };
      if (opts.requestId && !rows.some(row => row.request_id === opts.requestId)) throw catalogueError('recovery_effect_unsupported', refused.reason, effectGuidance(sourceId));
      scan.refused.push(refused);
      residual('effect_recovery');
    }
    if (!rows.length) continue;
    const binding = sourceIds.length === 1 || opts.requestId ? ownerBinding(found, sourceId, hostId) : found.owner_host_id === hostId && found.local_path ? found : null;
    if (!binding) { residual('owned_by_other_host'); continue; }
    const [head] = await engine.executeRaw<{ id: string; request_id: string }>("SELECT id::text, request_id::text FROM persistence_requests WHERE worktree_id=$1::uuid AND state='queued' ORDER BY sequence LIMIT 1", [binding.worktree_id]);
    const read = head ? (await readHeadBlockers(engine, [head.id], hostId).catch(() => null))?.get(head.id) : undefined;
    const blocker = read?.status === 'blocked' ? read.blocker : null;
    scan.heads.push({ source_id: sourceId, queued_request_id: head?.request_id ?? null, blocked_by: blocker ? blocker.predicate : null });
    const ids = blocker?.predicate === 'request_recovery' ? new Set(blocker.ids) : null;
    for (const row of rows) {
      if (opts.requestId && row.request_id !== opts.requestId) continue;
      if (ids && !ids.has(row.request_id)) continue;
      if (isTerminal(row)) {
        if (!row.blocked_reason) { residual('terminal_cleanup'); continue; }
        const refused: RefusedRecovery = { code: 'recovery_choice_refused', request_id: row.request_id, source_id: row.source_id, slug: row.slug, state: row.state,
          blocked_reason: row.blocked_reason, reason: terminalReason(row) };
        if (opts.requestId) throw choiceRefused(refused.reason, row.source_id);
        scan.refused.push(refused);
        residual('terminal_refused');
        continue;
      }
      if (row.blocked_reason === 'unexpected_staging_bytes') { residual('unexpected_staging_bytes'); continue; }
      const { item, records, disks } = await readItem(engine, row, binding);
      if (row.blocked_reason !== 'unexpected_file_bytes' && item.files.every(file => file.matches !== 'neither')) { residual('recovers_on_its_own'); continue; }
      if (opts.artifacts) {
        const paths = writeArtifacts(await privateBackupDir(engine, row.request_id, item.digest.slice(0, 16)), item, records, disks);
        item.files = item.files.map((file, index) => ({ ...file, ...paths[index] }));
      }
      scan.items.push(item);
    }
  }
  if (opts.requestId && !scan.items.length) throw opError('invalid_params', `Request ${opts.requestId} holds no resolvable recovery record in ${sourceIds.length === 1 ? `source ${sourceIds[0]}` : 'the selected sources'}.`,
    `Nothing was changed. Preview without the request id to list the stuck recoveries: ${stuckRecoveryPreviewCommand(sourceIds)}`);
  return scan;
}

function terminalReason(row: WriteRequest): string {
  return `Request ${row.request_id} already ended ${row.state}; a terminal outcome is immutable and its recovery never restores the canonical file, so `
    + `--keep prior would roll back ${row.state === 'committed' ? 'a committed write' : 'the outcome it recorded'} and --keep disk has nothing to abandon. Its recovery only waits `
    + `for staging cleanup (${row.blocked_reason}), which this command does not perform.`;
}
function effectReason(kind: string): string {
  return `A ${kind} effect recovery blocks the worktree. It only finishes forward (it never restores the bytes from before a withdrawal), and either `
    + '--keep choice could put withdrawn content back on disk, so gbrain repair stuck-recovery does not resolve it.';
}
const effectGuidance = (sourceId: string) => `Nothing was changed. Inspect the effect read-only with gbrain sources writer status --source ${sourceId} --json and ask the user `
  + 'whether the edited file may be replaced by its withdrawn version; the resident writer finishes the effect once the file matches one of its recorded versions.';
const choiceRefused = (reason: string, sourceId: string) => catalogueError('recovery_choice_refused', reason,
  `Nothing was changed. Inspect the request read-only with gbrain sources writer status --source ${sourceId} --json and follow the guidance for its blocked reason.`);

async function readJournal(engine: BrainEngine, key: string): Promise<Journal | null> {
  const [row] = await engine.executeRaw<{ completed_keys: Journal[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [RESOLUTION_OP, key]);
  return row?.completed_keys?.[0] ?? null;
}
async function writeJournal(engine: BrainEngine, key: string, journal: Journal): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [RESOLUTION_OP, key, JSON.stringify([journal])]);
}
/** The finished resolutions recorded under one preview hash (the audit entries an identical apply replays). */
export async function readResolutions(engine: BrainEngine, previewHash: string): Promise<Journal[]> {
  const rows = await engine.executeRaw<{ completed_keys: Journal[] }>("SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'preview_hash'=$2 ORDER BY fingerprint",
    [RESOLUTION_OP, previewHash]);
  return rows.map(row => row.completed_keys[0]);
}

/**
 * `--keep disk`: ends the live request terminal without touching its record. With no recorded failure it ends `conflict`
 * (`source_changed`); a recorded failure ends it by the owner's rule (`finishUnpublishedFailure`), except the two
 * reprepare codes, which that helper would requeue and which are conflicts.
 */
async function abandonWrite(engine: BrainEngine, row: WriteRequest, previewHash: string): Promise<void> {
  if (!row.error_code) {
    await engine.transaction(tx => completeWrite(tx, row, 'conflict', {}, { code: 'source_changed',
      message: `Publication abandoned by gbrain repair stuck-recovery --keep disk (preview ${previewHash.slice(0, 12)}): the canonical file was kept as edited on disk.` }));
    return;
  }
  const recorded = new OperationError(row.error_code, row.error_message ?? 'Publication failed before database completion.',
    `Read request ${row.request_id}'s receipt with gbrain write-request -- ${row.request_id}; the canonical file was kept as edited on disk.`);
  if (!mayReprepare(row, recorded) && !transientDatabaseFailure(recorded)) { await finishUnpublishedFailure(engine, row, recorded); return; }
  await engine.transaction(tx => completeWrite(tx, row, mayReprepare(row, recorded) ? 'conflict' : 'failed', {}, { code: recorded.code, message: recorded.message }));
}

const sameIdentity = (row: WriteRequest | null, item: StuckRecovery) => !!row?.recovery && row.recovery.version === 1
  && digest(identityOf(recoveryFiles(row.recovery), row.recovery)) === digest(item.identity);

function nextStep(item: StuckRecovery, keep: KeepChoice, state: string): string {
  if (keep === 'disk') return `The bytes on disk are kept and the write's publication was abandoned (request ${state}); the database page still holds the content before the write, `
    + `so the page shows as file/database drift until it is reconciled. Next: gbrain sources reconcile ${item.source_id} ${item.slug} --brain host --preview. This command does not mark the page repaired.`;
  return state === 'queued' ? 'The prior bytes are back on disk and the write was requeued: the resident writer publishes it again on its next pass.'
    : `The prior bytes are back on disk and the write ended ${state}; read its receipt with gbrain write-request -- ${item.request_id}.`;
}

/**
 * Resolves one approved record (see the module comment). Runs on the owner host under the worktree lock; a run
 * killed at any step resumes from its journal, and an identical apply after success returns the recorded result.
 */
export async function resolveStuckRecovery(engine: BrainEngine, item: StuckRecovery, opts: { keep: KeepChoice; previewHash: string; hostId?: string; lockWaitMs?: number }):
Promise<ResolutionResult & { replayed: boolean }> {
  const hostId = opts.hostId ?? localHostId();
  const key = `${item.id}:${opts.previewHash}`;
  const command = stuckRecoveryPreviewCommand([item.source_id], item.request_id);
  let journal = await readJournal(engine, key);
  if (journal && journal.keep !== opts.keep) throw opError('idempotency_conflict', `Preview ${opts.previewHash.slice(0, 12)} of request ${item.request_id} was ${journal.phase === 'done' ? 'resolved' : 'started'} with --keep ${journal.keep}.`,
    `Nothing was changed. ${journal.phase === 'done' ? 'That resolution is final' : `Finish it with the same choice: rerun the apply with --keep ${journal.keep}`}; for a different choice, preview again (${command}) and apply the new hash.`);
  if (journal?.phase === 'done' && journal.result) return { ...journal.result, replayed: true };
  const binding = ownerBinding(await getWorktreeBinding(engine, item.source_id, hostId), item.source_id, hostId);
  const lock = await acquireWorktree(binding, opts.lockWaitMs ?? 10_000, undefined, engine, { yieldLanes: true });
  if (!lock) throw opError('writer_lock_unavailable', `Source ${item.source_id}'s worktree lock is held by another writer, so the recovery of request ${item.request_id} was not resolved.`,
    `Nothing was changed. Rerun the same apply in a few seconds; if it stays busy, inspect the holder with gbrain sources writer status --source ${item.source_id} --json.`, { fix: statusFix(item.source_id) });
  try {
    let row = await getWriteRequestById(engine, item.id);
    if (!journal) {
      if (!sameIdentity(row, item)) throw previewChangedError(opts.previewHash, command);
      if (isTerminal(row!)) throw choiceRefused(terminalReason(row!), item.source_id);
      const current = await readItem(engine, row!, binding);
      if (current.item.digest !== item.digest) throw previewChangedError(opts.previewHash, command);
      if (!current.item.choices[opts.keep]) throw catalogueError('recovery_choice_refused', `--keep ${opts.keep} is not available for request ${item.request_id}: `
        + (opts.keep === 'prior' ? 'the recovery record does not hold the prior bytes, or a blocked file is not a regular file.' : 'a blocked file is not a regular file.'),
        `Nothing was changed. The preview lists the available choices; run it again (${command}) and apply one of those.`);
      const dir = await privateBackupDir(engine, item.request_id, item.digest.slice(0, 16));
      writeArtifacts(dir, current.item, current.records, current.disks);
      await faultPoint('stuck_recovery:backed_up', { requestId: item.request_id, sourceId: item.source_id });
      journal = { id: item.id, request_id: item.request_id, source_id: item.source_id, slug: item.slug, preview_hash: opts.previewHash, keep: opts.keep, phase: 'backed_up',
        backup_dir: dir, original: { state: row!.state, blocked_reason: row!.blocked_reason ?? null, prior_hashes: item.prior_hashes,
          disk_hashes: item.files.map(file => file.disk.deleted ? null : file.disk.sha256) } };
      await writeJournal(engine, key, journal);
    }
    if (journal.phase === 'backed_up' && sameIdentity(row, item)) {
      const records = recoveryFiles(row!.recovery!);
      const unexpected = records.map((record, index) => ({ record, index })).filter(({ index }) => item.files[index].matches === 'neither');
      for (const { record, index } of unexpected) {
        const hash = diskView(record.path).view;
        const now = hash.deleted ? null : hash.sha256;
        const allowed = opts.keep === 'prior' ? [journal.original.disk_hashes[index], item.prior_hashes[index]] : [journal.original.disk_hashes[index]];
        if (!allowed.includes(now)) throw opError('unexpected_file_bytes', `A canonical file of request ${item.request_id} changed again after the preview, so the resolution stopped before touching it.`,
          `Nothing more was changed; the bytes from the preview are backed up under ${journal.backup_dir}. Preview again (${command}), show the user the new diff and apply the new hash.`, { fix: statusFix(item.source_id) });
      }
      if (opts.keep === 'prior') {
        await upgradeRecoveryStaging(engine, 'persistence_requests', item.id, item.worktree_id, 'restore');
        const staged = recoveryFiles((await getWriteRequestById(engine, item.id))!.recovery!);
        await withFilesystemPublication([...new Set(staged.map(record => record.root))], async () => {
          for (const { index } of unexpected) {
            const record = staged[index];
            cleanupRecoveryStaging(record);
            publishPersistenceFile({ path: record.path, root: record.root, content: priorBytes(record) }, record.staging?.restoration?.path, undefined, record.mode);
          }
        });
        await faultPoint('stuck_recovery:written', { requestId: item.request_id, sourceId: item.source_id });
        journal = { ...journal, phase: 'written' };
        await writeJournal(engine, key, journal);
      } else {
        if (!isTerminal(row!)) await abandonWrite(engine, row!, opts.previewHash);
        journal = { ...journal, phase: 'abandoned' };
        await writeJournal(engine, key, journal);
        await faultPoint('stuck_recovery:abandoned', { requestId: item.request_id, sourceId: item.source_id });
      }
      row = await getWriteRequestById(engine, item.id);
    }
    const ours = sameIdentity(row, item);
    const recovered = ours ? await recoverPublication(engine, item.id, hostId, true) : row!;
    await faultPoint('stuck_recovery:recovered', { requestId: item.request_id, sourceId: item.source_id });
    const blocked = sameIdentity(recovered, item);
    const result: ResolutionResult = { outcome: blocked ? 'still_blocked' : 'resolved', keep: opts.keep, request_state: recovered.state,
      blocked_reason: blocked ? recovered.blocked_reason ?? null : null, finished_by: ours ? 'this_run' : 'another_pass', backup_dir: journal.backup_dir,
      next: blocked ? `The recovery is still blocked (${recovered.blocked_reason ?? 'recovering'}); rerun the same apply, or inspect it with gbrain sources writer status --source ${item.source_id} --json.`
        : nextStep(item, opts.keep, recovered.state) };
    if (!blocked) await writeJournal(engine, key, { ...journal, phase: 'done', result });
    return { ...result, replayed: false };
  } finally { await lock.release(); }
}
