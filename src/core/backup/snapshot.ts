/** Full PGLite state recovery for managed in-agent installations. Never starts workers. */
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { VERSION } from '../../version.ts';
import { PGLiteEngine } from '../pglite-engine.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { configDir, type GBrainConfig } from '../config.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { AgentInstallError, checkedManagedPaths, checkedRoot, confinedPath, privateWrite, readFileConfigState, readInstallReceipt, type AgentInstallReceipt } from '../agent-install/state.ts';
import { extractPgliteDump, hashFile, isBackupArchiveFile, readBackupArchive, writeBackupArchive, type ArchiveManifest } from './archive.ts';
import { quarantineRestoredExecution, type RestoreQuarantine } from './quarantine.ts';

interface SourceInventory { id: string; local_path: string | null; managed_relative_path: string | null }
interface BackupMetadata {
  kind: 'gbrain-pglite';
  created_at: string;
  gbrain_version: string;
  schema_version: number;
  original_root: string;
  classification: 'sensitive-full-database-state';
  sources: SourceInventory[];
  omitted: string[];
  credential_references: string[];
  managed_paths: string[];
  installation: AgentInstallReceipt | null;
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.cache', 'cache', 'caches', 'backup', 'backups',
  'browser-profile', 'browser-profiles', 'chrome-profile', 'chromium-profile',
  '.mozilla', '.ssh', '.aws', '.azure', 'credential-deliveries',
]);
const EXCLUDED_FILES = new Set(['.ds_store', '.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials', 'id_rsa', 'id_ed25519']);
const credentialFilename = /^(?:credentials?|auth|tokens?|secrets?|client[_-]secrets?|service[_-]account)(?:(?:[._-][a-z0-9_-]+)?\.(?:json|ya?ml|toml|ini|conf|txt))?$/i;
const credentialKey = /(^|[._-])(key|secret|token|password|pwd|passwd|auth)([._-]|$)/i;

export function sanitizedConfig(value: unknown, references: string[] = [], prefix = ''): unknown {
  if (Array.isArray(value)) return value.map((v, i) => sanitizedConfig(v, references, `${prefix}.${i}`));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (credentialKey.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')) || key === 'database_url') { references.push(path); continue; }
    result[key] = sanitizedConfig(field, references, path);
  }
  return result;
}

function walkFiles(root: string, relativePath: string, excluded: string[] = []): string[] {
  const path = confinedPath(root, relativePath);
  if (!existsSync(path)) throw new AgentInstallError('missing_managed_path', `Managed path is missing: ${relativePath}`);
  const stat = lstatSync(path);
  const name = basename(relativePath).toLowerCase();
  const reason = stat.isFile() && (name.endsWith('.gbrain-backup') || isBackupArchiveFile(path))
    ? 'previous GBrain backup archive'
    : name.startsWith('.env') || (stat.isFile() && (EXCLUDED_FILES.has(name) || credentialFilename.test(name) || /\.(?:key|p12|pfx)$/.test(name)))
    ? 'known standalone credential/environment filename'
    : stat.isDirectory() && EXCLUDED_DIRECTORIES.has(name) ? 'cache, browser, credential, runtime or backup directory' : null;
  if (reason) { excluded.push(`Excluded managed path ${relativePath}: ${reason}.`); return []; }
  if (stat.isFile()) return [relativePath];
  if (!stat.isDirectory()) throw new AgentInstallError('unsupported_file', `Unsupported managed file: ${relativePath}`);
  const result: string[] = [];
  for (const name of readdirSync(path).sort()) {
    result.push(...walkFiles(root, `${relativePath}/${name}`, excluded));
  }
  return result;
}

function relativeInside(root: string, path: string): string | null {
  const result = relative(root, resolve(path));
  return result && result !== '..' && !result.startsWith('..' + sep) && !resolve(path).startsWith(root + sep + '.gbrain' + sep) ? result : null;
}

