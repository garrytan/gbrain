/**
 * Git-canonical memory, wave G1 (docs/designs/GIT_CANONICAL_MEMORY.md): the read-only pieces the git-gap census
 * (`gbrain sources git-gap`, commands/sources-git-gap.ts) and doctor `db_ahead_of_git` share. The one predicate for which
 * pages may have a tracked file (`declaredDatabaseOnly`), the equality contract between a page's export view
 * (readExportPage, so fact withdrawals are overlaid) and a committed blob, and filter-free reads of HEAD and the working
 * tree. Git runs only as hardened plumbing (`ls-tree`, `cat-file --batch`, `check-ignore`, `rev-parse`), which never runs
 * a repository's clean/smudge filter or textconv; the working tree is hashed here, never through `git status` or `git diff`.
 * Nothing here writes.
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { hardenedGitStream, hardenedGitSync, HISTORY_LOG_OPTIONS, NulRecordSplitter } from '../hardened-git.ts';
import { exportBodyLedger, readExportPages, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown, type ExportSnapshot, type ExportWithdrawal } from '../export-snapshot.ts';
import { parseMarkdown } from '../markdown.ts';
import { isPrivacyDerivationPrivate, isPrivacyPrivatePage } from '../search/private-visibility.ts';
import { alignWithStored } from './align-stored.ts';
import { digest } from './digest.ts';
import { isDeclaredReason, isNeverFiledDerivedPage } from './git-declared.ts';
import { classifyDrift } from './reconcile-additive.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading } from './reconcile-state.ts';
import { SYNC_READ_BOUND } from './sync-blobs.ts';
import { RestoreTargetError, restoreFilePath } from '../restore-target.ts';
import type { SlugRootMode } from '../sync-anchor.ts';

/** Why a page has no tracked file on purpose, in the order `declaredDatabaseOnly` tests them. */
export const DECLARED_CLASSES = ['mirror_source', 'database_only_source', 'private', 'alias_private', 'lineage_private', 'database_only', 'db_only_prefix', 'derive_folder', 'git_ignored'] as const;
export type DeclaredClass = typeof DECLARED_CLASSES[number];

/**
 * What decides a declared class beyond the page itself: whether the source is a read-only mirror (sourceMirrorReadOnly),
 * whether the whole source is database-only (G7a: no checkout, so every write is unbound and outside strict mode), whether
 * a slug sits under a `storage.db_only` dir (isSourceDbOnlySlug, which refuses an invalid gbrain.yml) and the paths the
 * checkout's Git ignores.
 */
export interface GitHomePolicy { mirror: boolean; databaseOnlySource?: boolean; dbOnly: (slug: string) => boolean; ignored: ReadonlySet<string> }

/**
 * Why a page may not have a tracked file, or null when it may. gbrain never writes a read-only mirror's checkout (#5409);
 * private and alias-private pages never reach a remote; a page the database keeps on purpose (`database_only_reason`) or
 * under a `storage.db_only` prefix stays there; a derive-phase page that never recorded a file (page-prepare.ts
 * `isNeverFiledDerivedPage`, DERIVE_PHASE_DB_ONLY_DEFAULTS) publishes database-only; a path the checkout's Git ignores
 * can never be committed. `lineage_private` is what privacyPartSql adds over the row's own fields; the caller
 * computes it in SQL. Callers load `visibility.honor_aliases` (readHonorAliases) first.
 */
export function declaredDatabaseOnly(page: { slug: string; type?: string | null; frontmatter?: unknown; database_only_reason?: string | null;
  lineage_private?: boolean; source_path?: string | null; source_uri?: string | null; withheld_source_path?: string | null }, relativePath: string | null, policy: GitHomePolicy): DeclaredClass | null {
  if (policy.mirror) return 'mirror_source';
  if (policy.databaseOnlySource) return 'database_only_source';
  if (isPrivacyPrivatePage(page)) return 'private';
  if (isPrivacyDerivationPrivate(page)) return 'alias_private';
  if (page.lineage_private) return 'lineage_private';
  // G7a (git-declared.ts): a strict publication stamps the class it declared; one whose cause is gone (an origin turned
  // public, `visibility.honor_aliases` off, the ignore rule removed) keeps it until the page is written again.
  if (isDeclaredReason(page.database_only_reason)) return page.database_only_reason;
  if (page.database_only_reason) return 'database_only';
  if (policy.dbOnly(page.slug)) return 'db_only_prefix';
  if (isNeverFiledDerivedPage(page.slug, page)) return 'derive_folder';
  if (relativePath !== null && policy.ignored.has(relativePath)) return 'git_ignored';
  return null;
}

