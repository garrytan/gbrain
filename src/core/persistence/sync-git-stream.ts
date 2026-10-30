/**
 * Async, chunked Git level reads for the managed-sync reconcile (#6712): the
 * committed tree (`T`), the index (`X`), exact-OID rename hints, blob contents
 * and per-path dirtiness (`Dp`, a batched `hardenedPathDirty`). Every call goes
 * through `hardenedGitStream`, so only allow-listed, filter-free plumbing runs
 * and the checkout's clean/process filters and textconv never execute. Output
 * is parsed as it streams; nothing but the result maps is held, so a
 * 600k-path tree costs its map and one chunk.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { configDir } from '../config.ts';
import { hardenedGitStream, hardenedStreamComplete, NulRecordSplitter, type HardenedGitStreamResult } from '../hardened-git.ts';
import { gitBlobOid, sha256 } from './digest.ts';
import { readSyncFile } from './sync-discovery.ts';
import { faultPointNow } from './fault-points.ts';
import { loopYield, type LoopYield } from './sync-yield.ts';

export type Dp = 'clean' | 'clean_eol' | 'clean_lfs' | 'modified' | 'deleted' | 'staged' | 'untracked' | 'unknown';
export interface GitTreeEntry { mode: string; oid: string }
export interface GitIndexEntry extends GitTreeEntry { stage: number }
export interface GitRenameHint { from: string; to: string; oid: string }
export interface DirtinessProbe { dp: Dp; rawOid: string | null; rawSha256: string | null }

/** A level read that did not satisfy the completeness rule (exit 0, no signal, output ended at a NUL), so its absences prove nothing. */
export class SyncTreeReadIncomplete extends Error {
  readonly code = 'reconcile_read_incomplete';
  constructor(read: string, detail: string) {
    super(`git ${read} did not finish a complete read (${detail}); nothing it omitted may be treated as absent`);
    this.name = 'SyncTreeReadIncomplete';
  }
}

const READ_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const LFS_POINTER_MAX_BYTES = 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_MODES = new Set(['100644', '100755']);

let gitStream = hardenedGitStream;
/** Replaces the Git runner (tests only: a truncated or signalled stream); no argument restores it. */
export function __setSyncGitStreamForTests(runner?: typeof hardenedGitStream): void { gitStream = runner ?? hardenedGitStream; }

function outcome(result: HardenedGitStreamResult): string {
  if (!result.ok) return `${result.reason}${result.status === undefined ? '' : ` ${result.status}`}${result.signal ? ` ${result.signal}` : ''}`;
  return result.endsWithNul || result.bytes === 0 ? 'complete' : 'output did not end at a NUL';
}

const malformed = (read: string, record: string) => new SyncTreeReadIncomplete(read, `malformed record ${JSON.stringify(record.slice(0, 80))}`);

async function readRecords(gitRoot: string, args: string[], read: string, visit: (record: Buffer) => void, shared?: LoopYield): Promise<void> {
  const splitter = new NulRecordSplitter();
  // A 600k-path read arrives faster than it parses: past the stretch budget, the stream waits one macrotask.
  const step = shared ?? loopYield();
  const visitChunk = (chunk: Buffer) => {
    if (shared) faultPointNow('sync:level_chunk', { read });
    const records = splitter.push(chunk);
    for (const record of records) visit(record);
    return step.due(records.length) ? step.pause() : undefined;
  };
  // A budget shared with the level's cursor (sync-yield.ts `turnYield`): a chunk waits a turn the cursor already spent.
  const take = (chunk: Buffer) => shared?.over() ? shared.pause().then(() => visitChunk(chunk)) : visitChunk(chunk);
  // Bun can close the stream (and hand the next chunk) before a held chunk settles: chunks chain here and the read waits for the last.
  let tail: Promise<void> | undefined;
  const result = await gitStream(gitRoot, args, { timeoutMs: READ_TIMEOUT_MS, onChunk: chunk => {
    const held = tail ? tail.then(() => take(chunk)) : take(chunk);
    if (!held) return;
    const settled: Promise<void> = held.finally(() => { if (tail === settled) tail = undefined; });
    return tail = settled;
  } });
  await tail;
  if (!hardenedStreamComplete(result) || !splitter.atRecordBoundary) throw new SyncTreeReadIncomplete(read, outcome(result));
}

/** The common modes and `ls-tree` types as one string each, so a 600k-entry map holds no per-entry copy and a read decodes none. */
const MODE_NAMES = ['100644', '100755', '120000', '160000', '040000'], TYPE_NAMES = ['blob', 'commit', 'tree'];

/** `record.toString('latin1', start, end)`, as the one string of `names` it spells when it spells one. */
function latin1Named(record: Buffer, start: number, end: number, names: readonly string[]): string {
  next: for (const name of names) {
    if (name.length !== end - start) continue;
    for (let i = 0; i < name.length; i++) if (record[start + i] !== name.charCodeAt(i)) continue next;
    return name;
  }
  return record.toString('latin1', start, end);
}

