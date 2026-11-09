/**
 * GBRA-150: the readers behind `sync.metafile_pages`. A nested file named like scaffolding (`index.md`, `README.md`,
 * …; `isNestedSkipMetafile`) is a page when its head carries a `type:` or `title:` (`metafileIsPage` in sync.ts), so a
 * caller that classifies paths builds one `metafilePagePredicate` from the bytes its importer reads: the checkout on
 * disk (`diskMetafileHeads`) or blobs of a commit (`gitMetafileHeads`, batch-primed from a tree listing the caller
 * already streams), chained with `firstMetafileHead` so a deleted file reads as it was last committed. Only
 * metafile-named paths are ever read.
 */
import { execFileSync } from './spawn.ts';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { gitChildEnv, literalPathspecs } from './git-env.ts';
import { readBlobBytes, type TreeBlob } from './persistence/sync-blobs.ts';
import type { BrainEngine } from './engine.ts';
import { isNestedSkipMetafile, metafileIsPage, METAFILE_HEAD_BYTES, SYNC_METAFILE_PAGES_KEY, SYNC_SKIP_FILES, type MetafilePagesMode } from './sync.ts';

/** The head text of the file at a path, or undefined when there is none (absent, unreadable, not a regular file). */
export type MetafileHeadReader = (path: string) => string | undefined;

/** The predicate `SyncableOptions.metafilePage` takes, memoized per path. `rootRelative` maps a caller's path to its source-root form. */
export function metafilePagePredicate(mode: MetafilePagesMode, read: MetafileHeadReader, rootRelative: (path: string) => string = path => path): (path: string) => boolean {
  if (mode === 'off') return () => false;
  const memo = new Map<string, boolean>();
  return path => {
    let page = memo.get(path);
    if (page === undefined) {
      const relative = rootRelative(path);
      page = isNestedSkipMetafile(relative) && metafileIsPage(relative, read(path), mode);
      memo.set(path, page);
    }
    return page;
  };
}

/** The first reader that finds the file. */
export function firstMetafileHead(...readers: MetafileHeadReader[]): MetafileHeadReader {
  return path => {
    for (const read of readers) {
      const head = read(path);
      if (head !== undefined) return head;
    }
    return undefined;
  };
}