/** Persist restored file contents AND directory entries before the ready receipt. */
function syncRestoredTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) syncRestoredTree(join(path, name));
  else if (!stat.isFile()) throw new AgentInstallError('unsupported_file', 'Unexpected file type in restored staging.');
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Only known filesystem config fields are paths; never rewrite remembered text. */
export function rebaseManagedConfig(config: GBrainConfig, originalRoot: string, root: string, managedPaths: string[], detached: string[]): GBrainConfig {
  const result = structuredClone(config) as GBrainConfig & Record<string, unknown>;
  if (result.autopilot) {
    for (const value of Object.values(result.autopilot)) {
      if (value && typeof value === 'object' && 'enabled' in value) value.enabled = false;
    }
    detached.push('Autopilot configuration is disabled; review schedules before explicitly resuming.');
  }
  if (result.storage && (result.storage as { backend?: string }).backend !== 'local') {
    delete result.storage;
    detached.push('External storage backend detached; explicitly reconnect and verify before using it.');
  }
  for (const parts of [
    ['storage', 'localPath'], ['mcp', 'skills_dir'],
    ['dream', 'synthesize', 'session_corpus_dir'], ['dream', 'synthesize', 'meeting_transcripts_dir'],
  ]) {
    let parent: Record<string, unknown> = result;
    for (const part of parts.slice(0, -1)) {
      // Restore only data present in the file configuration, never inherited
      // objects or accessors that could redirect writes outside this clone.
      const child = Object.getOwnPropertyDescriptor(parent, part)?.value;
      if (!child || typeof child !== 'object' || Array.isArray(child)) { parent = {}; break; }
      parent = child as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    const value = Object.getOwnPropertyDescriptor(parent, leaf)?.value;
    if (typeof value !== 'string') continue;
    const rel = isAbsolute(value) ? relativeInside(originalRoot, value) : null;
    if (rel && managedPaths.some(p => rel === p || rel.startsWith(p + '/'))) parent[leaf] = confinedPath(root, rel);
    else {
      detached.push(`External configuration path ${parts.join('.')}: ${value}`);
      // A local backend with no path silently defaults to /tmp; detach the
      // whole backend so restored attachment operations cannot use that fallback.
      if (parts[0] === 'storage') delete result.storage;
      else delete parent[leaf];
    }
  }
  return result;
}

export async function createPgliteBackup(options: { output: string; root?: string }): Promise<{ archive: string; manifest: ArchiveManifest }> {
  const root = checkedRoot(options.root ?? dirname(configDir()));
  if (!isAbsolute(options.output)) throw new AgentInstallError('absolute_output_required', 'Backup output must be an absolute path.');
  const output = resolve(options.output);
  if (existsSync(output)) throw new AgentInstallError('backup_exists', 'Backup destination already exists; select a new filename.');
  if (!existsSync(dirname(output))) throw new AgentInstallError('output_parent_missing', 'Create a private backup destination directory first.');
  const state = readFileConfigState(join(root, '.gbrain', 'config.json'));
  if (state.kind !== 'present' || state.config.engine !== 'pglite' || state.config.remote_mcp || state.config.database_url) {
    throw new AgentInstallError('pglite_required', 'Full local snapshots require an existing file-configured PGLite brain.');
  }
  const dbPath = state.config.database_path;
  if (typeof dbPath !== 'string' || resolve(dbPath) !== join(root, '.gbrain', 'brain.pglite') || !existsSync(dbPath)) {
    throw new AgentInstallError('unmanaged_database_path', 'This recovery format requires .gbrain/brain.pglite within the selected root.');
  }
  confinedPath(root, '.gbrain/brain.pglite');
  const lock = await acquireBootstrapLock(root);
  let work: string | undefined;
  const engine = new PGLiteEngine();
  try {
    work = mkdtempSync(join(dirname(output), '.gbrain-backup-')); chmodSync(work, 0o700);
    const receipt = readInstallReceipt(root);
    // The engine holds its real PGLite writer lock until publication completes.
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources ORDER BY id');
    const managedPaths = checkedManagedPaths(root, receipt?.managed_paths ?? []);
    const sources: SourceInventory[] = rows.map(row => {
      const rel = row.local_path ? relativeInside(root, row.local_path) : null;
      return { ...row, managed_relative_path: rel && managedPaths.some(p => rel === p || rel.startsWith(p + '/')) ? rel : null };
    });
    const excludedPaths: string[] = [];
    const originals = [...new Set(managedPaths.flatMap(path => walkFiles(root, path, excludedPaths)))].sort();
    // Copy config separately after removing known file-plane credentials. The
    // database remains a complete dump and may itself contain credentials.
    const credentialReferences: string[] = [];
    privateWrite(join(work, 'config.json'), JSON.stringify(sanitizedConfig(state.config, credentialReferences), null, 2) + '\n');
    const externalPaths: string[] = [];
    rebaseManagedConfig(state.config, root, root, managedPaths, externalPaths);
    const inventoryBefore = originals.map(path => ({ path, ...hashFile(confinedPath(root, path)) }));
    const dump = await engine.db.dumpDataDir('none');
    privateWrite(join(work, 'database.tar'), new Uint8Array(await dump.arrayBuffer()));
    const files = [
      { path: 'database.tar', file: join(work, 'database.tar') },
      { path: 'config.json', file: join(work, 'config.json') },
      ...inventoryBefore.map(entry => ({ path: `files/${entry.path}`, file: confinedPath(root, entry.path), expected: entry })),
    ];
    const inventoryAfter = [...new Set(managedPaths.flatMap(path => walkFiles(root, path)))].sort().map(path => ({ path, ...hashFile(confinedPath(root, path)) }));
    if (JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter) || JSON.stringify(readFileConfigState(join(root, '.gbrain', 'config.json'))) !== JSON.stringify(state)) {
      throw new AgentInstallError('writers_active', 'Managed files or configuration changed during backup. Pause writers and retry.');
    }
    const metadata: BackupMetadata = {
      kind: 'gbrain-pglite', created_at: new Date().toISOString(), gbrain_version: VERSION,
      schema_version: Number(await engine.getConfig('version')),
      original_root: root, classification: 'sensitive-full-database-state', sources,
      managed_paths: managedPaths, installation: receipt,
      credential_references: credentialReferences,
      omitted: [
        'Runtime packages and Bun; reinstall with gbrain-setup.',
        'Known standalone credential/environment filenames and cache/browser/backup directories are excluded from managed trees; their paths are inventoried. Other memory files may contain secrets.',
        'Unmanaged files, including .gbrain/credential-deliveries, browser sessions, git metadata, caches and prior backups outside managed data paths, are not included.',
        ...excludedPaths,
        ...externalPaths,
        ...(state.config.storage && (state.config.storage as { backend?: string }).backend !== 'local' ? ['Remote object storage content is not included; reconnect and verify the configured storage backend.'] : []),
        ...sources.filter(s => s.local_path && !s.managed_relative_path).map(s => `External source ${s.id}: ${s.local_path}`),
        'Native harness skills/routines must be reattached and verified; no platform account state is included.',
      ],
    };
    const manifest = writeBackupArchive(output, { ...metadata }, files);
    return { archive: output, manifest };
  } finally {
    try { await engine.disconnect(); } finally {
      try { if (work) rmSync(work, { recursive: true, force: true }); } finally { lock.release(); }
    }
  }
}

