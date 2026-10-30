/**
 * GBRA-133 wave 4: `T` across the passes of one resident process. A pass at a new commit patches the listing of the
 * commit the last pass read (`readTreeChanges`: one `diff-tree` between the two commits) instead of listing the whole
 * tree again. Only the listing is reused: the pass still judges every path's eligibility, so a selection change needs no
 * key. A commit's tree never changes (Git runs with GIT_NO_REPLACE_OBJECTS), so a listing of `from` patched with the
 * changes from `from` to `to` is the listing of `to`.
 *
 * Fails closed to a whole read: another process starts empty; an entry leaves the cache while a pass uses it and comes
 * back only after that pass walked it whole (a failed or concurrent pass finds none); an entry idle for
 * TREE_REUSE_MAX_AGE_MS is dropped; the key is the source, its incarnation, the Git root and the scope, and an entry kept
 * under the other canonical mode (G3: `config.canonical` flipped since) is dropped; a scope with
 * pathspec magic, a diff larger than a quarter of the tree, a change `readTreeLevel` would not list, and any Git
 * failure read whole. `sync.level_reuse false` turns reuse off (docs/guides/live-sync.md). With
 * GBRAIN_SYNC_LEVEL_REUSE_VERIFY=1 (tests and the nightly freshness cell) every reused listing is compared with a whole
 * read, each check prints one `[level_reuse]` stderr line, and any difference throws.
 */
import { readTreeChanges, readTreeLevel, type GitTreeEntry } from './sync-git-stream.ts';
import type { LoopYield } from './sync-yield.ts';

export const SYNC_LEVEL_REUSE_KEY = 'sync.level_reuse';
/** An entry unused this long is dropped (its tree is the largest thing a resident serve keeps between passes). */
export const TREE_REUSE_MAX_AGE_MS = 10 * 60_000;
/** A diff of more paths than this (and a quarter of the tree) reads the tree whole. */
const TREE_REUSE_MIN_DIFF_BOUND = 2_000;

interface TreeReuseEntry { head: string; canonical?: string; tree: Map<string, GitTreeEntry>; at: number; expiry: ReturnType<typeof setTimeout> }
const entries = new Map<string, TreeReuseEntry>();

/**
 * #7358: the drop timer of a kept value, created here so its callback closes over only `map`, `key` and `value`. A timer made
 * inside the reading function closed over that function's scope (the previous entry and the pass's options, its loop yield
 * and through it the whole pass), and a cleared timer still holds its callback: every pass of a resident process stayed
 * reachable from the newest timer.
 */
function dropWhenIdle<V>(map: Map<string, { value?: unknown; tree?: unknown }>, key: string, field: 'value' | 'tree', value: V): ReturnType<typeof setTimeout> {
  const expiry = setTimeout(() => { if (map.get(key)?.[field] === value) map.delete(key); }, TREE_REUSE_MAX_AGE_MS);
  expiry.unref?.();
  return expiry;
}

export class LevelReuseMismatch extends Error {
  readonly code = 'level_reuse_mismatch';
  constructor(read: string, detail: string) { super(`sync level reuse: the reused ${read} differs from a whole read (${detail})`); this.name = 'LevelReuseMismatch'; }
}

/** Whether `sync.level_reuse` allows reuse: only `false` (or off/0/no) turns it off. */
export const levelReuseAllowed = (value: string | null | undefined): boolean => !/^(?:false|off|0|no)$/i.test(value?.trim() ?? '');

export type TreeReuse = 'read' | 'same' | 'patched';

/**
 * `T` at `head` under `scope`, from the last listing this process kept for `key` when `allowed`; `keep` stores it for the
 * next pass once the caller has walked it (until then the next pass reads whole), and the caller must not change it.
 */
