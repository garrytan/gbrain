import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, FACTS_FENCE_OMITTED, omitFactsFence } from '../facts-fence.ts';
import { OperationError } from '../ops/contract.ts';
import type { Page } from '../types.ts';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Line-anchored: a placeholder or fence quoted inside prose (`like this`) is text, not structure.
const PLACEHOLDER_LINE = new RegExp(`^${escape(FACTS_FENCE_OMITTED)}[ \\t]*\\r?$`, 'gm');
const FENCE_BEGIN_LINE = new RegExp(`^${escape(FACTS_FENCE_BEGIN)}`, 'm');

/**
 * A get_page omit_facts read leaves FACTS_FENCE_OMITTED on its own line where
 * the facts fence stood; put the stored fence back in its place, byte for
 * byte. The caller's expected_revision already guarantees the stored fence is
 * the one it omitted.
 */
export function restoreOmittedFacts(incoming: string, stored: string): string {
  const found = [...incoming.matchAll(PLACEHOLDER_LINE)];
  if (found.length === 0) return incoming;
  if (found.length > 1 || FENCE_BEGIN_LINE.test(incoming)) {
    throw new OperationError('invalid_params', 'Content may carry one omitted-facts placeholder and no facts fence.',
      'Put back the content from a get_page omit_facts read with its placeholder unchanged, or read the page without omit_facts to edit the facts fence.');
  }
  const begin = stored.search(FENCE_BEGIN_LINE);
  const end = begin < 0 ? -1 : stored.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
  if (end < 0) {
    throw new OperationError('invalid_params', 'The page has no facts fence to restore at the omitted-facts placeholder.',
      'Read the page again with get_page before replacing it.');
  }
  const at = found[0].index!;
  return incoming.slice(0, at) + stored.slice(begin, end + FACTS_FENCE_END.length) + incoming.slice(at + FACTS_FENCE_OMITTED.length);
}

/**
 * get_page omit_facts: the facts fence becomes FACTS_FENCE_OMITTED in both
 * compiled_truth and timeline, so editing an entity page never carries its
 * (unbounded) facts table; restoreOmittedFacts puts the stored fence back on
 * put_page. Returns the page unchanged unless `enabled`.
 */
export function omitFactsFromPage(page: Page, enabled: boolean): Page {
  if (!enabled) return page;
  return { ...page, compiled_truth: omitFactsFence(page.compiled_truth), timeline: omitFactsFence(page.timeline) };
}