/** Whether an `ls-files -s` record (its first tab at `tab`) is exactly `<mode> <oid> 0` of `entry`: the parse it skips reads stage 0 at the entry's blob and mode. */
function sameIndexRecord(record: Buffer, tab: number, entry: GitTreeEntry): boolean {
  const { mode, oid } = entry;
  if (tab !== mode.length + oid.length + 3 || record[mode.length] !== 32 || record[tab - 2] !== 32 || record[tab - 1] !== 48) return false;
  for (let i = 0; i < mode.length; i++) if (record[i] !== mode.charCodeAt(i)) return false;
  for (let i = 0; i < oid.length; i++) if (record[mode.length + 1 + i] !== oid.charCodeAt(i)) return false;
  return true;
}

/**
 * One `<mode> <a> <b>\t<path>` record (`ls-tree`: type and OID; `ls-files -s`: OID and stage), its fields decoded straight
 * from the record's bytes as strings of their own (no substring keeps the record alive), or null when the header before the
 * tab has fewer than three fields (a fourth is ignored, as `split(' ')` did).
 */
function headerFields(record: Buffer): { mode: string; a: string; b: string; path: string } | null {
  const tab = record.indexOf(9);
  const first = tab < 0 ? -1 : record.indexOf(32);
  const second = first < 0 || first > tab ? -1 : record.indexOf(32, first + 1);
  if (second < 0 || second > tab) return null;
  const third = record.indexOf(32, second + 1);
  return { mode: latin1Named(record, 0, first, MODE_NAMES), a: latin1Named(record, first + 1, second, TYPE_NAMES), b: record.toString('latin1', second + 1, third < 0 || third > tab ? tab : third),
    path: record.toString('utf8', tab + 1) };
}

function* lines(items: readonly string[], terminator: string): Generator<Buffer> {
  for (let i = 0; i < items.length; i += 1000) yield Buffer.from(items.slice(i, i + 1000).map(item => item + terminator).join(''));
}

/**
 * `T`: blob entries of `commit` under `scope` (a Git-root-relative directory
 * prefix; empty lists the whole tree), keyed by Git-root-relative path.
 * Symlinks (120000) and gitlinks (160000) are kept with their mode so a caller
 * can mark them unknown.
 */
export async function readTreeLevel(gitRoot: string, commit: string, scope: string, shared?: LoopYield): Promise<Map<string, GitTreeEntry>> {
  const tree = new Map<string, GitTreeEntry>();
  await walkTreeLevel(gitRoot, commit, scope, (path, mode, oid) => tree.set(path, { mode, oid }), shared);
  return tree;
}

/** `readTreeLevel`'s entries handed to `visit` in `ls-tree` order as they arrive, none kept: a caller that needs only a pass over `T` holds no map of it. */
export async function walkTreeLevel(gitRoot: string, commit: string, scope: string, visit: (path: string, mode: string, oid: string) => void, shared?: LoopYield): Promise<void> {
  await readRecords(gitRoot, ['ls-tree', '-r', '-z', commit, '--', scope === '' ? '.' : scope], 'ls-tree', record => {
    const fields = headerFields(record);
    if (!fields || !OID.test(fields.b)) throw malformed('ls-tree', record.toString('utf8'));
    if (fields.a === 'blob' || fields.a === 'commit') visit(fields.path, fields.mode, fields.b);
  }, shared);
}

/** One `diff-tree -r` change of a `T` path: its entry at the new commit, or null where the new commit has none. */
export interface GitTreeChange { path: string; entry: GitTreeEntry | null }
/** The modes `readTreeLevel` keeps (blob and gitlink entries); a change to anything else is not a `T` change it can apply. */
const TREE_ENTRY_MODE = /^(?:10[0-7]{4}|120000|160000)$/;

/**
 * The changes of `T` under `scope` from commit `from` to `to` (one `diff-tree -r -z --no-renames`, raw: full OIDs),
 * or null when a record names an entry `readTreeLevel` would not list the same way: the caller reads `T` whole then.
 */
export async function readTreeChanges(gitRoot: string, from: string, to: string, scope: string, shared?: LoopYield): Promise<GitTreeChange[] | null> {
  const changes: GitTreeChange[] = [];
  let meta: string | null = null, foreign = false;
  await readRecords(gitRoot, ['diff-tree', '-r', '-z', '--no-renames', from, to, ...(scope ? ['--', scope] : [])], 'diff-tree', bytes => {
    if (meta === null) {
      meta = bytes.toString('latin1');
      if (!meta.startsWith(':')) throw malformed('diff-tree', meta);
      return;
    }
    const [, dstMode = '', , dstOid = '', status = ''] = meta.slice(1).split(' ');
    meta = null;
    const path = bytes.toString('utf8');
    if (status === 'D') changes.push({ path, entry: null });
    else if ((status === 'A' || status === 'M' || status === 'T') && TREE_ENTRY_MODE.test(dstMode) && OID.test(dstOid)) changes.push({ path, entry: { mode: dstMode, oid: dstOid } });
    else foreign = true;
  }, shared);
  if (meta !== null) throw new SyncTreeReadIncomplete('diff-tree', 'a status record had no path');
  return foreign ? null : changes;
}