export async function readTreeLevelReusing(gitRoot: string, head: string, scope: string, opts: { key: readonly string[]; canonical?: string; allowed: boolean; shared?: LoopYield }):
  Promise<{ tree: Map<string, GitTreeEntry>; reuse: TreeReuse; keep: () => void }> {
  const key = JSON.stringify([...opts.key, gitRoot, scope]);
  const prior = opts.allowed ? entries.get(key) : undefined;
  if (prior) { clearTimeout(prior.expiry); entries.delete(key); }
  const keep = (tree: Map<string, GitTreeEntry>) => () => { entries.set(key, { head, canonical: opts.canonical, tree, at: Date.now(), expiry: dropWhenIdle(entries, key, 'tree', tree) }); };
  const whole = async () => { const tree = await readTreeLevel(gitRoot, head, scope, opts.shared); return { tree, reuse: 'read' as const, keep: opts.allowed ? keep(tree) : () => {} }; };
  if (!opts.allowed || !prior || prior.canonical !== opts.canonical || Date.now() - prior.at > TREE_REUSE_MAX_AGE_MS || /[\\[*?]|^:/.test(scope)) return whole();
  let reuse: TreeReuse = 'same';
  if (prior.head !== head) {
    const changes = await readTreeChanges(gitRoot, prior.head, head, scope, opts.shared).catch(() => null);
    if (!changes || changes.length > Math.max(TREE_REUSE_MIN_DIFF_BOUND, prior.tree.size / 4)) return whole();
    for (const { path, entry } of changes) { if (entry) prior.tree.set(path, entry); else prior.tree.delete(path); }
    reuse = 'patched';
  }
  if (levelReuseVerify()) {
    const fresh = await readTreeLevel(gitRoot, head, scope, opts.shared);
    reportLevelReuseCheck('T', `${reuse} from ${prior.head} to ${head}`, fresh.size !== prior.tree.size ? `${prior.tree.size} paths, whole read ${fresh.size}`
      : [...fresh].find(([path, entry]) => { const own = prior.tree.get(path); return own?.oid !== entry.oid || own.mode !== entry.mode; })?.[0]);
  }
  return { tree: prior.tree, reuse, keep: keep(prior.tree) };
}

/** Whether every reused level read is compared with a whole read (tests and the nightly oracle cell). */
export const levelReuseVerify = (): boolean => process.env.GBRAIN_SYNC_LEVEL_REUSE_VERIFY === '1';

/** One `[level_reuse]` stderr line per verified read (the nightly oracle counts them); a difference throws. */
export function reportLevelReuseCheck(read: string, how: string, differs: string | null | undefined): void {
  const verdict = differs ? new LevelReuseMismatch(read, `${how}: ${differs}`) : null;
  console.error(verdict ? `[level_reuse] level_reuse_mismatch ${verdict.message}` : `[level_reuse] level_reuse_verified ${read} ${how}`);
  if (verdict) throw verdict;
}

/**
 * `I⋈P` across passes (sync-pass.ts `readRoundSnapshot`): the pages table and mark (S1) of a pass that ended synced, for the next
 * pass's first round to prove and patch (sync-pass-confirm.ts, `across`). Same rules as a listing: taken while used, dropped
 * when unused for TREE_REUSE_MAX_AGE_MS, keyed by source and incarnation.
 */
const passPages = new Map<string, { value: unknown; at: number; expiry: ReturnType<typeof setTimeout> }>();
export function keepPassPages<T extends object>(key: readonly string[], value: T): void {
  const k = JSON.stringify(key);
  const prior = passPages.get(k);
  if (prior) clearTimeout(prior.expiry);
  passPages.set(k, { value, at: Date.now(), expiry: dropWhenIdle(passPages, k, 'value', value) });
}
export function takePassPages<T>(key: readonly string[]): T | undefined {
  const k = JSON.stringify(key), entry = passPages.get(k);
  if (!entry) return undefined;
  clearTimeout(entry.expiry);
  passPages.delete(k);
  return Date.now() - entry.at > TREE_REUSE_MAX_AGE_MS ? undefined : entry.value as T;
}

/** Drops every kept listing and pages table (tests). */
export function __resetTreeReuseForTests(): void {
  for (const entry of [...entries.values(), ...passPages.values()]) clearTimeout(entry.expiry);
  entries.clear();
  passPages.clear();
}
