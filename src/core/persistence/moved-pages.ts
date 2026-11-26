/**
 * GST-2584: whether a live page whose file is gone (a ghost, held `file_gone` on a managed source) is a file that moved,
 * and to which page. Sync follows a move only when it happens; when the old page's deletion was held, the new path
 * imported as a fresh page and nothing pairs the two again. `gbrain repair file-drift` lists such a page `moved_to`
 * and `gbrain repair moved-pages` folds it into the moved page; both read this one verdict.
 *
 * The proof that loses nothing is two facts, read from Git and the page, never from today's content of the moved file:
 *   1. the move: the old path's last committed blob (at the first parent of the commit that deleted it) is the blob a new
 *      path took in that same commit, or the blob of the first commit that holds the new path. A Git rename with identical
 *      content is the first case; later edits to the moved file do not matter;
 *   2. the stale side is untouched: the old page still holds what that blob imports (`fileMatchesSnapshot`, which reads
 *      gbrain's own database-only artefacts as derived: `alignWithStored`). A page edited in the database after the move
 *      is `both_changed`. A path the deleting commit rewrote (it held other content before) pairs only once its page holds
 *      every line of the old page, else `survivor_differs`; a path it added again after an earlier deletion, whose page may
 *      be an older page sync still holds, pairs only once that page holds every line, the type, the tags and the frontmatter
 *      (`holdsEveryLine`).
 * Exactly one live page of the source may descend from the blob; two or more are `several_candidates`, and a moved page that
 * another old page with the same content also claims is `shared_survivor`. A first commit counts only between the old path's add and its deletion. The file name
 * only explains a result with no candidate (a move can rename the file too), and a frontmatter `id` alone never pairs
 * two pages. A page stored in segments (over 1 MiB) is `segmented_versions`: its versions name body generations of their
 * own page, so they cannot move to another. Pages whose readers, folder rules or privacy label differ are `access_differs`: a
 * fold would put the old page's database-only evidence under the moved page's access. A history too shallow to read the move, or one Git cannot answer, keeps the page held and says so.
 *
 * A move that changed the file is also proven when it loses nothing: the deleting commit renamed the old path (Git's rename
 * detection) or a single live page has the same file name and Git first added it after the old path's add and no later than
 * its deletion,
 * and that page holds every line of the old page's body and of its timeline, in order, its type, its tags and every
 * frontmatter key but slug and title (`contained`). A page edited in the database after a
 * proven move folds the same way when the moved page holds that edit. Two old pages with the same content still never pair
 * with an older or later copy: a blob alone proves only the strict move above.
 */
import { basename } from 'node:path';
import { bodyUnread } from '../page-body/page-shape.ts';
import type { BrainEngine } from '../engine.ts';
import { syncGit } from './sync-discovery.ts';
import { readDeletionProvenance, type DeletionProvenance } from './sync-origin-evidence.ts';
import { fileMatchesSnapshot } from './page-prepare.ts';
import { twinMergeConflicts } from './twin-merge.ts';
import { literalPathspecs } from '../git-env.ts';
import { privateSnapshotFilterFragment } from '../search/private-visibility.ts';

export interface MovedPageRef { page_id: number; slug: string; revision: string; path: string }
export type MovedEvidence = 'same_commit' | 'first_commit' | 'renamed_contained' | 'named_contained';
export const MOVED_HELD_REASONS = ['not_moved', 'several_candidates', 'shared_survivor', 'both_changed', 'first_blob_differs', 'same_id_body_differs', 'evidence_conflicts',
  'segmented_versions', 'access_differs', 'history_shallow', 'history_unknown', 'deletion_not_committed', 'survivor_differs'] as const;
export type MovedHeldReason = typeof MOVED_HELD_REASONS[number];
export type MovedPageVerdict =
  | { verdict: 'moved'; survivor: MovedPageRef; old_blob: string; move_commit: string; evidence: MovedEvidence; evidence_commit: string; detail: string }
  | { verdict: 'held'; reason: MovedHeldReason; detail: string; candidates?: string[] };

