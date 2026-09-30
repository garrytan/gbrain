/**
 * File identity decisions for importFromContent: frontmatter.id dedup and
 * slug collisions. Pure reads; the importer applies the decision.
 */

import { existsSync, realpathSync } from 'fs';
import { basename, resolve, sep } from 'path';
import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import { slugifyPath } from './sync.ts';

export interface ImportIdentityInput {
  sourceId: string;
  slug: string;
  hash: string;
  /** The page text; a row written outside the importer carries a different hash for the same text. */
  body: { title: string; compiled_truth: string; timeline: string };
  frontmatterId: string | null;
  /** Repo-relative path and the directory it is relative to, when importing a file. */
  sourcePath?: string;
  sourceRoot?: string;
}

export type ImportIdentityDecision =
  | { kind: 'none' }
  | { kind: 'move'; dupSlug: string; dupSourcePath: string }
  | { kind: 'duplicate'; dupSlug: string }
  | { kind: 'shared_id'; dupSlug: string }
  | { kind: 'shared_hash'; dupSlug: string };

/**
 * Identity-based cross-slug dedup (#1309, overlapping ingest roots): find
 * another page with this content_hash or external frontmatter.id.
 *
 *   - move: the id matches and the other page's own origin proves it moved
 *     (see hasMoveEvidence). The importer renames the row in place (page id,
 *     links, facts and timeline survive) and imports the new content onto it,
 *     so a full sync's delete-reconcile has nothing live to remove.
 *   - duplicate: the id matches and so does the content (hash, or title and
 *     body for a row written outside the importer) while the recorded file
 *     still exists (or no file is known). The importer skips.
 *   - shared_id: the id matches but the content differs. Templates and
 *     copy-paste reuse ids, so both pages index; an edit is never frozen.
 *   - shared_hash: same text, different identity. Both pages index.
 *
 * Content-only callers (put_page, transcripts) pass no sourceRoot, so they
 * never move a page. A lookup error fails closed.
 */
export async function decideImportIdentity(engine: BrainEngine, input: ImportIdentityInput): Promise<ImportIdentityDecision> {
  if (!engine.findDuplicatePage) return { kind: 'none' };
  let dup: { slug: string; id: number } | null;
  try {
    dup = await engine.findDuplicatePage(input.sourceId, { hash: input.hash, frontmatterId: input.frontmatterId, excludeSlug: input.slug });
  } catch (err) {
    throw new Error(
      `[import] dedup pre-check failed for ${input.sourcePath ?? input.slug}: ` +
      `${(err as Error).message}. Re-run import after DB recovery.`
    );
  }
  if (!dup) return { kind: 'none' };
  const dupPage = await engine.getPage(dup.slug, { sourceId: input.sourceId });
  const dupFmId = (dupPage?.frontmatter as Record<string, unknown> | undefined)?.id;
  const sameExternalId = input.frontmatterId !== null && dupFmId === input.frontmatterId;
  if (!sameExternalId) return { kind: 'shared_hash', dupSlug: dup.slug };
  const sameContent = dupPage?.content_hash === input.hash || (!!dupPage && dupPage.title === input.body.title
    && dupPage.compiled_truth === input.body.compiled_truth && (dupPage.timeline ?? '') === input.body.timeline);
  const dupSourcePath = dupPage?.source_path ?? null;
  if (dupPage && dupSourcePath !== null && input.sourceRoot !== undefined && input.sourcePath !== undefined && dupSourcePath !== input.sourcePath
    && await hasMoveEvidence(engine, input.sourceId, dupPage, dupSourcePath, input.sourceRoot, input.sourcePath, sameContent, input.body.title)) {
    return { kind: 'move', dupSlug: dup.slug, dupSourcePath };
  }
  return sameContent ? { kind: 'duplicate', dupSlug: dup.slug } : { kind: 'shared_id', dupSlug: dup.slug };
}

/**
 * Move evidence is bound to the filesystem root the other page was imported
 * from (#5675), never to this import's root: a path that is missing under a
 * different root proves nothing.
 *
 *   - Its origin still exists: a move only when it is this very file, reached
 *     through another relative path (overlapping import roots converge).
 *   - Its origin is gone: this file must live under that same root. Differing
 *     content also needs continuity (the same file name or the same title), so
 *     a new note that reuses a deleted note's template id stays its own page.
 */
