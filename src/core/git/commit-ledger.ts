/**
 * PR B Part 3 (docs/designs/REFRESH_WRITE_BARRIER.md): the commit ledger. Every commit gbrain makes in a repository is
 * appended as one JSON line to `<git common dir>/gbrain/commit-ledger.jsonl`, which lives inside `.git` (never tracked,
 * shared by every worktree, readable without a database). doctor's `foreign_writers` names every locally created commit
 * that is not in it.
 *
 * - One ledger lock (`commit-ledger.lock` beside it) is taken for the start line, every append and rotation; it is held
 *   for microseconds and never while git runs.
 * - The first append writes a `start` record: reflog entries older than it are uncovered, never foreign.
 * - At 4 MiB the file rotates to `commit-ledger.1.jsonl` (one previous file kept).
 * - Plumbing sites (`commit-tree`) record the sha before the ref moves. Porcelain sites (`git commit`) write an intent
 *   line (`head_before`, the message's sha256) first and the commit line after; doctor reports a commit matching an open
 *   intent as unconfirmed and never writes it back.
 * - A failed append never fails the commit: it is logged once, and doctor then reports that commit as foreign (the safe
 *   direction for an alarm). A directory that is not a git repository records nothing.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { acquireNativeLock, acquireNativeLockSync } from '../persistence/native-lock.ts';
import { existingLocalHostId } from '../persistence/identity.ts';

export type LedgerWriter = 'commit_push' | 'door' | 'merge' | 'replay' | 'effect' | 'sync_init' | 'workspace_push' | 'bootstrap' | 'hosted_repo';

export const LEDGER_DIR = 'gbrain';
export const LEDGER_FILE = 'commit-ledger.jsonl';
export const LEDGER_ROTATED_FILE = 'commit-ledger.1.jsonl';
export const LEDGER_LOCK_FILE = 'commit-ledger.lock';
export const LEDGER_ROTATE_BYTES = 4 * 1024 * 1024;
const LINE_MAX_BYTES = 1023;
const LOCK_WAIT_MS = 2_000;

export interface LedgerCommit { sha: string; writer: LedgerWriter; ref?: string | null; request_id?: string | null; worktree_id?: string | null; supersedes?: string[]; adopted?: string[] }
export interface LedgerIntent { writer: LedgerWriter; head_before: string | null; message: string }

export type LedgerRecord =
  | { v: 1; e: 'start'; t: string }
  | { v: 1; e: 'commit'; t: string; sha: string; writer: LedgerWriter; request_id: string | null; worktree: string | null; worktree_id: string | null; ref: string | null; pid: number; host: string | null; supersedes?: string[]; adopted?: string[] }
  | { v: 1; e: 'intent'; t: string; writer: LedgerWriter; head_before: string | null; msg_sha256: string; worktree: string | null; pid: number; host: string | null };

interface Location { common: string; gitDir: string; worktree: string | null }
const locations = new Map<string, Location | null>();

/** The repository's common dir, this checkout's git dir and toplevel (null for a bare repository); null outside git. */
export function ledgerLocation(root: string): Location | null {
  let key = resolve(root);
  try { key = realpathSync(key); } catch { /* resolved below */ }
  if (locations.has(key)) return locations.get(key)!;
  let found: Location | null = null;
  try {
    const run = (args: string[]) => execFileSync('git', ['-C', key, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ LC_ALL: 'C' }) }).toString().split('\n');
    const [gitDir, bare] = run(['rev-parse', '--absolute-git-dir', '--is-bare-repository']);
    if (gitDir) {
      let common = gitDir;
      try { common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* the main git dir is the common dir */ }
      const worktree = bare === 'true' ? null : run(['rev-parse', '--show-toplevel'])[0] || null;
      found = { gitDir, common, worktree };
    }
  } catch { found = null; }
  locations.set(key, found);
  return found;
}

export function ledgerFiles(common: string): { dir: string; current: string; rotated: string; lock: string } {
  const dir = join(common, LEDGER_DIR);
  return { dir, current: join(dir, LEDGER_FILE), rotated: join(dir, LEDGER_ROTATED_FILE), lock: join(dir, LEDGER_LOCK_FILE) };
}

/** sha256 of a commit message with git's whitespace cleanup applied, so the intent and the stored message compare. */
export function messageDigest(message: string): string {
  const out: string[] = [];
  for (const text of message.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''))) {
    if (!text && (!out.length || out[out.length - 1] === '')) continue;
    out.push(text);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return createHash('sha256').update(out.join('\n')).digest('hex');
}

