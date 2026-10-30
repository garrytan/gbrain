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
 *
 * #7305: put_page and capture also refuse a new slug with a hyphen run or a
 * segment-final hyphen (three hyphens between `notes/x-1900` and `2000-ab`, or `notes/x-`), naming the
 * folded slug (`notes/x-1900-2000-ab`): import and sync derive that folded slug
 * from the file, so the page would keep its identity only through the `slug:`
 * line its file is stamped with (#5966), and a file rewritten without it forks
 * a second page. A live page that already holds the exact slug keeps updating
 * with an advisory, like the rules above; nothing is ever redirected to the
 * folded slug's page.
 */
import type { BrainEngine } from '../engine.ts';
import type { ContentRefusal } from '../import-screen.ts';
import { opError, type OperationContext, type OperationError } from '../ops/contract.ts';
import { opTransport, readFix } from '../ops/op-fix.ts';
import { slugPortabilityProblem, type SlugPortabilityProblem } from '../portable-slug.ts';
import { hyphenFoldedSlug } from '../sync.ts';

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

function hyphenRunRefusal(ctx: OperationContext, operation: SlugAdmissionOperation, folded: string): OperationError {
  const cli = opTransport(ctx) === 'cli';
  return opError('invalid_params', 'New page slugs must not contain a hyphen run or end a segment in a hyphen.',
    cli ? `Write the page as ${folded}: ${operation === 'capture' ? `gbrain capture --slug ${folded}` : `gbrain put ${folded}`}`
      : `Call ${operation} again with slug "${folded}" and the same content.`, {
      detail: 'slug_hyphen_run',
      why: `A page is stored at <slug>.md, and import and sync derive a file's slug with every hyphen run folded to one hyphen, so this file would import as ${folded}. `
        + 'The page would keep its identity only through the slug: line in its file; a copy of the file without that line forks a second page.',
      fix: {
        ...readFix('Checks whether the folded slug already holds a page before writing it there.',
          { argv: ['gbrain', 'get', folded], mcp: { tool: 'get_page', arguments: { slug: folded } } }),
        verify: { argv: ['gbrain', 'get', folded], mcp: { tool: 'get_page', arguments: { slug: folded } } },
      },
    });
}

type SlugAdmissionOperation = 'put_page' | 'capture';

/**
 * Refuses a new slug that is suffixed, unportable (put_page only) or not
 * hyphen-folded (put_page and capture); for a live exact-identity page returns
 * the advisory to attach to the response. Null for every other slug.
 */
export function suffixedSlugAdmission(ctx: OperationContext, slug: string, liveExactRow: boolean, operation: SlugAdmissionOperation = 'put_page'): string | null {
  const bare = operation === 'put_page' ? bareSlugOf(slug) : null;
  const problem = operation === 'put_page' ? slugPortabilityProblem(bare ?? slug) : null;
  const folded = bare === null && problem === null ? hyphenFoldedSlug(slug) : null;
  if (bare === null && problem === null && folded === null) return null;
  if (!liveExactRow) throw bare !== null ? refusal(ctx, bare) : problem !== null ? portabilityRefusal(ctx, slug, problem) : hyphenRunRefusal(ctx, operation, folded!);
  const target = problem?.suggestion ?? bare ?? folded!;
  const why = bare !== null ? 'ends in .md, which new pages cannot use'
    : problem !== null ? 'is not a portable file name, which new pages need'
      : `has a hyphen run or a segment-final hyphen, which new pages cannot use: its file path imports as "${folded}", so the page keeps its identity only through the slug: line in its file`;
  return `This page's slug ${why}. To move it, put_page its content under "${target}", then delete_page "${slug}".`;
}


async function liveExactRow(engine: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return !!snapshot && !snapshot.page.deleted_at;
}

/** Dry-run form: reads the exact `(source_id, slug)` row itself. */
export async function suffixedSlugDryRun(ctx: OperationContext, sourceId: string, slug: string, operation: SlugAdmissionOperation = 'put_page'): Promise<void> {
  if (suffixedSlugAdmission(ctx, slug, true, operation) === null) return;
  suffixedSlugAdmission(ctx, slug, await liveExactRow(ctx.engine, sourceId, slug.toLowerCase()), operation);
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
