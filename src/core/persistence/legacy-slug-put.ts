/**
 * A put_page that names a page by the exact spelling it was stored under before writes composed slugs to
 * Unicode NFC (a decomposed `café` stored lowercase only). The write path stores the composed slug, so a put
 * by that spelling would create a second page that prints the same name. Until `gbrain repair slug-spelling` moves such a page, the put is refused: nothing moves, no revision is written and no composed twin is created.
 * The page still opens by either spelling, with its tags and timeline.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { normalizeSlug, withStoredSlug } from '../utils.ts';
import { managedPersistenceEnabled } from './ownership.ts';

/** The command that previews moving the stored pages of a source to their normal spelling. */
export const slugSpellingPreviewArgv = (sourceId: string): string[] => ['gbrain', 'repair', 'slug-spelling', '--source', sourceId];

/**
 * The refusal for a put by the decomposed (or capitalised) spelling `stored` of a page whose normal slug is `slug`. On a
 * classic brain it names the repair that moves the page; on a managed brain, where page tables take writes only through
 * coordinated publications, it says a person must decide, and names no command that would refuse too. The text is the
 * same on every engine.
 */
export function legacySpellingRefusal(stored: string, slug: string, sourceId: string, managed = false) {
  const read = { argv: ['gbrain', 'get', '--source', sourceId, '--', stored], mcp: { tool: 'get_page', arguments: { slug: stored, source_id: sourceId } } };
  const preview = slugSpellingPreviewArgv(sourceId);
  const kind = stored === stored.normalize('NFC') ? 'capitalised' : 'decomposed Unicode';
  const way = managed
    ? `Moving the page to the normal spelling ${slug} is not available on a managed brain, so a person has to decide how to rename it; until then the page cannot be replaced by put, and it stays readable and editable by its stored spelling.`
    : `To move the page to the normal spelling ${slug}, preview ${preview.join(' ')}, then run the apply command it prints after the owner agrees; until then the page cannot be replaced by put.`;
  return opError('invalid_params',
    `Page ${stored} is stored under an older ${kind} spelling of its name, so a put by that spelling is refused and nothing was changed. ${way}`,
    'Read the page with get_page by either spelling; it keeps its content, tags and timeline. Do not write it under the normal spelling, which would create a second page.', {
      detail: 'legacy_slug_spelling',
      why: 'Writes store slugs in the normal form (lowercase, Unicode NFC). Writing this page would either create a second page under the normal slug or move the stored one, '
        + 'and only the explicit repair moves a page, after a preview the owner approves.',
      fix: managed ? { ...readFix('Reads the page under the spelling it is stored by.', read), verify: read }
        : { ...readFix('Previews moving every page of the source stored under an older spelling to its normal slug; writes nothing.', { argv: [...preview, '--json'] }), verify: read },
    });
}

/** Operations that change a page that already exists: they address the exact stored row, whatever its spelling (storedWriteSlug). */
export const EXISTING_PAGE_OPERATIONS: readonly string[] = ['delete_page', 'restore_page', 'add_tag', 'remove_tag', 'add_timeline_entry', 'edit_page', 'append_page'];

/**
 * Refuse a put whose exact bytes, or their lowercase, name a stored page in `sourceId` that is not the composed `slug`: whether
 * or not a page already holds `slug` (a composed twin), the put would write that page, or a second one beside it.
 */
export async function refuseLegacySpelling(ctx: OperationContext, sourceId: string, rawSlug: unknown, slug: string): Promise<void> {
  if (typeof rawSlug !== 'string') return;
  for (const stored of new Set([rawSlug, rawSlug.toLowerCase()])) {
    if (stored !== slug && await ctx.engine.readPageSnapshot(stored, { sourceId, includeDeleted: true })) throw legacySpellingRefusal(stored, slug, sourceId, await managedPersistenceEnabled(ctx.engine));
  }
}

/**
 * The message that holds an import of content for the spelling a page was stored under before slugs were lowercased
 * and composed (capitals, or decomposed Unicode); null: no hold. An import writes the normal slug, so it would create a
 * second page that prints the same name; the stored page is left as it is.
 */
export async function legacyImportHold(engine: BrainEngine, sourceId: string | undefined, rawSlug: string, slug: string): Promise<string | null> {
  const at = { sourceId: sourceId ?? 'default', includeDeleted: true };
  const spellings = [...new Set([rawSlug, rawSlug.toLowerCase()])].filter(spelling => spelling !== slug);
  if (spellings.length === 0 || await engine.getPage(slug, at)) return null;
  for (const stored of spellings) {
    if (!await engine.getPage(stored, at)) continue;
    const managed = await managedPersistenceEnabled(engine);
    return `Page ${stored} is stored under an older spelling of its name (capitals or decomposed Unicode), and an import writes the normal spelling ${slug}, which would create a second page that prints the same name, so nothing was imported. `
      + (managed
        ? 'Fix: leave this content out (moving the page is not available on a managed brain, so a person has to decide how to rename it), or import it under a different slug.'
        : `Fix: leave this content out until the page moves to ${slug} (preview ${slugSpellingPreviewArgv(sourceId ?? 'default').join(' ')}), or import it under a different slug.`);
  }
  return null;
}

/** The spelling an existing-page write addresses: the page stored under the caller's exact bytes, then under their lowercase; null when neither is stored, so the normal slug is the key. */
export async function storedWriteSlug(engine: BrainEngine, sourceId: string, rawSlug: string, slug: string): Promise<string | null> {
  for (const candidate of [...new Set([rawSlug, rawSlug.toLowerCase()])].filter(c => c !== slug)) {
    if (await engine.readPageSnapshot(candidate, { sourceId, includeDeleted: true })) return candidate;
  }
  return null;
}

/** Runs the preparation or publication of `row` so that a write on an existing page's stored spelling keeps that spelling (storedWriteSlug; a remember is admitted on the stored key of the entity page it resolved), whichever process picks the request up. */
export function inStoredSlugScope<T>(row: { operation: string; slug: string }, run: () => T): T {
  return (EXISTING_PAGE_OPERATIONS.includes(row.operation) || row.operation === 'remember') && row.slug !== normalizeSlug(row.slug) ? withStoredSlug(row.slug, run) : run();
}
