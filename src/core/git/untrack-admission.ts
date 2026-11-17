/**
 * GST-2519 / GST-2964: which files `gbrain git commit-push --untrack` may remove from Git (#7753), and in a managed
 * canonical worktree whether untracking a code-extension file under a declared storage.db_only dir would delete a page. Sync
 * keeps a page by its slug, and a code file's slug is flattened (`health-backups-a-json`), so on a source whose sync
 * strategy imports code such a page is not database-only and leaves the brain once its file leaves Git. The brain is
 * read only for that question (src/commands/git.ts opens it), only when the untrack names such a file in a managed
 * canonical worktree: no migration, one read-only transaction under a statement timeout, the whole read bounded by
 * `UNTRACK_PAGE_READ_TIMEOUT_MS`.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { literalPathspecs } from '../git-env.ts';
import { git } from './git-run.ts';
import { opError } from '../ops/contract.ts';
import type { ManagedFilesystemRoot } from '../persistence/filesystem-guard.ts';
import { isDeclaredDbOnlySlug, storageConfigFromYaml, unresolvedDbOnlyIn, type StorageConfig } from '../storage-config.ts';
import { isCodeFilePath, isSyncable, resolveSlugForPath } from '../sync.ts';

/** What the brain says about the code-extension files an untrack names; `unreadable` refuses them (fail closed). */
export type UntrackPageVerdict = { importsCode: boolean; live: ReadonlySet<string> } | { unreadable: string };
export interface UntrackPageCandidate { file: string; slug: string; sourcePath: string }

export const UNTRACK_PAGE_READ_TIMEOUT_MS = 10_000;

/** The source's sync strategy and the live pages among `candidates` (by slug or source path), in one read-only transaction. */
export async function readUntrackPageVerdict(engine: BrainEngine, managed: ManagedFilesystemRoot, candidates: UntrackPageCandidate[]): Promise<UntrackPageVerdict> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('statement_timeout', $1, true)", [String(UNTRACK_PAGE_READ_TIMEOUT_MS)]);
    const [source] = await tx.executeRaw<{ id: string; strategy: string | null }>(managed.sourceId
      ? "SELECT id, config->>'strategy' AS strategy FROM sources WHERE id=$1" : "SELECT id, config->>'strategy' AS strategy FROM sources WHERE local_path=$1",
    [managed.sourceId ?? managed.root]);
    if (!source) return { unreadable: `no source in the brain is bound to ${managed.root}` };
    const rows = await tx.executeRaw<{ slug: string; source_path: string | null }>(
      'SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND (slug = ANY($2::text[]) OR source_path = ANY($3::text[]))',
      [source.id, candidates.map(c => c.slug), candidates.map(c => c.sourcePath)]);
    const live = new Set<string>();
    for (const c of candidates) if (rows.some(row => row.slug === c.slug || row.source_path === c.sourcePath)) live.add(c.file);
    return { importsCode: source.strategy === 'code' || source.strategy === 'auto', live };
  }, { readOnly: true });
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
 * GST-2519: the files an untrack in a managed canonical worktree would remove, each under a storage.db_only dir that
 * gbrain.yml at HEAD and on disk declares (the database row is canonical there, so sync keeps the page when its file
 * leaves Git) and ignored by .gitignore (so no later commit adds it back). GST-2964: a file is matched by its path under
 * the declared dir, whatever its extension; a file sync may import as a page (Markdown, code) also needs its slug under a
 * declared dir, since sync keeps a page by slug; a code file is admitted when `pages` (the brain, read by the caller) shows
 * that the source's sync strategy does not import code or that no live page comes from the file. A tracked symlink pointing out of the dir, or a file reached through a
 * symlinked directory on disk, is refused. Anything else refuses `untrack_not_db_only` before the index is touched:
 * untracking any other page file would delete that page at the next sync.
 */
