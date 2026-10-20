/**
 * #6712 PR 4b: a level's origin domain (the page claiming each origin and every claimant of a shared one, the domain,
 * the spelling twins and the attestation walk), built from every page, or patched at the origins a taken confirm round
 * re-read (sync-pass.ts `readShadowLevel`, `narrowGate`).
 *
 * A confirm round at the previous round's tree holds the previous round's `I⋈P` with the pages the pass wrote re-read into
 * their slots (a rewritten page in its own slot, a new page last; sync-pass.ts `confirmPages`). Only those slots changed,
 * so only the origins they named before and name now can claim differently: each is claimed again from its rows, in row
 * order, by `claimOrigins`' own rule, and the domain, the twins and the attestation walk are updated at those origins and
 * at the marker paths. What the patch leaves is what a full build at this round gives (the narrowing probe).
 */
import { resolveSlugForPath } from '../sync.ts';
import { isWindowsColonTarget } from './native-file-target.ts';
import type { GitTreeEntry } from './sync-git-stream.ts';
import type { PageTable } from './sync-pass.ts';
import type { LoopYield } from './sync-yield.ts';

/** What a committed-mode round leaves for the next round at the same tree (`PassLevelCache.domain`). */
export interface LevelDomainCache {
  treeKey: string;
  /** The `I⋈P` table it was built from: a confirm round re-reads into this same object. */
  table: PageTable;
  byOrigin: Map<string, number>; claimants: Map<string, number[]>;
  /** The domain, and the paths in it only a marker brought. */
  domain: Set<string>; markerOnly: string[];
  /** Claimed origins that count for no reconcilable page (a tombstone, or outside the level). */
  unreconciled: Set<string>;
  /** Domain paths that are not their own case and separator fold (spelling-twin candidates). */
  unfolded: Set<string>;
  /** The attestation walk: origins whose page needs the baseline tree, and whose page needs a proof read (`A`). */
  baselineWanted: Set<string>; unproven: Set<string>;
}

export interface DomainInput {
  pages: PageTable; tree: Map<string, GitTreeEntry>; keyOf: (row: number) => string; inLevel: (path: string) => boolean;
  /** Working mode's untracked and index paths (none in committed mode). */
  extra: Iterable<string>;
  markerPaths: readonly string[];
  isFile: (path: string) => boolean; originOf: (gitPath: string) => string; step: LoopYield;
  /** A taken confirm round at the cached tree: the cache and what the re-read replaced. */
  prior?: { cache: LevelDomainCache; changed: { rewritten: Array<{ slot: number; sourcePath: string; slug: string }>; from: number }; oldKey: (sourcePath: string, slug: string) => string };
}

export interface LevelDomain extends LevelDomainCache {
  twins: Set<string>; twinGroups: string[][];
  /** Patched: the origins claimed again and the marker paths of both rounds (what the classification looks at again). */
  touched: Set<string> | null;
}

const fold = (path: string) => path.replaceAll('\\', '/').toLowerCase();
const claimBeats = (pages: PageTable, row: number, win: number | undefined) =>
  win === undefined || (pages.deleted(win) && !pages.deleted(row)) || (pages.deleted(win) === pages.deleted(row) && Number(pages.id[row]) > Number(pages.id[win]));
/** A record naming the tree's blob keeps the tree's copy of its id: a converged 600k level holds one string per blob. */
const shareBlob = (pages: PageTable, row: number, tree: Map<string, GitTreeEntry>, key: string) => {
  const committed = pages.hasRecord(row) && tree.get(key);
  if (committed && pages.blobOid[row] === committed.oid) pages.blobOid[row] = committed.oid;
};

/**
 * The page claiming each origin (keyed by `keyOf`): the live one first, else the newest tombstone; and every page recording
 * an origin that more than one page records (#6517), in row order, so the level can name an ambiguous origin.
 */
async function claimOrigins(pages: PageTable, keyOf: (row: number) => string, tree: Map<string, GitTreeEntry>, step: LoopYield) {
  const byOrigin = new Map<string, number>(), claimants = new Map<string, number[]>();
  for (let row = 0; row < pages.length; row++) {
    if (step.due()) await step.pause();
    if (isWindowsColonTarget(pages.sourcePath[row]!)) continue;
    const key = keyOf(row);
    const prior = byOrigin.get(key);
    if (prior !== undefined) { const all = claimants.get(key); if (all) all.push(row); else claimants.set(key, [prior, row]); }
    if (claimBeats(pages, row, prior)) byOrigin.set(key, row);
    shareBlob(pages, row, tree, key);
  }
  return { byOrigin, claimants };
}

