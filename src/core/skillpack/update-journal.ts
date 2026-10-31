/**
 * skillpack/update-journal.ts — the journal and backups behind
 * `gbrain skillpack reference --update-untouched` and `gbrain skillpack restore`.
 *
 * Layout: `~/.gbrain/skillpack-backups/<id>/journal.json` plus
 * `files/<rel>`, the bytes each replaced file had before the update. Plain
 * files under GBRAIN_HOME, so it works the same with or without a brain
 * repository.
 *
 * Journal lifecycle: a run writes the journal (status `pending`, every
 * skill `planned`) before it changes anything. Each skill moves to
 * `applying` before its first backup, then to `committed`, `rolled_back`
 * or `abandoned`. The run ends `complete`. A journal still `pending`
 * when no run holds the workspace lock is a crash (`skillpack_update_incomplete`).
 * `restore` puts back each applied file whose current hash equals the
 * journal's post-update hash and marks the journal `restored`.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { dirname, join } from 'path';

import { gbrainPath } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { assertLegacySkillFilesystemWrite, confinedSkillChildWrite } from './writer-guard.ts';

export const JOURNAL_SCHEMA = 'gbrain-skillpack-journal-v1' as const;
export const JOURNAL_KEEP_DAYS = 30;
export const JOURNAL_KEEP_LAST = 10;

export type JournalSkillStatus = 'planned' | 'applying' | 'committed' | 'rolled_back' | 'abandoned' | 'restored';

export interface JournalFile {
  /** Path relative to the skills root (posix). */
  rel: string;
  /** sha256 before the update; null when the file did not exist. */
  pre: string | null;
  /** sha256 the update writes. */
  post: string;
  /** The base recorded for this file before the update (restore puts it back). */
  base_before: string | null;
  /** Backup path relative to the journal dir; null when `pre` is null. */
  backup: string | null;
}

export interface JournalSkill {
  slug: string;
  status: JournalSkillStatus;
  reason?: string;
  files: JournalFile[];
}

export interface Journal {
  schema_version: typeof JOURNAL_SCHEMA;
  id: string;
  status: 'pending' | 'complete' | 'restored';
  skills_root: string;
  created_at: string;
  pid: number;
  skills: JournalSkill[];
}

export function backupsRoot(): string {
  return gbrainPath('skillpack-backups');
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** sha256 of a regular file, null when absent. A symlink (or anything not a regular file) throws `target_escape`. */
export function hashTarget(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile()) {
    throw new OperationError('target_escape', `${path} is not a regular file (symlinks are refused).`,
      'Replace it with a regular file, or pin the skill with gbrain skillpack pin <skill>.');
  }
  return sha256(readFileSync(path));
}

export function newJournalId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

export function journalDir(id: string, root = backupsRoot()): string {
  if (!/^[0-9TZ-]+-[0-9a-f]{6}$/.test(id)) {
    throw new OperationError('skillpack_journal_not_found', `'${id}' is not a skillpack backup id.`,
      'List the backups with gbrain skillpack restore --list.');
  }
  return join(root, id);
}