const git = (root: string, args: string[]): string | null => { try { return syncGit(root, args); } catch { return null; } };
const shallow = (root: string) => git(root, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true';
const short = (sha: string) => sha.slice(0, 12);

/** Paths (relative to `root`) that took `blob` in `commit` itself (added or changed to it there). */
function sameCommitPaths(root: string, commit: string, blob: string): string[] | null {
  const out = git(root, ['diff-tree', '-r', '--no-renames', '--no-commit-id', '--relative', '-z', `${commit}^`, commit]);
  if (out === null) return null;
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, , , next, status] = fields[i]!.split(' ');
    if (next === blob && status !== 'D') paths.push(fields[i + 1]!);
  }
  return paths;
}

/**
 * Each entry of a `git log --raw -z` walk (paths relative to `root`) with the commit that made it and whether that commit
 * is a merge; a merge lists entries only when `args` ask for its diff (`--diff-merges`). Null when Git could not read it.
 */
function rawLog(root: string, args: string[]): Array<{ commit: string; merge: boolean; mode: string; old: string; next: string; status: string; path: string }> | null {
  const out = git(root, ['log', '--no-renames', '--relative', '--raw', '--no-abbrev', '-z', '--format=commit %H %P', ...args]);
  if (out === null) return null;
  const fields = out.split('\0'), entries: Array<{ commit: string; merge: boolean; mode: string; old: string; next: string; status: string; path: string }> = [];
  let commit = '', merge = false;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!.replace(/^\n+/, '');
    if (field.startsWith('commit ')) { const [sha, ...parents] = field.slice(7).trim().split(' '); commit = sha!; merge = parents.length > 1; }
    else if (field.startsWith(':')) { const [, mode, old, next, status] = field.split(' '); entries.push({ commit, merge, mode: mode!, old: old!, next: next!, status: status!, path: fields[++i]! }); }
  }
  return entries;
}

const PATHSPEC_BATCH = 500;
/**
 * Per path, the oldest commit that added it in HEAD's history as one path-limited `git log` reads it (merges simplified).
 * One full-history walk per 500 paths finds every add; a path added once has that add, and only a path added more than
 * once is read again on its own, since a merge can hide one of its adds. Null when Git could not read it.
 */
function firstAdds(root: string, paths: string[]): Map<string, string> | null {
  const adds = new Map<string, string[]>();
  for (let at = 0; at < paths.length; at += PATHSPEC_BATCH) {
    const entries = rawLog(root, ['--full-history', '--diff-filter=A', 'HEAD', '--', ...literalPathspecs(paths.slice(at, at + PATHSPEC_BATCH))]);
    if (entries === null) return null;
    for (const entry of entries) { const list = adds.get(entry.path); if (list) list.push(entry.commit); else adds.set(entry.path, [entry.commit]); }
  }
  const first = new Map<string, string>();
  for (const [path, commits] of adds) {
    if (commits.length === 1) { first.set(path, commits[0]!); continue; }
    const own = git(root, ['log', '--no-renames', '--relative', '--diff-filter=A', '--format=%H', 'HEAD', '--', ...literalPathspecs([path])]);
    if (own === null) return null;
    const oldest = own.trim().split('\n').filter(Boolean).pop();
    if (oldest) first.set(path, oldest);
  }
  return first;
}

/**
 * What HEAD's history holds for one blob: each path a commit added with it, with the oldest such commit (`added`), those
 * whose first add is that commit (`first`), each path a commit rewrote to it (`written`: changed to it, a symlink replaced
 * by it included, and each path a merge commit rewrote or added with it against its first parent) and each path a commit
 * deleted holding it (`deleted`).
 */
export interface BlobHistory { added: Map<string, string>; first: Map<string, string>; written: Set<string>; deleted: Set<string> }

