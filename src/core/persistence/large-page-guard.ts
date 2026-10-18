/**
 * Large pages (Wave A): put_page's guard against replacing a large page with
 * a window of it. Above the inline read size a get_page read returns an
 * outline and windows, not the body, so a replacement must name the revision
 * it read (force does not stand in for it) and may not be much smaller than
 * the stored body unless the caller says so with allow_shrink: true. The
 * stored size of a segmented page is its `body_bytes` (its body columns are NULL).
 */
import { DEFAULT_INLINE_BODY_BYTES } from '../ops/get-page-body.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { pageBodyBytes } from '../page-body/page-shape.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { BrainEngine } from '../engine.ts';

/** A replacement under this fraction of the stored body counts as a shrink. */
export const SHRINK_REFUSE_FRACTION = 0.5;

const sizeFix = (slug: string, sourceId: string) => ({ argv: ['gbrain', 'get', '--source', sourceId, '--', slug],
  mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'none' } },
  consent: [], actor: 'agent' as const, requires_exclusive: false, why: "Returns the page's revision and size without its body." });

/**
 * Admission (remote put_page): checked before the write is queued, so the
 * refusal is immediate, carries its fix, and nothing is accepted. A page over
 * the inline read size must be replaced against the revision the caller read
 * (force does not stand in for it), and content under half its body is
 * refused unless allow_shrink is true. The content's own bytes (frontmatter
 * included) are measured here; preparation re-checks the parsed body.
 */
export async function assertLargePageAdmission(engine: Pick<BrainEngine, 'executeRaw'>, slug: string, sourceId: string, intent: Record<string, unknown>): Promise<void> {
  if (typeof intent.content !== 'string') return;
  const [row] = await engine.executeRaw<{ bytes: unknown }>(
    `SELECT CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(compiled_truth) + COALESCE(octet_length(timeline), 0) END AS bytes
      FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`, [slug, sourceId]);
  const stored = Number(row?.bytes ?? 0);
  if (stored <= DEFAULT_INLINE_BODY_BYTES) return;
  if (intent.expected_revision === undefined && intent.force === true) {
    const e = new OperationError('revision_required', `Page ${slug} is ${stored} bytes, over the ${DEFAULT_INLINE_BODY_BYTES}-byte inline read size; replacing it needs expected_revision (force does not apply). Nothing was written.`,
      "Read the revision with get_page body: 'none' and change the part you mean with edit_page, or send the complete page with that expected_revision.");
    e.fix = sizeFix(slug, sourceId);
    e.contractVersion = 1;
    throw e;
  }
  if (intent.allow_shrink !== true) assertNotShrunk(slug, sourceId, stored, Buffer.byteLength(intent.content, 'utf8'));
}

function assertNotShrunk(slug: string, sourceId: string, stored: number, next: number): void {
  if (next >= stored * SHRINK_REFUSE_FRACTION) return;
  throw opError('page_shrink_refused',
    `Refusing to replace ${slug} (${stored} bytes) with ${next} bytes: under ${Math.round(SHRINK_REFUSE_FRACTION * 100)}% of the stored body. Nothing was written.`,
    "A window or outline sent back as the page would delete the unread rest. Change part of the page with edit_page (revision from get_page body: 'none'); pass allow_shrink: true only when the smaller content is the intended complete page.",
    { detail: JSON.stringify({ stored_bytes: stored, content_bytes: next, min_bytes: Math.ceil(stored * SHRINK_REFUSE_FRACTION) }), fix: sizeFix(slug, sourceId) });
}

/** Preparation: the same shrink rule on the parsed body, against the locked snapshot. */
export function assertLargePageReplacement(
  slug: string,
  sourceId: string,
  intent: Record<string, unknown>,
  snapshot: PageSnapshot,
  incoming: { compiled_truth: string; timeline?: string | null },
): void {
  const stored = pageBodyBytes(snapshot.page);
  if (stored <= DEFAULT_INLINE_BODY_BYTES || intent.allow_shrink === true) return;
  assertNotShrunk(slug, sourceId, stored, pageBodyBytes(incoming));
}
