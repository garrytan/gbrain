/**
 * GST-2519 / GST-2964: which files `gbrain git commit-push --untrack` may remove from Git (#7753), and in a managed
 * canonical worktree whether untracking a code-extension file under a declared storage.db_only dir would delete a page. Sync
 * keeps a page by its slug, and a code file's slug is flattened (`health-backups-a-json`), so a code file's page (a source
 * whose sync strategy is `code` or `auto` imports one) is not database-only and leaves the brain once its file leaves Git. In a managed
 * canonical worktree every untrack reads the brain (src/commands/git.ts opens it): the source's root, which only the
 * brain records (a source rooted in a folder of its repository is claimed at the repository's top, and sync reads that
 * folder's gbrain.yml), and the code-extension files that are live pages. No migration, one read-only transaction under a
 * statement timeout, the whole read bounded by `UNTRACK_PAGE_READ_TIMEOUT_MS`; without that answer nothing is untracked.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { literalPathspecs } from '../git-env.ts';
import { git } from './git-run.ts';
import { opError } from '../ops/contract.ts';
import { relativeEscapesRoot } from '../path-confine.ts';
import type { ManagedFilesystemRoot } from '../persistence/filesystem-guard.ts';
import { isDeclaredDbOnlySlug, storageConfigFromYaml, unresolvedDbOnlyIn, type StorageConfig } from '../storage-config.ts';
import { isCodeFilePath, isImageFilePath, isSyncable, resolveSlugForPath, type SyncStrategy } from '../sync.ts';

/**
 * What the brain says about an untrack: the source's root, the slug root its sync uses (a source rooted in a folder of its
 * repository keeps slugs from the repository's top in `git-root` mode), the code-extension files the read checked and those
 * that are live pages; `unreadable` refuses every file (fail closed), and a code-extension file the read did not check refuses.
 * A code file counts as checked only when the source's sync has processed it: the sync anchor (`sources.last_commit`, moved
 * only by a finished pass) is on this branch's history, the commit that last changed the file is that anchor or an ancestor
 * of it, and the anchor holds the file's current blob. Otherwise a sync running between this read and the untrack could
 * import the file as a page that the next sync then deletes (`syncNote` says why the anchor did not count). `live` also holds
 * every code file the source's current strategy imports (`code` or `auto`), page or not yet: the last finished sync may have
 * skipped it under another strategy, and the next one imports it.
 */
export type UntrackPageVerdict = { sourceId: string; sourceRoot: string; slugRoot: 'git-root' | 'source-root'; checked: ReadonlySet<string>; live: ReadonlySet<string>;
  syncNote?: string; syncOff?: boolean } | { unreadable: string };
export interface UntrackPageCandidate { file: string; slugs: string[]; sourcePaths: string[] }

export const UNTRACK_PAGE_READ_TIMEOUT_MS = 10_000;

/**
 * The managed source's root (canonical, inside the checkout `root`), its slug root, and the live pages among the
 * code-extension files `rel` names (by slug or source path), in one read-only transaction. A worktree recorded without its
 * source is matched to the one source rooted in it.
 */