/** The history of each of `blobs`: one walk for all of them, then one first-add read for the paths they were added at. Null when Git could not read it. */
export function readBlobHistory(root: string, blobs: string[]): Map<string, BlobHistory> | null {
  const history = new Map<string, BlobHistory>(blobs.map(blob => [blob, { added: new Map(), first: new Map(), written: new Set(), deleted: new Set() }]));
  if (!blobs.length) return history;
  const entries = rawLog(root, ['--diff-merges=first-parent', ...blobs.map(blob => `--find-object=${blob}`), 'HEAD']);
  if (entries === null) return null;
  for (const entry of entries) {
    const written = entry.status === 'M' || (entry.status === 'T' && entry.mode.startsWith('100'));
    if (entry.merge) { if (written || entry.status === 'A') history.get(entry.next)?.written.add(entry.path); continue; }
    if (entry.status === 'A') history.get(entry.next)?.added.set(entry.path, entry.commit);
    if (written) history.get(entry.next)?.written.add(entry.path);
    if (entry.status === 'D') history.get(entry.old)?.deleted.add(entry.path);
  }
  const firsts = firstAdds(root, [...new Set([...history.values()].flatMap(blob => [...blob.added.keys()]))]);
  if (firsts === null) return null;
  for (const blob of history.values()) for (const [path, commit] of blob.added) if (firsts.get(path) === commit) blob.first.set(path, commit);
  return history;
}

/** Of `paths`, those HEAD still holds (relative to `root`). */
function inHead(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const out = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...literalPathspecs(paths)]);
  return new Set((out ?? '').split('\0').filter(Boolean));
}

/** What makes a file in HEAD look like where a ghost's file went (GST-3623 class a). */
export type MoveMatch = 'git_rename' | 'commit_copy' | 'same_blob' | 'first_blob' | 'same_file_name';
/** A file in HEAD that looks like where a ghost went; `page_id`, `slug` and `revision` are null when sync has not imported it yet. */
export interface MoveCandidate { match: MoveMatch; page_id: number | null; slug: string | null; revision: string | null; path: string; linked?: boolean | null }
/** Per ghost page id, the candidates found; `unread` names the ghosts whose history or HEAD listing Git could not read; `history` is the ghosts' blob history. */
export interface MoveCandidates { found: Map<number, MoveCandidate[]>; unread: Set<number>; history: Map<string, BlobHistory> }

/**
 * Per deleted path, the path its deleting commit renamed it to and its last committed blob, and per blob the paths the
 * commit wrote it to in place of what they held (one diff-tree per commit).
 */
function commitChanges(root: string, commit: string): { renames: Map<string, string>; blobs: Map<string, string>; written: Map<string, string[]> } | null {
  const out = git(root, ['diff-tree', '-r', '-M', '--no-commit-id', '--relative', '-z', `${commit}^`, commit]);
  if (out === null) return null;
  const fields = out.split('\0');
  const renames = new Map<string, string>(), blobs = new Map<string, string>(), written = new Map<string, string[]>();
  for (let i = 0; i < fields.length - 1;) {
    const [, mode, old, next, status] = fields[i]!.split(' ');
    const from = fields[i + 1]!;
    if (status?.startsWith('R') || status?.startsWith('C')) {
      if (status.startsWith('R')) { renames.set(from, fields[i + 2]!); blobs.set(from, old!); }
      i += 3;
      continue;
    }
    if (status === 'D') blobs.set(from, old!);
    if (status === 'M' || (status === 'T' && mode?.startsWith('100'))) { const list = written.get(next!); if (list) list.push(from); else written.set(next!, [from]); }
    i += 2;
  }
  return { renames, blobs, written };
}

/** Same-name files linked to a ghost are read for at most this many paths per ghost; past it, their linkage is unknown (`linked` null), so the ghost is kept. */
const SAME_NAME_LINK_LIMIT = 5;

/**
 * Whether Git links a path whose first add is `at` (`firstAdds`) to the old file: that add comes after the old path's add
 * (`added`, never the same commit) and no later than the deleting commit. Null when Git could not answer.
 */
function linkedByHistory(root: string, at: string | undefined, added: string | null, commit: string): boolean | null {
  if (!added || !at) return null;
  if (at === added) return false;
  const after = git(root, ['merge-base', added, at])?.trim(), before = git(root, ['merge-base', at, commit])?.trim();
  if (!after || !before) return null;
  return after === added && before === at;
}

/**
 * For each ghost whose file a commit deleted, the files in HEAD that look like where it went, with their live page when
 * sync imported one (`page_id` null: not imported yet): the path the deleting commit renamed it to, a path that commit or an
 * earlier one rewrote to its last committed blob in place of what that path held, a path holding that blob or whose first commit added it, or a path with
 * the same file name (`linked` when Git first added it between the old file's add and its deletion). Evidence, not proof: `readMovedPage` decides whether a fold loses nothing.
 * Read once per call: one HEAD listing, one diff-tree per deleting commit, one history walk for the ghosts' blobs (handed on
 * as `history`, so `readMovedPage` never walks it again), one first-add read for the paths they hold and one for same-name
 * files, and one page query. A ghost whose reads failed is `unread`, never "no candidate".
 */
