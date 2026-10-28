/** Carrying gbrain's own fences into a connector re-render (shared by the unmanaged Google and meetings sweeps). */
import { FACTS_FENCE_BEGIN } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { conceptPreservationHold, preserveCanonicalFences } from '../cycle/concept-publication.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { Page } from '../types.ts';

export const hasFence = (text: string | null | undefined) => [FACTS_FENCE_BEGIN, TAKES_FENCE_BEGIN].some(begin => (text ?? '').includes(begin));

/**
 * GBRA-133 (#7292): facts and takes fences added on the brain (loop extraction, `remember`) are not part of the
 * provider's render. The managed connector carries them into each re-render (connector-sync.ts); the unmanaged one
 * replaced the page with the bare render, so a re-render dropped the fence from the file and the database and the next
 * `extract_facts` expired its facts. Carry them the same way: a render that brings its own fence owns it, and a stored
 * fence the render cannot carry verbatim (below the timeline sentinel, duplicated, unbalanced, unparseable) refuses
 * `connector_fence_below_timeline` instead of expiring its rows.
 */
export async function carryStoredFences(sourceId: string, slug: string, relPath: string, existing: Page | null, markdown: string, label: string): Promise<string> {
  if (!existing) return markdown;
  assertInlineBody(existing, label);
  if (!(hasFence(existing.compiled_truth) || hasFence(existing.timeline))) return markdown;
  const parsed = parseMarkdown(markdown, relPath);
  if (hasFence(parsed.compiled_truth)) return markdown;
  const hold = conceptPreservationHold(existing);
  if (hold) throw (await import('../persistence/connector-sync.ts')).connectorFenceRefusal(sourceId, slug, hold);
  return serializePageToMarkdown({ ...existing, ...parsed, compiled_truth: preserveCanonicalFences(existing, parsed.compiled_truth),
    type: parsed.typeExplicit ? parsed.type : existing.type }, parsed.tags);
}