export async function readUntrackPageVerdict(engine: BrainEngine, managed: ManagedFilesystemRoot, root: string, rel: string[]): Promise<UntrackPageVerdict> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('statement_timeout', $1, true)", [String(UNTRACK_PAGE_READ_TIMEOUT_MS)]);
    const canonical = (path: string) => { try { return realpathSync(path); } catch { return null; } };
    const top = canonical(root) ?? root, worktree = canonical(managed.root) ?? managed.root;
    const within = (outer: string, path: string) => !relativeEscapesRoot(relative(outer, path));
    const rows = (await tx.executeRaw<{ id: string; local_path: string | null; last_commit: string | null; config: Record<string, unknown> | null }>(managed.sourceId
      ? 'SELECT id, local_path, last_commit, config FROM sources WHERE id=$1' : 'SELECT id, local_path, last_commit, config FROM sources WHERE local_path IS NOT NULL',
    managed.sourceId ? [managed.sourceId] : [])).map(row => ({ ...row, path: row.local_path ? canonical(row.local_path) : null }));
    const matched = managed.sourceId ? rows : rows.filter(row => row.path && within(worktree, row.path));
    if (matched.length !== 1) return { unreadable: managed.sourceId ? `source ${managed.sourceId} is not in the brain` : `${matched.length ? 'more than one source' : 'no source'} in the brain is rooted in ${managed.root}` };
    const source = matched[0]!;
    if (!source.path) return { unreadable: `source ${source.id}'s root ${source.local_path ?? '(none)'} is not a directory on this machine` };
    if (!within(top, source.path)) return { unreadable: `source ${source.id} is rooted at ${source.path}, outside the checkout ${top}` };
    const scope = sourcePrefix(root, source.path);
    const { resolveSlugRootMode } = await import('../sync-anchor.ts');
    const slugRoot = scope ? await resolveSlugRootMode(tx, { sourceId: source.id, explicitGitRoot: false, slugPrefix: resolveSlugForPath(`${scope}x.md`).slice(0, -2), dryRun: true }) : 'git-root';
    const candidates = untrackPageCandidates(root, rel, source.path);
    const pages = candidates.length ? await tx.executeRaw<{ slug: string; source_path: string | null }>(
      'SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND (slug = ANY($2::text[]) OR source_path = ANY($3::text[]))',
      [source.id, candidates.flatMap(c => c.slugs), candidates.flatMap(c => c.sourcePaths)]) : [];
    const live = new Set<string>();
    for (const c of candidates) if (pages.some(row => c.slugs.includes(row.slug) || (row.source_path !== null && c.sourcePaths.includes(row.source_path)))) live.add(c.file);
    const strategy = typeof source.config?.strategy === 'string' ? source.config.strategy : 'markdown';
    for (const c of candidates) if (isSyncable(c.sourcePaths[0]!, { strategy: strategy as SyncStrategy, includeHidden: ['**'], metafilePage: () => true })) live.add(c.file);
    const { syncNote, processed } = syncProcessed(root, source.id, source.last_commit);
    const { isSyncDisabledConfig } = await import('../sync-policy.ts');
    return { sourceId: source.id, sourceRoot: source.path, slugRoot, checked: new Set(candidates.map(c => c.file).filter(processed)), live,
      ...(syncNote ? { syncNote } : {}), ...(isSyncDisabledConfig(source.config) ? { syncOff: true } : {}) };
  }, { readOnly: true });
}

