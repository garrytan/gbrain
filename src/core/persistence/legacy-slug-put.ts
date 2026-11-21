/**
 * A put_page that names a page by the exact spelling it was stored under before writes composed slugs to
 * Unicode NFC (a decomposed `café` stored lowercase only). The write path stores the composed slug, so without
 * this a put would create a second page that prints the same name. When the composed slug is unheld and the
 * caller's lowercased spelling is held, the put is treated as a write to that existing page:
 * - no expected_revision: revision_required (the page exists), nothing moved;
 * - the right expected_revision: the page's key moves to the composed slug (collision-free: it was unheld) and
 *   the put then updates it, keeping its id, chunks, tags and timeline;
 * - another expected_revision: revision_conflict.
 */
import type { OperationContext } from '../ops/contract.ts';
import { PageRevisionConflictError, type PageSnapshot } from '../page-state/types.ts';

/** The snapshot of the moved page under its composed slug, or null when the put is not a legacy-spelling write. */
export async function adoptLegacySpelling(
  ctx: OperationContext,
  sourceId: string,
  rawSlug: unknown,
  slug: string,
  expectedRevision: unknown,
): Promise<PageSnapshot | null> {
  if (typeof rawSlug !== 'string') return null;
  const old = rawSlug.toLowerCase();
  if (old === slug) return null;
  const opts = { sourceId, includeDeleted: true };
  const legacy = await ctx.engine.readPageSnapshot(old, opts);
  if (!legacy) return null;
  if (typeof expectedRevision !== 'string') throw new PageRevisionConflictError(undefined, legacy.revision);
  if (expectedRevision !== legacy.revision) throw new PageRevisionConflictError(expectedRevision, legacy.revision);
  if (await ctx.engine.updateSlug(old, slug, { sourceId }) === 0) return null;
  return ctx.engine.readPageSnapshot(slug, opts);
}