function metadataOf(manifest: ArchiveManifest): BackupMetadata {
  const value = manifest as unknown as BackupMetadata;
  if (value.kind !== 'gbrain-pglite' || value.classification !== 'sensitive-full-database-state' || typeof value.original_root !== 'string' || !Number.isInteger(value.schema_version) || value.schema_version < 1 || !Array.isArray(value.sources) || !Array.isArray(value.managed_paths) || !Array.isArray(value.credential_references) || !Array.isArray(value.omitted)) {
    throw new AgentInstallError('invalid_backup', 'Invalid PGLite backup metadata.');
  }
  checkedRoot(value.original_root);
  if (value.schema_version > LATEST_VERSION) throw new AgentInstallError('newer_backup_schema', 'Upgrade GBrain before restoring this newer database schema.');
  checkedManagedPaths('/restore', value.managed_paths);
  if ([...value.credential_references, ...value.omitted].some(v => typeof v !== 'string')) throw new AgentInstallError('invalid_backup', 'Invalid backup reconnect inventory.');
  for (const source of value.sources) {
    if (!source || typeof source.id !== 'string' || (source.local_path !== null && typeof source.local_path !== 'string')) throw new AgentInstallError('invalid_backup', 'Invalid source inventory.');
    if (source.managed_relative_path !== null && (typeof source.managed_relative_path !== 'string' || (!value.managed_paths.includes(source.managed_relative_path) && !value.managed_paths.some(p => source.managed_relative_path!.startsWith(p + '/'))))) throw new AgentInstallError('invalid_backup', 'Source path is outside the managed inventory.');
  }
  if (value.installation && (!['grok-bot', 'muse'].includes(value.installation.harness) || typeof value.installation.source_id !== 'string' || !value.sources.some(s => s.id === value.installation!.source_id))) throw new AgentInstallError('invalid_backup', 'Invalid installer identity in backup.');
  return value;
}