export function writeJournal(journal: Journal, root = backupsRoot()): void {
  const dir = journalDir(journal.id, root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'journal.json');
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJournal(id: string, root = backupsRoot()): Journal {
  const path = join(journalDir(id, root), 'journal.json');
  if (!existsSync(path)) {
    throw new OperationError('skillpack_journal_not_found', `No skillpack backup '${id}' under ${root}.`,
      'List the backups with gbrain skillpack restore --list.');
  }
  const journal = JSON.parse(readFileSync(path, 'utf-8')) as Journal;
  if (journal.schema_version !== JOURNAL_SCHEMA) {
    throw new OperationError('skillpack_journal_not_found', `${path} is not a ${JOURNAL_SCHEMA} journal.`,
      'List the backups with gbrain skillpack restore --list.');
  }
  return journal;
}

/** Every readable journal, newest first. Unreadable entries are skipped. */
export function listJournals(root = backupsRoot()): Journal[] {
  if (!existsSync(root)) return [];
  const out: Journal[] = [];
  for (const id of readdirSync(root).sort().reverse()) {
    try {
      out.push(readJournal(id, root));
    } catch { /* not a journal dir */ }
  }
  return out;
}

/** Journals a crash left `pending`, optionally only for one skills root. */
export function pendingJournals(opts: { root?: string; skillsRoot?: string } = {}): Journal[] {
  return listJournals(opts.root).filter(j => j.status === 'pending' && (!opts.skillsRoot || j.skills_root === opts.skillsRoot));
}

/** Keep journals younger than JOURNAL_KEEP_DAYS, the newest JOURNAL_KEEP_LAST, and every pending one. Returns the pruned ids. */
export function pruneJournals(root = backupsRoot(), now = Date.now()): string[] {
  const pruned: string[] = [];
  listJournals(root).forEach((journal, index) => {
    const age = now - Date.parse(journal.created_at);
    if (journal.status === 'pending' || index < JOURNAL_KEEP_LAST || age < JOURNAL_KEEP_DAYS * 86_400_000) return;
    rmSync(journalDir(journal.id, root), { recursive: true, force: true });
    pruned.push(journal.id);
  });
  return pruned;
}

/** Copy `target` into the journal's backup tree and verify the copy hashes to `expected`. */
export function backupFile(journalId: string, rel: string, target: string, expected: string, root = backupsRoot()): string {
  const backupRel = `files/${rel}`;
  const dest = join(journalDir(journalId, root), backupRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(target, dest);
  if (sha256(readFileSync(dest)) !== expected) throw new Error(`${rel} changed while it was being backed up`);
  return backupRel;
}

/** Atomically put `bytes` at `target` (temp file in the same directory, then rename). */
export function replaceFile(target: string, bytes: Buffer): void {
  assertLegacySkillFilesystemWrite(target);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.gbrain-skillpack-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Undo one applied file if it still holds the update's bytes: restore the
 * backup, or remove a file the update created. Returns false (and leaves the
 * file) when it changed since the update.
 */
export function undoFile(journalId: string, skillsRoot: string, file: JournalFile, root = backupsRoot()): boolean {
  const target = confinedSkillChildWrite(skillsRoot, file.rel);
  if (hashTarget(target) !== file.post) return false;
  if (file.pre === null || file.backup === null) {
    unlinkSync(target);
    return true;
  }
  const bytes = readFileSync(join(journalDir(journalId, root), file.backup));
  if (sha256(bytes) !== file.pre) {
    throw new OperationError('skillpack_backup_corrupt', `The backup of ${file.rel} in ${journalId} does not hash to the journal's pre-update hash.`,
      `Leave ${file.rel} as it is, or compare it with the bundle using gbrain skillpack reference <skill>.`);
  }
  replaceFile(target, bytes);
  return true;
}

export interface RestorePlanFile {
  slug: string;
  rel: string;
  action: 'restore' | 'remove' | 'already_restored' | 'skipped' | 'conflict';
}

/** What restore would do with each applied file. Pure read. */
export function planRestore(journal: Journal, skip: ReadonlySet<string>): RestorePlanFile[] {
  const out: RestorePlanFile[] = [];
  for (const skill of journal.skills) {
    if (skill.status !== 'applying' && skill.status !== 'committed' && skill.status !== 'restored') continue;
    for (const file of skill.files) {
      const current = hashTarget(confinedSkillChildWrite(journal.skills_root, file.rel, { dryRun: true }));
      const action: RestorePlanFile['action'] = current === file.pre ? 'already_restored'
        : skip.has(file.rel) ? 'skipped'
        : current === file.post ? (file.pre === null ? 'remove' : 'restore')
        : 'conflict';
      out.push({ slug: skill.slug, rel: file.rel, action });
    }
  }
  return out;
}