/** Reads the head of a regular file (never a symlink) under `root`. */
export function diskMetafileHeads(root: string): MetafileHeadReader {
  return path => {
    const absolute = join(root, path);
    try {
      if (!lstatSync(absolute).isFile()) return undefined;
      const fd = openSync(absolute, 'r');
      try {
        const buffer = Buffer.alloc(METAFILE_HEAD_BYTES);
        return buffer.subarray(0, readSync(fd, buffer, 0, METAFILE_HEAD_BYTES, 0)).toString('utf8');
      } finally { closeSync(fd); }
    } catch { return undefined; }
  };
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const metafileNamed = (path: string) => (SYNC_SKIP_FILES as readonly string[]).includes(nameOf(path));

function git(gitRoot: string, args: string[], input: string, maxBuffer = 64 * 1024 ** 2): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', gitRoot, ...args], { env: gitChildEnv(), timeout: 60_000, maxBuffer, input, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Blob ids and sizes of `<commit>:<path>`-style object names through one `cat-file --batch-check`; missing names are absent. */
function batchCheck(gitRoot: string, names: string[]): Map<string, TreeBlob> {
  const out = new Map<string, TreeBlob>();
  if (!names.length) return out;
  const asked = names.filter(name => !name.includes('\n'));
  if (!asked.length) return out;
  const lines = git(gitRoot, ['cat-file', '--batch-check'], asked.join('\n') + '\n').toString('utf8').split('\n');
  asked.forEach((name, i) => {
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(lines[i] ?? '');
    if (match) out.set(name, { oid: match[1]!, size: Number(match[2]) });
  });
  return out;
}

export interface GitMetafileHeads {
  read: MetafileHeadReader;
  /** Batch-reads the metafile-named entries of a tree listing the caller streams (one `cat-file` per call, none for other names). */
  prime(entries: Iterable<{ path: string; oid: string; size?: number }>): void;
}

/**
 * Heads of blobs at the first of `commits` that has the path (a later one names where a deleted file was last seen).
 * A primed path costs nothing more; an unprimed one costs one `cat-file --batch-check` and one `cat-file --batch`.
 * A Git failure reads as no file.
 */
export function gitMetafileHeads(gitRoot: string, commits: ReadonlyArray<string | null | undefined>): GitMetafileHeads {
  const chain = [...new Set(commits.filter((commit): commit is string => !!commit))];
  const cache = new Map<string, string | undefined>();
  const load = (blobs: Map<string, TreeBlob>) => {
    let bytes: Map<string, Buffer>;
    try { bytes = readBlobBytes(gitRoot, [...blobs.values()]); } catch { bytes = new Map(); }
    for (const [path, blob] of blobs) cache.set(path, bytes.get(blob.oid)?.subarray(0, METAFILE_HEAD_BYTES).toString('utf8'));
  };
  return {
    read: path => {
      if (cache.has(path)) return cache.get(path);
      if (!chain.length || !metafileNamed(path)) return undefined;
      try {
        const found = batchCheck(gitRoot, chain.map(commit => `${commit}:${path}`));
        const blob = chain.map(commit => found.get(`${commit}:${path}`)).find(Boolean);
        if (blob) load(new Map([[path, blob]]));
        else cache.set(path, undefined);
      } catch { cache.set(path, undefined); }
      return cache.get(path);
    },
    prime: entries => {
      const wanted = new Map<string, { oid: string; size?: number }>();
      for (const entry of entries) if (metafileNamed(entry.path) && !cache.has(entry.path)) wanted.set(entry.path, entry);
      if (!wanted.size) return;
      try {
        const unsized = [...wanted.values()].filter(entry => entry.size === undefined).map(entry => entry.oid);
        const sizes = batchCheck(gitRoot, unsized);
        load(new Map([...wanted].flatMap(([path, entry]) => {
          const size = entry.size ?? sizes.get(entry.oid)?.size;
          return size === undefined ? [] : [[path, { oid: entry.oid, size }] as [string, TreeBlob]];
        })));
      } catch { /* an unread entry is read on demand */ }
    },
  };
}

/**
 * A managed level's predicate over Git-root paths (depth judged below `scope`, the source root): blobs at `commits` (a deleted file as last committed), the checkout first when `checkout`
 * is set (working mode). `primeTree` batch-reads the metafile-named entries of the level's tree listing and returns it.
 */
export function levelMetafilePages(mode: MetafilePagesMode, gitRoot: string, commits: ReadonlyArray<string | null | undefined>, checkout: string | null,
  scope: string): { metafilePage: (path: string) => boolean; primeTree<L extends Iterable<[string, { oid: string }]>>(level: L): L } {
  const heads = gitMetafileHeads(gitRoot, commits);
  return {
    metafilePage: metafilePagePredicate(mode, checkout ? firstMetafileHead(diskMetafileHeads(checkout), heads.read) : heads.read,
      path => scope && path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : path),
    primeTree: level => { if (mode !== 'off') heads.prime((function* () { for (const [path, entry] of level) yield { path, oid: entry.oid }; })()); return level; },
  };
}

/** The metafile-named blobs of `commit`'s tree under `scope` (one `ls-tree`), Git-root relative. */
export function listMetafileNamedBlobs(gitRoot: string, commit: string, scope = ''): Array<{ path: string; oid: string; size: number }> {
  const rows = git(gitRoot, ['ls-tree', '-r', '-l', '-z', commit, ...(scope ? ['--', ...literalPathspecs([scope])] : [])], '', 512 * 1024 ** 2).toString('utf8').split('\0');
  const out: Array<{ path: string; oid: string; size: number }> = [];
  for (const row of rows) {
    const tab = row.indexOf('\t');
    const path = row.slice(tab + 1);
    if (tab < 0 || !metafileNamed(path)) continue;
    const [, kind, oid, size] = row.slice(0, tab).split(/\s+/);
    if (kind === 'blob') out.push({ path, oid: oid!, size: Number(size) });
  }
  return out;
}

/** The mode a classic source last finished a sync under (one config row per source), so a mode it has not applied yet backfills once. */
const appliedKey = (sourceId: string) => `${SYNC_METAFILE_PAGES_KEY}.applied.${sourceId}`;

/**
 * Whether the next classic sync of `sourceId` must visit the typed nested metafiles already in its tree: the brain runs
 * `typed` and the source has not finished a sync under it (an upgrade, or `off` flipped back), since a Git delta never
 * names a file that did not change.
 */
export async function metafileBackfillDue(engine: Pick<BrainEngine, 'getConfig'>, sourceId: string, mode: MetafilePagesMode): Promise<boolean> {
  if (mode !== 'typed') return false;
  try { return (await engine.getConfig(appliedKey(sourceId))) !== mode; } catch { return false; }
}

/** Records the mode a classic sync of `sourceId` just advanced under (written with its bookmark). */
export async function recordMetafilePagesApplied(engine: Pick<BrainEngine, 'getConfig' | 'setConfig'>, sourceId: string, mode: MetafilePagesMode): Promise<void> {
  if ((await engine.getConfig(appliedKey(sourceId))) !== mode) await engine.setConfig(appliedKey(sourceId), mode);
}
