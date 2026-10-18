/**
 * #6649: `gbrain backup create` on PGLite checks, before it takes the writer
 * lock or opens the database, that this recovery format can hold the brain:
 * the data dir must be the managed `<root>/.gbrain/brain.pglite` with no
 * symlink on the way (a flat or symlinked home is `unmanaged_database_path`),
 * and its estimated archive size must fit the 8 GiB cap (`backup_too_large`).
 * Both refusals name the same recovery: the quiesced physical-copy runbook.
 * Doctor's `pglite_data_dir` uses the same size estimate to warn early.
 */
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { BACKUP_ARCHIVE_MAX_BYTES } from './archive.ts';
import { UNREADABLE_CODES } from './runtime-artefacts.ts';

export const PHYSICAL_COPY_RUNBOOK = 'docs/guides/in-agent-setup.md#large-or-non-standard-brains-quiesced-physical-copy';
/** Doctor warns once the data dir's estimated archive size passes this share of the cap. */
export const BACKUP_SIZE_WARN_RATIO = 0.75;

const TAR_BLOCK = 512;

/**
 * Bytes `dumpDataDir` would write for `dir`: every regular file's apparent
 * size rounded up to a 512-byte tar block plus its header block, a header per
 * directory, and the two closing blocks. Symlinks are not followed. An entry
 * that vanished or that the runtime cannot lstat (a Windows AF_UNIX socket
 * reads as EACCES) adds nothing: it is not a regular file, and the runtime
 * artefact sweep decides what happens to it.
 */
export function estimatedTarBytes(dir: string): number {
  let total = 2 * TAR_BLOCK;
  const walk = (path: string): void => {
    let stat: Stats;
    try { stat = lstatSync(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (path !== dir && code && (code === 'ENOENT' || UNREADABLE_CODES.has(code))) return;
      throw error;
    }
    if (stat.isDirectory()) {
      total += TAR_BLOCK;
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stat.isFile()) {
      total += TAR_BLOCK + Math.ceil(stat.size / TAR_BLOCK) * TAR_BLOCK;
    }
  };
  walk(dir);
  return total;
}

export type PgliteBackupLayout = 'managed' | 'flat' | 'symlinked';

/** Where the configured data dir sits relative to the managed `<root>/.gbrain/brain.pglite`. */
export function pgliteBackupLayout(root: string, dbPath: string): PgliteBackupLayout {
  const managed = join(root, '.gbrain', 'brain.pglite');
  if (resolve(dbPath) !== managed) return 'flat';
  for (let path = managed; path !== root && dirname(path) !== path; path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) return 'symlinked'; } catch { /* missing: reported by the caller */ }
  }
  return 'managed';
}

const RUNBOOK_STEPS = 'Take a quiesced physical copy instead: stop every gbrain writer on this brain (gbrain serve, jobs and autopilot, agent sessions), ' +
  'copy the whole data directory and config.json into a new, isolated GBRAIN_HOME, point that config\'s database_path at the copy, ' +
  `then verify the copy with gbrain doctor --json run with GBRAIN_HOME set to it before relying on it (runbook: ${PHYSICAL_COPY_RUNBOOK}).`;

/** The runbook needs the user (writers stop, a copy is made); the agent then runs doctor read-only. */
export function physicalCopyFix(): Action {
  return {
    ask_user: true, argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, docs: PHYSICAL_COPY_RUNBOOK,
    why: 'Read-only, after the user agrees to the physical copy: doctor opens the brain only when no other gbrain process holds it, so a clean run shows the writers are stopped.',
    user_message: RUNBOOK_STEPS, verify: { argv: ['gbrain', 'doctor', '--json'] },
  };
}

/**
 * The refusal for a brain this recovery format cannot hold, or null when it can.
 * Reads only file metadata; `managedFileBytes` runs only for a managed layout.
 */
export function pgliteBackupPreflight(root: string, dbPath: string, managedFileBytes: () => number): OperationError | null {
  const layout = pgliteBackupLayout(root, dbPath);
  if (layout !== 'managed') {
    return opError('unmanaged_database_path',
      layout === 'flat'
        ? `This recovery format requires the data directory at ${join(root, '.gbrain', 'brain.pglite')}; this brain's database_path is ${dbPath}. Nothing was written.`
        : `This recovery format requires a data directory with no symlink on its path; ${join(root, '.gbrain', 'brain.pglite')} reaches the data through a symlink. Nothing was written.`,
      RUNBOOK_STEPS,
      { why: 'The archive records the managed root it can restore and refuses to follow a symlink out of it.', fix: physicalCopyFix(), docs: PHYSICAL_COPY_RUNBOOK, detail: `layout=${layout}` });
  }
  const bytes = estimatedTarBytes(dbPath) + managedFileBytes();
  if (bytes <= BACKUP_ARCHIVE_MAX_BYTES) return null;
  return opError('backup_too_large',
    `This brain needs about ${formatGiB(bytes)} in a backup archive (${bytes} bytes), over the archive's ${formatGiB(BACKUP_ARCHIVE_MAX_BYTES)} cap. Nothing was written.`,
    RUNBOOK_STEPS,
    { why: 'The archive format holds at most 8 GiB of payload; refusing before the dump avoids hours of work and a partial archive.', fix: physicalCopyFix(), docs: PHYSICAL_COPY_RUNBOOK, detail: `bytes=${bytes} limit=${BACKUP_ARCHIVE_MAX_BYTES}` });
}

export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