/** Why Git could not say whether a path is ignored: a parent directory is a symlink, the path leaves the checkout, the check timed out, or Git refused it otherwise. */
export const IGNORE_UNKNOWN_REASONS = ['symlink', 'outside_repo', 'timeout', 'git_error'] as const;
export type IgnoreUnknownReason = typeof IGNORE_UNKNOWN_REASONS[number];
export interface IgnoreStatus { ignored: Set<string>; unknown: Map<string, IgnoreUnknownReason> }
const IGNORE_CHUNK = 1_000;

/**
 * Which of `relativePaths` (relative to `root`) the checkout's ignore rules exclude, read with filter-free
 * `git check-ignore -z --stdin`; tracked files are never reported (Git commits them whatever the rules say). Git refuses a
 * whole input for one path it cannot check (one beyond a symlink, one outside the repository), so the paths are checked
 * IGNORE_CHUNK at a time and a refused chunk is bisected down to the paths Git refuses: those, and every path of a chunk
 * that timed out, are `unknown`. Null when Git cannot answer at all (it refuses an empty input too), so a caller never
 * reads a failed check as "nothing ignored".
 */
export async function ignoredPaths(root: string, relativePaths: string[]): Promise<IgnoreStatus | null> {
  const status: IgnoreStatus = { ignored: new Set(), unknown: new Map() };
  let answers: boolean | undefined;
  const settle = async (paths: string[]): Promise<boolean> => {
    const answer = await checkIgnore(root, paths);
    if (answer === 'timeout') { for (const path of paths) status.unknown.set(path, 'timeout'); return true; }
    if (answer) { for (const path of answer) status.ignored.add(path); return true; }
    answers ??= Array.isArray(await checkIgnore(root, []));
    if (!answers) return false;
    if (paths.length === 1) { status.unknown.set(paths[0]!, ignoreRefusal(root, paths[0]!)); return true; }
    const half = Math.ceil(paths.length / 2);
    return await settle(paths.slice(0, half)) && await settle(paths.slice(half));
  };
  for (let start = 0; start < relativePaths.length; start += IGNORE_CHUNK) {
    if (!await settle(relativePaths.slice(start, start + IGNORE_CHUNK))) return null;
  }
  return status;
}

/** One `git check-ignore` call: the ignored paths among `paths` (exit 1 means none), 'timeout', or null when Git refused it. */
async function checkIgnore(root: string, paths: string[]): Promise<string[] | 'timeout' | null> {
  const ignored: string[] = [];
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(root, ['check-ignore', '-z', '--stdin'], {
    stdin: paths.map(path => path + '\0'), timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024,
    onChunk: chunk => { for (const record of splitter.push(chunk)) ignored.push(record.toString('utf8')); } });
  if (result.ok) return result.endsWithNul || result.bytes === 0 ? ignored : null;
  if (result.reason === 'timeout') return 'timeout';
  return result.reason === 'exit' && result.status === 1 && ignored.length === 0 ? ignored : null;
}

/** Why Git refused one path it can otherwise answer for. */
function ignoreRefusal(root: string, path: string): IgnoreUnknownReason {
  const normal = posix.normalize(path);
  if (posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) return 'outside_repo';
  const parts = normal.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    try { if (lstatSync(join(root, ...parts.slice(0, depth))).isSymbolicLink()) return 'symlink'; } catch { break; }
  }
  return 'git_error';
}

/** Why a committed file cannot be compared: a symlink (or another non-regular mode), bytes that are not UTF-8, or frontmatter that does not parse. */
export type UnparseableReason = 'symlink' | 'non_regular_mode' | 'not_utf8' | 'frontmatter';
export type ExportFileComparison = { state: 'equal' } | { state: 'differs'; paths: string[] } | { state: 'unparseable'; reason: UnparseableReason };

/**
 * The equality contract for an inline page: the file, parsed the way reconcile parses a canonical file (aligned with the
 * stored type, subtype and the #6429 grandfather stamp), carries the same canonical fields as the page's export view.
 * `importPath` is the file's path as sync keys it (scannerSourcePath).
 */
export function compareInlineExportFile(raw: Buffer, importPath: string, snapshot: ExportSnapshot): ExportFileComparison {
  const { page, tags } = snapshot;
  const file = canonicalFile(raw, importPath, page);
  if (file.state !== 'parsed') return file;
  const database = reconcileCanonical(page, tags);
  if (digest(file.canonical) === digest(database)) return { state: 'equal' };
  return { state: 'differs', paths: classifyDrift(file.canonical, database).paths.map(p => p.path) };
}

