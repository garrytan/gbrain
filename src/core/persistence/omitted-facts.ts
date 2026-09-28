import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, FACTS_FENCE_OMITTED } from '../facts-fence.ts';
import { OperationError } from '../ops/contract.ts';

/**
 * A get_page omit_facts read leaves FACTS_FENCE_OMITTED where the facts fence
 * stood; put the stored fence back in its place, byte for byte. The caller's
 * expected_revision already guarantees the stored fence is the one it omitted.
 */
export function restoreOmittedFacts(incoming: string, stored: string): string {
  const at = incoming.indexOf(FACTS_FENCE_OMITTED);
  if (at < 0) return incoming;
  if (incoming.indexOf(FACTS_FENCE_OMITTED, at + FACTS_FENCE_OMITTED.length) >= 0 || incoming.includes(FACTS_FENCE_BEGIN)) {
    throw new OperationError('invalid_params', 'Content may carry one omitted-facts placeholder and no facts fence.',
      'Put back the content from a get_page omit_facts read with its placeholder unchanged, or read the page without omit_facts to edit the facts fence.');
  }
  const begin = stored.indexOf(FACTS_FENCE_BEGIN);
  const end = begin < 0 ? -1 : stored.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
  if (end < 0) {
    throw new OperationError('invalid_params', 'The page has no facts fence to restore at the omitted-facts placeholder.',
      'Read the page again with get_page before replacing it.');
  }
  return incoming.slice(0, at) + stored.slice(begin, end + FACTS_FENCE_END.length) + incoming.slice(at + FACTS_FENCE_OMITTED.length);
}