/** What the next round at `treeKey` patches (`PassLevelCache.domain`): the domain without this round's twins and touched origins. */
export function domainCache(domain: LevelDomain, treeKey: string): LevelDomainCache {
  const { twins: _twins, twinGroups: _groups, touched: _touched, ...cache } = domain;
  return { ...cache, treeKey };
}

export async function levelDomain(input: DomainInput): Promise<LevelDomain> {
  return input.prior ? patchedDomain(input, input.prior) : fullDomain(input);
}

async function fullDomain(input: DomainInput): Promise<LevelDomain> {
  const { pages, tree, inLevel, step } = input;
  const { byOrigin, claimants } = await claimOrigins(pages, input.keyOf, tree, step);
  const domain = new Set<string>(), unreconciled = new Set<string>(), markerOnly: string[] = [];
  for (const path of tree.keys()) { domain.add(path); if (step.due()) await step.pause(); }
  for (const path of input.extra) domain.add(path);
  for (const [path, i] of byOrigin) {
    if (step.due()) await step.pause();
    if (!inLevel(path)) { unreconciled.add(path); continue; }
    domain.add(path);
    if (pages.deleted(i)) unreconciled.add(path);
  }
  for (const path of input.markerPaths) if (inLevel(path) && !domain.has(path)) { domain.add(path); markerOnly.push(path); }
  const unfolded = new Set<string>();
  for (const path of domain) { if (step.due()) await step.pause(); if (fold(path) !== path) unfolded.add(path); }
  const cache = { treeKey: '', table: pages, byOrigin, claimants, domain, markerOnly, unreconciled, unfolded, baselineWanted: new Set<string>(), unproven: new Set<string>() };
  return { ...cache, ...await spellingTwins(input, cache), touched: null };
}

async function patchedDomain(input: DomainInput, prior: NonNullable<DomainInput['prior']>): Promise<LevelDomain> {
  const { pages, tree, inLevel } = input, { cache, changed } = prior, { byOrigin, claimants, domain } = cache;
  const slots = new Map<number, string | null>(), touched = new Set<string>();
  for (const row of changed.rewritten) if (!isWindowsColonTarget(row.sourcePath)) touched.add(prior.oldKey(row.sourcePath, row.slug));
  for (const row of changed.rewritten) slots.set(row.slot, null);
  for (let i = changed.from; i < pages.length; i++) slots.set(i, null);
  for (const slot of slots.keys()) if (!isWindowsColonTarget(pages.sourcePath[slot]!)) { const key = input.keyOf(slot); slots.set(slot, key); touched.add(key); }
  for (const key of touched) {
    const rows = (claimants.get(key) ?? (byOrigin.has(key) ? [byOrigin.get(key)!] : [])).filter(row => !slots.has(row));
    for (const [slot, now] of slots) if (now === key) rows.push(slot);
    rows.sort((a, b) => a - b);
    let win: number | undefined;
    for (const row of rows) if (claimBeats(pages, row, win)) win = row;
    if (win === undefined) byOrigin.delete(key); else byOrigin.set(key, win);
    if (rows.length > 1) claimants.set(key, rows); else claimants.delete(key);
  }
  for (const [slot, key] of slots) if (key !== null) shareBlob(pages, slot, tree, key);
  for (const path of cache.markerOnly) { domain.delete(path); touched.add(path); }
  for (const key of touched) {
    const at = byOrigin.get(key), claimed = at !== undefined && inLevel(key);
    if (tree.has(key) || claimed) domain.add(key); else domain.delete(key);
    if (at === undefined || (claimed && !pages.deleted(at))) cache.unreconciled.delete(key); else cache.unreconciled.add(key);
  }
  const markerOnly: string[] = [];
  for (const path of input.markerPaths) if (inLevel(path) && !domain.has(path)) { domain.add(path); markerOnly.push(path); }
  for (const path of markerOnly) touched.add(path);
  for (const path of touched) if (domain.has(path) && fold(path) !== path) cache.unfolded.add(path); else cache.unfolded.delete(path);
  const next = { ...cache, table: pages, markerOnly };
  return { ...next, ...await spellingTwins(input, next), touched };
}