/** A committed file parsed the way reconcile parses a canonical file, aligned with the stored page (the census contract's file side). */
function canonicalFile(raw: Buffer, importPath: string, page: ExportSnapshot['page']): { state: 'parsed'; canonical: ReturnType<typeof reconcileCanonical> }
  | { state: 'differs'; paths: string[] } | { state: 'unparseable'; reason: UnparseableReason } {
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) return { state: 'unparseable', reason: 'not_utf8' };
  const reading = reconcileFileReading(text, importPath, page);
  const parsed = parseMarkdown(reading.content, `${page.slug}.md`, { validate: true, expectedSlug: page.slug });
  if (parsed.errors?.some(e => !['MISSING_OPEN', 'EMPTY_FRONTMATTER'].includes(e.code))) return { state: 'unparseable', reason: 'frontmatter' };
  if (parsed.slug !== page.slug) return { state: 'differs', paths: ['/slug'] };
  alignWithStored(parsed, page, reading.inferred);
  return { state: 'parsed', canonical: reconcileCanonical(parsed, parsed.tags) };
}

export type ObjectFormat = 'sha1' | 'sha256';
export interface TreeBlob { oid: string; size: number; mode: string }

/**
 * A segmented page's body cannot be read whole (page-body/page-shape.ts), so it compares byte for byte: the Git blob id
 * of its streamed export (`blob <size>\0` + the export, in the repository's object format) against the committed blob's.
 * An export longer than the blob differs without hashing further.
 */
export async function compareSegmentedExportBlob(tx: BrainEngine, snapshot: ExportSnapshot, withdrawals: ExportWithdrawal[], blob: TreeBlob,
  format: ObjectFormat): Promise<ExportFileComparison> {
  const hash = createHash(format).update(`blob ${blob.size}\0`);
  let bytes = 0;
  for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, withdrawals), segmentedExportHead(snapshot))) {
    bytes += typeof piece === 'string' ? Buffer.byteLength(piece) : piece.length;
    if (bytes > blob.size) return { state: 'differs', paths: ['/body'] };
    hash.update(piece);
  }
  return bytes === blob.size && hash.digest('hex') === blob.oid ? { state: 'equal' } : { state: 'differs', paths: ['/body'] };
}

export interface HeadTree {
  /** The checkout's top level (real path); tree paths are relative to it. */
  gitRoot: string;
  format: ObjectFormat;
  /** The HEAD commit, or null on an unborn branch (nothing is committed). */
  commit: string | null;
  /** Every blob under the source's directory at HEAD, keyed by its path relative to `gitRoot`. */
  blobs: Map<string, TreeBlob>;
}

const GIT_LIMITS = { timeoutMs: 30_000, maxBytes: 64 * 1024 };
function gitLine(root: string, args: string[]): string | null {
  const result = hardenedGitSync(root, args, GIT_LIMITS);
  return result.ok ? result.stdout.toString('utf8').replace(/\n$/, '') : null;
}

/** The top level of the Git working tree `root` is inside (hardened `rev-parse --show-toplevel`); null outside one. */
export function gitTopLevel(root: string): string | null {
  return gitLine(root, ['rev-parse', '--show-toplevel']);
}

/** Whether `root` is inside a Git working tree. */
export function isGitCheckout(root: string): boolean {
  return gitTopLevel(root) !== null;
}

/**
 * HEAD of the checkout at `root` (or the commit `rev` names), listed once with `ls-tree -r -l -z --full-tree` under the
 * source's directory. Null when Git cannot answer (not a checkout, an unknown commit, a failed or truncated read).
 */
export async function readHeadTree(root: string, rev = 'HEAD'): Promise<HeadTree | null> {
  const top = gitLine(root, ['rev-parse', '--show-toplevel']);
  const format = gitLine(root, ['rev-parse', '--show-object-format']);
  if (top === null || (format !== 'sha1' && format !== 'sha256')) return null;
  const gitRoot = realpathSync(top), real = realpathSync(root);
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], GIT_LIMITS);
  if (!head.ok) return rev === 'HEAD' && head.reason === 'exit' && head.status === 1 ? { gitRoot, format, commit: null, blobs: new Map() } : null;
  const commit = head.stdout.toString('utf8').trim();
  const scope = real === gitRoot ? '' : real.slice(gitRoot.length + 1);
  const blobs = new Map<string, TreeBlob>();
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit, '--', ...(scope ? [`:(literal)${scope}`] : [])], {
    timeoutMs: 300_000, maxBytes: 1024 * 1024 * 1024,
    onChunk: chunk => {
      for (const record of splitter.push(chunk)) {
        const text = record.toString('utf8'), tab = text.indexOf('\t');
        const [mode = '', type = '', oid = '', size = ''] = text.slice(0, tab).split(/ +/);
        if (type === 'blob') blobs.set(text.slice(tab + 1), { oid, size: Number(size), mode });
      }
    } });
  if (!result.ok || !(result.bytes === 0 || result.endsWithNul)) return null;
  return { gitRoot, format, commit, blobs };
}

