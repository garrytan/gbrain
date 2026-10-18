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
 *
 * The same admission refuses a new identity whose file name no supported
 * platform can store (GBRA-130 B-5, B-12: a Windows reserved device name such
 * as `companies/aux`, or a segment over the 240-byte file-name budget;
 * portable-slug.ts), naming the portable slug to write instead. A live page
 * already holding such a slug keeps accepting updates with an advisory, and a
 * replayed request never reaches this check.
 */
import type { BrainEngine } from '../engine.ts';
import type { ContentRefusal } from '../import-screen.ts';
import { opError, type OperationContext, type OperationError } from '../ops/contract.ts';
import { opTransport, readFix } from '../ops/op-fix.ts';
import { slugPortabilityProblem, type SlugPortabilityProblem } from '../portable-slug.ts';

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

function portabilityRefusal(ctx: OperationContext, slug: string, problem: SlugPortabilityProblem): OperationError {
  const cli = opTransport(ctx) === 'cli';
  const what = problem.reason === 'reserved_name' ? `"${problem.segment}" is a name Windows reserves for a device`
    : `"${problem.segment.slice(0, 24)}…" is longer than the 240-byte file-name budget`;
  return opError('invalid_params', `New page slugs must be portable file names: ${what}.`,
    cli ? `Write the page as ${problem.suggestion}: gbrain put ${problem.suggestion}`
      : `Call put_page again with slug "${problem.suggestion}" and the same content.`, {
      detail: 'slug_not_portable',
      why: 'Each slug segment becomes a file or directory name on disk and in exports, and that name cannot be stored on every supported platform.',
      fix: {
        ...readFix('Checks whether the portable slug already holds a page before writing it there.',
          { argv: ['gbrain', 'get', problem.suggestion], mcp: { tool: 'get_page', arguments: { slug: problem.suggestion } } }),
        verify: { argv: ['gbrain', 'get', problem.suggestion], mcp: { tool: 'get_page', arguments: { slug: problem.suggestion } } },
      },
    });
}

/**
 * Refuses a new suffixed or unportable slug; for a live exact-identity page
 * returns the advisory to attach to the response. Null for every other slug.
 */
export function suffixedSlugAdmission(ctx: OperationContext, slug: string, liveExactRow: boolean): string | null {
  const bare = bareSlugOf(slug);
  const problem = slugPortabilityProblem(bare ?? slug);
  if (bare === null && problem === null) return null;
  if (!liveExactRow) throw bare !== null ? refusal(ctx, bare) : portabilityRefusal(ctx, slug, problem!);
  const target = problem?.suggestion ?? bare!;
  const why = bare !== null ? 'ends in .md, which new pages cannot use' : 'is not a portable file name, which new pages need';
  return `This page's slug ${why}. To move it, put_page its content under "${target}", then delete_page "${slug}".`;
}


async function liveExactRow(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return !!snapshot && !snapshot.page.deleted_at;
}

/** Dry-run form: reads the exact `(source_id, slug)` row itself. */
export async function suffixedSlugDryRun(ctx: OperationContext, sourceId: string, slug: string): Promise<void> {
  const bare = bareSlugOf(slug);
  if (bare === null && slugPortabilityProblem(slug) === null) return;
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
