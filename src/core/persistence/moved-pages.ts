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
 *      is `both_changed`.
 * Exactly one live page of the source may descend from the blob; two or more are `several_candidates`, and a moved page that
 * another old page with the same content also claims is `shared_survivor`. A first commit counts only between the old path's add and its deletion. The file name
 * only explains a result with no candidate (a move can rename the file too), and a frontmatter `id` alone never pairs
 * two pages. A page stored in segments (over 1 MiB) is `segmented_versions`: its versions name body generations of their
 * own page, so they cannot move to another. Pages whose readers, folder rules or privacy label differ are `access_differs`: a
 * fold would put the old page's database-only evidence under the moved page's access. A history too shallow to read the move, or one Git cannot answer, keeps the page held and says so.
 */
import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { syncGit } from './sync-discovery.ts';
import { readDeletionProvenance, type DeletionProvenance } from './sync-origin-evidence.ts';
import { fileMatchesSnapshot } from './page-prepare.ts';
import { twinMergeConflicts } from './twin-merge.ts';
import { literalPathspecs } from '../git-env.ts';
import { privateSnapshotFilterFragment } from '../search/private-visibility.ts';

export interface MovedPageRef { page_id: number; slug: string; revision: string; path: string }
export type MovedEvidence = 'same_commit' | 'first_commit';
export const MOVED_HELD_REASONS = ['not_moved', 'several_candidates', 'shared_survivor', 'both_changed', 'first_blob_differs', 'same_id_body_differs', 'evidence_conflicts',
  'segmented_versions', 'access_differs', 'history_shallow', 'history_unknown', 'deletion_not_committed'] as const;
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

/** Paths (relative to `root`) whose first commit in HEAD's history added them with `blob`, with that commit, and every path a commit deleted holding `blob`. */
function firstCommitPaths(root: string, blob: string): { first: Map<string, string>; deleted: Set<string> } | null {
  const out = git(root, ['log', '--no-renames', '--relative', '--raw', '--no-abbrev', '--format=commit %H', `--find-object=${blob}`, 'HEAD']);
  if (out === null) return null;
  const added = new Map<string, string>(), deleted = new Set<string>();
  let commit = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7).trim(); continue; }
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) A\t(.+)$/.exec(line);
    if (match && match[1] === blob && !match[2]!.startsWith('"')) added.set(match[2]!, commit);
    const gone = /^:\d+ \d+ ([0-9a-f]+) [0-9a-f]+ D\t(.+)$/.exec(line);
    if (gone && gone[1] === blob && !gone[2]!.startsWith('"')) deleted.add(gone[2]!);
  }
  const first = new Map<string, string>();
  for (const [path, commitOf] of added) {
    const history = git(root, ['log', '--no-renames', '--relative', '--diff-filter=A', '--format=%H', '--reverse', 'HEAD', '--', ...literalPathspecs([path])]);
    if (history === null) return null;
    if (history.split('\n').find(Boolean)?.trim() === commitOf) first.set(path, commitOf);
  }
  return { first, deleted };
}

/** Of `paths`, those HEAD still holds (relative to `root`). */
function inHead(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const out = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...literalPathspecs(paths)]);
  return new Set((out ?? '').split('\0').filter(Boolean));
}

/**
 * The verdict for one ghost page (`old`: its id, slug, revision and recorded path, relative to the source's canonical
 * root). `provenance` is the path's deletion provenance when the caller already read it (one history walk per window).
 */
