/**
 * `gbrain backup create` and `backup restore` of a Rust brain (PR 21b). The PGLite bodies stay in snapshot.ts; this file
 * is the Rust half and the two entry points that choose between them (`createBackup`, `restoreBackup`).
 *
 * create: output checks -> `rustBackupPreflight` (layout, 8 GiB cap) -> bootstrap lock -> engine as owner or client of the
 *   brain's owner -> `snapshotStore` (one committed generation, writers keep going) -> `verifyStoreDir` against the
 *   manifest -> the restore census on a scratch copy, retaking the snapshot while work is unfinished (3 times, 60 s) ->
 *   file and config inventory before/after -> archive v1 with `store/{records.redb,FORMAT,SNAPSHOT.json}`.
 * restore: addon and mode checks (before any folder is reserved) -> absent-root reservation -> extraction -> phase 1: the
 *   restored bytes equal the snapshot (`verifyStoreDir`, read-only) -> purge check by request id -> census refusals ->
 *   phase 2: `restoreQuarantine` (one transaction) -> clean-close check -> publish.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { VERSION } from '../../version.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { configDir, type GBrainConfig } from '../config.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { AgentInstallError, checkedManagedPaths, checkedRoot, confinedPath, privateWrite, readFileConfigState, readInstallReceipt, syncDirectory, type AgentInstallReceipt } from '../agent-install/state.ts';
import { openRustEngine, type RustEngine } from '../rust-engine.ts';
import { loadRustAddon, type RustAddon } from '../rust-engine/addon-loader.ts';
import { forwardWholeOperation } from '../rust-engine/owner-ipc/whole-op.ts';
import { snapshotStore, type SnapshotStatus } from '../rust-engine/store-snapshot.ts';
import { openRustStore, verifyStoreDir, type StoreSnapshotManifest, type StoreVerifyReport } from '../rust-engine/store.ts';
import type { RestoreCensus } from '../rust-engine/restore-types.ts';
import { PURGE_MIRROR_FILE, replayState, type PurgeMirrorIntent, type PurgeMirrorLine, type PurgeReplayResult, type ReplayRecord } from '../belief/purge-mirror.ts';
import { validateSharedSkillRestoreMode, type SharedSkillRestoreOptions } from '../shared-skills/restore.ts';
import { hashFile, readBackupArchive, readBackupManifest, writeBackupArchive, type ArchiveManifest } from './archive.ts';
import { protectNewBackupPath } from './private-path.ts';
import { rebaseManagedConfig, sanitizedConfig, syncRestoredTree, walkFiles, createPgliteBackup, restorePgliteBackup } from './snapshot.ts';
import { relativeBackupPath, type RestoredSource } from './quarantine.ts';
import { rustBackupPreflight, RUST_STORE_FILES } from './preflight.ts';
import { RESTORE_REFUSAL_DOCS, buildQuarantinePlan, checkStoreIdentity, restoreAddonSupportsSafety, restoreRefusal, restoreRefusalFor } from './rust-restore-safety.ts';

/** The snapshot is retaken while it holds unfinished work: this many snapshots, over this long. */
export const SNAPSHOT_ATTEMPTS = 3;
export const SNAPSHOT_BUDGET_MS = 60_000;
const STORE_ENTRIES = ['store/records.redb', 'store/FORMAT', 'store/SNAPSHOT.json'] as const;

interface RustSourceInventory { id: string; incarnation: string | null; local_path: string | null; managed_relative_path: string | null }
interface RustBackupMetadata {
  kind: 'gbrain-rust';
  created_at: string;
  gbrain_version: string;
  schema_version: number;
  original_root: string;
  classification: 'sensitive-full-database-state';
  /** The store's own identity: a different namespace from the container's `format_version` (always 1). */
  store: { engine_format_version: number; generation: number; brain_id: string; schema_version: number; snapshot_manifest_sha256: string };
  sources: RustSourceInventory[];
  omitted: string[];
  credential_references: string[];
  managed_paths: string[];
  installation: AgentInstallReceipt | null;
}