let warned = false;
function warnOnce(root: string, error: unknown): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[gbrain notice] commit ledger: could not record a commit in ${root} (${error instanceof Error ? error.message : String(error)}); doctor foreign_writers will report it as foreign.\n`);
}

function hostId(): string | null {
  try { return existingLocalHostId(); } catch { return null; }
}

function headRef(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? head.slice(5) : null;
  } catch { return null; }
}

/** One JSON line under 1 KiB: an over-long worktree path keeps its tail. */
function line(record: LedgerRecord): string {
  let text = JSON.stringify(record);
  const over = Buffer.byteLength(text) - LINE_MAX_BYTES;
  if (over > 0 && 'worktree' in record && record.worktree) {
    text = JSON.stringify({ ...record, worktree: `...${record.worktree.slice(Math.min(record.worktree.length, over + 3))}` });
  }
  return `${text}\n`;
}

function commitRecord(loc: Location, entry: LedgerCommit): LedgerRecord {
  return { v: 1, e: 'commit', t: new Date().toISOString(), sha: entry.sha, writer: entry.writer, request_id: entry.request_id ?? null,
    worktree: loc.worktree, worktree_id: entry.worktree_id ?? null, ref: entry.ref === undefined ? headRef(loc.gitDir) : entry.ref, pid: process.pid, host: hostId(),
    ...(entry.supersedes?.length ? { supersedes: entry.supersedes } : {}), ...(entry.adopted?.length ? { adopted: entry.adopted } : {}) };
}

function intentRecord(loc: Location, intent: LedgerIntent): LedgerRecord {
  return { v: 1, e: 'intent', t: new Date().toISOString(), writer: intent.writer, head_before: intent.head_before,
    msg_sha256: messageDigest(intent.message), worktree: loc.worktree, pid: process.pid, host: hostId() };
}

/** Under the ledger lock: the start line on a new ledger, rotation at 4 MiB, then the append (O_APPEND). */
function appendLocked(common: string, record: LedgerRecord): void {
  const files = ledgerFiles(common);
  const text = line(record);
  let size = -1;
  try { size = statSync(files.current).size; } catch { /* no current file */ }
  if (size >= 0 && size + Buffer.byteLength(text) > LEDGER_ROTATE_BYTES) { renameSync(files.current, files.rotated); size = -1; }
  if (size < 0 && !existsSync(files.rotated)) appendFileSync(files.current, line({ v: 1, e: 'start', t: record.t }));
  appendFileSync(files.current, text);
}

function writeLocked(root: string, build: (loc: Location) => LedgerRecord): void {
  const loc = ledgerLocation(root);
  if (!loc) return;
  try {
    const files = ledgerFiles(loc.common);
    mkdirSync(files.dir, { recursive: true });
    const lock = acquireNativeLockSync(files.lock, { timeoutMs: LOCK_WAIT_MS });
    if (!lock) throw new Error(`the ledger lock ${files.lock} stayed busy for ${LOCK_WAIT_MS} ms`);
    try { appendLocked(loc.common, build(loc)); } finally { lock.release(); }
  } catch (error) { warnOnce(root, error); }
}

async function writeLockedAsync(root: string, build: (loc: Location) => LedgerRecord): Promise<void> {
  const loc = ledgerLocation(root);
  if (!loc) return;
  try {
    const files = ledgerFiles(loc.common);
    mkdirSync(files.dir, { recursive: true });
    const lock = await acquireNativeLock(files.lock, { timeoutMs: LOCK_WAIT_MS });
    if (!lock) throw new Error(`the ledger lock ${files.lock} stayed busy for ${LOCK_WAIT_MS} ms`);
    try { appendLocked(loc.common, build(loc)); } finally { await lock.release(); }
  } catch (error) { warnOnce(root, error); }
}

/** Ledger a commit gbrain made in the repository holding `root` (any directory inside it). Never throws. */
export function recordCommit(root: string, entry: LedgerCommit): void {
  if (entry.sha) writeLocked(root, loc => commitRecord(loc, entry));
}
export async function recordCommitAsync(root: string, entry: LedgerCommit): Promise<void> {
  if (entry.sha) await writeLockedAsync(root, loc => commitRecord(loc, entry));
}
/** A porcelain site's intent, written before `git commit` runs. Never throws. */
export function recordIntent(root: string, intent: LedgerIntent): void {
  writeLocked(root, loc => intentRecord(loc, intent));
}
export async function recordIntentAsync(root: string, intent: LedgerIntent): Promise<void> {
  await writeLockedAsync(root, loc => intentRecord(loc, intent));
}

/** One ledger file's text; null when it does not exist, and any other read error is thrown (GST-1623). */
function readLedgerFile(file: string): string | null {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/**
 * The retained ledger lines, oldest first (the rotated file, then the current one); unparseable lines are skipped. Only a
 * missing file reads as empty: any other read error throws (GST-1623), so doctor never reads an unreadable ledger as
 * "nothing ledgered".
 */
export function readLedger(common: string): LedgerRecord[] {
  const files = ledgerFiles(common);
  const out: LedgerRecord[] = [];
  for (const text of [readLedgerFile(files.rotated), readLedgerFile(files.current)]) {
    if (text === null) continue;
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as LedgerRecord;
        if (record && record.v === 1 && typeof record.t === 'string') out.push(record);
      } catch { /* a torn or foreign line */ }
    }
  }
  return out;
}

/** Test seam: forget cached locations (a test that re-inits a directory) and the one-time warning. */
export function resetLedgerCacheForTests(): void { locations.clear(); warned = false; }