export async function readMovedPage(engine: BrainEngine, input: { sourceId: string; root: string; old: MovedPageRef; provenance?: DeletionProvenance }): Promise<MovedPageVerdict> {
  const { sourceId, root, old } = input;
  const held = (reason: MovedHeldReason, detail: string, candidates?: string[]): MovedPageVerdict => ({ verdict: 'held', reason, detail, ...(candidates ? { candidates } : {}) });
  const deletion = input.provenance ?? (await readDeletionProvenance(root, [old.path])).get(old.path) ?? { kind: 'unknown' as const };
  if (deletion.kind !== 'deleted_by_commit') {
    if (shallow(root)) return held('history_shallow', `the checkout's history is shallow, so the commit that deleted ${old.path} cannot be read; fetch the full history (git fetch --unshallow) to check whether it moved`);
    if (deletion.kind === 'unknown') return held('history_unknown', `Git could not name the commit that deleted ${old.path}, so no move can be proven`);
    return held('deletion_not_committed', deletion.kind === 'never_committed' ? `no commit ever held ${old.path}, so there is no committed content to follow`
      : `HEAD still holds ${old.path}; only the working tree lost it, so it did not move in Git`);
  }
  const commit = deletion.commit;
  const blob = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^:./${old.path}`])?.trim();
  if (!blob) return shallow(root) ? held('history_shallow', `the checkout's history is shallow, so ${old.path}'s content before commit ${short(commit)} cannot be read; fetch the full history (git fetch --unshallow) to check whether it moved`)
    : held('history_unknown', `Git could not read ${old.path} before commit ${short(commit)}, which deleted it`);
  const same = sameCommitPaths(root, commit, blob);
  const first = firstCommitPaths(root, blob);
  const added = git(root, ['log', '--no-renames', '--relative', '--diff-filter=A', '--format=%H', '-1', `${commit}^`, '--', ...literalPathspecs([old.path])])?.trim();
  if (same === null || first === null || !added) return held('history_unknown', `Git could not read which paths took ${old.path}'s content (blob ${short(blob)})`);
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
    if (named.length) return held('first_blob_differs', `${named.map(row => row.source_path).join(', ')} has the same file name, but neither its first committed content nor its content in commit ${short(commit)} is ${old.path}'s last committed content (blob ${short(blob)}), so it is not proven to be the moved file`,
      named.map(row => row.slug));
    const [own] = await engine.executeRaw<{ id: string | null }>('SELECT frontmatter->>\'id\' AS id FROM pages WHERE id=$1', [old.page_id]);
    const twins = own?.id ? await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND frontmatter->>'id'=$3 ORDER BY slug LIMIT 5`,
      [sourceId, old.page_id, own.id]) : [];
    if (twins.length) return held('same_id_body_differs', `${twins.map(row => row.slug).join(', ')} has the same frontmatter id, but no page started from ${old.path}'s last committed content (blob ${short(blob)}), so the bodies differ and a fold would drop one side's edits`,
      twins.map(row => row.slug));
    return held('not_moved', `no live page of the source started from ${old.path}'s last committed content (blob ${short(blob)}), so commit ${short(commit)} deleted it rather than moving it`);
  }
  const row = rows[0]!;
  const gone = [...first.deleted].filter(path => path !== old.path);
  const back = inHead(root, gone);
  const others = gone.length ? await engine.executeRaw<{ source_path: string }>(`SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2
    AND source_path=ANY($3::text[]) ORDER BY source_path`, [sourceId, old.page_id, gone.filter(path => !back.has(path))]) : [];
  if (others.length) return held('shared_survivor', `${[old.path, ...others.map(other => other.source_path)].join(', ')} were deleted holding the same content (blob ${short(blob)}) and each still backs a live page, so which of them moved to ${row.source_path} is a person's decision`, [row.slug]);
  const [storage] = await engine.executeRaw<{ segmented: boolean }>(`SELECT EXISTS (SELECT 1 FROM pages WHERE id=$1 AND body_storage<>'inline')
    OR EXISTS (SELECT 1 FROM page_versions WHERE page_id=$1 AND body_storage<>'inline') AS segmented`, [old.page_id]);
  if (storage?.segmented) return held('segmented_versions', `${old.path} moved to ${row.source_path}, but page ${old.slug} or one of its saved versions is stored in segments (over 1 MiB), whose body generations belong to ${old.slug} and cannot move to ${row.slug}, so it stays as it is`, [row.slug]);
  const access = await engine.executeRaw<{ id: number; readers: unknown; folder: unknown; readable_by: unknown; world: boolean }>(`SELECT p.id, p.page_readers AS readers, p.folder_rule_ids AS folder,
    p.frontmatter->'readable_by' AS readable_by, ${privateSnapshotFilterFragment('p')} AS world FROM pages p WHERE p.id=ANY($1::int[])`, [[old.page_id, Number(row.id)]]);
  const key = (id: number) => { const page = access.find(entry => Number(entry.id) === id); return page ? JSON.stringify([page.readers, page.folder, page.readable_by, page.world]) : null; };
  if (key(old.page_id) !== key(Number(row.id))) return held('access_differs', `${old.path} moved to ${row.source_path}, but the two pages differ in who may read them (readers, folder rules or privacy label), so a fold would put ${old.slug}'s database-only evidence under ${row.slug}'s access; decide with the user`, [row.slug]);
  const survivor: MovedPageRef = { page_id: Number(row.id), slug: row.slug, revision: String(row.revision), path: row.source_path };
  const proof = evidence.get(row.source_path)!;
  const snapshot = await engine.readPageSnapshot(old.slug, { sourceId });
  const content = git(root, ['cat-file', 'blob', blob]);
  if (!snapshot || content === null) return held('history_unknown', `the page or blob ${short(blob)} could not be read`);
  if (!await fileMatchesSnapshot(engine, old.slug, content, snapshot, old.path).catch(() => false)) {
    return held('both_changed', `${old.path} moved to ${row.source_path} (blob ${short(blob)}), but page ${old.slug} changed in the database after the move, so a fold would drop its edit; decide with the user`, [row.slug]);
  }
  const conflicts = await twinMergeConflicts(engine, survivor.page_id, old.page_id);
  if (conflicts.length) return held('evidence_conflicts', `${old.path} moved to ${row.source_path}, but page ${old.slug} holds ${conflicts.map(c => c.detail).join('; ')}, which a fold would discard`, [row.slug]);
  return { verdict: 'moved', survivor, old_blob: blob, move_commit: commit, evidence: proof.evidence, evidence_commit: proof.commit,
    detail: `moved to ${row.slug}: ${proof.evidence === 'same_commit' ? `commit ${short(commit)} deleted ${old.path} and gave ${row.source_path} its content`
      : `${row.source_path}'s first commit ${short(proof.commit)} holds ${old.path}'s last committed content`} (blob ${short(blob)}), and page ${old.slug} still holds that content` };
}