export async function readMoveCandidates(engine: BrainEngine, input: { sourceId: string; root: string; ghosts: ReadonlyArray<{ page_id: number; path: string; deletion: DeletionProvenance }> }): Promise<MoveCandidates> {
  const result: MoveCandidates = { found: new Map(), unread: new Set(), history: new Map() };
  const deleted = input.ghosts.filter((ghost): ghost is typeof ghost & { deletion: { kind: 'deleted_by_commit'; commit: string } } => ghost.deletion.kind === 'deleted_by_commit');
  if (!deleted.length) return result;
  const unread = () => { for (const ghost of deleted) result.unread.add(ghost.page_id); return result; };
  const listing = git(input.root, ['ls-tree', '-r', '-z', 'HEAD']);
  if (listing === null) return unread();
  const byBlob = new Map<string, string[]>(), byName = new Map<string, string[]>(), head = new Set<string>();
  const push = (map: Map<string, string[]>, key: string, value: string) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    head.add(path);
    push(byBlob, entry.slice(0, tab).split(' ')[2]!, path);
    push(byName, basename(path), path);
  }
  const changes = new Map<string, ReturnType<typeof commitChanges>>();
  for (const commit of new Set(deleted.map(ghost => ghost.deletion.commit))) changes.set(commit, commitChanges(input.root, commit));
  const blobOf = (ghost: typeof deleted[number]) => changes.get(ghost.deletion.commit)?.blobs.get(ghost.path) ?? '';
  const history = readBlobHistory(input.root, [...new Set(deleted.map(blobOf).filter(Boolean))]);
  if (history === null) return unread();
  result.history = history;
  const firsts = (ghost: typeof deleted[number]) => [...history.get(blobOf(ghost))?.added.keys() ?? []];
  const named = (ghost: typeof deleted[number]) => (byName.get(basename(ghost.path)) ?? []).filter(path => path !== ghost.path);
  const paths = [...new Set(deleted.flatMap(ghost => [changes.get(ghost.deletion.commit)?.renames.get(ghost.path) ?? '', ...(changes.get(ghost.deletion.commit)?.written.get(blobOf(ghost)) ?? []), ...(history.get(blobOf(ghost))?.written ?? []), ...(byBlob.get(blobOf(ghost)) ?? []),
    ...firsts(ghost), ...named(ghost)].filter(path => path && head.has(path))))];
  const pages = paths.length ? await engine.executeRaw<{ id: number; slug: string; revision: string; source_path: string }>(`SELECT id, slug, knowledge_revision::text AS revision, source_path FROM pages
    WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[])`, [input.sourceId, paths]) : [];
  const byPath = new Map(pages.map(page => [page.source_path, { id: Number(page.id), slug: page.slug, revision: String(page.revision) }]));
  const add = (ghost: typeof deleted[number], found: MoveCandidate[], match: MoveMatch, path: string | undefined, linked?: boolean | null) => {
    if (!path || path === ghost.path || !head.has(path) || found.some(candidate => candidate.path === path)) return;
    const page = byPath.get(path);
    if (page?.id === ghost.page_id) return;
    found.push({ match, page_id: page?.id ?? null, slug: page?.slug ?? null, revision: page?.revision ?? null, path, ...(linked === undefined ? {} : { linked }) });
  };
  const reads: Array<{ ghost: typeof deleted[number]; found: MoveCandidate[]; sameName: string[] }> = [];
  for (const ghost of deleted) {
    const change = changes.get(ghost.deletion.commit);
    if (!change) { result.unread.add(ghost.page_id); continue; }
    const found: MoveCandidate[] = [];
    add(ghost, found, 'git_rename', change.renames.get(ghost.path));
    for (const path of [...change.written.get(blobOf(ghost)) ?? [], ...history.get(blobOf(ghost))?.written ?? []]) add(ghost, found, 'commit_copy', path);
    for (const path of byBlob.get(blobOf(ghost)) ?? []) add(ghost, found, 'same_blob', path);
    for (const path of firsts(ghost)) add(ghost, found, 'first_blob', path);
    reads.push({ ghost, found, sameName: named(ghost).filter(path => !found.some(candidate => candidate.path === path)) });
  }
  const linkable = [...new Set(reads.flatMap(read => read.sameName.length <= SAME_NAME_LINK_LIMIT ? read.sameName : []))];
  const links = linkable.length ? firstAdds(input.root, linkable) : null;
  for (const { ghost, found, sameName } of reads) {
    if (sameName.length) {
      const readable = sameName.length <= SAME_NAME_LINK_LIMIT;
      const added = readable ? git(input.root, ['log', '--no-renames', '--relative', '--diff-filter=A', '--format=%H', '-1', `${ghost.deletion.commit}^`, '--', ...literalPathspecs([ghost.path])])?.trim() || null : null;
      for (const path of sameName) add(ghost, found, 'same_file_name', path, readable ? linkedByHistory(input.root, links?.get(path), added, ghost.deletion.commit) : null);
    }
    if (found.length) result.found.set(ghost.page_id, found);
  }
  return result;
}