/**
 * The attestation walk over the claimed origins (every one built in full, the touched ones patched): whose page needs the
 * baseline tree, and whose page needs a proof read (`A`); the rows to read, and whether the baseline tree is wanted.
 */
export async function walkAttestations(domain: LevelDomain, attest: (path: string, row: number) => { baseline: boolean; unproven: boolean }, step: LoopYield) {
  const keys: Iterable<string> = domain.touched ?? domain.byOrigin.keys();
  for (const key of keys) {
    if (step.due()) await step.pause();
    domain.baselineWanted.delete(key); domain.unproven.delete(key);
    const at = domain.byOrigin.get(key);
    if (at === undefined) continue;
    const verdict = attest(key, at);
    if (verdict.baseline) domain.baselineWanted.add(key);
    if (verdict.unproven) domain.unproven.add(key);
  }
  return { rows: [...domain.unproven].map(key => domain.byOrigin.get(key)!), wantBaseline: domain.baselineWanted.size > 0 };
}

/**
 * Spellings of one origin that differ only by case or separator. Files at L count (`isFile`), and so does a live page's
 * separator-spelled origin. Only a path that is not its own fold can bring a fold in (`unfolded`); the fold's spellings
 * are those paths and the fold itself. As discovery does, only spellings that name one page are twins: a live origin's page
 * slug, else the slug its path names.
 */
async function spellingTwins(input: DomainInput, domain: Pick<LevelDomainCache, 'byOrigin' | 'domain' | 'unfolded'>) {
  const { pages } = input;
  const live = (path: string) => { const at = domain.byOrigin.get(path); return at !== undefined && !pages.deleted(at) ? at : undefined; };
  const spelled = (path: string) => { const at = live(path); return input.isFile(path) || (at !== undefined && pages.sourcePath[at]!.includes('\\')); };
  const folds = new Set<string>();
  for (const path of domain.unfolded) { if (input.step.due()) await input.step.pause(); if (spelled(path)) folds.add(fold(path)); }
  const twins = new Set<string>(), twinGroups: string[][] = [];
  if (!folds.size) return { twins, twinGroups };
  const spellings = new Map<string, string[]>();
  for (const path of [...domain.unfolded, ...[...folds].filter(own => domain.domain.has(own))]) {
    const folded = fold(path);
    if (!folds.has(folded) || !spelled(path)) continue;
    const prior = spellings.get(folded);
    if (prior) prior.push(path); else spellings.set(folded, [path]);
  }
  for (const paths of spellings.values()) {
    if (paths.length < 2) continue;
    const slugOf = (path: string) => { const at = live(path); return at !== undefined ? pages.slug[at]! : resolveSlugForPath(input.originOf(path)); };
    const bySlug = new Map<string, string[]>();
    for (const path of paths) bySlug.set(slugOf(path), [...bySlug.get(slugOf(path)) ?? [], path]);
    for (const group of bySlug.values()) if (group.length > 1) { twinGroups.push(group); for (const path of group) twins.add(path); }
  }
  return { twins, twinGroups };
}

/**
 * A patched round's classification walk in the domain's sorted order: the previous round's entries, each kept as it is,
 * with the paths to classify again in their places: `again` within the domain, and each entry `keep` refuses. `again`
 * holds every path that may have left or joined the domain, so every other entry's path is still in it.
 */
export function narrowedWalk<T extends { path: string }>(prior: readonly T[], domain: Set<string>, again: Set<string>, keep: (entry: T) => boolean): Array<string | T> {
  const fresh = [...again].filter(path => domain.has(path)).sort(), walk: Array<string | T> = [];
  let j = 0;
  for (const entry of prior) {
    while (j < fresh.length && fresh[j]! < entry.path) walk.push(fresh[j++]!);
    if (fresh[j] === entry.path) { walk.push(fresh[j++]!); continue; }
    if (!again.has(entry.path)) walk.push(keep(entry) ? entry : entry.path);
  }
  while (j < fresh.length) walk.push(fresh[j++]!);
  return walk;
}