/** Whether the source's sync anchor has processed each file at its HEAD version, and why the anchor does not count when it does not. */
function syncProcessed(root: string, sourceId: string, anchor: string | null): { syncNote?: string; processed: (file: string) => boolean } {
  const never = () => false;
  if (!anchor) return { syncNote: `source ${sourceId} has not finished a sync`, processed: never };
  const commit = (rev: string) => { const r = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]); return r.code === 0 ? r.stdout.trim() : null; };
  const synced = commit(anchor), head = commit('HEAD');
  if (!synced || !head) return { syncNote: `source ${sourceId}'s last sync, ${anchor.slice(0, 12)}, is not a commit in this checkout`, processed: never };
  const ancestor = (a: string, b: string) => git(root, ['merge-base', '--is-ancestor', a, b]).code === 0;
  if (!ancestor(synced, head) && !ancestor(head, synced)) return { syncNote: `source ${sourceId}'s last sync, ${synced.slice(0, 12)}, is not on this branch's history`, processed: never };
  const blob = (rev: string, file: string) => { const r = git(root, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`]); return r.code === 0 ? r.stdout.trim() : null; };
  return { processed: file => {
    const last = git(root, ['rev-list', '-1', head, '--', ...literalPathspecs([file])]).stdout.trim();
    return !!last && ancestor(last, synced) && blob(synced, file) !== null && blob(synced, file) === blob(head, file);
  } };
}

/** The source root's path in the checkout, `<dir>/` or '' at the top. */
function sourcePrefix(root: string, sourceRoot: string): string {
  const base = relative(realpathSync(root), sourceRoot).split(sep).join('/');
  return base && !relativeEscapesRoot(base) ? `${base}/` : '';
}

/** #7753: the files HEAD holds under each of `rel`; a named path HEAD holds nothing under is refused before anything changes. */
export function untrackTargets(root: string, rel: string[]): string[] {
  const out = new Set<string>();
  for (const path of rel) {
    const held = git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...literalPathspecs([path])]).stdout.split('\0').filter(Boolean);
    if (!held.length) {
      throw opError('commit_paths_invalid', `${path} is not tracked: the last commit holds no file there, so nothing was untracked.`,
        'Name files or directories the branch\'s last commit holds (git ls-tree -r --name-only HEAD -- <path> lists them).', { detail: path });
    }
    for (const file of held) out.add(file);
  }
  const sparse = git(root, ['ls-files', '-v', '-z', '--', ...literalPathspecs([...out])]).stdout.split('\0').filter(entry => /^[sS] /.test(entry)).map(entry => entry.slice(2));
  if (sparse.length) {
    const list = `${sparse.slice(0, 10).join(', ')}${sparse.length > 10 ? ', ...' : ''}`;
    throw opError('commit_paths_invalid', `${sparse.length} file(s) to untrack are marked skip-worktree, so git rm --cached would refuse them: ${list}. Nothing was untracked.`,
      `They sit outside of your sparse-checkout definition (or carry the skip-worktree bit). Widen the sparse checkout (git sparse-checkout add <dir>) or clear the bit (git update-index --no-skip-worktree -- <path>), then rerun.`,
      { detail: JSON.stringify({ paths: sparse }) });
  }
  return [...out];
}

/**
 * GST-2519: the files an untrack in a managed canonical worktree would remove, each under a storage.db_only dir that the
 * source's gbrain.yml (in the source root `pages` names, as sync reads it) declares at HEAD and on disk (the database row
 * is canonical there, so sync keeps the page when its file leaves Git) and ignored by .gitignore (so no later commit adds
 * it back). Without the brain's answer (`pages` absent or unreadable) every file refuses. GST-2964: a file is matched by its path under
 * the declared dir, whatever its extension; a file sync may import as a page (Markdown, code) also needs its slug under a
 * declared dir, since sync keeps a page by slug (spelled from the repository's top on a `git-root` source); a code file is
 * admitted when the read checked it and no live page comes from it, whatever the source's sync strategy now is. A tracked symlink pointing out of the dir, or a file reached through a
 * symlinked directory on disk, is refused. Anything else refuses `untrack_not_db_only` before the index is touched:
 * untracking any other page file would delete that page at the next sync.
 */
export function untrackAdmitted(root: string, rel: string[], managed: ManagedFilesystemRoot, pages?: UntrackPageVerdict): string[] {
  const files = untrackTargets(root, rel);
  const source = pages && !('unreadable' in pages) ? pages : null;
  const prefix = source ? sourcePrefix(root, source.sourceRoot) : '';
  const ymlPath = join(source?.sourceRoot ?? root, 'gbrain.yml');
  const yml = git(root, ['show', `HEAD:${prefix}gbrain.yml`]);
  let disk: string | null = null;
  try { disk = readFileSync(ymlPath, 'utf8'); } catch { disk = null; }
  const config = (text: string | null, label: string): StorageConfig | null => {
    if (text === null) return null;
    try {
      const parsed = storageConfigFromYaml(text, label);
      return parsed && !unresolvedDbOnlyIn(text, parsed) ? parsed : null;
    } catch { return null; }
  };
  const committed = config(yml.code === 0 ? yml.stdout : null, `HEAD:${prefix}gbrain.yml`), onDisk = config(disk, ymlPath);
  const declaredDir = (path: string) => committed?.db_only.find(dir => isDeclaredDbOnlySlug(path.toLowerCase(), { ...committed, db_only: [dir] }));
  const declared = (path: string) => isDeclaredDbOnlySlug(path.toLowerCase(), committed) && isDeclaredDbOnlySlug(path.toLowerCase(), onDisk);
  const ignored = new Set(git(root, ['check-ignore', '--no-index', '-z', '--stdin'], { input: files.map(f => `${f}\0`).join('') }).stdout.split('\0').filter(Boolean));
  const links = new Map(git(root, ['ls-tree', '-r', '-z', 'HEAD', '--', ...literalPathspecs(rel)]).stdout.split('\0').filter(Boolean)
    .map(entry => /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(entry)).filter(m => m?.[1] === '120000').map(m => [m![3]!, m![2]!] as const));
  const escapes = (file: string, dir: string): boolean => {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      try { if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) return true; } catch { break; }
    }
    const oid = links.get(file);
    if (!oid) return false;
    const target = git(root, ['cat-file', 'blob', oid]).stdout;
    const resolved = posix.normalize(posix.join(posix.dirname(file.slice(prefix.length)), target));
    return posix.isAbsolute(target) || !resolved.toLowerCase().startsWith(dir.toLowerCase());
  };
  const pageKind = (path: string) => isImageFilePath(path) || isSyncable(path, { strategy: 'markdown', includeHidden: ['**'], metafilePage: () => true });
  const refusals: Record<'undeclared' | 'unignored' | 'link' | 'slug' | 'page' | 'late' | 'unchecked', string[]> = { undeclared: [], unignored: [], link: [], slug: [], page: [], late: [], unchecked: [] };
  const slugs = new Map<string, string>();
  for (const file of files) {
    if (!source) { refusals.unchecked.push(file); continue; }
    const path = file.slice(prefix.length);
    const dir = file.startsWith(prefix) && declared(path) ? declaredDir(path) : undefined;
    if (!dir) { refusals.undeclared.push(file); continue; }
    if (escapes(file, dir)) { refusals.link.push(file); continue; }
    if (!ignored.has(file)) { refusals.unignored.push(file); continue; }
    if (isCodeFilePath(path)) {
      if (source.live.has(file)) refusals.page.push(file);
      else if (!source.checked.has(file)) refusals.late.push(file);
      continue;
    }
    if (!pageKind(path)) continue;
    const slug = resolveSlugForPath(source.slugRoot === 'git-root' ? file : path);
    if (!isDeclaredDbOnlySlug(slug, committed) || !isDeclaredDbOnlySlug(slug, onDisk)) { refusals.slug.push(file); slugs.set(file, slug); }
  }
  const refused = files.filter(file => Object.values(refusals).some(list => list.includes(file)));
  if (!refused.length) return files;
  const list = (paths: string[], label = (p: string) => p) => `${paths.slice(0, 10).map(label).join(', ')}${paths.length > 10 ? ', ...' : ''}`;
  const slugDirs = [...new Set([...slugs.values()].map(slug => `${posix.dirname(slug)}/`))];
  const groups: Array<[string[], string, string]> = [
    [refusals.undeclared, `not under a storage.db_only dir that the source's gbrain.yml declares both at HEAD (HEAD:${prefix}gbrain.yml) and on disk (${ymlPath})`,
      `Declare the folder first: add it under storage.db_only in ${prefix}gbrain.yml and its <dir>/ line to .gitignore, commit both (gbrain git commit-push -m <msg> -- ${prefix}gbrain.yml .gitignore), then rerun the untrack.`],
    [refusals.unignored, 'under a declared storage.db_only dir that .gitignore does not ignore',
      'Add the folder\'s <dir>/ line to .gitignore and commit it (gbrain git commit-push -m <msg> -- .gitignore), then rerun the untrack.'],
    [refusals.link, 'symbolic links pointing out of the declared dir, or reached through a symbolic link on disk',
      'Untrack only real files inside the folder: a symbolic link that leaves it, or a folder reached through a symbolic link, is refused; name the other files, or replace the link with the file it points to.'],
    [refusals.slug, 'page files whose page slug, which sync keeps a page by, falls outside the declared dir',
      `Declare the slug spelling too: add ${slugDirs.join(', ')} under storage.db_only in ${prefix}gbrain.yml and commit it (gbrain git commit-push -m <msg> -- ${prefix}gbrain.yml), then rerun the untrack.`],
    [refusals.page, 'code files that are pages on this source, or that its sync imports as pages (its strategy imports code), so untracking them would delete the page at the next sync',
      'These files are pages on this source, or its sync imports them as pages, and untracking them would delete the pages at the next sync: a database-only folder does not make a code file\'s page database-only. Keep them tracked and untrack the folder\'s other files by name.'],
    [refusals.late, `code files the source's sync has not processed at their current version${source?.syncNote ? ` (${source.syncNote})` : ''}, or that reached the branch after the brain was read`,
      `Sync has not yet decided whether these files are pages, and a sync that imports one after this check would leave a page the next sync deletes, so nothing was untracked. Run gbrain sync --source ${source?.sourceId ?? '<id>'}${source?.syncOff ? ' (automatic sync is off for this source; an explicit sync still runs)' : ''}, then rerun the untrack.`],
    [refusals.unchecked, `files the brain could not be read to check${pages && 'unreadable' in pages ? ` (${pages.unreadable})` : ''}`,
      'The brain could not be read to check whether these files are pages on this source, so nothing was untracked. If another process holds the brain (on PGLite, a running gbrain serve or a sync), stop it, then rerun the untrack; otherwise retry once the brain is reachable.'],
  ];
  const hit = groups.filter(([paths]) => paths.length);
  throw opError('untrack_not_db_only', `${root} is the managed canonical worktree${managed.sourceId ? ` of source ${managed.sourceId}` : ''}, and ${refused.length} file(s) to untrack cannot leave Git as database-only: ${hit.map(([paths, why]) => `${why}: ${list(paths, p => slugs.has(p) ? `${p} (slug ${slugs.get(p)})` : p)}`).join('; ')}. Nothing was untracked.`,
    hit.map(([, , fix]) => fix).join(' '),
    { detail: JSON.stringify({ paths: refused }), docs: 'docs/guides/shared-checkout-git.md#untrack' });
}

/**
 * GST-2964: the code-extension files an untrack in a managed canonical worktree names, each with the slugs and source
 * paths sync may give it under `sourceRoot` (relative to that root, and to the repository's top, which a `git-root` source
 * uses); readUntrackPageVerdict looks up the live pages among them only when there are any.
 * A path the real run refuses yields none, so that refusal stays the real run's.
 */
export function untrackPageCandidates(root: string, rel: string[], sourceRoot: string): UntrackPageCandidate[] {
  const prefix = sourcePrefix(root, sourceRoot);
  let files: string[];
  try { files = untrackTargets(root, rel); } catch { return []; }
  return files.filter(file => file.startsWith(prefix) && isCodeFilePath(file.slice(prefix.length)))
    .map(file => ({ file, slugs: [...new Set([resolveSlugForPath(file.slice(prefix.length)), resolveSlugForPath(file)])], sourcePaths: [...new Set([file.slice(prefix.length), file])] }));
}
