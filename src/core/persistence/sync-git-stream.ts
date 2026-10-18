/**
 * Async, chunked Git level reads for the managed-sync reconcile (#6712): the
 * committed tree (`T`), the index (`X`), exact-OID rename hints, blob contents
 * and per-path dirtiness (`Dp`, a batched `hardenedPathDirty`). Every call goes
 * through `hardenedGitStream`, so only allow-listed, filter-free plumbing runs
 * and the checkout's clean/process filters and textconv never execute. Output
 * is parsed as it streams; nothing but the result maps is held, so a
 * 600k-path tree costs its map and one chunk.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { hardenedGitStream, hardenedStreamComplete, NulRecordSplitter, type HardenedGitStreamResult } from '../hardened-git.ts';
import { gitBlobOid, sha256 } from './digest.ts';
import { readSyncFile } from './sync-discovery.ts';

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

async function readRecords(gitRoot: string, args: string[], read: string, visit: (record: string) => void): Promise<void> {
  const splitter = new NulRecordSplitter();
  const result = await gitStream(gitRoot, args, { timeoutMs: READ_TIMEOUT_MS,
    onChunk: chunk => { for (const record of splitter.push(chunk)) visit(record.toString('utf8')); } });
  if (!hardenedStreamComplete(result) || !splitter.atRecordBoundary) throw new SyncTreeReadIncomplete(read, outcome(result));
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
export async function readTreeLevel(gitRoot: string, commit: string, scope: string): Promise<Map<string, GitTreeEntry>> {
  const tree = new Map<string, GitTreeEntry>();
  await readRecords(gitRoot, ['ls-tree', '-r', '-z', commit, '--', scope === '' ? '.' : scope], 'ls-tree', record => {
    const tab = record.indexOf('\t');
    const [mode = '', type = '', oid = ''] = tab < 0 ? [] : record.slice(0, tab).split(' ');
    if (!OID.test(oid)) throw malformed('ls-tree', record);
    if (type === 'blob' || type === 'commit') tree.set(record.slice(tab + 1), { mode, oid });
  });
  return tree;
}

/** `X`: the index (never the worktree), keyed by Git-root-relative path; a conflicted path keeps its highest stage. */
export async function readIndexLevel(gitRoot: string): Promise<Map<string, GitIndexEntry>> {
  const index = new Map<string, GitIndexEntry>();
  await readRecords(gitRoot, ['ls-files', '-s', '-z'], 'ls-files', record => {
    const tab = record.indexOf('\t');
    const [mode = '', oid = '', stage = ''] = tab < 0 ? [] : record.slice(0, tab).split(' ');
    if (!OID.test(oid) || !/^[0-3]$/.test(stage)) throw malformed('ls-files', record);
    const path = record.slice(tab + 1);
    if ((index.get(path)?.stage ?? -1) < Number(stage)) index.set(path, { mode, oid, stage: Number(stage) });
  });
  return index;
}

/**
 * Exact-OID rename hints from `from` to `to`: a deleted and an added regular
 * file with the same blob, only when that OID has exactly one of each. Hints
 * only; never a source of candidates.
 */
export async function readRenameHints(gitRoot: string, from: string, to: string): Promise<GitRenameHint[]> {
  const byOid = new Map<string, { deleted: string[]; added: string[] }>();
  let meta: string | null = null;
  await readRecords(gitRoot, ['diff-tree', '-r', '-z', '--no-renames', from, to], 'diff-tree', record => {
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

interface ReadFile { path: string; sha256: string; localOid: string; foldedOid: string; size: number; executable: boolean | null }

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
 * `untracked`, for working mode.
 */
export async function probeDirtiness(root: string, gitRoot: string, paths: string[], tree: Map<string, GitTreeEntry>,
  index: Map<string, GitIndexEntry>, opts: { batch?: number } = {}): Promise<Map<string, DirtinessProbe>> {
  const batch = Math.max(1, opts.batch ?? 2000);
  const results = new Map<string, DirtinessProbe>();
  const firstOid = tree.values().next().value?.oid ?? index.values().next().value?.oid ?? '';
  const format = firstOid.length === 64 ? 'sha256' as const : 'sha1' as const;
  let realRoot: string | null = null;
  let realGitRoot: string | null = null;
  try { realRoot = realpathSync.native(root); realGitRoot = realpathSync.native(gitRoot); } catch {}
  for (let start = 0; start < paths.length; start += batch) {
    const decided = new Map<string, Dp | null>();
    const read: ReadFile[] = [];
    for (const path of paths.slice(start, start + batch)) {
      const committed = tree.get(path);
      const indexed = index.get(path);
      let dp: Dp | null = !committed && !indexed ? 'untracked'
        : !committed || !indexed || indexed.oid !== committed.oid || indexed.mode !== committed.mode || indexed.stage !== 0 ? 'staged' : null;
      let bytes: Buffer | null = null;
      let unreadable = realRoot === null || realGitRoot === null;
      const sourcePath = unreadable ? '' : relative(realRoot!, join(realGitRoot!, path)).split(sep).join('/');
      if (!unreadable) { try { bytes = readSyncFile(root, sourcePath); } catch { unreadable = true; } }
      if (dp === null && !unreadable && bytes === null) dp = 'deleted';
      const hashable = bytes !== null && !path.includes('\n') && !path.startsWith('"');
      if (dp === null && (committed!.mode === '120000' || committed!.mode === '160000' || unreadable || !hashable)) dp = 'unknown';
      decided.set(path, dp);
      if (bytes === null) { results.set(path, { dp: dp!, rawOid: null, rawSha256: null }); continue; }
      if (!hashable) { results.set(path, { dp: dp!, rawOid: null, rawSha256: sha256(bytes) }); continue; }
      let executable: boolean | null = null;
      try { executable = (lstatSync(join(realRoot!, ...sourcePath.split('/'))).mode & 0o111) !== 0; } catch {}
      const localOid = gitBlobOid(bytes, format);
      read.push({ path, sha256: sha256(bytes), localOid, size: bytes.length, executable,
        foldedOid: bytes.includes('\r\n') ? gitBlobOid(foldCrlf(bytes), format) : localOid });
    }
    const undecided = read.filter(file => decided.get(file.path) === null).map(file => file.path);
    const [rawOids, attrs] = await Promise.all([hashRaw(gitRoot, read.map(file => file.path)), readAttributes(gitRoot, undecided)]);
    const lfs: Array<{ file: ReadFile; treeOid: string; executableMatches: boolean }> = [];
    for (const [i, file] of read.entries()) {
      const rawOid = rawOids?.[i] === file.localOid ? file.localOid : null;
      const settle = (dp: Dp) => { results.set(file.path, { dp, rawOid, rawSha256: file.sha256 }); };
      const prior = decided.get(file.path);
      if (prior) { settle(prior); continue; }
      const committed = tree.get(file.path)!;
      const attr = attrs?.get(file.path);
      if (rawOid === null || attr === undefined || file.executable === null) { settle('unknown'); continue; }
      const executableMatches = file.executable === (committed.mode === '100755');
      if (rawOid === committed.oid) { settle(executableMatches ? 'clean' : 'unknown'); continue; }
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
  return results;
}

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