const nonBlank = (text: string | null | undefined) => (text ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean);
const bodyLines = (page: { compiled_truth: string; timeline?: string | null }) => ({ truth: nonBlank(page.compiled_truth), dated: nonBlank(page.timeline) });
/** Whether `held` holds every line of `lines` in the same order (repeated lines included). */
function inOrder(lines: string[], held: string[]): boolean {
  let at = 0;
  for (const line of lines) {
    while (at < held.length && held[at] !== line) at++;
    if (at++ >= held.length) return false;
  }
  return true;
}

/**
 * Whether `target` holds every line of `old`'s body and of its timeline, each in order in the same region, its type, its
 * tags and every frontmatter key but slug and title (`bodyOnly`: the lines alone). A segmented page (body unread) never matches.
 */
async function holdsEveryLine(engine: BrainEngine, sourceId: string, oldSlug: string, targetSlug: string, opts: { bodyOnly?: boolean } = {}): Promise<boolean> {
  const [old, target] = await Promise.all([engine.readPageSnapshot(oldSlug, { sourceId }), engine.readPageSnapshot(targetSlug, { sourceId })]);
  if (!old || !target || bodyUnread(old.page) || bodyUnread(target.page) || (!opts.bodyOnly && old.page.type !== target.page.type)) return false;
  const lines = bodyLines(old.page), held = bodyLines(target.page);
  if (!lines.truth.length && !lines.dated.length) return false;
  if (!inOrder(lines.truth, held.truth) || !inOrder(lines.dated, held.dated)) return false;
  if (opts.bodyOnly) return true;
  const [oldTags, targetTags] = await Promise.all([engine.getTags(oldSlug, { sourceId }), engine.getTags(targetSlug, { sourceId })]);
  if (oldTags.some(tag => !targetTags.includes(tag))) return false;
  const theirs = (target.page.frontmatter ?? {}) as Record<string, unknown>;
  return Object.entries((old.page.frontmatter ?? {}) as Record<string, unknown>).every(([key, value]) => key === 'slug' || key === 'title' || JSON.stringify(value) === JSON.stringify(theirs[key]));
}