export interface RustBackupOptions {
  output: string; root?: string;
  /** The addon to use instead of the one gbrain's loader finds (tests). */
  addon?: RustAddon;
  /**
   * Seams for the unfinished-work retake: attempts, the wait between them, and the whole budget (milliseconds); `onWait`
   * runs before each wait with the work that was found (a test lets the work finish there).
   */
  retake?: { attempts?: number; waitMs?: number; budgetMs?: number; onWait?: (attempt: number, pending: string[]) => Promise<void> | void };
}
export interface RustBackupResult { archive: string; manifest: ArchiveManifest; restore_blockers: string[] }

/** Adds the versions and the restore id to a refusal's `detail`, so a report of it can be matched to a build and a staging folder. */
function withRuntime<E extends { detail?: string }>(error: E, addon: RustAddon, restoreId?: string): E {
  error.detail = `${error.detail ?? ''} gbrain=${VERSION} addon_build=${addon.engineBuild}${restoreId ? ` diagnostic=${restoreId}` : ''}`.trim();
  return error;
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
const sha256Of = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const isRustConfig = (config: unknown): boolean => (config as { engine?: unknown } | null)?.engine === 'rust';

/** The census of a snapshot, read from a scratch copy: a normal open commits (builder, format repair), so the snapshot itself stays as taken. */
async function censusOfCopy(addon: RustAddon, dir: string, purgeIds: string[] = []): Promise<RestoreCensus> {
  const scratch = mkdtempSync(join(dirname(dir), 'census-'));
  try {
    for (const name of RUST_STORE_FILES) copyFileSync(join(dir, name), join(scratch, name), constants.COPYFILE_FICLONE);
    const store = await openRustStore(addon, scratch);
    try { return await store.restoreCensus(purgeIds); } finally { await store.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const pendingWork = (census: RestoreCensus): string[] => census.blockers
  .filter(b => b.reason === 'pending_requests' || b.reason === 'recovery_required').map(b => `${b.reason} ${b.count}`);

/** One snapshot of the brain `engine` owns (or reaches through its owner), verified against its own manifest. */
async function takeSnapshot(engine: RustEngine, addon: RustAddon, target: string, opId: string): Promise<StoreSnapshotManifest> {
  const sent = forwardWholeOperation<SnapshotStatus>(engine, 'snapshotStore', [target, { opId }]);
  const status = sent ? await sent : await snapshotStore(engine, target, { opId });
  if (!status.manifest) throw new AgentInstallError('snapshot_failed', 'The brain owner returned no snapshot manifest.');
  const report = await verifyStoreDir(addon, target, status.manifest);
  if (report.verdict !== 'ok') throw new AgentInstallError('snapshot_verify_failed', `The snapshot did not verify against its manifest (${report.verdict}: ${report.mismatches.join(', ') || report.integrity || 'no detail'}). Nothing was archived.`);
  return status.manifest;
}

export async function createRustBackup(options: RustBackupOptions): Promise<RustBackupResult> {
  const root = checkedRoot(options.root ?? dirname(configDir()));
  if (!isAbsolute(options.output)) throw new AgentInstallError('absolute_output_required', 'Backup output must be an absolute path.');
  const output = resolve(options.output);
  if (existsSync(output)) throw new AgentInstallError('backup_exists', 'Backup destination already exists; select a new filename.');
  if (!existsSync(dirname(output))) throw new AgentInstallError('output_parent_missing', 'Create a private backup destination directory first.');
  const state = readFileConfigState(join(root, '.gbrain', 'config.json'));
  if (state.kind !== 'present' || !isRustConfig(state.config) || state.config.remote_mcp || state.config.database_url) {
    throw new AgentInstallError('rust_required', 'A Rust backup needs an existing file-configured Rust brain.');
  }
  const dbPath = state.config.database_path;
  if (typeof dbPath !== 'string' || !existsSync(dbPath)) throw new AgentInstallError('unmanaged_database_path', 'This recovery format requires .gbrain/brain.rust within the selected root.');
  const managedFiles = (): string[] => checkedManagedPaths(root, readInstallReceipt(root, 'brain.rust')?.managed_paths ?? []).flatMap(path => walkFiles(root, path));
  const refusal = rustBackupPreflight(root, dbPath, () => managedFiles().reduce((sum, path) => sum + lstatSync(confinedPath(root, path)).size, 0));
  if (refusal) throw refusal;
  confinedPath(root, '.gbrain/brain.rust');
  const addon = options.addon ?? await loadRustAddon();
  const proto = (addon as { Brain?: { prototype?: Record<string, unknown> } }).Brain?.prototype;
  if (typeof proto?.snapshotTo !== 'function' || typeof proto?.restoreCensus !== 'function') {
    throw new AgentInstallError('backup_addon_too_old', 'This gbrain\'s Rust addon is older than the snapshot step, so it cannot back up a Rust brain. Install the current gbrain and its Rust addon, then run the backup again.');
  }
  const lock = await acquireBootstrapLock(root);
  let work: string | undefined;
  const engine = openRustEngine({ addon, databasePath: dbPath });
  try {
    work = mkdtempSync(join(dirname(output), '.gbrain-backup-')); chmodSync(work, 0o700);
    await protectNewBackupPath(work, 'directory');
    const receipt = readInstallReceipt(root, 'brain.rust');
    // As owner the engine holds the brain's lock until publication completes; as a client it asks the owner for the copy.
    await engine.connect({ engine: 'rust', database_path: dbPath } as never);
    const rows = await engine.listAllSources({ includeArchived: true }) as Array<{ id: string; local_path: string | null; incarnation?: string }>;
    const managedPaths = checkedManagedPaths(root, receipt?.managed_paths ?? []);
    const sources: RustSourceInventory[] = rows.map(row => {
      const rel = row.local_path ? relativeBackupPath(root, row.local_path) : null;
      return { id: row.id, incarnation: row.incarnation ?? null, local_path: row.local_path,
        managed_relative_path: rel && managedPaths.some(p => rel === p || rel.startsWith(p + '/')) ? rel : null };
    });
    const excludedPaths: string[] = [];
    const originals = [...new Set(managedPaths.flatMap(path => walkFiles(root, path, excludedPaths)))].sort();
    const credentialReferences: string[] = [];
    privateWrite(join(work, 'config.json'), JSON.stringify(sanitizedConfig(state.config, credentialReferences), null, 2) + '\n');
    const externalPaths: string[] = [];
    rebaseManagedConfig(state.config, root, root, managedPaths, externalPaths);
    const inventoryBefore = originals.map(path => ({ path, ...hashFile(confinedPath(root, path)) }));

    // The snapshot is retaken while it holds unfinished write work: a restore refuses such an archive (pending_requests).
    const attempts = options.retake?.attempts ?? SNAPSHOT_ATTEMPTS;
    const waitMs = options.retake?.waitMs ?? Math.floor(SNAPSHOT_BUDGET_MS / SNAPSHOT_ATTEMPTS);
    const deadline = Date.now() + (options.retake?.budgetMs ?? SNAPSHOT_BUDGET_MS);
    let snapshotDir = '';
    let manifest: StoreSnapshotManifest | undefined;
    let census: RestoreCensus | undefined;
    const stillPending: string[] = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      snapshotDir = join(work, `snapshot-${attempt}`);
      manifest = await takeSnapshot(engine, addon, snapshotDir, `backup-${randomUUID()}`);
      census = await censusOfCopy(addon, snapshotDir);
      stillPending.splice(0, stillPending.length, ...pendingWork(census));
      if (!stillPending.length) break;
      rmSync(snapshotDir, { recursive: true, force: true });
      if (attempt < attempts) { if (Date.now() + waitMs > deadline) break; await options.retake?.onWait?.(attempt, [...stillPending]); await sleep(waitMs); }
    }
    if (stillPending.length || !manifest || !census) {
      throw new AgentInstallError('writers_active', `The brain kept unfinished write work (${stillPending.join(', ')}) in every snapshot taken over ${Math.round((options.retake?.budgetMs ?? SNAPSHOT_BUDGET_MS) / 1000)} s, and a restore would refuse such an archive. Pause writers (gbrain serve, jobs and autopilot, agent sessions) and retry.`);
    }
    const snapshotJson = join(snapshotDir, 'SNAPSHOT.json');
    const files = [
      ...STORE_ENTRIES.map(path => ({ path, file: join(snapshotDir, path.slice(6)) })),
      { path: 'config.json', file: join(work, 'config.json') },
      ...inventoryBefore.map(entry => ({ path: `files/${entry.path}`, file: confinedPath(root, entry.path), expected: entry })),
    ];
    const inventoryAfter = [...new Set(managedPaths.flatMap(path => walkFiles(root, path)))].sort().map(path => ({ path, ...hashFile(confinedPath(root, path)) }));
    if (JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter) || JSON.stringify(readFileConfigState(join(root, '.gbrain', 'config.json'))) !== JSON.stringify(state)) {
      throw new AgentInstallError('writers_active', 'Managed files or configuration changed during backup. Pause writers and retry.');
    }
    const metadata: RustBackupMetadata = {
      kind: 'gbrain-rust', created_at: new Date().toISOString(), gbrain_version: VERSION, schema_version: manifest.schema_version,
      original_root: root, classification: 'sensitive-full-database-state',
      store: { engine_format_version: manifest.engine_format_version, generation: manifest.generation, brain_id: manifest.brain_id,
        schema_version: manifest.schema_version, snapshot_manifest_sha256: sha256Of(readFileSync(snapshotJson)) },
      sources, managed_paths: managedPaths, installation: receipt, credential_references: credentialReferences,
      omitted: [
        'Runtime packages and Bun; reinstall with gbrain-setup.',
        'Known standalone credential/environment filenames and cache/browser/backup directories are excluded from managed trees; their paths are inventoried. Other memory files may contain secrets.',
        'Unmanaged files, including .gbrain/credential-deliveries, browser sessions, git metadata, caches and prior backups outside managed data paths, are not included.',
        'The owner socket and lock file of the brain directory are never archived.',
        ...excludedPaths, ...externalPaths,
        ...(state.config.storage && (state.config.storage as { backend?: string }).backend !== 'local' ? ['Remote object storage content is not included; reconnect and verify the configured storage backend.'] : []),
        ...sources.filter(s => s.local_path && !s.managed_relative_path).map(s => `External source ${s.id}: ${s.local_path}`),
        'Native harness skills/routines must be reattached and verified; no platform account state is included.',
      ],
    };
    const archive = await writeBackupArchive(output, { ...metadata }, files);
    const restore_blockers = census.blockers.map(b => `This archive would not restore on this build yet: ${b.reason} (${b.count}${b.detail ? `, ${b.detail}` : ''}). See ${RESTORE_REFUSAL_DOCS}.`);
    return { archive: output, manifest: archive, restore_blockers };
  } finally {
    try { await engine.disconnect(); } finally {
      try { if (work) rmSync(work, { recursive: true, force: true }); } finally { lock.release(); }
    }
  }
}

function rustMetadataOf(manifest: ArchiveManifest): RustBackupMetadata {
  const value = manifest as unknown as RustBackupMetadata;
  const bad = (what: string): never => { throw new AgentInstallError('invalid_backup', `Invalid Rust backup metadata: ${what}.`); };
  if (value.kind !== 'gbrain-rust' || value.classification !== 'sensitive-full-database-state' || typeof value.original_root !== 'string') bad('kind');
  if (!Number.isInteger(value.schema_version) || value.schema_version < 1 || !Array.isArray(value.sources) || !Array.isArray(value.managed_paths) || !Array.isArray(value.credential_references) || !Array.isArray(value.omitted)) bad('shape');
  const store = value.store;
  if (!store || !Number.isInteger(store.engine_format_version) || !Number.isInteger(store.generation) || typeof store.brain_id !== 'string' || !Number.isInteger(store.schema_version) || !/^[a-f0-9]{64}$/.test(store.snapshot_manifest_sha256)) bad('store identity');
  if (store.schema_version !== value.schema_version) bad('schema version');
  if (relativeBackupPath(value.original_root, value.original_root) !== '') bad('archived root');
  if (value.schema_version > LATEST_VERSION) throw new AgentInstallError('newer_backup_schema', 'Upgrade GBrain before restoring this newer database schema.');
  checkedManagedPaths(null, value.managed_paths);
  if ([...value.credential_references, ...value.omitted].some(v => typeof v !== 'string')) bad('reconnect inventory');
  for (const source of value.sources) {
    if (!source || typeof source.id !== 'string' || (source.local_path !== null && typeof source.local_path !== 'string') || (source.incarnation !== null && typeof source.incarnation !== 'string')) bad('source inventory');
  }
  if (value.installation && (!['grok-bot', 'muse'].includes(value.installation.harness) || typeof value.installation.source_id !== 'string' || !value.sources.some(s => s.id === value.installation!.source_id))) bad('installer identity');
  return value;
}

type MirrorRead = { state: 'ok'; lines: PurgeMirrorLine[] } | { state: 'unavailable' } | { state: 'corrupt' };

/** The purge mirror, with the three outcomes kept apart: absent (the root is gone), readable, or damaged. */
export function readMirrorForRestore(path: string): MirrorRead {
  if (!existsSync(path)) return existsSync(join(dirname(path), 'config.json')) ? { state: 'ok', lines: [] } : { state: 'unavailable' };
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as PurgeMirrorLine);
    const whole = lines.every(l => l && typeof l === 'object' && typeof l.request === 'string' && (l.kind === 'committed' || (l.kind === 'intent' && typeof (l as PurgeMirrorIntent).source_id === 'string')));
    return whole ? { state: 'ok', lines } : { state: 'corrupt' };
  } catch { return { state: 'corrupt' }; }
}

