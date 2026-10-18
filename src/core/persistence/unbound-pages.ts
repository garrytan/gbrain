/**
 * Database-only pages and their slug-derived canonical path (fix wave 3,
 * #5254 collision resolution). A page written while its source had no
 * canonical owner is stored without a recorded origin: no `source_path` and no
 * `source_uri`. After the source is bound, a canonical file can appear at the
 * page's slug-derived path; `gbrain sources reconcile` then previews both sides
 * against that path instead of refusing for want of a recorded origin.
 *
 * `isDatabaseOnlyPage` is the one predicate reconcile consults. It requires
 * the durable page-level marker (`pages.database_only_reason='unbound_source'`,
 * stamped in the publication transaction), so an ordinary page that merely
 * lacks a recorded origin is never matched to a slug-derived file.
 */
import { readdirSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { scannerSourcePath } from '../write-through.ts';
import { resolveSlugForPath } from '../sync.ts';

export function isDatabaseOnlyPage(page: { source_path?: string | null; source_uri?: string | null; database_only_reason?: string | null }): boolean {
  return page.database_only_reason === 'unbound_source' && !page.source_path?.trim() && !page.source_uri?.trim();
}

/** `isDatabaseOnlyPage` as a SQL predicate over the `pages` row aliased `alias` (#6536: doctor counts with it). */
export function databaseOnlyPageSql(alias: string): string {
  const blank = (column: string) => `COALESCE(btrim(${alias}.${column}, E' \\t\\n\\r\\f\\v'), '')=''`;
  return `${alias}.database_only_reason IS NOT DISTINCT FROM 'unbound_source' AND ${blank('source_path')} AND ${blank('source_uri')}`;
}

/**
 * The canonical file an import would give this slug (`<slug>.md` under the Git
 * root or the source root, per the source's slug-root mode) and the
 * `source_path` a scan of that file records. Null when it resolves outside the
 * source, or when a scan of the candidate would give it a different slug (a
 * legacy source-relative fallback in a Git subfolder source names another page).
 *
 * #6670: the importer lowercases a file's path into its slug, so `HEARTBEAT.md`
 * is page `heartbeat`. When no file is spelled exactly `<slug>.md`, the slug's
 * directory chain is read case-insensitively per segment (ordinary directories
 * and `.md`/`.mdx` files only, never symlinks) for files a scan maps to this
 * slug, and the result is the on-disk spelling, on case-insensitive filesystems
 * too. One match is the origin; several refuse `source_changed` with detail
 * `slug_path_ambiguous`, naming each; none keeps the expected path (the caller
 * reports it missing).
 */
export function slugDerivedOrigin(root: string, slug: string, mode: 'git-root' | 'source-root'): { path: string; sourcePath: string } | null {
  const path = resolveSourceLocalFilePath(root, `${slug}.md`, slug, mode);
  if (!path) return null;
  const sourcePath = scannerSourcePath(root, path, mode);
  if (resolveSlugForPath(sourcePath) !== slug) return null;
  const base = resolve(root), segments = relative(base, path).split(sep);
  if (segments[0] === '..' || isAbsolute(segments.join(sep))) return { path, sourcePath };
  let dirs = [base];
  for (const segment of segments.slice(0, -1)) {
    dirs = dirs.flatMap(dir => entries(dir).filter(entry => entry.isDirectory() && entry.name.toLowerCase() === segment.toLowerCase()).map(entry => join(dir, entry.name)));
  }
  const files = dirs.flatMap(dir => entries(dir).filter(entry => entry.isFile() && /\.mdx?$/i.test(entry.name)).map(entry => join(dir, entry.name)));
  if (files.includes(path)) return { path, sourcePath };
  const matches = files.map(file => ({ path: file, sourcePath: scannerSourcePath(root, file, mode) })).filter(file => resolveSlugForPath(file.sourcePath) === slug);
  if (matches.length > 1) {
    throw opError('source_changed', `Several files map to page ${slug}; none is spelled exactly ${basename(path)}.`,
      `Files ${matches.map(file => file.sourcePath).join(', ')} all import as ${slug}, so none can be adopted as its canonical file and nothing changed. `
        + 'Ask the user which one is the page\'s file; rename or remove the others, commit, then preview again.', { detail: 'slug_path_ambiguous' });
  }
  return matches[0] ?? { path, sourcePath };
}

function entries(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