/** `X`: the index (never the worktree), keyed by Git-root-relative path; a conflicted path keeps its highest stage. */
export async function readIndexLevel(gitRoot: string, shared?: LoopYield): Promise<Map<string, GitIndexEntry>> {
  const index = new Map<string, GitIndexEntry>();
  await readRecords(gitRoot, ['ls-files', '-s', '-z'], 'ls-files', record => {
    const fields = headerFields(record);
    if (!fields || !OID.test(fields.a) || !/^[0-3]$/.test(fields.b)) throw malformed('ls-files', record.toString('utf8'));
    const stage = Number(fields.b);
    if ((index.get(fields.path)?.stage ?? -1) < stage) index.set(fields.path, { mode: fields.mode, oid: fields.a, stage });
  }, shared);
  return index;
}

/**
 * `X` as committed mode reads it: only the tree paths whose index entry differs from `T` (OID, mode or a non-zero stage,
 * the highest stage kept; null: absent from the index). A 600k-path checkout whose index matches its tree holds no second
 * map of every path. Paths outside `tree` are not kept; when some tree path never appeared, the index is read whole
 * once more to name them.
 */
export async function readIndexDelta(gitRoot: string, tree: Map<string, GitTreeEntry>, shared?: LoopYield): Promise<Map<string, GitIndexEntry | null>> {
  const delta = new Map<string, GitIndexEntry | null>();
  let same = 0;
  await readRecords(gitRoot, ['ls-files', '-s', '-z'], 'ls-files', record => {
    const tab = record.indexOf(9);
    const matched = tab < 0 ? undefined : tree.get(record.toString('utf8', tab + 1));
    if (matched && sameIndexRecord(record, tab, matched)) { same++; return; }
    const fields = headerFields(record);
    if (!fields || !OID.test(fields.a) || !/^[0-3]$/.test(fields.b)) throw malformed('ls-files', record.toString('utf8'));
    const committed = tree.get(fields.path);
    if (!committed) return;
    const stage = Number(fields.b);
    if (stage === 0 && fields.a === committed.oid && fields.mode === committed.mode) { same++; return; }
    if ((delta.get(fields.path)?.stage ?? -1) < stage) delta.set(fields.path, { mode: fields.mode, oid: fields.a, stage });
  }, shared);
  if (same + delta.size === tree.size) return delta;
  const index = await readIndexLevel(gitRoot, shared);
  const whole = new Map<string, GitIndexEntry | null>();
  for (const [path, committed] of tree) {
    const indexed = index.get(path);
    if (!indexed) whole.set(path, null);
    else if (indexed.stage !== 0 || indexed.oid !== committed.oid || indexed.mode !== committed.mode) whole.set(path, indexed);
  }
  return whole;
}

/**
 * Exact-OID rename hints from `from` to `to`: a deleted and an added regular
 * file with the same blob, only when that OID has exactly one of each. Hints
 * only; never a source of candidates.
 */
export async function readRenameHints(gitRoot: string, from: string, to: string): Promise<GitRenameHint[]> {
  const byOid = new Map<string, { deleted: string[]; added: string[] }>();
  let meta: string | null = null;
  await readRecords(gitRoot, ['diff-tree', '-r', '-z', '--no-renames', from, to], 'diff-tree', bytes => {
    const record = bytes.toString('utf8');
    if (meta === null) {
      if (!record.startsWith(':')) throw malformed('diff-tree', record);
      meta = record;
      return;
    }
    const [srcMode = '', dstMode = '', srcOid = '', dstOid = '', status = ''] = meta.slice(1).split(' ');
    meta = null;
    const side = status === 'D' && REGULAR_MODES.has(srcMode) ? { oid: srcOid, key: 'deleted' as const }
      : status === 'A' && REGULAR_MODES.has(dstMode) ? { oid: dstOid, key: 'added' as const } : null;
    if (!side) return;
    const entry = byOid.get(side.oid) ?? { deleted: [], added: [] };
    entry[side.key].push(record);
    byOid.set(side.oid, entry);
  });
  if (meta !== null) throw new SyncTreeReadIncomplete('diff-tree', 'a status record had no path');
  const hints: GitRenameHint[] = [];
  for (const [oid, { deleted, added }] of byOid) {
    if (deleted.length === 1 && added.length === 1) hints.push({ from: deleted[0]!, to: added[0]!, oid });
  }
  return hints.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/**
 * Blob contents by OID through one `cat-file --batch`. A blob over `maxBytes`,
 * a non-blob, a missing object, or one that would pass `maxTotalBytes` is left
 * out of the map (its bytes are still consumed); a Git failure or a short read
 * throws `SyncTreeReadIncomplete`.
 */
export async function readBlobs(gitRoot: string, oids: string[], maxBytes: number, maxTotalBytes = 64 * 1024 * 1024): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const bad = oids.find(oid => !OID.test(oid));
  if (bad !== undefined) throw new Error(`readBlobs takes full hexadecimal object ids, not ${JSON.stringify(bad)}`);
  let header: Buffer[] = [];
  let body: { oid: string; keep: boolean; remaining: number; parts: Buffer[] } | null = null;
  let answered = 0;
  let stored = 0;
  const result = await gitStream(gitRoot, ['cat-file', '--batch'], { timeoutMs: READ_TIMEOUT_MS, stdin: lines(oids, '\n'), onChunk: chunk => {
    let at = 0;
    while (at < chunk.length) {
      if (body) {
        const take = Math.min(body.remaining, chunk.length - at);
        if (body.keep) body.parts.push(chunk.subarray(at, at + take));
        body.remaining -= take;
        at += take;
        if (body.remaining > 0) continue;
        if (chunk[at - 1] !== 10) throw new SyncTreeReadIncomplete('cat-file', `object ${body.oid} did not end with a newline`);
        if (body.keep) { const all = Buffer.concat(body.parts); blobs.set(body.oid, all.subarray(0, all.length - 1)); }
        body = null;
        continue;
      }
      const newline = chunk.indexOf(10, at);
      if (newline < 0) { header.push(chunk.subarray(at)); break; }
      const line = Buffer.concat([...header, chunk.subarray(at, newline)]).toString('utf8');
      header = [];
      at = newline + 1;
      answered += 1;
      const [oid = '', type = '', size = ''] = line.split(' ');
      if (type === 'missing' || type === 'ambiguous') continue;
      if (!/^\d+$/.test(size)) throw malformed('cat-file', line);
      const keep = type === 'blob' && Number(size) <= maxBytes && stored + Number(size) <= maxTotalBytes;
      if (keep) stored += Number(size);
      body = { oid, keep, remaining: Number(size) + 1, parts: [] };
    }
  } });
  if (!result.ok || body !== null || header.length > 0 || answered !== oids.length) {
    throw new SyncTreeReadIncomplete('cat-file', result.ok ? `${answered} of ${oids.length} objects answered` : outcome(result));
  }
  return blobs;
}

