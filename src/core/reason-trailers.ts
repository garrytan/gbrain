/**
 * GBRA-217 (A6, A7): page change reasons read back from Git. A commit gbrain makes, and an outside commit made with
 * `git commit --trailer "gbrain-reason: <path>: <text>"`, carries one `gbrain-reason` trailer per path. Sync mirrors
 * them into page history (`page_versions.change_reason` on the snapshot the import archives); purge finds the commits
 * whose reason quotes a purged claim and tombstones them (`reason_purge_tombstones`, text-free), so no later import
 * brings that reason back.
 *
 * One reader serves both: a single streaming `git log` over the first-parent line (merges diffed against their first
 * parent, so a merge's own trailer decides for a conflict resolution and a side-branch commit never decides), with no
 * pathspec and no grep on the command line, parsed as it streams and stopped at a commit cap.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { hardenedGitStream, hardenedGitSync, REASON_LOG_OPTIONS } from './hardened-git.ts';
import { canonicalChangeReason, CHANGE_REASON_MAX } from './persistence/change-reason.ts';
import { scanTextSpans } from './secret-scan.ts';
import type { BrainEngine } from './engine.ts';
import type { Notice } from './agent-output.ts';
import type { VersionHistory } from './page-state/versions.ts';

export const SYNC_REASON_SCAN_CAP = 10_000;
export const PURGE_REASON_SCAN_CAP = 200_000;
const SCAN_TIMEOUT_MS = 120_000;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface TrailerCommit { sha: string; values: string[]; paths: string[] }
export type TrailerRead = { status: 'complete' | 'capped'; commits: number } | { status: 'failed'; commits: number; detail: string };

let caps = { sync: SYNC_REASON_SCAN_CAP, purge: PURGE_REASON_SCAN_CAP };
let gitStream = hardenedGitStream;
let scans = 0;
/** Test seams: smaller caps, a replacement Git runner, and the number of scans run (no argument restores each). */
export function __setReasonScanCapsForTests(next?: Partial<typeof caps>): void { caps = { sync: SYNC_REASON_SCAN_CAP, purge: PURGE_REASON_SCAN_CAP, ...next }; }
export function __setReasonGitStreamForTests(runner?: typeof hardenedGitStream): void { gitStream = runner ?? hardenedGitStream; }
export function __reasonScansForTests(): number { return scans; }
export function reasonScanCap(kind: 'sync' | 'purge'): number { return caps[kind]; }

class CapReached extends Error {}

/**
 * Streams `git log` over `revisions` (a range `a..b`, or one commit for its whole history), newest first along the
 * first parent, calling `visit` for each commit up to `cap`. Output is `-z`: each commit is an empty token, its OID,
 * its trailer values (one per line, folded lines joined), then its paths (the first prefixed by Git's blank line).
 */