/** The mirror's intents for the source incarnations this archive holds, split by whether the purge committed. */
function purgesToCheck(lines: PurgeMirrorLine[], sources: RustSourceInventory[]): { committed: PurgeMirrorIntent[]; intentOnly: PurgeMirrorIntent[] } {
  const done = new Set(lines.filter(l => l.kind === 'committed').map(l => l.request));
  const seen = new Set<string>();
  const mine = lines.filter((l): l is PurgeMirrorIntent => l.kind === 'intent' && sources.some(s => s.id === l.source_id && s.incarnation === l.source_incarnation))
    .filter(l => !seen.has(l.request) && !!seen.add(l.request));
  return { committed: mine.filter(l => done.has(l.request)), intentOnly: mine.filter(l => !done.has(l.request)) };
}

const record = (intent: PurgeMirrorIntent, outcome: ReplayRecord['outcome']): ReplayRecord => ({ request: intent.request, request_id: intent.request_id, scope: intent.scope, outcome });

function revokedText(revoked: { local_writers: string[]; oauth_clients: string[] }): string {
  const list = (what: string, ids: string[]): string => `${ids.length} ${what}${ids.length ? ` (${ids.join(', ')})` : ''}`;
  return `Revoked by this restore: ${list('local writer registration(s)', revoked.local_writers)}, ${list('OAuth client(s)', revoked.oauth_clients)}. ` +
    'Re-issue access for the restored brain: register its local writers again, run gbrain auth register-client <name> for each OAuth client, and have MCP users sign in again. ' +
    'Access tokens are not revoked by this restore: an archive that holds any is refused as unclassified_state, so none are in this root.';
}

