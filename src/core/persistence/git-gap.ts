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
import { join, posix } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitStream, hardenedGitSync, NulRecordSplitter } from '../hardened-git.ts';
import { exportBodyLedger, segmentedExportHead, segmentedExportMarkdown, type ExportSnapshot, type ExportWithdrawal } from '../export-snapshot.ts';
import { parseMarkdown } from '../markdown.ts';
import { isDerivationPrivate, isPrivatePage } from '../search/private-visibility.ts';
import { alignWithStored } from './align-stored.ts';
import { digest } from './digest.ts';
import { isDeclaredReason, isNeverFiledDerivedPage } from './git-declared.ts';
import { classifyDrift } from './reconcile-additive.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading } from './reconcile-state.ts';

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
 * can never be committed. `lineage_private` is what privatePagesFilterFragment adds over the row's own fields; the caller
 * computes it in SQL. Callers load `visibility.honor_aliases` (readHonorAliases) first.
 */
export function declaredDatabaseOnly(page: { slug: string; type?: string | null; frontmatter?: unknown; database_only_reason?: string | null;
  lineage_private?: boolean; source_path?: string | null; source_uri?: string | null; withheld_source_path?: string | null }, relativePath: string | null, policy: GitHomePolicy): DeclaredClass | null {
  if (policy.mirror) return 'mirror_source';
  if (policy.databaseOnlySource) return 'database_only_source';
  if (isPrivatePage(page)) return 'private';
  if (isDerivationPrivate(page)) return 'alias_private';
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
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) return { state: 'unparseable', reason: 'not_utf8' };
  const reading = reconcileFileReading(text, importPath, page);
  const parsed = parseMarkdown(reading.content, `${page.slug}.md`, { validate: true, expectedSlug: page.slug });
  if (parsed.errors?.some(e => !['MISSING_OPEN', 'EMPTY_FRONTMATTER'].includes(e.code))) return { state: 'unparseable', reason: 'frontmatter' };
  if (parsed.slug !== page.slug) return { state: 'differs', paths: ['/slug'] };
  alignWithStored(parsed, page, reading.inferred);
  const file = reconcileCanonical(parsed, parsed.tags), database = reconcileCanonical(page, tags);
  if (digest(file) === digest(database)) return { state: 'equal' };
  return { state: 'differs', paths: classifyDrift(file, database).paths.map(p => p.path) };
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

/** Whether `root` is inside a Git working tree (hardened `rev-parse --show-toplevel`). */
export function isGitCheckout(root: string): boolean {
  return gitLine(root, ['rev-parse', '--show-toplevel']) !== null;
}

/**
 * HEAD of the checkout at `root`, listed once with `ls-tree -r -l -z --full-tree` under the source's directory. Null when
 * Git cannot answer (not a checkout, a failed or truncated read).
 */
export async function readHeadTree(root: string): Promise<HeadTree | null> {
  const top = gitLine(root, ['rev-parse', '--show-toplevel']);
  const format = gitLine(root, ['rev-parse', '--show-object-format']);
  if (top === null || (format !== 'sha1' && format !== 'sha256')) return null;
  const gitRoot = realpathSync(top), real = realpathSync(root);
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], GIT_LIMITS);
  if (!head.ok) return head.reason === 'exit' && head.status === 1 ? { gitRoot, format, commit: null, blobs: new Map() } : null;
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