export async function readReasonTrailers(gitRoot: string, revisions: string, cap: number, visit: (commit: TrailerCommit) => void): Promise<TrailerRead> {
  scans++;
  let state: 'sha' | 'trailers' | 'paths' = 'sha';
  let current: TrailerCommit | null = null;
  let commits = 0;
  let pending: Buffer[] = [];
  const flush = () => { if (current) visit(current); current = null; };
  const token = (text: string) => {
    if (state === 'paths' && text === '') { flush(); state = 'sha'; return; }
    if (state === 'sha') {
      if (text === '') return;
      if (!OID.test(text)) throw new Error(`unexpected git log record ${JSON.stringify(text.slice(0, 60))}`);
      if (++commits > cap) throw new CapReached();
      current = { sha: text, values: [], paths: [] };
      state = 'trailers';
      return;
    }
    if (state === 'trailers') { current!.values = text.split('\n').map(line => line.trim()).filter(Boolean); state = 'paths'; return; }
    current!.paths.push(current!.paths.length === 0 && text.startsWith('\n') ? text.slice(1) : text);
  };
  const onChunk = (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end >= 0; end = chunk.indexOf(0, start)) {
      const piece = chunk.subarray(start, end);
      token((pending.length ? Buffer.concat([...pending, piece]) : piece).toString('utf8'));
      pending = [];
      start = end + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  };
  try {
    const result = await gitStream(gitRoot, ['log', ...REASON_LOG_OPTIONS, '--end-of-options', revisions, '--'], { timeoutMs: SCAN_TIMEOUT_MS, onChunk });
    if (!result.ok) return { status: 'failed', commits, detail: `git log ${result.reason}${result.status === undefined ? '' : ` ${result.status}`}` };
    if (pending.length) token(Buffer.concat(pending).toString('utf8'));
    flush();
    return { status: 'complete', commits };
  } catch (error) {
    if (error instanceof CapReached) return { status: 'capped', commits: cap };
    return { status: 'failed', commits, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The spellings of a repository-relative path a trailer may use: itself, and (under a scoped source) relative to the scope. */
export function pathForms(scopePrefix: string): (path: string) => string[] {
  const prefix = scopePrefix && !scopePrefix.endsWith('/') ? `${scopePrefix}/` : scopePrefix;
  return path => prefix && path.startsWith(prefix) ? [path, path.slice(prefix.length)] : [path];
}

/**
 * Each trailer value of `commit` by the path it names (`<path>: <text>`). A path may itself hold ": ", so the longest
 * spelling of a path the commit touched that prefixes a value owns it; a value naming no such path is malformed.
 */
export function trailerTexts(commit: TrailerCommit, forms: (path: string) => string[]): { byPath: Map<string, string>; malformed: number } {
  const byPath = new Map<string, string>();
  let malformed = 0;
  for (const value of commit.values) {
    let best: { path: string; length: number } | null = null;
    for (const path of commit.paths) {
      for (const form of forms(path)) {
        if (value.startsWith(`${form}: `) && (!best || form.length > best.length)) best = { path, length: form.length };
      }
    }
    if (!best) { malformed++; continue; }
    if (!byPath.has(best.path)) byPath.set(best.path, value.slice(best.length + 2));
  }
  return { byPath, malformed };
}

export interface ReasonDecision { commit: string; reason: string | null; commits: number }
export interface SyncReasonScan {
  status: 'complete' | 'capped' | 'failed';
  /** The repository's top level, which the scanned paths are relative to. */
  gitRoot: string;
  /** The range as `git log` names it (`<from>..<to>`, or `<to>` for its whole history). */
  range: string;
  /** Repository-relative path -> the newest first-parent commit that touched it, its reason, and how many commits touched it. */
  byPath: Map<string, ReasonDecision>;
  malformed: number;
  secrets: Array<{ commit: string; path: string }>;
  detail?: string;
}


/**
 * A6: one scan per sync pass. For each path, the newest first-parent commit in the range that touched it decides: its
 * trailer for that path, or NULL when it has none, so an older reason is never stamped on newer text. Each reason is
 * canonicalised and secret-scanned (a secret, an over-long value or a tombstoned (commit, path) gives NULL); a value
 * naming no path its commit touched is malformed and counted. A failed or capped scan maps nothing.
 */
export async function scanSyncReasons(engine: BrainEngine, input: { sourceId: string; sourceRoot: string; from: string | null; to: string }): Promise<SyncReasonScan | null> {
  const repo = gitTopLevel(input.sourceRoot);
  if (!repo) return null;
  const range = input.from ? `${input.from}..${input.to}` : input.to;
  const byPath = new Map<string, ReasonDecision>();
  const secrets: SyncReasonScan['secrets'] = [];
  let malformed = 0;
  const tombstones = new Set((await engine.executeRaw<{ commit_sha: string; path: string }>(
    'SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1', [input.sourceId])).map(row => `${row.commit_sha}\0${row.path}`));
  const forms = pathForms(repo.scopePrefix);
  const read = await readReasonTrailers(repo.gitRoot, range, caps.sync, commit => {
    const texts = trailerTexts(commit, forms);
    malformed += texts.malformed;
    for (const path of commit.paths) {
      const seen = byPath.get(path);
      if (seen) { seen.commits++; continue; }
      const raw = texts.byPath.get(path);
      let reason = raw === undefined ? null : canonicalChangeReason(raw);
      if (reason !== null && [...reason].length > CHANGE_REASON_MAX) { reason = null; malformed++; }
      if (reason !== null && scanTextSpans(reason).some(span => span.finding !== null)) { reason = null; secrets.push({ commit: commit.sha, path }); }
      if (reason !== null && tombstones.has(`${commit.sha}\0${path}`)) reason = null;
      byPath.set(path, { commit: commit.sha, reason, commits: 1 });
    }
  });
  if (read.status === 'complete') return { status: 'complete', gitRoot: repo.gitRoot, range, byPath, malformed, secrets };
  return { status: read.status, gitRoot: repo.gitRoot, range, byPath: new Map(), malformed: 0, secrets: [], ...(read.status === 'failed' ? { detail: read.detail } : {}) };
}

type GitTopLevel = { status: 'found'; gitRoot: string; scopePrefix: string } | { status: 'not_repository' } | { status: 'failed'; detail: string };

/**
 * Where `sourceRoot` sits in Git: its top level and the source's path under it (both real paths); `not_repository` only
 * when Git itself says the folder is in no repository (exit 128, "not a git repository"); anything else, a missing path,
 * no `git`, an unsafe or corrupt repository, a timeout, is `failed`.
 */
function locateGitTopLevel(sourceRoot: string): GitTopLevel {
  let root: string;
  try { root = realpathSync(sourceRoot); } catch (error) { return { status: 'failed', detail: `source path unreadable: ${(error as NodeJS.ErrnoException).code ?? 'error'}` }; }
  const top = hardenedGitSync(root, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000, maxBytes: 64 * 1024, stderr: true });
  if (top.ok) {
    const gitRoot = realpathSync(top.stdout.toString('utf8').trim());
    return { status: 'found', gitRoot, scopePrefix: relative(gitRoot, root).split(sep).join('/') };
  }
  if (top.reason === 'exit' && top.status === 128 && /not a git repository/i.test(top.stderr ?? '')) return { status: 'not_repository' };
  return { status: 'failed', detail: `git rev-parse --show-toplevel ${top.reason}${top.status === undefined ? '' : ` ${top.status}`}` };
}

/**
 * Sync's view: the Git top level holding `sourceRoot`, or null when it is in no Git repository (a plain folder source,
 * a repo-less brain) or Git cannot place it; such a pass runs no scan and imports as before.
 */
export function gitTopLevel(sourceRoot: string): { gitRoot: string; scopePrefix: string } | null {
  const top = locateGitTopLevel(sourceRoot);
  return top.status === 'found' ? { gitRoot: top.gitRoot, scopePrefix: top.scopePrefix } : null;
}

/** A file's path relative to the scan's Git top level, resolving its directory's real path (the file itself may be gone). */
function repoPathOf(scan: SyncReasonScan, filePath: string): string {
  let dir = dirname(filePath);
  try { dir = realpathSync(dir); } catch { /* the lexical path is the best guess */ }
  return relative(scan.gitRoot, join(dir, basename(filePath))).split(sep).join('/');
}

/**
 * What the snapshot an import of one file (absolute path) archives carries: the deciding reason, and a history gap when
 * the range held more than one commit for the file or the scan could not say. Nothing when the pass ran no scan (no Git
 * checkout).
 */
export function importHistoryFor(scan: SyncReasonScan | null | undefined, filePath: string): VersionHistory | undefined {
  if (!scan) return undefined;
  if (scan.status !== 'complete') return { reason: null, historyGap: true };
  const decision = scan.byPath.get(repoPathOf(scan, filePath));
  return { reason: decision?.reason ?? null, historyGap: (decision?.commits ?? 0) > 1 };
}

/** The pass's notices: a failed or capped scan (reasons stored as NULL, no backfill), and secrets found in pushed trailers. */
export function reasonScanNotices(scan: SyncReasonScan | null | undefined, sourceId: string): Notice[] {
  if (!scan) return [];
  const notices: Notice[] = [];
  if (scan.status !== 'complete') {
    const what = scan.status === 'capped' ? `reached its limit of ${caps.sync} commits` : `failed (${scan.detail ?? 'git error'})`;
    notices.push({ code: scan.status === 'capped' ? 'reason_scan_capped' : 'reason_scan_failed', kind: 'degraded',
      why: `Source ${sourceId} synced, but reading change reasons from Git for ${scan.range} ${what}. Content was imported; every reason in this pass is stored as empty and each imported page is marked as having a history gap. `
        + 'This release does not backfill reasons for that range, and a later sync will not rescan it. The reasons are still in Git.',
      fix: { argv: ['git', 'log', '--first-parent', '--format=%H %(trailers:key=gbrain-reason,valueonly)', scan.range], consent: [], actor: 'user', requires_exclusive: false,
        why: 'Lists the reasons Git holds for the range this pass could not read; read-only, nothing in the brain changes.' } });
  }
  if (scan.secrets.length) {
    const named = scan.secrets.slice(0, 10).map(hit => `${hit.commit.slice(0, 12)} ${hit.path}`).join(', ');
    const more = scan.secrets.length > 10 ? `, and ${scan.secrets.length - 10} more` : '';
    notices.push({ code: 'reason_trailer_secret', kind: 'safety',
      why: `A gbrain-reason trailer already in Git looks like it holds a secret (${named}${more}); that reason was not stored. Git history keeps the commit message, so rotate the credential.`,
      user_message: `A commit message in source ${sourceId} appears to contain a credential (${named}${more}). Rotate it: Git history keeps the commit text.` });
  }
  return notices;
}

const cache = new Map<string, { at: number; scan: Promise<SyncReasonScan | null> }>();
const CACHE_TTL_MS = 10 * 60_000;

/**
 * Managed sync prepares one request at a time, each naming its pass's range: the pass's scan runs once per process and
 * its later requests reuse it. The key carries the source's purge epoch, which every fact purge bumps in the transaction
 * that writes its tombstones, so a purge from any process makes the next request scan again and read them.
 */
export async function cachedSyncReasonScan(engine: BrainEngine, input: Parameters<typeof scanSyncReasons>[1]): Promise<SyncReasonScan | null> {
  const [source] = await engine.executeRaw<{ purge_epoch: string | number }>('SELECT purge_epoch FROM sources WHERE id = $1', [input.sourceId]);
  const key = [input.sourceId, String(source?.purge_epoch ?? 0), input.sourceRoot, input.from ?? '', input.to].join('\0');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scan;
  const scan = scanSyncReasons(engine, input);
  cache.set(key, { at: Date.now(), scan });
  scan.catch(() => cache.delete(key));
  while (cache.size > 16) cache.delete(cache.keys().next().value!);
  return scan;
}
export function clearReasonScanCache(): void { cache.clear(); }

/** A7: what a purge's trailer scan found: the (commit, path) pairs whose reason quotes the claim, read up to HEAD. */
export type PurgeTrailerScan =
  | { status: 'no_repository' }
  | { status: 'complete'; gitRoot: string; head: string | null; hits: Array<{ commit: string; path: string }>; commits: number; limited: boolean }
  | { status: 'failed'; detail: string }
  | { status: 'capped'; cap: number };

/**
 * A7: the commits on the first-parent line of HEAD (`from..HEAD` for a recheck) whose `gbrain-reason` trailer quotes one of
 * `needles` (case-insensitive, both canonicalised as a stored reason is: whitespace runs and control characters folded),
 * each with the path its trailer names: the touched path it prefixes, else the text before its first ": ". Capped at
 * the purge cap, or at `limit` when the user chose one (then older commits are not read).
 */
export async function scanTrailersCarrying(sourceRoot: string, needles: readonly string[], opts: { from?: string | null; limit?: number } = {}): Promise<PurgeTrailerScan> {
  const repo = locateGitTopLevel(sourceRoot);
  if (repo.status === 'not_repository') return { status: 'no_repository' };
  if (repo.status === 'failed') return { status: 'failed', detail: repo.detail };
  const head = hardenedGitSync(repo.gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 10_000, maxBytes: 1024 });
  if (!head.ok) return head.reason === 'exit' && head.status === 1 ? { status: 'complete', gitRoot: repo.gitRoot, head: null, hits: [], commits: 0, limited: false }
    : { status: 'failed', detail: `git rev-parse ${head.reason}` };
  const tip = head.stdout.toString('utf8').trim();
  if (opts.from === tip) return { status: 'complete', gitRoot: repo.gitRoot, head: tip, hits: [], commits: 0, limited: false };
  const lowered = needles.map(needle => canonicalChangeReason(needle)?.toLowerCase() ?? '').filter(Boolean);
  const forms = pathForms(repo.scopePrefix);
  const hits: Array<{ commit: string; path: string }> = [];
  const cap = opts.limit ?? caps.purge;
  const read = await readReasonTrailers(repo.gitRoot, opts.from ? `${opts.from}..${tip}` : tip, cap, commit => {
    for (const value of commit.values) {
      const lower = canonicalChangeReason(value)?.toLowerCase() ?? '';
      if (!lowered.some(needle => lower.includes(needle))) continue;
      let best: { path: string; length: number } | null = null;
      for (const path of commit.paths) for (const form of forms(path)) {
        if (value.startsWith(`${form}: `) && (!best || form.length > best.length)) best = { path, length: form.length };
      }
      hits.push({ commit: commit.sha, path: best?.path ?? value.split(': ')[0]! });
    }
  });
  if (read.status === 'failed') return { status: 'failed', detail: read.detail };
  if (read.status === 'capped' && opts.limit === undefined) return { status: 'capped', cap };
  return { status: 'complete', gitRoot: repo.gitRoot, head: tip, hits, commits: read.commits, limited: read.status === 'capped' };
}