async function hasMoveEvidence(engine: BrainEngine, sourceId: string, dup: Page, dupSourcePath: string,
  sourceRoot: string, sourcePath: string, sameContent: boolean, title: string): Promise<boolean> {
  const origin = await recordedOrigin(engine, sourceId, dup, dupSourcePath);
  const incoming = pathUnderRoot(sourceRoot, sourcePath);
  if (!origin || !incoming) return false;
  if (existsSync(origin.file)) return canonicalPath(origin.file) === canonicalPath(incoming);
  if (canonicalPath(origin.root) !== canonicalPath(sourceRoot)) return false;
  return sameContent || basename(dupSourcePath) === basename(sourcePath) || dup.title === title;
}

/**
 * The root and file a page was imported from: the `file://` origin
 * importFromFile records in `source_uri`, else the source's configured root
 * (`local_path`, or the legacy `sync.repo_path` anchor of the default source).
 * Null when neither is known.
 */
async function recordedOrigin(engine: BrainEngine, sourceId: string, page: Page, sourcePath: string): Promise<{ root: string; file: string } | null> {
  if (page.source_uri?.startsWith(FILE_URI)) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalizes the file:// origin importFromFile recorded; it is only compared with other paths and accepted when rejoining the relative path under the derived root lands on it
    const file = resolve(page.source_uri.slice(FILE_URI.length));
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- walks up from the recorded origin by the depth of its own relative path; the result is only accepted when rejoining the relative path lands on the same file
    const root = resolve(file, ...sourcePath.split(/[\\/]/).map(() => '..'));
    if (pathUnderRoot(root, sourcePath) === file) return { root, file };
  }
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  const configured = source?.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  if (!configured) return null;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the operator's configured source root (sources.local_path or sync.repo_path); every probe under it goes through pathUnderRoot confinement
  const root = resolve(configured);
  const file = pathUnderRoot(root, sourcePath);
  return file ? { root, file } : null;
}

const FILE_URI = 'file://';

/**
 * The `source_uri` recording where a file import came from, so a later import
 * can bind move inference to it. Non-file provenance (a capture URI, a message
 * id) is never replaced.
 */
export function fileOriginUri(existingUri: string | null | undefined, sourceRoot: string | undefined, sourcePath: string | undefined): string | null {
  if (sourceRoot === undefined || sourcePath === undefined || (existingUri && !existingUri.startsWith(FILE_URI))) return null;
  const file = pathUnderRoot(sourceRoot, sourcePath);
  return file ? FILE_URI + file : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalizes an already-derived path for equality comparison only; nothing is read or written through it
    return resolve(path);
  }
}

/**
 * The live file that already owns `slug`, when it is not the file being
 * imported. Two files that slugify to one slug (`notes/Foo Bar.md`,
 * `notes/foo-bar.md`) would otherwise overwrite each other on every edit. The
 * file named exactly like the slug owns it (the file the link extractor reads
 * for that slug); otherwise the current owner keeps it. An owner path that is
 * gone, or resolves to the same file (a case-only rename on a case-insensitive
 * filesystem), is no collision.
 */
export function collidingSlugOwner(existing: Pick<Page, 'source_path' | 'deleted_at'> | null, slug: string,
  sourceRoot: string | undefined, sourcePath: string | undefined): string | null {
  const owner = existing?.source_path;
  if (!owner || existing?.deleted_at || sourceRoot === undefined || sourcePath === undefined) return null;
  if (owner === sourcePath || sourcePath === `${slug}.md` || slugifyPath(owner) !== slug) return null;
  const ownerFile = pathUnderRoot(sourceRoot, owner);
  const candidateFile = pathUnderRoot(sourceRoot, sourcePath);
  if (ownerFile === null || candidateFile === null) return null;
  try {
    return realpathSync.native(ownerFile) !== realpathSync.native(candidateFile) ? owner : null;
  } catch {
    return null;
  }
}

/**
 * A repo-relative path joined to its (absolute, normalized) import root, or
 * null when it would escape the root.
 */
function pathUnderRoot(root: string, relativePath: string): string | null {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the joined path is checked to stay inside `root` on the next line before any filesystem probe, and it is only ever used for existsSync/realpath, never read or written
  const full = resolve(root, relativePath);
  return full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null;
}