/** The bytes one `cat-file --batch` call reads at most, so a call holds a bounded batch of committed files. */
const CAT_FILE_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * The raw bytes of committed blobs keyed by blob id, read with `cat-file --batch` (no `--filters`, no `--textconv`:
 * exactly what Git stores). Calls are split so each reads at most CAT_FILE_BATCH_BYTES (a larger blob is read alone).
 * Null when Git could not answer or a blob was missing.
 */
export async function readBlobs(root: string, blobs: readonly TreeBlob[]): Promise<Map<string, Buffer> | null> {
  const out = new Map<string, Buffer>();
  for (let start = 0; start < blobs.length;) {
    let end = start, bytes = 0;
    while (end < blobs.length && (end === start || bytes + blobs[end]!.size <= CAT_FILE_BATCH_BYTES)) bytes += blobs[end++]!.size;
    const chunk = blobs.slice(start, end);
    const pieces: Buffer[] = [];
    const result = await hardenedGitStream(root, ['cat-file', '--batch'], { stdin: chunk.map(blob => blob.oid + '\n').join(''), timeoutMs: 300_000,
      maxBytes: bytes + chunk.length * 160 + 1024, onChunk: piece => { pieces.push(piece); } });
    if (!result.ok) return null;
    const output = Buffer.concat(pieces);
    let offset = 0;
    for (const blob of chunk) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) return null;
      const [oid, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
      if (oid !== blob.oid || type !== 'blob' || Number(size) !== blob.size || output.length < newline + 1 + blob.size) return null;
      out.set(blob.oid, output.subarray(newline + 1, newline + 1 + blob.size));
      offset = newline + 1 + blob.size + 1;
    }
    start = end;
  }
  return out;
}

/**
 * The Git blob id of the working-tree file at `path` from its raw bytes (no filters, so a checkout whose attributes
 * convert line endings reads as modified); null when nothing is there, `other` for a symlink or other non-regular entry.
 */