function foldCrlf(bytes: Buffer): Buffer {
  const folded = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    folded[length++] = bytes[i]!;
  }
  return folded.subarray(0, length);
}

function lfsPointer(blob: Buffer): { oid: string; size: number } | null {
  const text = blob.toString('utf8');
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n') || !text.endsWith('\n')) return null;
  const fields = new Map(text.slice(0, -1).split('\n').map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)] as const));
  const oid = /^sha256:([0-9a-f]{64})$/.exec(fields.get('oid') ?? '')?.[1];
  const size = fields.get('size') ?? '';
  return oid && /^\d+$/.test(size) ? { oid, size: Number(size) } : null;
}

const attributeSet = (value: string | undefined): boolean => value !== undefined && value !== 'unspecified' && value !== 'unset';

interface ReadFile { path: string; sha256: string; localOid: string; foldedOid: string; size: number; executable: boolean | null; statKey: string | null }

/**
 * `Dp` for each Git-root-relative path, first match wins: `untracked` (in
 * neither index nor tree), `staged` (index differs from tree in OID or mode,
 * a non-zero stage, or in only one of them), `deleted` (no file backs the path,
 * as `readSyncFile` reports it), `unknown` (a symlink or gitlink in the tree,
 * a file sync cannot read, a path `hash-object --stdin-paths` cannot carry, or
 * any Git failure for its batch), then from the raw bytes: `clean` (raw OID is
 * the tree OID with the executable bit matching), `clean_eol` (only
 * `text`/`eol` set and the CRLF-folded bytes hash to the tree OID),
 * `clean_lfs` (`filter=lfs`, the tree blob is a valid pointer whose sha256 and
 * size are the raw bytes'), else `modified`. Another filter, a
 * `working-tree-encoding`, an executable-bit-only difference, or CRLF bytes
 * that fold to the tree with no attribute (repository `core.autocrlf` may
 * apply) are `unknown`, which is never clean. Raw OIDs come from one
 * `hash-object --no-filters --stdin-paths` per batch and must agree with the
 * bytes read here; attributes from one `check-attr -z --stdin`. A present,
 * readable file also reports its raw OID and sha256 under `staged` and
 * `untracked`.
 *
 * `working` (design v3.2 §2.1, the working level is the physical bytes):
 * the index is not read. A path is `deleted` when no file backs it, whatever
 * the index says; a present file outside the tree is `untracked` with its raw
 * OID; every other present file is judged from its bytes against the tree,
 * through the same `clean_eol`/`clean_lfs` domains. So a staged edit, a staged
 * new file, `git rm --cached`, a staged deletion and a staged file removed from
 * disk probe exactly as the same disk does with a pristine index.
 *
 * Committed mode reuses a `clean` probe (#7338) where the path's lstat key and
 * its tree entry are the ones the probe was vouched under, and the index entry
 * is the tree's: a clean verdict depends on the raw bytes alone, so it needs no
 * read, hash or attribute lookup. A probe is vouched only when the stat taken
 * before the read is unchanged after the batch's hash and its `mtime` and
 * `ctime` are older than 2 s before the call began, by the earlier of the
 * process's and the filesystem's clocks (`racyFloor`, the working stat cache's
 * racy window), so an edit made during or after the read always rehashes.
 *
 * With `persist` (`sync.level_reuse`, GBRA-133 wave 4) the vouched probes also outlive the process: a process with none
 * for this root and Git root starts from the ones the last process saved (`cleanProbeFile`), each still checked against
 * the path's lstat key and tree entry, and saves its own when they changed (at most once a minute per root). A file that
 * is missing, unreadable, for another root or with any malformed entry is ignored whole. With `verify` every reused probe
 * is read and hashed anyway, and `verify` gets the reused count and the first path whose fresh probe differs.
 */