/** A held verdict when the pair cannot fold whatever the proof: segmented versions, or access that differs. */
async function pairRefusal(engine: BrainEngine, old: MovedPageRef, row: { id: number; slug: string; source_path: string },
  held: (reason: MovedHeldReason, detail: string, candidates?: string[]) => MovedPageVerdict): Promise<MovedPageVerdict | null> {
  const [storage] = await engine.executeRaw<{ segmented: boolean }>(`SELECT EXISTS (SELECT 1 FROM pages WHERE id=$1 AND body_storage<>'inline')
    OR EXISTS (SELECT 1 FROM page_versions WHERE page_id=$1 AND body_storage<>'inline') AS segmented`, [old.page_id]);
  if (storage?.segmented) return held('segmented_versions', `${old.path} moved to ${row.source_path}, but page ${old.slug} or one of its saved versions is stored in segments (over 1 MiB), whose body generations belong to ${old.slug} and cannot move to ${row.slug}, so it stays as it is`, [row.slug]);
  const access = await engine.executeRaw<{ id: number; readers: unknown; folder: unknown; readable_by: unknown; world: boolean }>(`SELECT p.id, p.page_readers AS readers, p.folder_rule_ids AS folder,
    p.frontmatter->'readable_by' AS readable_by, ${privateSnapshotFilterFragment('p')} AS world FROM pages p WHERE p.id=ANY($1::int[])`, [[old.page_id, Number(row.id)]]);
  const key = (id: number) => { const page = access.find(entry => Number(entry.id) === id); return page ? JSON.stringify([page.readers, page.folder, page.readable_by, page.world]) : null; };
  if (key(old.page_id) !== key(Number(row.id))) return held('access_differs', `${old.path} moved to ${row.source_path}, but the two pages differ in who may read them (readers, folder rules or privacy label), so a fold would put ${old.slug}'s database-only evidence under ${row.slug}'s access; decide with the user`, [row.slug]);
  return null;
}

/**
 * The contained move of a ghost the strict proof did not pair: the deleting commit renamed its path, or the one same-name
 * live page is linked to it by history (`linked`), and that page holds every line of it. `candidates` are the caller's
 * `readMoveCandidates` result for this ghost when it has one (null: unread). Null keeps the strict verdict.
 */
async function containedMove(engine: BrainEngine, input: { sourceId: string; root: string; old: MovedPageRef; deletion: DeletionProvenance & { kind: 'deleted_by_commit' }; blob: string; candidates?: MoveCandidate[] | null },
  held: (reason: MovedHeldReason, detail: string, candidates?: string[]) => MovedPageVerdict): Promise<MovedPageVerdict | null> {
  const { sourceId, old, deletion } = input;
  const read = input.candidates !== undefined ? input.candidates
    : await readMoveCandidates(engine, { sourceId, root: input.root, ghosts: [{ page_id: old.page_id, path: old.path, deletion }] }).then(all => all.unread.has(old.page_id) ? null : all.found.get(old.page_id) ?? []);
  if (!read) return null;
  const candidates = read.filter(candidate => candidate.match === 'git_rename' || candidate.match === 'same_file_name');
  const renamed = candidates.filter(candidate => candidate.match === 'git_rename');
  const pick = renamed.length ? renamed : candidates;
  if (pick.length !== 1) return null;
  const target = pick[0]!;
  if (target.page_id === null || target.slug === null || target.revision === null || (target.match === 'same_file_name' && target.linked !== true)) return null;
  const row = { id: target.page_id, slug: target.slug, source_path: target.path };
  if (!await holdsEveryLine(engine, sourceId, old.slug, row.slug)) return null;
  const refused = await pairRefusal(engine, old, row, held);
  if (refused) return refused;
  const conflicts = await twinMergeConflicts(engine, Number(row.id), old.page_id);
  if (conflicts.length) return held('evidence_conflicts', `${old.path} moved to ${row.source_path}, but page ${old.slug} holds ${conflicts.map(c => c.detail).join('; ')}, which a fold would discard`, [row.slug]);
  const evidence: MovedEvidence = target.match === 'git_rename' ? 'renamed_contained' : 'named_contained';
  return { verdict: 'moved', survivor: { page_id: row.id, slug: row.slug, revision: target.revision, path: row.source_path }, old_blob: input.blob, move_commit: deletion.commit,
    evidence, evidence_commit: deletion.commit,
    detail: `moved to ${row.slug}: ${evidence === 'renamed_contained' ? `commit ${short(deletion.commit)} renamed ${old.path} to ${row.source_path}` : `${row.source_path} is the one live file named ${basename(old.path)}`}, and page ${row.slug} holds every line of page ${old.slug}` };
}

/**
 * The verdict for one ghost page (`old`: its id, slug, revision and recorded path, relative to the source's canonical
 * root). `provenance` is the path's deletion provenance when the caller already read it (one history walk per window), and
 * `history` the blob history `readMoveCandidates` read for it (one walk per run).
 */