export async function worktreeBlobOid(path: string, format: ObjectFormat): Promise<string | 'other' | null> {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return 'other';
    size = stat.size;
  } catch { return null; }
  const hash = createHash(format).update(`blob ${size}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * d4 of the convergence plan: which side moved for a page whose export view differs from its committed file and whose row
 * no import record explains (so neither the record's blob nor its revision says which side changed). Content evidence
 * only, never a timestamp: the page's versions (page_versions, the export view each write archived) and the blobs its
 * path held in Git are compared newest first, EVIDENCE_DEPTH of each, under the census contract, to find the last state
 * both sides shared.
 *   - adopt_db_moved: an older version of the page equals the committed file, so only the database moved since.
 *   - git_wins_file_moved: the row equals an older committed blob of the path, so only the file moved since.
 *   - both_moved: the newest shared state is older on both sides, or the history matches on both sides at once.
 *   - no_evidence: nothing shared within the depth (pruned versions, a path with no history, an unreadable history).
 * A page stored in segments has no comparable older version: it is git_wins_file_moved only when its streamed export's
 * blob id equals an older blob of the path, and no_evidence otherwise. Renames are followed through the origins the
 * page's versions recorded (`page_versions.source_path`): their paths' blobs count as the page's history too.
 */
export const DIRECTION_EVIDENCE = ['adopt_db_moved', 'git_wins_file_moved', 'both_moved', 'no_evidence'] as const;
export type DirectionEvidence = typeof DIRECTION_EVIDENCE[number];
export type EvidenceBasis = 'older_version_matches_file' | 'row_matches_older_file' | 'conflicting_history' | 'shared_older_state' | 'no_shared_state'
  | 'segmented' | 'history_unreadable' | 'changed_during_read' | 'history_truncated';
/** Versions and blobs compared per page, newest first. */
export const EVIDENCE_DEPTH = 32;
/** Pages whose versions, export views and blobs one evidence read holds at a time. */
const EVIDENCE_BATCH = 64;

/**
 * `blob`: the older committed blob the row equals (git_wins_file_moved) or the shared state's blob (both_moved);
 * `version`: the page_versions id that equals the committed file (adopt_db_moved) or the shared state's version;
 * `committed_at`: the commit time (Unix seconds) of the newest commit that touched the page's paths, for ordering a review list.
 */
export interface Evidence { kind: DirectionEvidence; basis: EvidenceBasis; blob: string | null; version: number | null; versions: number; blobs: number; committed_at: number | null }

/** A page the evidence read classifies: its id, slug, revision as the census read it, its path (source-root relative) and blob at `tip`, and its path as sync keys it (scannerSourcePath). */
export interface EvidenceSubject { id: string; slug: string; revision: string | null; rel: string; importPath: string; segmented: boolean; blob: TreeBlob }

interface HistoryEntry { oid: string; at: number; seq: number }

/**
 * One filter-free `git log --raw` walk of `tip` under `scope` (Git-root relative; '' is the whole repository): per path of
 * `interest` (Git-root relative), the blobs it held, newest first, a blob it held again after another kept again (a
 * revert), at most `depth` + 1 each (the tip's own blob is usually the first). Null when Git could not answer.
 */
export async function readPathHistory(root: string, tip: string, scope: string, interest: ReadonlySet<string>, depth = EVIDENCE_DEPTH): Promise<Map<string, HistoryEntry[]> | null> {
  const history = new Map<string, HistoryEntry[]>();
  if (!interest.size) return history;
  const splitter = new NulRecordSplitter();
  let at = 0, seq = 0, raw: string | null = null;
  const result = await hardenedGitStream(root, ['log', ...HISTORY_LOG_OPTIONS, '--end-of-options', tip, '--', ...(scope ? [`:(literal)${scope}`] : [])], {
    timeoutMs: 600_000, onChunk: chunk => {
      for (const record of splitter.push(chunk)) {
        if (raw !== null) {
          const path = record.toString('utf8');
          const [, mode = '', , oid = '', status = ''] = raw.slice(1).split(' ');
          raw = null;
          if (!interest.has(path) || status === 'D' || (mode !== '100644' && mode !== '100755')) continue;
          const list = history.get(path) ?? [];
          if (list.length <= depth && list.at(-1)?.oid !== oid) list.push({ oid, at, seq: seq++ });
          history.set(path, list);
          continue;
        }
        const token = record.toString('utf8').replace(/^\n+/, '');
        if (token.startsWith('\x1e')) at = Number(token.slice(1).split('\x1f')[1] ?? 0);
        else if (token.startsWith(':')) raw = token;
      }
    } });
  return result.ok && splitter.atRecordBoundary ? history : null;
}

/** The sizes of blobs by id (`cat-file --batch-check`); a missing object is left out. Null when Git could not answer. */
export async function readBlobSizes(root: string, oids: readonly string[]): Promise<Map<string, number> | null> {
  const sizes = new Map<string, number>();
  if (!oids.length) return sizes;
  const pieces: Buffer[] = [];
  const result = await hardenedGitStream(root, ['cat-file', '--batch-check'], { stdin: oids.map(oid => oid + '\n').join(''), timeoutMs: 300_000,
    maxBytes: oids.length * 160 + 1024, onChunk: piece => { pieces.push(piece); } });
  if (!result.ok) return null;
  for (const line of Buffer.concat(pieces).toString('utf8').split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid && type === 'blob') sizes.set(oid, Number(size));
  }
  return sizes;
}

/**
 * The direction pure decision: `row` and `head` are the canonical digests of the page's export view and of its file at
 * the tip (null when the file does not parse), `versions` the page's older versions and `blobs` the path's older blobs
 * (the tip's excluded), each newest first with its digest (null when it does not parse); `capped` says a list reached
 * EVIDENCE_DEPTH, so older entries exist that were not read.
 *
 * A one-sided verdict needs the matched state to be the newest state both sides shared, and the side that did not move
 * to have stayed there. The row equals an older blob (only the file moved) unless a state newer than that blob was shared
 * with an older version that differs from the row, or an archived copy of the row's state is followed by a version that
 * differs from it (the database left that state and came back: a revert is a move). The mirror holds for the file equal
 * to an older version, `blobs` keeping a blob the path held again. When the other side's list is capped, a newer shared
 * state may lie past it, so the verdict is no_evidence.
 */
export function decideDirection(row: string, head: string | null, versions: ReadonlyArray<{ id: number; digest: string }>,
  blobs: ReadonlyArray<{ oid: string; digest: string | null }>, capped: { versions: boolean; blobs: boolean } = { versions: false, blobs: false }): Pick<Evidence, 'kind' | 'basis' | 'blob' | 'version'> {
  const fileAt = blobs.findIndex(blob => blob.digest === row);
  const databaseAt = head === null ? -1 : versions.findIndex(version => version.digest === head);
  const fileMoved = fileAt >= 0 ? blobs[fileAt]! : undefined, databaseMoved = databaseAt >= 0 ? versions[databaseAt]! : undefined;
  const sharedNewerThanBlob = fileAt >= 0 && blobs.slice(0, fileAt).some(blob => blob.digest !== null && blob.digest !== row && versions.some(version => version.digest === blob.digest));
  const sharedNewerThanVersion = databaseAt >= 0 && versions.slice(0, databaseAt).some(version => version.digest !== head && blobs.some(blob => blob.digest === version.digest));
  const rowArchived = fileAt >= 0 ? versions.map(version => version.digest).lastIndexOf(row) : -1;
  const databaseLeftRow = rowArchived > 0 && versions.slice(0, rowArchived).some(version => version.digest !== row);
  const headCommitted = databaseAt >= 0 ? blobs.map(blob => blob.digest).lastIndexOf(head) : -1;
  const fileLeftHead = headCommitted > 0 && blobs.slice(0, headCommitted).some(blob => blob.digest !== head);
  if ((fileMoved && databaseMoved) || sharedNewerThanBlob || sharedNewerThanVersion || databaseLeftRow || fileLeftHead) {
    return { kind: 'both_moved', basis: 'conflicting_history', blob: fileMoved?.oid ?? null, version: databaseMoved?.id ?? null };
  }
  if (fileMoved) return capped.versions ? { kind: 'no_evidence', basis: 'history_truncated', blob: fileMoved.oid, version: null }
    : { kind: 'git_wins_file_moved', basis: 'row_matches_older_file', blob: fileMoved.oid, version: null };
  if (databaseMoved) return capped.blobs ? { kind: 'no_evidence', basis: 'history_truncated', blob: null, version: databaseMoved.id }
    : { kind: 'adopt_db_moved', basis: 'older_version_matches_file', blob: null, version: databaseMoved.id };
  const digests = new Map<string, string>();
  for (const blob of blobs) if (blob.digest !== null && !digests.has(blob.digest)) digests.set(blob.digest, blob.oid);
  const shared = versions.find(version => digests.has(version.digest));
  if (shared) return { kind: 'both_moved', basis: 'shared_older_state', blob: digests.get(shared.digest)!, version: shared.id };
  return { kind: 'no_evidence', basis: 'no_shared_state', blob: null, version: null };
}

type VersionRow = { id: number; page_id: string; compiled_truth: string; frontmatter: unknown; timeline: string | null; title: string | null; type: string | null; tags: unknown };
/** A version the evidence read lists: `readable` when it is an inline, live snapshot with a body (its digest can be computed). */
type VersionMeta = { id: number | string; page_id: string; bytes: number | string; readable: boolean };
/** At most this many version body bytes are held at once (a larger version is read alone). */
const VERSION_READ_BYTES = 32 * 1024 * 1024;
const json = <T>(value: unknown, fallback: T): T => value == null ? fallback : typeof value === 'string' ? JSON.parse(value) as T : value as T;

/**
 * The evidence of every subject, read against the commit `tip` of the checkout at `root` (`gitRoot` its top level,
 * `scope` the source's directory in it, `mode` its slug-root mode). One history walk for all of them, then
 * EVIDENCE_BATCH pages at a time: their export views and versions in a read-only transaction, their older blobs through
 * `cat-file --batch`. A page whose revision moved since the census read it is no_evidence (`changed_during_read`), so a
 * later preview judges it again. Read-only.
 */
export async function readDirectionEvidence(engine: BrainEngine, input: { sourceId: string; root: string; gitRoot: string; scope: string; tip: string; format: ObjectFormat;
  mode: SlugRootMode; subjects: EvidenceSubject[] }): Promise<Map<string, Evidence>> {
  const { sourceId, root, scope, tip, format, mode, subjects } = input;
  const out = new Map<string, Evidence>();
  if (!subjects.length) return out;
  const gitPath = (rel: string) => scope ? `${scope}/${rel}` : rel;
  const ids = subjects.map(subject => subject.id);
  const origins = await engine.executeRaw<{ page_id: string; slug: string; source_path: string }>(`SELECT DISTINCT v.page_id::text AS page_id, p.slug, v.source_path
    FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE v.page_id = ANY(string_to_array($1::text, ',')::int[]) AND v.source_path IS NOT NULL AND v.source_path <> ''`, [ids.join(',')]);
  const paths = new Map(subjects.map(subject => [subject.id, new Set([gitPath(subject.rel)])]));
  for (const origin of origins) {
    try {
      const target = restoreFilePath(root, origin.slug, origin.source_path, Buffer.byteLength(origin.source_path), mode);
      const rel = target.slice(root.length + 1).split(sep).join('/');
      if (!rel.startsWith('../') && target.startsWith(root + sep)) paths.get(origin.page_id)?.add(gitPath(rel));
    } catch (error) { if (!(error instanceof RestoreTargetError)) throw error; }
  }
  const history = await readPathHistory(input.gitRoot, tip, scope, new Set([...paths.values()].flatMap(set => [...set])));
  const none = (basis: EvidenceBasis, committed_at: number | null = null): Evidence => ({ kind: 'no_evidence', basis, blob: null, version: null, versions: 0, blobs: 0, committed_at });
  if (!history) { for (const subject of subjects) out.set(subject.id, none('history_unreadable')); return out; }
  const olderOf = new Map<string, { list: HistoryEntry[]; committed_at: number | null; capped: boolean }>();
  const older = (subject: EvidenceSubject) => olderOf.get(subject.id) ?? olderOf.set(subject.id, readOlder(subject)).get(subject.id)!;
  const readOlder = (subject: EvidenceSubject) => {
    const merged = [...paths.get(subject.id)!].flatMap(path => history.get(path) ?? []).sort((a, b) => a.seq - b.seq);
    const seen = new Set<string>(), list: HistoryEntry[] = [];
    let pastTip = false;
    for (const entry of merged) {
      if (!pastTip && entry.oid === subject.blob.oid) continue;
      pastTip = true;
      if (!seen.has(entry.oid) && list.length < EVIDENCE_DEPTH) { seen.add(entry.oid); list.push(entry); }
    }
    return { list, committed_at: merged[0]?.at ?? null, capped: list.length >= EVIDENCE_DEPTH || [...paths.get(subject.id)!].some(path => (history.get(path)?.length ?? 0) > EVIDENCE_DEPTH) };
  };
  const withdrawals = await readExportWithdrawals(engine, sourceId);
  for (let start = 0; start < subjects.length; start += EVIDENCE_BATCH) {
    const batch = subjects.slice(start, start + EVIDENCE_BATCH);
    const segmentedSizes = new Map<string, Map<string, number> | null>();
    for (const subject of batch) if (subject.segmented) segmentedSizes.set(subject.id, await readBlobSizes(root, older(subject).list.map(entry => entry.oid)));
    const read = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      const rows = await tx.executeRaw<{ id: string; revision: string | null; gap: boolean }>(`SELECT id::text, knowledge_revision::text AS revision, version_history_gap_at IS NOT NULL AS gap
        FROM pages WHERE id = ANY(string_to_array($1::text, ',')::bigint[]) AND deleted_at IS NULL`, [batch.map(subject => subject.id).join(',')]);
      const live = new Map(rows.map(row => [row.id, row.revision])), gaps = new Set(rows.filter(row => row.gap).map(row => row.id));
      const current = batch.filter(subject => live.has(subject.id) && live.get(subject.id) === subject.revision);
      const snapshots = await readExportPages(tx, current.map(subject => ({ id: subject.id, source_id: sourceId, slug: subject.slug })), withdrawals);
      const versions = current.length ? await tx.executeRaw<VersionMeta>(`SELECT id, page_id::text AS page_id, COALESCE(octet_length(compiled_truth), 0) + COALESCE(octet_length(timeline), 0) AS bytes,
          (COALESCE(body_storage,'inline')='inline' AND NOT COALESCE(is_deleted, false) AND compiled_truth IS NOT NULL) AS readable FROM (SELECT v.id, v.page_id, v.compiled_truth, v.timeline, v.body_storage,
          v.is_deleted, row_number() OVER (PARTITION BY v.page_id ORDER BY v.id DESC) AS rank FROM page_versions v WHERE v.page_id = ANY(string_to_array($1::text, ',')::int[])) ranked
          WHERE rank <= $2 ORDER BY page_id, id DESC`, [current.map(subject => subject.id).join(','), EVIDENCE_DEPTH]) : [];
      const snapshotOf = new Map(current.map((subject, i) => [subject.id, snapshots[i]!]));
      const digests = new Map<string, string>(), wanted = versions.filter(row => row.readable);
      for (let from = 0; from < wanted.length;) {
        let to = from, bytes = 0;
        while (to < wanted.length && (to === from || bytes + Number(wanted[to]!.bytes) <= VERSION_READ_BYTES)) bytes += Number(wanted[to++]!.bytes);
        const rows = await tx.executeRaw<VersionRow>(`SELECT id, page_id::text AS page_id, compiled_truth, frontmatter, timeline, title, type, tags FROM page_versions
          WHERE id = ANY(string_to_array($1::text, ',')::int[])`, [wanted.slice(from, to).map(row => row.id).join(',')]);
        for (const row of rows) {
          const page = snapshotOf.get(row.page_id)!.page;
          digests.set(String(row.id), digest(reconcileCanonical({ type: (row.type ?? page.type) as Page['type'], title: row.title ?? page.title, compiled_truth: row.compiled_truth,
            timeline: row.timeline ?? '', frontmatter: json(row.frontmatter, {}) }, json<string[]>(row.tags, []))));
        }
        from = to;
      }
      const segmentedOids = new Map<string, Set<string>>();
      for (const [i, subject] of current.entries()) {
        if (!subject.segmented) continue;
        const sizes = segmentedSizes.get(subject.id);
        segmentedOids.set(subject.id, sizes ? await segmentedExportBlobIds(tx, snapshots[i]!, withdrawals, new Set(sizes.values()), format) : new Set());
      }
      return { current, snapshots, versions, digests, segmentedOids, gaps };
    });
    for (const subject of batch) if (!read.current.includes(subject)) out.set(subject.id, none('changed_during_read', older(subject).committed_at));
    const byPage = new Map<string, VersionMeta[]>();
    for (const row of read.versions) byPage.set(row.page_id, [...byPage.get(row.page_id) ?? [], row]);
    const inline = read.current.filter(subject => !subject.segmented);
    const oids = [...new Set(inline.flatMap(subject => [subject.blob.oid, ...older(subject).list.map(entry => entry.oid)]))];
    const sizes = await readBlobSizes(root, oids) ?? new Map<string, number>();
    const readable = oids.flatMap(oid => { const size = sizes.get(oid); return size !== undefined && size <= SYNC_READ_BOUND ? [{ oid, size, mode: '100644' }] : []; });
    const fileDigests = new Map<string, string | null>();
    for (let from = 0; from < readable.length;) {
      let to = from, bytes = 0;
      while (to < readable.length && (to === from || bytes + readable[to]!.size <= CAT_FILE_BATCH_BYTES)) bytes += readable[to++]!.size;
      const chunk = readable.slice(from, to);
      const blobs = await readBlobs(root, chunk);
      for (const subject of inline) {
        const i = read.current.indexOf(subject), page = read.snapshots[i]!.page;
        for (const blob of chunk) {
          const key = `${subject.id}:${blob.oid}`;
          if (fileDigests.has(key) || !blobs?.has(blob.oid)) continue;
          if (blob.oid !== subject.blob.oid && !older(subject).list.some(entry => entry.oid === blob.oid)) continue;
          const file = canonicalFile(blobs.get(blob.oid)!, subject.importPath, page);
          fileDigests.set(key, file.state === 'parsed' ? digest(file.canonical) : null);
        }
      }
      from = to;
    }
    for (const [i, subject] of read.current.entries()) {
      const { list, committed_at, capped } = older(subject);
      if (subject.segmented) {
        const match = list.find(entry => read.segmentedOids.get(subject.id)?.has(entry.oid));
        const rows = byPage.get(subject.id) ?? [];
        out.set(subject.id, match && !rows.length && !read.gaps.has(subject.id) ? { kind: 'git_wins_file_moved', basis: 'row_matches_older_file', blob: match.oid, version: null, versions: rows.length, blobs: list.length, committed_at }
          : { ...none('segmented', committed_at), blob: match?.oid ?? null, versions: rows.length, blobs: list.length });
        continue;
      }
      const snapshot = read.snapshots[i]!;
      const rows = byPage.get(subject.id) ?? [];
      const versions = rows.flatMap(row => read.digests.has(String(row.id)) ? [{ id: Number(row.id), digest: read.digests.get(String(row.id))! }] : []);
      const unread = read.gaps.has(subject.id) || rows.length >= EVIDENCE_DEPTH || versions.length < rows.length;
      const decided = decideDirection(digest(reconcileCanonical(snapshot.page, snapshot.tags)), fileDigests.get(`${subject.id}:${subject.blob.oid}`) ?? null, versions,
        list.map(entry => ({ oid: entry.oid, digest: fileDigests.get(`${subject.id}:${entry.oid}`) ?? null })), { versions: unread, blobs: capped });
      out.set(subject.id, { ...decided, versions: versions.length, blobs: list.length, committed_at });
    }
  }
  return out;
}

/** The Git blob ids a segmented page's streamed export would have at each of `sizes` (only the one equal to its length can match). */
async function segmentedExportBlobIds(tx: BrainEngine, snapshot: ExportSnapshot, withdrawals: ExportWithdrawal[], sizes: ReadonlySet<number>, format: ObjectFormat): Promise<Set<string>> {
  const hashes = new Map([...sizes].map(size => [size, createHash(format).update(`blob ${size}\0`)]));
  const max = Math.max(0, ...sizes);
  let bytes = 0;
  for await (const piece of segmentedExportMarkdown(tx, snapshot.page, exportBodyLedger(snapshot.page.slug, withdrawals), segmentedExportHead(snapshot))) {
    bytes += typeof piece === 'string' ? Buffer.byteLength(piece) : piece.length;
    if (bytes > max) return new Set();
    for (const hash of hashes.values()) hash.update(piece);
  }
  const hash = hashes.get(bytes);
  return hash ? new Set([hash.digest('hex')]) : new Set();
}