export async function probeDirtiness(root: string, gitRoot: string, paths: string[], tree: Map<string, GitTreeEntry>,
  index: Map<string, GitIndexEntry>, opts: { batch?: number; working?: boolean; step?: LoopYield; persist?: boolean; verify?: (reused: number, differs: string | null) => void } = {}): Promise<Map<string, DirtinessProbe>> {
  const batch = Math.max(1, opts.batch ?? 2000);
  const results = new Map<string, DirtinessProbe>();
  const firstOid = tree.values().next().value?.oid ?? index.values().next().value?.oid ?? '';
  const format = firstOid.length === 64 ? 'sha256' as const : 'sha1' as const;
  let realRoot: string | null = null;
  let realGitRoot: string | null = null;
  try { realRoot = realpathSync.native(root); realGitRoot = realpathSync.native(gitRoot); } catch {}
  const step = opts.step ?? loopYield();
  const cleanKey = !opts.working && realRoot !== null && realGitRoot !== null ? `${realRoot}\0${realGitRoot}` : null;
  const vouched = cleanKey === null ? null : new Map(cleanProbes.get(cleanKey) ?? (opts.persist ? loadCleanProbes(cleanKey) : undefined));
  const checked = new Map<string, DirtinessProbe>();
  let touched = false;
  const racyFrom = vouched ? racyFloor(realGitRoot!) : 0n;
  for (let start = 0; start < paths.length; start += batch) {
    const decided = new Map<string, Dp | null>();
    const read: ReadFile[] = [];
    for (const path of paths.slice(start, start + batch)) {
      // Each entry reads and hashes a file: the clock, not the entry counter, decides its stretch.
      if (step.over()) await step.pause();
      const committed = tree.get(path);
      const indexed = index.get(path);
      let dp: Dp | null = opts.working ? (committed ? null : 'untracked') : !committed && !indexed ? 'untracked'
        : !committed || !indexed || indexed.oid !== committed.oid || indexed.mode !== committed.mode || indexed.stage !== 0 ? 'staged' : null;
      let bytes: Buffer | null = null;
      let unreadable = realRoot === null || realGitRoot === null;
      const sourcePath = unreadable ? '' : relative(realRoot!, join(realGitRoot!, path)).split(sep).join('/');
      const statKey = vouched && dp === null && !unreadable ? statAt(realGitRoot!, path) : null;
      const prior = statKey && statKey !== ABSENT ? vouched!.get(path) : undefined;
      const signature = `${statKey}|${committed?.oid}|${committed?.mode}|`;
      if (prior?.startsWith(signature)) {
        const kept: DirtinessProbe = { dp: 'clean', rawOid: committed!.oid, rawSha256: prior.slice(signature.length) };
        if (!opts.verify) { results.set(path, kept); continue; }
        checked.set(path, kept);
      }
      if (vouched?.delete(path)) touched = true;
      if (!unreadable) { try { bytes = readSyncFile(root, sourcePath); } catch { unreadable = true; } }
      if ((dp === null || opts.working) && !unreadable && bytes === null) dp = 'deleted';
      const hashable = bytes !== null && !path.includes('\n') && !path.startsWith('"');
      if (dp === null && (committed!.mode === '120000' || committed!.mode === '160000' || unreadable || !hashable)) dp = 'unknown';
      decided.set(path, dp);
      if (bytes === null) { results.set(path, { dp: dp!, rawOid: null, rawSha256: null }); continue; }
      if (!hashable) { results.set(path, { dp: dp!, rawOid: null, rawSha256: sha256(bytes) }); continue; }
      let executable: boolean | null = null;
      try { executable = (lstatSync(join(realRoot!, ...sourcePath.split('/'))).mode & 0o111) !== 0; } catch {}
      const localOid = gitBlobOid(bytes, format);
      read.push({ path, sha256: sha256(bytes), localOid, size: bytes.length, executable, statKey: statKey === ABSENT ? null : statKey,
        foldedOid: bytes.includes('\r\n') ? gitBlobOid(foldCrlf(bytes), format) : localOid });
    }
    const undecided = read.filter(file => decided.get(file.path) === null).map(file => file.path);
    const [rawOids, attrs] = await Promise.all([hashRaw(gitRoot, read.map(file => file.path)), readAttributes(gitRoot, undecided)]);
    const lfs: Array<{ file: ReadFile; treeOid: string; executableMatches: boolean }> = [];
    for (const [i, file] of read.entries()) {
      if (step.due()) await step.pause();
      const rawOid = rawOids?.[i] === file.localOid ? file.localOid : null;
      const settle = (dp: Dp) => { results.set(file.path, { dp, rawOid, rawSha256: file.sha256 }); };
      const prior = decided.get(file.path);
      if (prior) { settle(prior); continue; }
      const committed = tree.get(file.path)!;
      const attr = attrs?.get(file.path);
      if (rawOid === null || attr === undefined || file.executable === null) { settle('unknown'); continue; }
      const executableMatches = file.executable === (committed.mode === '100755');
      if (rawOid === committed.oid) {
        settle(executableMatches ? 'clean' : 'unknown');
        if (executableMatches && file.statKey && vouched!.size < WORKING_STAT_CACHE_MAX_ENTRIES && statAt(realGitRoot!, file.path) === file.statKey
          && file.statKey.split(':').slice(5).every(ns => BigInt(ns) < racyFrom)) { vouched!.set(file.path, `${file.statKey}|${committed.oid}|${committed.mode}|${file.sha256}`); touched = true; }
        continue;
      }
      if (attributeSet(attr['working-tree-encoding']) || (attributeSet(attr.filter) && attr.filter !== 'lfs')) { settle('unknown'); continue; }
      if (attr.filter === 'lfs') { lfs.push({ file, treeOid: committed.oid, executableMatches }); continue; }
      const folds = file.foldedOid === committed.oid;
      if (attr.text !== 'unset' && (attributeSet(attr.text) || attributeSet(attr.eol))) settle(!folds ? 'modified' : executableMatches ? 'clean_eol' : 'unknown');
      else settle(folds ? 'unknown' : 'modified');
    }
    if (lfs.length === 0) continue;
    let pointers: Map<string, Buffer> | null = null;
    try { pointers = await readBlobs(gitRoot, [...new Set(lfs.map(entry => entry.treeOid))], LFS_POINTER_MAX_BYTES); } catch {}
    for (const { file, treeOid, executableMatches } of lfs) {
      const blob = pointers?.get(treeOid);
      const pointer = blob ? lfsPointer(blob) : null;
      const dp: Dp = !blob ? 'unknown' : !pointer || pointer.oid !== file.sha256 || pointer.size !== file.size ? 'modified'
        : executableMatches ? 'clean_lfs' : 'unknown';
      results.set(file.path, { dp, rawOid: file.localOid, rawSha256: file.sha256 });
    }
  }
  if (cleanKey !== null) {
    cleanProbes.delete(cleanKey);
    cleanProbes.set(cleanKey, vouched!);
    while (cleanProbes.size > WORKING_STAT_CACHES_REMEMBERED) cleanProbes.delete(cleanProbes.keys().next().value!);
    if (opts.persist && touched && Date.now() - (cleanProbesSavedAt.get(cleanKey) ?? -Infinity) >= CLEAN_PROBE_SAVE_EVERY_MS) saveCleanProbes(cleanKey, vouched!);
  }
  if (opts.verify) {
    const differs = [...checked].find(([path, kept]) => JSON.stringify(results.get(path)) !== JSON.stringify(kept));
    opts.verify(checked.size, differs ? `${differs[0]}: kept ${JSON.stringify(differs[1])}, read ${JSON.stringify(results.get(differs[0]))}` : null);
  }
  return results;
}