export async function restorePgliteBackup(options: { archive: string; into: string }): Promise<{ root: string; quarantined_jobs: number; reconnect_required: string[] }> {
  const root = checkedRoot(options.into);
  if (!existsSync(dirname(root))) throw new AgentInstallError('parent_missing', 'Restore parent directory must already exist.');
  // Exclusive mkdir reserves an ABSENT destination. A crash leaves a private
  // incomplete receipt, never destroys the old brain or publishes a launcher.
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentInstallError('restore_target_exists', 'Restore only into a new, absent root. Existing state is never overwritten.');
    throw error;
  }
  const restoreId = randomUUID();
  const receiptPath = join(root, 'restore-receipt.json');
  privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'restoring' }) + '\n');
  const stage = mkdtempSync(join(root, '.restore-')); chmodSync(stage, 0o700);
  const engine = new PGLiteEngine();
  let published = false;
  try {
    const payload = join(stage, 'payload'); mkdirSync(payload, { mode: 0o700 });
    const manifest = readBackupArchive(resolve(options.archive), payload);
    const metadata = metadataOf(manifest);
    if (!manifest.entries.some(e => e.path === 'database.tar') || !manifest.entries.some(e => e.path === 'config.json') || manifest.entries.some(e => e.path !== 'database.tar' && e.path !== 'config.json' && !e.path.startsWith('files/'))) throw new AgentInstallError('invalid_backup', 'Unexpected backup payload.');
    for (const entry of manifest.entries.filter(e => e.path.startsWith('files/'))) {
      const rel = entry.path.slice(6);
      if (!metadata.managed_paths.some(p => rel === p || rel.startsWith(p + '/'))) throw new AgentInstallError('invalid_backup', 'Payload is outside the declared managed paths.');
    }
    const state = readFileConfigState(join(payload, 'config.json'));
    if (state.kind !== 'present' || state.config.engine !== 'pglite' || state.config.remote_mcp) throw new AgentInstallError('invalid_backup', 'Backup configuration is not local PGLite.');
    const restored = join(stage, 'restored'); mkdirSync(restored, { mode: 0o700 });
    const home = join(restored, '.gbrain'); mkdirSync(home, { mode: 0o700 });
    const dbPath = join(home, 'brain.pglite'); mkdirSync(dbPath, { mode: 0o700 });
    extractPgliteDump(join(payload, 'database.tar'), dbPath);
    if (readFileSync(join(dbPath, 'PG_VERSION'), 'utf8').trim() !== '17') throw new AgentInstallError('unsupported_database_version', 'This runtime only restores PostgreSQL 17 PGLite clusters.');
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    const databaseSchema = Number(await engine.getConfig('version'));
    if (!Number.isInteger(databaseSchema) || databaseSchema !== metadata.schema_version) {
      throw new AgentInstallError('backup_schema_mismatch', 'The archived database schema does not match the backup inventory. Preserve the archive and use a verified backup.');
    }
    // No initSchema, migration, sync, provider request, or worker is run here.
    // Restore changes are committed in ONE database transaction.
    let quarantined = 0;
    let execution: RestoreQuarantine;
    await engine.transaction(async tx => {
      execution = await quarantineRestoredExecution(tx, { sources: metadata.sources, originalRoot: metadata.original_root, root, managedPaths: metadata.managed_paths, restoreId });
      const jobs = await tx.executeRaw<{ id: number }>(`UPDATE minion_jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL, finished_at = NOW(), updated_at = NOW(), error_text = 'quarantined by backup restore; inspect and explicitly resubmit', data = data || jsonb_build_object('__restore_previous_status', status, '__restore_id', $1::text) WHERE status NOT IN ('completed', 'failed', 'dead', 'cancelled') RETURNING id`, [restoreId]);
      quarantined = jobs.length;
    });
    await engine.executeRaw('CHECKPOINT');
    const restoredDatabase = engine.db;
    await engine.disconnect();
    if (!restoredDatabase.closed) throw new AgentInstallError('restore_close_incomplete', 'The restored database did not close cleanly. Staging is preserved; no usable root was published.');
    const detachedConfig: string[] = [];
    const config: GBrainConfig = { ...rebaseManagedConfig(state.config, metadata.original_root, root, metadata.managed_paths, detachedConfig), engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite') };
    delete config.database_url;
    privateWrite(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    privateWrite(join(home, 'restore-detached.json'), JSON.stringify({ restore_id: restoreId, ...execution! }, null, 2) + '\n');
    privateWrite(join(home, 'autopilot-paused'), `Paused by backup restore ${restoreId}. Review the reconnect inventory before explicitly resuming automation.\n`);
    for (const path of metadata.managed_paths) {
      const from = confinedPath(join(payload, 'files'), path);
      const to = confinedPath(restored, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      if (existsSync(from)) renameSync(from, to);
      else mkdirSync(to, { recursive: true, mode: 0o700 });
    }
    // Recreate an ownership receipt for setup/repair, never copy old runtime
    // paths, credentials, launcher hashes or platform verification claims.
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
    // root is our exclusively reserved directory; only these staged children
    // are published. No launcher exists until a subsequent setup/repair.
    syncRestoredTree(restored);
    for (const name of readdirSync(restored)) {
      if (existsSync(join(root, name))) throw new AgentInstallError('restore_collision', 'New content appeared in the reserved restore root.');
      renameSync(join(restored, name), join(root, name));
    }
    const reconnect = [...new Set([...metadata.credential_references.map(key => `Configure credential: ${key}`), ...metadata.omitted, ...detachedConfig, ...execution!.reconnect, 'Autopilot is paused; review .gbrain/restore-detached.json before explicitly resuming automation.'])];
    privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'ready', original_root: metadata.original_root, quarantined_jobs: quarantined, reconnect_required: reconnect, launcher_ready: false, setup_required: true, native_automation_started: false }, null, 2) + '\n');
    const rootFd = openSync(root, 'r'); try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
    published = true;
    return { root, quarantined_jobs: quarantined, reconnect_required: reconnect };
  } catch (error) {
    privateWrite(receiptPath, JSON.stringify({ format_version: 1, restore_id: restoreId, state: 'failed', reason: error instanceof AgentInstallError ? error.code : 'restore_failed', original_preserved: true }) + '\n');
    throw error;
  } finally {
    try { await engine.disconnect(); } finally {
      if (published) rmSync(stage, { recursive: true, force: true });
      // Failed staging is deliberately retained, privately, for inspection.
    }
  }
}
