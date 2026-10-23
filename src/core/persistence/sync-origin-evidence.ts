/**
 * #7130: whether a missing file is evidence that its page was deleted. A managed sync deletes a live page whose recorded
 * file is absent from the pinned tree and the disk only when Git once committed that file: then its absence is a removal
 * the history records, and the page's bytes stay recoverable from the commit that held them. A file Git never committed
 * (an agent's write-through that landed in a directory `.gitignore` excludes, a copy removed before any commit) left no
 * history, so its absence proves nothing and the page may hold the only copy of its content: sync holds it instead.
 *
 * Both reads come from one walk of the history (`historyIndex`): every path a commit touched, and the newest commit that
 * deleted it. The walk is cached per commit and extended by the commits after a cached one, so a long history is read
 * once per process, not once per path or per batch (a pathspec walk per 500 paths ran past its time limit on a long
 * history and answered `unknown` for every path). A walk that fails or times out answers `unknown` for every path,
 * which the classifier treats like a missing commit (fail closed: hold, never delete).
 */
import { execFile, spawn } from '../spawn.ts';
import { promisify } from 'node:util';
import { gitChildEnv } from '../git-env.ts';
import { NulRecordSplitter } from '../hardened-git.ts';

const execFileAsync = promisify(execFile);

/** `committed`: some commit of the history holds the path. `never_committed`: none does. `ignored`: none does and `.gitignore` excludes it (a commit's evidence wins over a later ignore rule). `unknown`: a read failed. */
export type OriginEvidence = 'committed' | 'never_committed' | 'ignored' | 'unknown';

/** Paths per `check-ignore` invocation. */
const BATCH = 500;
const GIT_TIMEOUT_MS = 120_000;
/** One history walk; the old per-batch walks each had GIT_TIMEOUT_MS. */
const WALK_TIMEOUT_MS = 600_000;
/** Walks kept per Git top level: a newer commit extends and replaces its ancestor's, so two cover a pass's target and a baseline off its line. */
const INDEXES_PER_ROOT = 2;
const GIT_MAX_BUFFER = 64 * 1024 ** 2;

/** `literal`: the paths are pathspecs read literally (`log`); `check-ignore` takes plain pathnames and refuses the magic. */
async function git(gitRoot: string, args: string[], literal = false): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...(literal ? ['--literal-pathspecs'] : []), '-C', gitRoot, ...args],
      { env: gitChildEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; killed?: boolean };
    return { code: typeof e.code === 'number' && !e.killed ? e.code : -1, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
  }
}

/** `git check-ignore --no-index -z --stdin` over `paths` (NUL-separated both ways, so any byte in a name survives). */
function checkIgnore(gitRoot: string, paths: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', gitRoot, 'check-ignore', '--no-index', '-z', '--stdin'], { env: gitChildEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const done = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(-1); }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > GIT_MAX_BUFFER) { child.kill('SIGKILL'); done(-1); } else chunks.push(chunk); });
    child.on('error', () => done(-1));
    child.on('close', code => done(code ?? -1));
    child.stdin.on('error', () => undefined);
    child.stdin.end(paths.map(path => `${path}\0`).join(''));
  });
}

/**
 * #7130 (write-through): whether the Git work tree around `root` ignores `relativePath` and does not track it, so a
 * file written there would never be committed. False outside a work tree or when Git cannot answer (the write keeps its
 * old behavior then; sync's own evidence read still fails closed).
 */
export async function gitIgnoresUntracked(root: string, relativePath: string): Promise<boolean> {
  return (await git(root, ['check-ignore', '-q', '--', relativePath])).code === 0;
}

type Deletion = { commit: string; author: string; date: string; subject: string };
/** A path some commit touched, with the newest ordinary commit and the newest merge (against its first parent) that deleted it. */
interface PathHistory { deleted?: Deletion; mergeDeleted?: Deletion }
interface HistoryIndex { tip: string; paths: Map<string, PathHistory> }
const historyIndexes = new Map<string, HistoryIndex[]>();

/** Test seam: forget every cached walk. */
export function __resetHistoryIndexesForTest(): void { historyIndexes.clear(); }

/**
 * Walks `revs` (`--full-history`, every commit, merges against their first parent) and records, per Git-root-relative path,
 * that a commit touched it and the newest commits that deleted it. Null when Git failed or the walk ran out of time.
 */