/** Committed-mode `clean` probes this process vouched, by root and Git root: path -> `<stat key>|<tree oid>|<tree mode>|<sha256>`. */
const cleanProbes = new Map<string, Map<string, string>>();
const cleanProbesSavedAt = new Map<string, number>();
const CLEAN_PROBE_SAVE_EVERY_MS = 60_000;
const CLEAN_PROBE = /^\d+:\d+:\d+:\d+:\d+:\d+:\d+\|[0-9a-f]{40}(?:[0-9a-f]{24})?\|\d{6}\|[0-9a-f]{64}$/;

/** Where `persist` keeps the vouched probes of one root and Git root (`key`): this machine's gbrain home, never the brain. */
export function cleanProbeFile(key: string): string {
  return join(configDir(), 'persistence', 'clean-probes', `${sha256(key).slice(0, 32)}.json`);
}

function loadCleanProbes(key: string): Map<string, string> | undefined {
  try {
    const doc = JSON.parse(readFileSync(cleanProbeFile(key), 'utf8')) as { v?: unknown; key?: unknown; entries?: unknown };
    if (doc.v !== 1 || doc.key !== key || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) return undefined;
    const list = Object.entries(doc.entries as Record<string, unknown>);
    if (list.length > WORKING_STAT_CACHE_MAX_ENTRIES || !list.every(([, entry]) => typeof entry === 'string' && CLEAN_PROBE.test(entry))) return undefined;
    return new Map(list as Array<[string, string]>);
  } catch { return undefined; }
}

function saveCleanProbes(key: string, probes: Map<string, string>): void {
  const file = cleanProbeFile(key), staged = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(staged, JSON.stringify({ v: 1, key, entries: Object.fromEntries(probes) }), { mode: 0o600 });
    renameSync(staged, file);
    cleanProbesSavedAt.set(key, Date.now());
  } catch { rmSync(staged, { force: true }); }
}

/** Tests: forget this process's vouched probes and save times, as a new process starts. */
export function __resetCleanProbesForTests(): void { cleanProbes.clear(); cleanProbesSavedAt.clear(); }

