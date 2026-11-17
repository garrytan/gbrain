/**
 * The markdown tree as extraction reads it (GBRA-133 2b.1): the descent-pruned walk behind `walkMarkdownFiles`, the
 * yielding tree index the sync hooks share per run, and the endpoint page-type lookup they extract links through.
 * Full `foresights extract` keeps its whole-tree page-type parse in extract.ts.
 */
import { readFileSync, readdirSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { parseMarkdown } from '../core/markdown.ts';
import type { LinkExtractionPack } from '../core/link-extraction.ts';
import { pathToSlug, pruneDir, isSyncable, DEFAULT_METAFILE_PAGES_MODE, type MetafilePagesMode } from '../core/sync.ts';
import { diskMetafileHeads, metafilePagePredicate } from '../core/sync-metafile-pages.ts';

/** The walk behind `walkMarkdownFiles`, in its order; yields after each directory it finishes. */
export function* markdownWalk(dir: string, d: string, emit: (file: { path: string; relPath: string }) => void,
  metafilePages: MetafilePagesMode = DEFAULT_METAFILE_PAGES_MODE,
  metafilePage: (path: string) => boolean = metafilePagePredicate(metafilePages, diskMetafileHeads(dir))): Generator<void> {
  for (const entry of readdirSync(d)) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- d is the walk's own directory (the brain root or one of its subdirectories, never a symlink: lstat below) and entry is a directory entry read from it; moved unchanged from extract.ts walkMarkdownFiles
    const full = join(d, entry);
    try {
      const st = lstatSync(full);
      if (st.isDirectory()) {
        // v0.37.7.0 #1169: pass parentDir so pruneDir can detect git
        // submodule pointers (`.git` as a file inside the candidate).
        if (!pruneDir(entry, d)) continue;
        yield* markdownWalk(dir, full, emit, metafilePages, metafilePage);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        const rel = relative(dir, full);
        if (!isSyncable(rel, { strategy: 'markdown', metafilePage })) continue;
        emit({ path: full, relPath: rel });
      }
    } catch { /* skip unreadable */ }
  }
  yield;
}

/** A source tree as the sync hooks read it: `walkMarkdownFiles` entries with their slugs, and `buildSlugPathIndex` of them. */
export interface MarkdownTree { files: Array<{ path: string; relPath: string; slug: string }>; slugToPath: Map<string, string> }

/**
 * GBRA-133 2b.1/2b.3: `walkMarkdownFiles` plus `buildSlugPathIndex` for a sync, the same entries in the same order,
 * yielding to the event loop after each directory, so a resident's commit-triggered sync never holds its event loop
 * for the whole walk (about 0.75 s at 100k files). The sync hooks share one tree per run.
 */
export async function indexMarkdownTree(dir: string, metafilePages: MetafilePagesMode = DEFAULT_METAFILE_PAGES_MODE): Promise<MarkdownTree> {
  const tree: MarkdownTree = { files: [], slugToPath: new Map() };
  const emit = (file: { path: string; relPath: string }) => {
    const slug = pathToSlug(file.relPath);
    tree.files.push({ ...file, slug });
    indexSlugPath(tree.slugToPath, slug, file.relPath);
  };
  for (const _ of markdownWalk(dir, dir, emit, metafilePages)) await new Promise<void>(resolve => setImmediate(resolve));
  return tree;
}

export function indexSlugPath(index: Map<string, string>, slug: string, relPath: string): void {
  if (!index.has(slug) || relPath === `${slug}.md`) index.set(slug, relPath);
}

/** What link extraction reads a page type through: a whole-tree map (full `foresights extract`) or the sync hook's endpoint lookup. */
export type PageTypeLookup = Pick<ReadonlyMap<string, string>, 'get'>;

/**
 * GBRA-133 2b.1: the sync hook's page types, parsed from the files of the link endpoints its pages actually look up
 * instead of from every file in the tree (`loadFsPageTypes`, which full `foresights extract` keeps). `pass` runs the
 * extraction against the lookup; a walked slug it asks for and has no type yet is recorded, its file parsed, and the
 * pass repeated until one asks for nothing new (an answer can make extraction ask for more, e.g. a person target
 * prompts the attendance candidates). Each answer is what `loadFsPageTypes` gives that slug: the parse under the
 * active pack, `unknown` when the file cannot be read, and the last walked file on a slug collision. So the links
 * match the whole-tree parse, held and never-imported targets included, and a pack page-type change applies at once.
 */
export async function withEndpointPageTypes<T>(repoPath: string, tree: MarkdownTree, pack: LinkExtractionPack | null,
  pass: (pageTypes: PageTypeLookup) => Promise<T>): Promise<T> {
  const { files, slugToPath } = tree;
  const lastWalked = slugToPath.size === files.length ? null : new Map(files.map(file => [file.slug, file.relPath]));
  const activePack = pack?.page_types ? { page_types: pack.page_types } : undefined;
  const types = new Map<string, string>();
  for (;;) {
    const missing = new Set<string>();
    const result = await pass({ get: (slug) => {
      const type = types.get(slug);
      if (type === undefined && slugToPath.has(slug)) missing.add(slug);
      return type;
    } });
    if (!missing.size) return result;
    for (const slug of missing) {
      const relPath = lastWalked?.get(slug) ?? slugToPath.get(slug)!;
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- relPath is an entry of the walkMarkdownFiles(repoPath) walk the caller indexed, never caller input
      try { types.set(slug, parseMarkdown(readFileSync(join(repoPath, relPath), 'utf-8'), relPath, { activePack }).type); }
      catch { types.set(slug, 'unknown'); }
    }
  }
}