export function untrackAdmitted(root: string, rel: string[], managed: ManagedFilesystemRoot, pages?: UntrackPageVerdict): string[] {
  const files = untrackTargets(root, rel);
  const base = relative(root, managed.root).split(sep).join('/');
  const prefix = base && !base.startsWith('..') ? `${base}/` : '';
  const yml = git(root, ['show', `HEAD:${prefix}gbrain.yml`]);
  let disk: string | null = null;
  try { disk = readFileSync(join(managed.root, 'gbrain.yml'), 'utf8'); } catch { disk = null; }
  const config = (text: string | null, label: string): StorageConfig | null => {
    if (text === null) return null;
    try {
      const parsed = storageConfigFromYaml(text, label);
      return parsed && !unresolvedDbOnlyIn(text, parsed) ? parsed : null;
    } catch { return null; }
  };
  const committed = config(yml.code === 0 ? yml.stdout : null, `HEAD:${prefix}gbrain.yml`), onDisk = config(disk, join(managed.root, 'gbrain.yml'));
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
  const pageKind = (path: string) => isSyncable(path, { strategy: 'markdown', includeHidden: ['**'], metafilePage: () => true });
  const refusals: Record<'undeclared' | 'unignored' | 'link' | 'slug' | 'page' | 'unchecked', string[]> = { undeclared: [], unignored: [], link: [], slug: [], page: [], unchecked: [] };
  const slugs = new Map<string, string>();
  for (const file of files) {
    const path = file.slice(prefix.length);
    const dir = file.startsWith(prefix) && declared(path) ? declaredDir(path) : undefined;
    if (!dir) { refusals.undeclared.push(file); continue; }
    if (escapes(file, dir)) { refusals.link.push(file); continue; }
    if (!ignored.has(file)) { refusals.unignored.push(file); continue; }
    if (isCodeFilePath(path)) {
      if (!pages || 'unreadable' in pages) refusals.unchecked.push(file);
      else if (pages.importsCode && pages.live.has(file)) refusals.page.push(file);
      continue;
    }
    if (!pageKind(path)) continue;
    const slug = resolveSlugForPath(path);
    if (!isDeclaredDbOnlySlug(slug, committed) || !isDeclaredDbOnlySlug(slug, onDisk)) { refusals.slug.push(file); slugs.set(file, slug); }
  }
  const refused = files.filter(file => Object.values(refusals).some(list => list.includes(file)));
  if (!refused.length) return files;
  const list = (paths: string[], label = (p: string) => p) => `${paths.slice(0, 10).map(label).join(', ')}${paths.length > 10 ? ', ...' : ''}`;
  const slugDirs = [...new Set([...slugs.values()].map(slug => `${posix.dirname(slug)}/`))];
  const groups: Array<[string[], string, string]> = [
    [refusals.undeclared, 'not under a storage.db_only dir that gbrain.yml declares both at HEAD and on disk',
      'Declare the folder first: add it under storage.db_only in gbrain.yml and its <dir>/ line to .gitignore, commit both (gbrain git commit-push -m <msg> -- gbrain.yml .gitignore), then rerun the untrack.'],
    [refusals.unignored, 'under a declared storage.db_only dir that .gitignore does not ignore',
      'Add the folder\'s <dir>/ line to .gitignore and commit it (gbrain git commit-push -m <msg> -- .gitignore), then rerun the untrack.'],
    [refusals.link, 'symbolic links pointing out of the declared dir, or reached through a symbolic link on disk',
      'Untrack only real files inside the folder: a symbolic link that leaves it, or a folder reached through a symbolic link, is refused; name the other files, or replace the link with the file it points to.'],
    [refusals.slug, 'page files whose page slug, which sync keeps a page by, falls outside the declared dir',
      `Declare the slug spelling too: add ${slugDirs.join(', ')} under storage.db_only in gbrain.yml and commit it (gbrain git commit-push -m <msg> -- gbrain.yml), then rerun the untrack.`],
    [refusals.page, 'code files that are pages on this source, whose sync strategy imports code, so untracking them would delete the page at the next sync',
      'These files are pages on this source and untracking them would delete the pages at the next sync: a database-only folder does not make a code file\'s page database-only. Keep them tracked and untrack the folder\'s other files by name.'],
    [refusals.unchecked, `code files the brain could not be read to check${pages && 'unreadable' in pages ? ` (${pages.unreadable})` : ''}`,
      'The brain could not be read to check whether these files are pages on this source, so nothing was untracked; retry when it is free.'],
  ];
  const hit = groups.filter(([paths]) => paths.length);
  throw opError('untrack_not_db_only', `${root} is the managed canonical worktree${managed.sourceId ? ` of source ${managed.sourceId}` : ''}, and ${refused.length} file(s) to untrack cannot leave Git as database-only: ${hit.map(([paths, why]) => `${why}: ${list(paths, p => slugs.has(p) ? `${p} (slug ${slugs.get(p)})` : p)}`).join('; ')}. Nothing was untracked.`,
    hit.map(([, , fix]) => fix).join(' '),
    { detail: JSON.stringify({ paths: refused }), docs: 'docs/guides/shared-checkout-git.md#untrack' });
}

/**
 * GST-2964: the code-extension files an untrack in a managed canonical worktree names, each with the slug and source
 * path sync gives it; the caller (src/commands/git.ts) reads the brain about them only when there are any. A path
 * the real run refuses yields none, so that refusal stays the real run's.
 */
export function untrackPageCandidates(root: string, rel: string[], managed: ManagedFilesystemRoot): UntrackPageCandidate[] {
  const base = relative(root, managed.root).split(sep).join('/');
  const prefix = base && !base.startsWith('..') ? `${base}/` : '';
  let files: string[];
  try { files = untrackTargets(root, rel); } catch { return []; }
  return files.filter(file => file.startsWith(prefix) && isCodeFilePath(file.slice(prefix.length)))
    .map(file => ({ file, slug: resolveSlugForPath(file.slice(prefix.length)), sourcePath: file.slice(prefix.length) }));
}