export interface RustRestoreResult {
  root: string; quarantined_jobs: number; reconnect_required: string[]; shared_skills: null; purge_replay: PurgeReplayResult;
  revoked: { local_writers: string[]; oauth_clients: string[] };
  /** The brain id the archive held and the fresh one the restored brain has: the two are never equal. */
  brain_id: { archived: string; restored: string };
}

export async function restoreRustBackup(options: { archive: string; into: string; purgeMirror?: string; addon?: RustAddon } & SharedSkillRestoreOptions): Promise<RustRestoreResult> {
  const mode = validateSharedSkillRestoreMode(options);
  const root = checkedRoot(options.into);
  if (!existsSync(dirname(root))) throw new AgentInstallError('parent_missing', 'Restore parent directory must already exist.');
  // Both refusals come before a folder is reserved, so a retry needs no new --into.
  const addon = options.addon ?? await loadRustAddon();
  const hasVerify = typeof (addon as { Pool?: { prototype?: Record<string, unknown> } }).Pool?.prototype?.verifyStoreDir === 'function';
  if (!restoreAddonSupportsSafety(addon) || !hasVerify) throw withRuntime(restoreRefusal('restore_addon_too_old'), addon);
  if (mode === 'recovery') throw withRuntime(restoreRefusal('recovery_mode'), addon);
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentInstallError('restore_target_exists', 'Restore only into a new, absent root. Existing state is never overwritten.');
    throw error;
  }
  await protectNewBackupPath(root, 'directory');
  const restoreId = randomUUID();
  const receiptPath = join(root, 'restore-receipt.json');
  privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'restoring', mode }) + '\n');
  const stage = mkdtempSync(join(root, '.restore-')); chmodSync(stage, 0o700);
  let published = false;
  try {
    const payload = join(stage, 'payload'); mkdirSync(payload, { mode: 0o700 });
    const manifest = readBackupArchive(resolve(options.archive), payload);
    const metadata = rustMetadataOf(manifest);
    const paths = manifest.entries.map(e => e.path);
    if (STORE_ENTRIES.some(p => !paths.includes(p)) || !paths.includes('config.json') || paths.some(p => !(STORE_ENTRIES as readonly string[]).includes(p) && p !== 'config.json' && !p.startsWith('files/'))) {
      throw new AgentInstallError('invalid_backup', 'Unexpected backup payload.');
    }
    for (const rel of paths.filter(p => p.startsWith('files/')).map(p => p.slice(6))) {
      if (!metadata.managed_paths.some(p => rel === p || rel.startsWith(p + '/'))) throw new AgentInstallError('invalid_backup', 'Payload is outside the declared managed paths.');
    }
    const state = readFileConfigState(join(payload, 'config.json'));
    if (state.kind !== 'present' || !isRustConfig(state.config) || state.config.remote_mcp) throw new AgentInstallError('invalid_backup', 'Backup configuration is not a local Rust brain.');
    const snapshotEntry = manifest.entries.find(e => e.path === 'store/SNAPSHOT.json')!;
    if (snapshotEntry.sha256 !== metadata.store.snapshot_manifest_sha256) throw new AgentInstallError('invalid_backup', 'The archived store manifest does not match the backup inventory. Preserve the archive and use a verified backup.');
    const expected = JSON.parse(readFileSync(join(payload, 'store', 'SNAPSHOT.json'), 'utf8')) as StoreSnapshotManifest;
    for (const key of ['brain_id', 'generation', 'engine_format_version', 'schema_version'] as const) {
      if (expected[key] !== metadata.store[key]) throw new AgentInstallError('invalid_backup', `The archived store ${key.replace(/_/g, ' ')} does not match the backup inventory. Preserve the archive and use a verified backup.`);
    }
    const restored = join(stage, 'restored'); mkdirSync(restored, { mode: 0o700 });
    const home = join(restored, '.gbrain'); mkdirSync(home, { mode: 0o700 });
    const dbPath = join(home, 'brain.rust'); mkdirSync(dbPath, { mode: 0o700 });
    for (const name of RUST_STORE_FILES) renameSync(join(payload, 'store', name), join(dbPath, name));
    renameSync(join(payload, 'store', 'SNAPSHOT.json'), join(home, 'restore-snapshot.json'));

    // Phase 1: the restored bytes are the snapshot, checked without opening the store the normal way.
    const phase1 = await verifyStoreDir(addon, dbPath, expected);
    if (phase1.verdict !== 'ok') throw new AgentInstallError('restore_verify_failed', `The restored store does not equal the archived snapshot (${phase1.verdict}: ${phase1.mismatches.join(', ') || phase1.integrity || 'no detail'}). Preserve the archive and use a verified backup.`);

    // Purges, by request id: a committed purge the snapshot lacks would come back (F2).
    const mirror = readMirrorForRestore(options.purgeMirror ?? join(metadata.original_root, '.gbrain', PURGE_MIRROR_FILE));
    const toCheck = mirror.state === 'ok' ? purgesToCheck(mirror.lines, metadata.sources) : { committed: [], intentOnly: [] };
    // Phase 2: one writable open for the census and the quarantine; the generation moves once, by the quarantine.
    const store = await openRustStore(addon, dbPath);
    let census: RestoreCensus, quarantine, unverified: PurgeMirrorIntent[] = [];
    try {
      census = await store.restoreCensus(toCheck.committed.map(i => i.request));
      checkStoreIdentity(metadata, { ...census.store, generation: phase1.generation ?? census.store.generation });
      const refusal = restoreRefusalFor({ census, mode, mirror: mirror.state === 'corrupt' ? 'corrupt' : mirror.state === 'unavailable' ? 'unavailable' : 'ok' });
      if (refusal) throw withRuntime(refusal, addon, restoreId);
      if (toCheck.intentOnly.length) {
        const missing = new Set((await store.restoreCensus(toCheck.intentOnly.map(i => i.request))).purges_missing.map(id => id.toLowerCase()));
        unverified = toCheck.intentOnly.filter(i => missing.has(i.request.toLowerCase()));
      }
      const sources: RestoredSource[] = census.sources.map(s => {
        const rel = s.local_path ? relativeBackupPath(metadata.original_root, s.local_path) : null;
        return { id: s.id, local_path: s.local_path, managed_relative_path: rel && metadata.managed_paths.some(p => rel === p || rel.startsWith(p + '/')) ? rel : null };
      });
      quarantine = await store.restoreQuarantine(buildQuarantinePlan({ restoreId, census, sources, originalRoot: metadata.original_root, root, managedPaths: metadata.managed_paths }));
    } finally { await store.close(); }
    // A read-only look at the closed store: it refuses a file that was not closed cleanly.
    const phase2 = await verifyStoreDir(addon, dbPath).catch(cause => { throw new AgentInstallError('restore_close_incomplete', `The restored store did not close cleanly (${(cause as { code?: string }).code ?? 'unreadable'}). Staging is preserved; no usable root was published.`); });
    // The restore gave the store a fresh brain id: the closed store must carry exactly the one the quarantine reported, and not the archived one.
    if (phase2.verdict !== 'ok' || quarantine.previous_brain_id !== metadata.store.brain_id || quarantine.brain_id === quarantine.previous_brain_id || phase2.brain_id !== quarantine.brain_id) throw new AgentInstallError('restore_close_incomplete', 'The restored store did not verify after the restore. Staging is preserved; no usable root was published.');

    const detachedConfig: string[] = [];
    const config = { ...rebaseManagedConfig(state.config, metadata.original_root, root, metadata.managed_paths, detachedConfig), engine: 'rust', database_path: join(root, '.gbrain', 'brain.rust') } as unknown as GBrainConfig;
    delete config.database_url;
    privateWrite(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    privateWrite(join(home, 'restore-detached.json'), JSON.stringify({ restore_id: restoreId, ...quarantine, generation: { snapshot: phase1.generation, restored: phase2.generation } }, null, 2) + '\n');
    privateWrite(join(home, 'autopilot-paused'), `Paused by backup restore ${restoreId}. Review the reconnect inventory before explicitly resuming automation.\n`);
    for (const path of metadata.managed_paths) {
      const from = confinedPath(join(payload, 'files'), path);
      const to = confinedPath(restored, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      if (existsSync(from)) renameSync(from, to);
      else mkdirSync(to, { recursive: true, mode: 0o700 });
    }
    if (metadata.installation) {
      const old = metadata.installation;
      const next: AgentInstallReceipt = {
        format_version: 1, installation_id: randomUUID(), root, harness: old.harness,
        source_id: old.source_id, database_path: config.database_path!, state: 'installing',
        initialized: true, adopted: old.adopted, managed_paths: metadata.managed_paths,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        owned_files: Object.fromEntries(Object.entries(old.owned_files ?? {}).filter(([path]) => metadata.managed_paths.some(p => path === p || path.startsWith(p + '/')))),
        native: { skill_id: `gbrain-${restoreId}`, routine_id: `gbrain-maintenance-${restoreId}`, verification: 'unverified' },
        search_mode_confirmation_required: old.search_mode_confirmation_required,
      };
      privateWrite(join(home, 'agent-install', 'receipt.json'), JSON.stringify(next, null, 2) + '\n');
    }
    syncRestoredTree(restored);
    for (const name of readdirSync(restored)) {
      if (existsSync(join(root, name))) throw new AgentInstallError('restore_collision', 'New content appeared in the reserved restore root.');
      renameSync(join(restored, name), join(root, name));
    }
    // As on PGLite, a purge the snapshot already holds is not a replay; one it lacks and never confirmed is `unverified`.
    const replays = unverified.map(i => record(i, 'unverified'));
    const purgeReplay: PurgeReplayResult = { state: mirror.state === 'unavailable' ? 'unavailable' : replayState(replays), replays };
    const replayWarning = purgeReplay.state === 'unavailable'
      ? [`Purges made after the archive (${metadata.created_at}) could not be checked: no purge mirror could be read under ${metadata.original_root}. Restore again into a new root with the original brain's .gbrain/${PURGE_MIRROR_FILE} in place, or name a copy of it with gbrain backup restore --purge-mirror <absolute path>; otherwise purge the content again.`]
      : unverified.length ? [`Purge(s) ${unverified.map(i => i.request).join(', ')} were recorded but never confirmed committed, and the snapshot does not hold them: review them and run those purges again if the content is still present.`] : [];
    const reconnect = [...new Set([...metadata.credential_references.map(key => `Configure credential: ${key}`), ...metadata.omitted, ...detachedConfig, ...quarantine.reconnect,
      `Brain id changed by this restore: ${quarantine.previous_brain_id} (the original) -> ${quarantine.brain_id} (this restored brain). Anything that names the old id (a shared-skills member, a receipt) does not reach this brain.`,
      revokedText(quarantine.revoked), ...replayWarning, 'Autopilot is paused; review .gbrain/restore-detached.json before explicitly resuming automation.'])];
    const result: RustRestoreResult = { root, quarantined_jobs: quarantine.jobs_cancelled, reconnect_required: reconnect, shared_skills: null, purge_replay: purgeReplay,
      revoked: quarantine.revoked, brain_id: { archived: quarantine.previous_brain_id, restored: quarantine.brain_id } };
    privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'ready', original_root: metadata.original_root, engine: 'rust', quarantined_jobs: result.quarantined_jobs,
      reconnect_required: reconnect, purge_replay: purgeReplay, revoked: result.revoked, store: { archived: metadata.store, generation_restored: phase2.generation }, brain_id: result.brain_id, launcher_ready: false, setup_required: true, native_automation_started: false }, null, 2) + '\n');
    syncDirectory(root);
    published = true;
    return result;
  } catch (error) {
    const e = error as { code?: unknown; reason?: unknown };
    privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'failed', mode, reason: typeof e.code === 'string' ? e.code : 'restore_failed',
      ...(typeof e.reason === 'string' ? { refusal_reason: e.reason } : {}), original_preserved: true }) + '\n');
    throw error;
  } finally {
    // Failed staging is deliberately retained, privately, for inspection.
    if (published) rmSync(stage, { recursive: true, force: true });
  }
}