function walkHistory(gitRoot: string, revs: string[], onCommit?: (commits: number) => void): Promise<Map<string, PathHistory> | null> {
  return new Promise(resolve => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', gitRoot, 'log', '--full-history', '--no-renames', '--diff-merges=first-parent', '-z',
      '--format=%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%s', '--name-status', ...revs, '--'], { env: gitChildEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const paths = new Map<string, PathHistory>();
    const splitter = new NulRecordSplitter();
    let commit: { deletion: Deletion; merge: boolean } | null = null, status: string | null = null, commits = 0, settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok && splitter.atRecordBoundary ? paths : null); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, WALK_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      for (const record of splitter.push(chunk)) {
        const raw = record.toString('utf8');
        // A path is taken byte for byte; only a header or a status may carry the newline Git puts after a header.
        const token = status === null ? raw.replace(/^\n+/, '') : raw;
        if (status === null && token.startsWith('\x1e')) {
          const [hash = '', parents = '', author = '', date = '', ...subject] = token.slice(1).split('\x1f');
          commit = { deletion: { commit: hash, author, date, subject: subject.join('\x1f') }, merge: parents.trim().split(' ').length > 1 };
          status = null;
          if (++commits % 1000 === 0) onCommit?.(commits);
        } else if (status === null) status = token;
        else {
          const entry = paths.get(token) ?? {};
          if (status === 'D' && commit) {
            if (commit.merge) entry.mergeDeleted ??= commit.deletion; else entry.deleted ??= commit.deletion;
          }
          paths.set(token, entry);
          status = null;
        }
      }
    });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}

/** Whether `ancestor` is an ancestor of (or equal to) `commit`. */
async function isAncestor(gitRoot: string, ancestor: string, commit: string): Promise<boolean> {
  return (await git(gitRoot, ['merge-base', '--is-ancestor', ancestor, commit])).code === 0;
}

/**
 * The history of the commit `tip` (a full object id) in the work tree at `gitRoot`: a cached walk, a cached walk of an
 * ancestor extended by the commits after it (those are newer, so their deletions win), or one full walk. Null when Git
 * could not answer. #7355: a caller that asks while that walk runs joins it (and hears its commits) instead of starting
 * another, so a pass that follows an abandoned one waits for the walk already under way rather than walking from the start.
 */
async function historyIndex(gitRoot: string, tip: string, onCommit?: (commits: number) => void): Promise<HistoryIndex | null> {
  const exact = (historyIndexes.get(gitRoot) ?? []).find(index => index.tip === tip);
  if (exact) return exact;
  const key = `${gitRoot}\0${tip}`;
  let running = historyWalks.get(key);
  if (!running) {
    const listeners = new Set<(commits: number) => void>();
    running = { listeners, index: indexAt(gitRoot, tip, commits => { for (const listener of listeners) listener(commits); }).finally(() => historyWalks.delete(key)) };
    historyWalks.set(key, running);
  }
  if (onCommit) running.listeners.add(onCommit);
  try { return await running.index; } finally { if (onCommit) running!.listeners.delete(onCommit); }
}

const historyWalks = new Map<string, { listeners: Set<(commits: number) => void>; index: Promise<HistoryIndex | null> }>();

async function indexAt(gitRoot: string, tip: string, onCommit: (commits: number) => void): Promise<HistoryIndex | null> {
  const cached = historyIndexes.get(gitRoot) ?? [];
  let base: HistoryIndex | undefined;
  for (const index of cached) if (await isAncestor(gitRoot, index.tip, tip)) { base = index; break; }
  const walked = await walkHistory(gitRoot, base ? [tip, `^${base.tip}`] : [tip], onCommit);
  if (!walked) return null;
  const paths = base ? new Map(base.paths) : walked;
  if (base) for (const [path, newer] of walked) {
    const older = paths.get(path);
    paths.set(path, { ...(newer.deleted ?? older?.deleted ? { deleted: newer.deleted ?? older!.deleted } : {}),
      ...(newer.mergeDeleted ?? older?.mergeDeleted ? { mergeDeleted: newer.mergeDeleted ?? older!.mergeDeleted } : {}) });
  }
  const index = { tip, paths };
  historyIndexes.set(gitRoot, [index, ...cached.filter(other => other !== base)].slice(0, INDEXES_PER_ROOT));
  return index;
}