export async function readMovedPage(engine: BrainEngine, input: { sourceId: string; root: string; old: MovedPageRef; provenance?: DeletionProvenance; candidates?: MoveCandidate[] | null; history?: Map<string, BlobHistory> }): Promise<MovedPageVerdict> {
  const { sourceId, root, old } = input;
  const held = (reason: MovedHeldReason, detail: string, candidates?: string[]): MovedPageVerdict => ({ verdict: 'held', reason, detail, ...(candidates ? { candidates } : {}) });
  const deletion = input.provenance ?? (await readDeletionProvenance(root, [old.path])).get(old.path) ?? { kind: 'unknown' as const };
  if (deletion.kind !== 'deleted_by_commit') {
    if (shallow(root)) return held('history_shallow', `the checkout's history is shallow, so the commit that deleted ${old.path} cannot be read; fetch the full history (git fetch --unshallow) to check whether it moved`);
    if (deletion.kind === 'unknown') return held('history_unknown', `Git could not name the commit that deleted ${old.path}, so no move can be proven`);
    return held('deletion_not_committed', deletion.kind === 'never_committed' ? `no commit ever held ${old.path}, so there is no committed content to follow`
      : `HEAD still holds ${old.path}; only the working tree lost it, so it did not move in Git`);
  }
  const commit = deletion.commit, committed = deletion;
  const blob = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^:./${old.path}`])?.trim();
  if (!blob) return shallow(root) ? held('history_shallow', `the checkout's history is shallow, so ${old.path}'s content before commit ${short(commit)} cannot be read; fetch the full history (git fetch --unshallow) to check whether it moved`)
    : held('history_unknown', `Git could not read ${old.path} before commit ${short(commit)}, which deleted it`);
  const same = sameCommitPaths(root, commit, blob);
  const first = input.history?.get(blob) ?? readBlobHistory(root, [blob])?.get(blob) ?? null;
  const added = git(root, ['log', '--no-renames', '--relative', '--diff-filter=A', '--format=%H', '-1', `${commit}^`, '--', ...literalPathspecs([old.path])])?.trim();
  if (same === null || first === null || !added) return held('history_unknown', `Git could not read which paths took ${old.path}'s content (blob ${short(blob)})`);
  const contained = async (verdict: MovedPageVerdict) => await containedMove(engine, { sourceId, root, old, deletion: committed, blob, candidates: input.candidates }, held) ?? verdict;
  const evidence = new Map<string, { evidence: MovedEvidence; commit: string }>();
  for (const [path, at] of first.first) {
    if (path === old.path || at === added) continue;
    const base: string | undefined = git(root, ['merge-base', added, at])?.trim();
    const until: string | undefined = git(root, ['merge-base', at, commit])?.trim();
    if (!base || !until) return held('history_unknown', `Git could not order ${path}'s first commit ${short(at)} against the commits that added and deleted ${old.path}`);
    if (base === added && until === at) evidence.set(path, { evidence: 'first_commit', commit: at });
  }
  for (const path of same) if (path !== old.path) evidence.set(path, { evidence: 'same_commit', commit });
  const present = inHead(root, [...evidence.keys()]);
  const rows = present.size ? await engine.executeRaw<{ id: number; slug: string; revision: string; source_path: string }>(`SELECT id, slug, knowledge_revision::text AS revision, source_path
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND source_path=ANY($3::text[]) ORDER BY id`, [sourceId, old.page_id, [...present]]) : [];
  if (present.size > 1) return held('several_candidates', `${present.size} paths in HEAD (${[...present].sort().join(', ')}) started from ${old.path}'s last committed content (blob ${short(blob)}), so which one it moved to is a person's decision`,
    rows.map(row => row.slug));
  if (!rows.length) {
    const name = basename(old.path);
    const named = await engine.executeRaw<{ slug: string; source_path: string }>(`SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2
      AND source_path IS NOT NULL AND (source_path=$3 OR right(source_path, length($3) + 1)='/' || $3) ORDER BY slug LIMIT 5`, [sourceId, old.page_id, name]);
    if (named.length) return contained(held('first_blob_differs', `${named.map(row => row.source_path).join(', ')} has the same file name, but neither its first committed content nor its content in commit ${short(commit)} is ${old.path}'s last committed content (blob ${short(blob)}), so it is not proven to be the moved file`,
      named.map(row => row.slug)));
    const [own] = await engine.executeRaw<{ id: string | null }>('SELECT frontmatter->>\'id\' AS id FROM pages WHERE id=$1', [old.page_id]);
    const twins = own?.id ? await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND frontmatter->>'id'=$3 ORDER BY slug LIMIT 5`,
      [sourceId, old.page_id, own.id]) : [];
    if (twins.length) return contained(held('same_id_body_differs', `${twins.map(row => row.slug).join(', ')} has the same frontmatter id, but no page started from ${old.path}'s last committed content (blob ${short(blob)}), so the bodies differ and a fold would drop one side's edits`,
      twins.map(row => row.slug)));
    return contained(held('not_moved', `no live page of the source started from ${old.path}'s last committed content (blob ${short(blob)}), so commit ${short(commit)} deleted it rather than moving it`));
  }
  const row = rows[0]!;
  const gone = [...first.deleted].filter(path => path !== old.path);
  const back = inHead(root, gone);
  const others = gone.length ? await engine.executeRaw<{ source_path: string }>(`SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2
    AND source_path=ANY($3::text[]) ORDER BY source_path`, [sourceId, old.page_id, gone.filter(path => !back.has(path))]) : [];
  if (others.length) return held('shared_survivor', `${[old.path, ...others.map(other => other.source_path)].join(', ')} were deleted holding the same content (blob ${short(blob)}) and each still backs a live page, so which of them moved to ${row.source_path} is a person's decision`, [row.slug]);
  const refused = await pairRefusal(engine, old, row, held);
  if (refused) return refused;
  const survivor: MovedPageRef = { page_id: Number(row.id), slug: row.slug, revision: String(row.revision), path: row.source_path };
  const proof = evidence.get(row.source_path)!;
  const snapshot = await engine.readPageSnapshot(old.slug, { sourceId });
  const content = git(root, ['cat-file', 'blob', blob]);
  if (!snapshot || content === null) return held('history_unknown', `the page or blob ${short(blob)} could not be read`);
  const edited = !await fileMatchesSnapshot(engine, old.slug, content, snapshot, old.path).catch(() => false);
  if (edited && !await holdsEveryLine(engine, sourceId, old.slug, row.slug)) {
    return held('both_changed', `${old.path} moved to ${row.source_path} (blob ${short(blob)}), but page ${old.slug} changed in the database after the move, so a fold would drop its edit; decide with the user`, [row.slug]);
  }
  const existed = proof.evidence === 'same_commit' && git(root, ['cat-file', '-e', `${commit}^:./${row.source_path}`]) !== null;
  const readded = proof.evidence === 'same_commit' && !existed && git(root, ['log', '-1', '--format=%H', `${commit}^`, '--', ...literalPathspecs([row.source_path])])?.trim() !== '';
  if ((existed || readded) && !await holdsEveryLine(engine, sourceId, old.slug, row.slug, { bodyOnly: existed })) {
    return held('survivor_differs', `commit ${short(commit)} gave ${row.source_path}, a path with earlier history, ${old.path}'s content (blob ${short(blob)}), but page ${row.slug} does not hold every line of page ${old.slug} (sync has not imported that commit), so a fold would put ${old.slug}'s evidence under a page that never held it; sync ${row.source_path}, then preview again`, [row.slug]);
  }
  const conflicts = await twinMergeConflicts(engine, survivor.page_id, old.page_id);
  if (conflicts.length) return held('evidence_conflicts', `${old.path} moved to ${row.source_path}, but page ${old.slug} holds ${conflicts.map(c => c.detail).join('; ')}, which a fold would discard`, [row.slug]);
  return { verdict: 'moved', survivor, old_blob: blob, move_commit: commit, evidence: proof.evidence, evidence_commit: proof.commit,
    detail: `moved to ${row.slug}: ${proof.evidence === 'same_commit' ? `commit ${short(commit)} deleted ${old.path} and gave ${row.source_path} its content`
      : `${row.source_path}'s first commit ${short(proof.commit)} holds ${old.path}'s last committed content`} (blob ${short(blob)}), and ${edited ? `page ${row.slug} holds every line of page ${old.slug}, including its database edit` : `page ${old.slug} still holds that content`}` };
}
