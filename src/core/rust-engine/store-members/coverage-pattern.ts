/**
 * The query word of one `coverageRelevance` pattern (search/retrieval-coverage.ts), for the store members that match
 * relevance patterns as whole words. Not a family file: `index.ts` does not spread it, so nothing here is served.
 */
import { refuseMember } from './common.ts';

const WORD_PATTERN_HEAD = '(^|[^[:alnum:]])';
const WORD_PATTERN_TAIL = '([^[:alnum:]]|$)';
/** The words `coverageRelevance` builds patterns from; none of their characters needs a regex escape. */
const PATTERN_WORD = /^[\p{L}\p{N}'-]+$/u;

/** The query word of one `coverageRelevance` pattern; any other pattern refuses (the store runs no POSIX regex). */
export function coveragePatternWord(member: string, pattern: string): string {
  const word = pattern.startsWith(WORD_PATTERN_HEAD) && pattern.endsWith(WORD_PATTERN_TAIL)
    ? pattern.slice(WORD_PATTERN_HEAD.length, pattern.length - WORD_PATTERN_TAIL.length) : '';
  if (!PATTERN_WORD.test(word)) refuseMember(member, 'a relevance pattern that is not one whole-word match');
  return word;
}
