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
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { scannerSourcePath } from '../write-through.ts';
import { resolveSlugForPath } from '../sync.ts';

export function isDatabaseOnlyPage(page: { source_path?: string | null; source_uri?: string | null; database_only_reason?: string | null }): boolean {
  return page.database_only_reason === 'unbound_source' && !page.source_path?.trim() && !page.source_uri?.trim();
}

/**
 * The canonical file an import would give this slug (`<slug>.md` under the Git
 * root or the source root, per the source's slug-root mode) and the
 * `source_path` a scan of that file records. Null when it resolves outside the
 * source, or when a scan of the candidate would give it a different slug (a
 * legacy source-relative fallback in a Git subfolder source names another page).
 */
export function slugDerivedOrigin(root: string, slug: string, mode: 'git-root' | 'source-root'): { path: string; sourcePath: string } | null {
  const path = resolveSourceLocalFilePath(root, `${slug}.md`, slug, mode);
  if (!path) return null;
  const sourcePath = scannerSourcePath(root, path, mode);
  return resolveSlugForPath(sourcePath) === slug ? { path, sourcePath } : null;
}
