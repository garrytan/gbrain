/**
 * put_page admission for slugs that end in `.md`/`.mdx` (#4807, E-D17).
 *
 * A page is stored at `<slug>.md`, so a new `notes/foo.md` page would land on
 * disk as `notes/foo.md.md`: reported as written, invisible to the file the
 * caller meant, and re-imported by sync under the same suffixed slug. A new
 * suffixed slug is refused with the bare slug as the recovery. A live page
 * that already has the exact suffixed `(source_id, slug)` identity (written
 * before this check) stays updatable, so its chunks and deep-research id keep
 * working; the response carries an advisory naming the bare slug and the
 * manual move, since master has no rename operation. A file import that takes
 * its identity from a frontmatter `slug:` follows the same rule through the
 * held-file path; path-derived import slugs, `validateSlug` and every internal
 * stored-identity reader are unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { ContentRefusal } from '../import-screen.ts';
import { opError, type OperationContext, type OperationError } from '../ops/contract.ts';
import { opTransport, readFix } from '../ops/op-fix.ts';

const MARKDOWN_SUFFIX = /(\.mdx?)+$/i;

/** The slug without its trailing markdown extensions, or null when it has none. */
export function bareSlugOf(slug: string): string | null {
  return MARKDOWN_SUFFIX.test(slug) ? slug.replace(MARKDOWN_SUFFIX, '') : null;
}

function refusal(ctx: OperationContext, bare: string): OperationError {
  const cli = opTransport(ctx) === 'cli';
  return opError('invalid_params', 'put_page slugs must not end in .md or .mdx.',
    cli ? `Write the page as ${bare}: gbrain put ${bare} (the .md file name is added for you).`
      : `Call put_page again with slug "${bare}" and the same content (the .md file name is added for you).`, {
      why: 'A page is stored at <slug>.md, so a slug ending in .md would create a second extension on disk (<slug>.md.md) that the intended file never sees.',
      fix: {
        ...readFix('Checks whether the bare slug already holds a page before writing it there.',
          { argv: ['gbrain', 'get', bare], mcp: { tool: 'get_page', arguments: { slug: bare } } }),
        verify: { argv: ['gbrain', 'get', bare], mcp: { tool: 'get_page', arguments: { slug: bare } } },
      },
    });
}

/**
 * Refuses a new suffixed slug; for a live exact-identity page returns the
 * advisory to attach to the response. Null for every other slug.
 */
export function suffixedSlugAdmission(ctx: OperationContext, slug: string, liveExactRow: boolean): string | null {
  const bare = bareSlugOf(slug);
  if (bare === null) return null;
  if (!liveExactRow) throw refusal(ctx, bare);
  return `This page's slug ends in .md, which new pages cannot use. To move it, put_page its content under "${bare}", then delete_page "${slug}".`;
}


async function liveExactRow(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return !!snapshot && !snapshot.page.deleted_at;
}

/** Dry-run form: reads the exact `(source_id, slug)` row itself. */
export async function suffixedSlugDryRun(ctx: OperationContext, sourceId: string, slug: string): Promise<void> {
  if (bareSlugOf(slug) === null) return;
  suffixedSlugAdmission(ctx, slug, await liveExactRow(ctx.engine, sourceId, slug.toLowerCase()));
}

/**
 * The hold for a file import whose frontmatter `slug:` ends in `.md`/`.mdx`
 * and names no live page. The message names the file, never the declared value.
 */
export async function suffixedFrontmatterSlugHold(engine: BrainEngine, sourceId: string | undefined, relativePath: string, slug: string): Promise<ContentRefusal | null> {
  if (bareSlugOf(slug) === null || await liveExactRow(engine, sourceId ?? 'default', slug)) return null;
  return { code: 'frontmatter_slug_conflict', key: 'slug',
    message: `The frontmatter slug of ${relativePath} must not end in .md or .mdx: a page is stored at <slug>.md, so it would create a second extension on disk. Remove the extension from the "slug:" line, or remove the line.` };
}
