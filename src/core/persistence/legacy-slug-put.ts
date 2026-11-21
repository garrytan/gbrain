/**
 * A put_page that names a page by the exact spelling it was stored under before writes composed slugs to
 * Unicode NFC (a decomposed `café` stored lowercase only). The write path stores the composed slug, so a put
 * by that spelling would create a second page that prints the same name. Until a collision-safe key migration
 * moves such pages, the put is refused: nothing moves, no revision is written and no composed twin is created.
 * The page still opens by either spelling, with its tags and timeline.
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';

/** The refusal for a put by the decomposed spelling `stored` of a page whose composed slug is `slug`. */
export function legacySpellingRefusal(stored: string, slug: string, sourceId: string) {
  const read = { argv: ['gbrain', 'get', '--source', sourceId, '--', stored], mcp: { tool: 'get_page', arguments: { slug: stored, source_id: sourceId } } };
  return opError('invalid_params',
    `Page ${stored} is stored under an older decomposed Unicode spelling of its name, so a put by that spelling is refused and nothing was changed. `
      + `A fix that moves the page to the composed spelling ${slug} is coming; until then the page cannot be replaced by put.`,
    'Read the page with get_page by either spelling; it keeps its content, tags and timeline. Do not write it under the composed spelling, which would create a second page.', {
      detail: 'legacy_slug_spelling',
      why: 'Writes store slugs in composed (NFC) form. Writing this page would either create a second page under the composed slug or move the stored one, '
        + 'and the move is not yet safe (it must check visibility and commit with the write).',
      fix: { ...readFix('Reads the page under the spelling it is stored by.', read), verify: read },
    });
}

/** Refuse a put whose exact lowercased spelling names a stored page in `sourceId` that is not the composed `slug`. */
export async function refuseLegacySpelling(ctx: OperationContext, sourceId: string, rawSlug: unknown, slug: string): Promise<void> {
  if (typeof rawSlug !== 'string') return;
  const stored = rawSlug.toLowerCase();
  if (stored === slug) return;
  if (await ctx.engine.readPageSnapshot(stored, { sourceId, includeDeleted: true })) throw legacySpellingRefusal(stored, slug, sourceId);
}