/** Raw blob ids (no filters) of present files, in order, or null when Git did not answer every path. */
async function hashRaw(gitRoot: string, paths: string[]): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const chunks: Buffer[] = [];
  const result = await gitStream(gitRoot, ['hash-object', '--no-filters', '--stdin-paths'],
    { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: paths.length * 66, stdin: lines(paths, '\n'), onChunk: chunk => { chunks.push(chunk); } }).catch(() => null);
  if (!result?.ok) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.endsWith('\n')) return null;
  const oids = text.slice(0, -1).split('\n');
  return oids.length === paths.length && oids.every(oid => OID.test(oid)) ? oids : null;
}

const ATTRIBUTES = ['filter', 'text', 'eol', 'working-tree-encoding'] as const;

/** The four conversion attributes per path, or null when Git did not answer every path completely. */
async function readAttributes(gitRoot: string, paths: string[]): Promise<Map<string, Record<string, string>> | null> {
  const attrs = new Map<string, Record<string, string>>();
  if (paths.length === 0) return attrs;
  const splitter = new NulRecordSplitter();
  const fields: string[] = [];
  const result = await gitStream(gitRoot, ['check-attr', '-z', '--stdin', ...ATTRIBUTES],
    { timeoutMs: PROBE_TIMEOUT_MS, stdin: lines(paths, '\0'), onChunk: chunk => { for (const record of splitter.push(chunk)) fields.push(record.toString('utf8')); } }).catch(() => null);
  if (!result || !hardenedStreamComplete(result) || !splitter.atRecordBoundary || fields.length !== paths.length * ATTRIBUTES.length * 3) return null;
  for (let i = 0; i < fields.length; i += 3) {
    const entry = attrs.get(fields[i]!) ?? {};
    entry[fields[i + 1]!] = fields[i + 2]!;
    attrs.set(fields[i]!, entry);
  }
  return paths.every(path => ATTRIBUTES.every(name => attrs.get(path)?.[name] !== undefined)) ? attrs : null;
}

/**
 * The working stat cache (design v3.2 §2.1, Git's freshness contract). Each
 * Git-root-relative path maps to the `lstat` key `dev:ino:mode:uid:size:mtime_ns:ctime_ns`
 * it had when its bytes were hashed, or `absent`. A user can restore `mtime` but
 * not `ctime`, so a same-size, same-inode edit still changes the key. Plain JSON;
 * entries are self-contained, so two caches of one root merge by spreading
 * their entries.
 */
export interface WorkingStatCache { v: 1; root: string; entries: Record<string, string> }

const WORKING_RACY_WINDOW_NS = 2_000_000_000n;

/**
 * The newest time a vouched stat may carry: 2 s before the earlier of this process's clock and the filesystem's, read as
 * the mtime of a file just written in the Git directory (Git anchors its racy entries to the index's mtime). On a mount
 * whose clock lags the process's, the process clock alone vouched a file written a moment ago, and a same-size edit in
 * the same timestamp tick then kept its stale verdict. The process clock alone when the Git directory cannot be written.
 */
function racyFloor(gitRoot: string): bigint {
  const local = BigInt(Date.now()) * 1_000_000n;
  let fs: bigint | null = null;
  try {
    const dotGit = join(gitRoot, '.git');
    const dir = lstatSync(dotGit).isDirectory() ? dotGit : resolve(gitRoot, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim() ?? '.git');
    const clock = join(dir, `gbrain-clock-${process.pid}-${randomUUID()}`);
    writeFileSync(clock, '');
    try { fs = lstatSync(clock, { bigint: true }).mtimeNs; } finally { rmSync(clock, { force: true }); }
  } catch {}
  return (fs !== null && fs < local ? fs : local) - WORKING_RACY_WINDOW_NS;
}
const WORKING_HASH_ATTEMPTS = 3;
const WORKING_STAT_CACHES_REMEMBERED = 64;
const ABSENT = 'absent';
const STAT_KEY = /^\d+:\d+:\d+:\d+:\d+:\d+:\d+$/;
/** Entries a cache keeps (by path order); a path beyond the bound reads as changed [estimated]. */
export const WORKING_STAT_CACHE_MAX_ENTRIES = 100_000;