/** `gbrain backup create`: a Rust brain takes the Rust path, any other brain the unchanged PGLite one (which also owns the Postgres refusal). */
export async function createBackup(options: { output: string; root?: string } & Partial<Pick<RustBackupOptions, 'addon' | 'retake'>>): Promise<RustBackupResult | Awaited<ReturnType<typeof createPgliteBackup>>> {
  const root = checkedRoot(options.root ?? dirname(configDir()));
  const state = readFileConfigState(join(root, '.gbrain', 'config.json'));
  return state.kind === 'present' && isRustConfig(state.config) ? createRustBackup({ ...options, root }) : createPgliteBackup({ output: options.output, root: options.root });
}

/** `gbrain backup restore`: the archive's own `kind` chooses; an archive that cannot be read goes to the PGLite path, which reports it as before. */
export async function restoreBackup(options: Parameters<typeof restorePgliteBackup>[0] & { addon?: RustAddon }): Promise<Awaited<ReturnType<typeof restorePgliteBackup>> | RustRestoreResult> {
  let kind: unknown;
  try { kind = readBackupManifest(resolve(options.archive)).kind; }
  // silent-read-ok: an archive that cannot be read goes to the PGLite path, which reports it exactly as before; capability-refusal-ok: a file read has no engine capability to refuse
  catch { kind = undefined; }
  return kind === 'gbrain-rust' ? restoreRustBackup(options) : restorePgliteBackup(options);
}

/** What `gbrain backup verify-store` reads: the report of a copied brain directory, which nothing opens. */
export async function verifyRustStoreDir(dir: string, addon?: RustAddon): Promise<StoreVerifyReport> {
  if (!isAbsolute(dir)) throw new AgentInstallError('absolute_path_required', 'verify-store takes the absolute path of the copied brain directory.');
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new AgentInstallError('verify_target_missing', `${dir} is not a directory.`);
  return verifyStoreDir(addon ?? await loadRustAddon(), dir);
}