/** The full object id of `rev`'s commit, or null. */
async function commitId(gitRoot: string, rev: string): Promise<string | null> {
  const read = await git(gitRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return read.code === 0 ? read.stdout.trim() : null;
}

/**
 * The evidence for each Git-root-relative path in `gitPaths`, read in the work tree at `gitRoot`. `commits` are the
 * history tips to search (the pinned target and the pass's baseline); a path any commit reachable from one of them
 * touched was committed. `.gitignore` is read as the checkout has it now. `onCommit` hears every 1,000 commits a walk reads.
 */
export async function readOriginEvidence(gitRoot: string, commits: ReadonlyArray<string | null | undefined>, gitPaths: readonly string[],
  opts: { onCommit?: (commits: number) => void } = {}): Promise<Map<string, OriginEvidence>> {
  const evidence = new Map<string, OriginEvidence>();
  const tips = [...new Set(commits.filter((commit): commit is string => typeof commit === 'string' && commit.length > 0))];
  const paths = [...new Set(gitPaths)];
  const ids = await Promise.all(tips.map(tip => commitId(gitRoot, tip)));
  let historyKnown = ids.every(id => id !== null);
  // A tip that is an ancestor of another adds no commit to the union (the baseline of a pass is usually one of its target).
  const walked: string[] = [];
  for (const id of new Set(ids.filter((id): id is string => id !== null))) {
    let covered = false;
    for (const other of ids) if (other && other !== id && await isAncestor(gitRoot, id, other)) { covered = true; break; }
    if (!covered) walked.push(id);
  }
  const indexes: HistoryIndex[] = [];
  for (const id of walked) {
    const index = await historyIndex(gitRoot, id, opts.onCommit);
    if (index) indexes.push(index); else historyKnown = false;
  }
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const ignoredRead = await checkIgnore(gitRoot, batch);
    const ignored = new Set(ignoredRead.stdout.split('\0').filter(Boolean));
    // check-ignore exits 1 when no path is ignored; anything else but 0 is a failed read.
    const ignoreKnown = ignoredRead.code === 0 || ignoredRead.code === 1;
    for (const path of batch) {
      if (!historyKnown || !ignoreKnown) evidence.set(path, 'unknown');
      else if (indexes.some(index => index.paths.has(path))) evidence.set(path, 'committed');
      else evidence.set(path, ignored.has(path) ? 'ignored' : 'never_committed');
    }
  }
  return evidence;
}

/**
 * GBRA-133: where a held file whose page is still live went. `deleted_by_commit`: the newest commit of HEAD's full history
 * (`--full-history`, so a side branch's deletion that a merge kept is not simplified away; a merge counts against its first
 * parent) that deleted the path, with its author, date and subject. `deletion_uncommitted`: HEAD still holds the path, so
 * only the worktree lost it. `never_committed`: no commit of HEAD's history ever held it (a checkout with no commit yet
 * included). `unknown`: Git could not answer, or the history touched the path without a deletion this read can name.
 */
export type DeletionProvenance =
  | { kind: 'deleted_by_commit'; commit: string; author: string; date: string; subject: string }
  | { kind: 'deletion_uncommitted' } | { kind: 'never_committed' } | { kind: 'unknown' };
export const DELETION_PROVENANCES = ['deleted_by_commit', 'deletion_uncommitted', 'never_committed'] as const;

/**
 * Paths relative to `root` (a work tree or a directory inside one), read against HEAD from one history walk; `onCommit`
 * hears every 1,000 commits the walk reads.
 */
export async function readDeletionProvenance(root: string, paths: readonly string[], opts: { onCommit?: (commits: number) => void } = {}): Promise<Map<string, DeletionProvenance>> {
  const provenance = new Map<string, DeletionProvenance>();
  const unique = [...new Set(paths)];
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const unborn = head.code === 1 && (await git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  for (const path of unique) provenance.set(path, unborn ? { kind: 'never_committed' } : { kind: 'unknown' });
  if (head.code !== 0) return provenance;
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  const prefix = await git(root, ['rev-parse', '--show-prefix']);
  if (top.code !== 0 || prefix.code !== 0) return provenance;
  // ls-tree from `root` names the paths HEAD still holds, relative to it.
  const inHead = new Set<string>();
  for (let i = 0; i < unique.length; i += BATCH) {
    const listed = await git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...unique.slice(i, i + BATCH)], true);
    if (listed.code !== 0) return provenance;
    for (const path of listed.stdout.split('\0')) if (path) inHead.add(path);
  }
  const index = await historyIndex(top.stdout.trim(), head.stdout.trim(), opts.onCommit);
  if (!index) return provenance;
  for (const path of unique) {
    const history = index.paths.get(`${prefix.stdout.trim()}${path}`);
    const deletion = history?.deleted ?? history?.mergeDeleted;
    provenance.set(path, inHead.has(path) ? { kind: 'deletion_uncommitted' } : deletion ? { kind: 'deleted_by_commit', ...deletion } : history ? { kind: 'unknown' } : { kind: 'never_committed' });
  }
  return provenance;
}