/** The cache key of one bigint `lstat`, or null when it cannot vouch for the file (no stat, or no `ctime`). */
export function workingStatKey(stats: Pick<BigIntStats, 'dev' | 'ino' | 'mode' | 'uid' | 'size' | 'mtimeNs' | 'ctimeNs'> | null): string | null {
  if (!stats || !stats.ctimeNs) return null;
  return [stats.dev, stats.ino, stats.mode, stats.uid, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

/** `absent` for a path nothing backs, its key, or null for any other stat failure (uncertain). */
function statAt(root: string, path: string): string | null {
  try { return workingStatKey(lstatSync(join(root, path), { bigint: true })); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : null; }
}

function rootStill(root: string): boolean {
  try { return realpathSync.native(root) === root; } catch { return false; }
}

/**
 * The idle tick's working-mode check: every path in `paths` or in the cache whose
 * stat no longer matches its entry is changed, as is a path the cache does not
 * hold (new, racy when hashed, past the bound), a stat that fails or has no
 * `ctime`, and every path when there is no cache or its root moved. Uncertainty is
 * never "no change". Returns the changed paths, sorted, and the cache without
 * them.
 */
export function workingChanged(cache: WorkingStatCache | null, paths: Iterable<string>): { changed: string[]; cache: WorkingStatCache | null } {
  const all = new Set(paths);
  if (!cache || !rootStill(cache.root)) return { changed: [...all].sort(), cache: null };
  for (const path of Object.keys(cache.entries)) all.add(path);
  const changed: string[] = [];
  const entries: Record<string, string> = {};
  for (const path of [...all].sort()) {
    const entry = cache.entries[path];
    if (entry !== undefined && statAt(cache.root, path) === entry) entries[path] = entry;
    else changed.push(path);
  }
  return { changed, cache: { v: 1, root: cache.root, entries } };
}

/**
 * The working level of `paths` (`probeDirtiness` with `working`, every path hashed:
 * full rounds rehash unconditionally) and the stat cache it leaves. Each path is
 * stat'd before and after its bytes are hashed; a path whose stat moved is
 * discarded and rehashed, up to three attempts, and one still moving keeps its
 * last probe but no entry. An entry is written only for a stable stat whose
 * `mtime` and `ctime` are older than 2 s before that attempt began, by the earlier of
 * the process's and the filesystem's clocks (`racyFloor`; a racy entry is
 * left out, so the next pass rehashes it), and only for a probe with a level
 * (raw bytes read, or `deleted` with nothing at the path). `afterHash` runs between
 * the hash and the re-stat (tests inject an edit there).
 */
export async function hashWorkingLevel(root: string, gitRoot: string, paths: string[], tree: Map<string, GitTreeEntry>,
  opts: { batch?: number; maxEntries?: number; afterHash?: (paths: string[]) => void | Promise<void> } = {}): Promise<{ probes: Map<string, DirtinessProbe>; cache: WorkingStatCache | null }> {
  let realGitRoot: string | null = null;
  try { realGitRoot = realpathSync.native(gitRoot); } catch {}
  const statOf = (path: string) => (realGitRoot === null ? null : statAt(realGitRoot, path));
  const probes = new Map<string, DirtinessProbe>();
  const entries = new Map<string, string>();
  let pending = [...new Set(paths)];
  for (let attempt = 0; attempt < WORKING_HASH_ATTEMPTS && pending.length > 0; attempt++) {
    const racyFrom = realGitRoot === null ? BigInt(Date.now()) * 1_000_000n - WORKING_RACY_WINDOW_NS : racyFloor(realGitRoot);
    const before = new Map(pending.map(path => [path, statOf(path)]));
    const probed = await probeDirtiness(root, gitRoot, pending, tree, new Map(), { batch: opts.batch, working: true });
    await opts.afterHash?.(pending);
    const moved: string[] = [];
    for (const path of pending) {
      const probe = probed.get(path)!;
      probes.set(path, probe);
      const key = before.get(path)!;
      if (statOf(path) !== key) { moved.push(path); continue; }
      if (key === null) continue;
      const [mtimeNs = '0', ctimeNs = '0'] = key === ABSENT ? [] : key.split(':').slice(5);
      const vouched = key === ABSENT ? probe.dp === 'deleted' : probe.rawOid !== null && BigInt(mtimeNs) < racyFrom && BigInt(ctimeNs) < racyFrom;
      if (vouched) entries.set(path, key);
    }
    pending = moved;
  }
  if (realGitRoot === null) return { probes, cache: null };
  const kept = [...entries.keys()].sort().slice(0, Math.max(0, opts.maxEntries ?? WORKING_STAT_CACHE_MAX_ENTRIES));
  return { probes, cache: { v: 1, root: realGitRoot, entries: Object.fromEntries(kept.map(path => [path, entries.get(path)!])) } };
}

/** A serialized cache (a pass row's copy), or null for anything that is not one; null reads as "everything changed". */
export function parseWorkingStatCache(value: unknown): WorkingStatCache | null {
  if (!value || typeof value !== 'object') return null;
  const { v, root, entries } = value as Record<string, unknown>;
  if (v !== 1 || typeof root !== 'string' || !entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  const list = Object.entries(entries as Record<string, unknown>);
  if (list.length > WORKING_STAT_CACHE_MAX_ENTRIES || !list.every(([, key]) => typeof key === 'string' && (key === ABSENT || STAT_KEY.test(key)))) return null;
  return { v: 1, root, entries: Object.fromEntries(list) as Record<string, string> };
}

const rememberedCaches = new Map<string, WorkingStatCache>();

/** Keeps a cache in this process under `key` (the pass uses `<source>:<incarnation>`); the least recently stored past 64 are dropped. */
export function rememberWorkingStatCache(key: string, cache: WorkingStatCache): void {
  rememberedCaches.delete(key);
  rememberedCaches.set(key, cache);
  while (rememberedCaches.size > WORKING_STAT_CACHES_REMEMBERED) rememberedCaches.delete(rememberedCaches.keys().next().value!);
}

/** The cache this process remembered under `key`, or null. */
export function recallWorkingStatCache(key: string): WorkingStatCache | null {
  return rememberedCaches.get(key) ?? null;
}
