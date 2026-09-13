/**
 * relational-intent.ts — the default (vocab-less) pattern set is compiled
 * ONCE per process. hybrid.ts parses every search's query at least twice
 * (relational-recall.ts for the arm, composeFusionLists' `relationalQuery`
 * flag); rebuilding ~10 RegExp objects per call was pure waste. Pins:
 *   - identity of the memoized set across calls (no recompilation)
 *   - repeated vocab-less parses return identical results (sharing the
 *     regexes is stateless — `i` flag only, no `g`/`y` lastIndex)
 *   - the vocab-parameterized path still honors `extraVerbs` and never
 *     leaks a pack verb into the shared default set
 */

import { describe, expect, test } from 'bun:test';
import {
  defaultRelationalPatterns,
  parseRelationalQuery,
  type RelationVocab,
} from '../../src/core/search/relational-intent.ts';

describe('relational-intent — default pattern memoization', () => {
  test('defaultRelationalPatterns() returns the SAME array on every call (compiled once)', () => {
    const a = defaultRelationalPatterns();
    const b = defaultRelationalPatterns();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(5);
    for (const p of a) {
      // Sharing compiled regexes across calls is only safe without lastIndex state.
      expect(p.re.global).toBe(false);
      expect(p.re.sticky).toBe(false);
    }
  });

  test('two vocab-less parses of the same query return identical results (and a no-match stays null)', () => {
    const q = 'who invested in widget-co?';
    const first = parseRelationalQuery(q);
    const second = parseRelationalQuery(q);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first!.kind).toBe('who_rel');
    expect(first!.seeds).toEqual(['widget-co']);
    // Interleave a non-relational query and a different archetype, then re-parse.
    expect(parseRelationalQuery('notes from the offsite')).toBeNull();
    expect(parseRelationalQuery('what connects fund-a and fund-b')!.kind).toBe('connects');
    expect(parseRelationalQuery(q)).toEqual(first);
  });

  test('the exported parse still honors a vocab argument; pack verbs never enter the shared default set', () => {
    const vocab: RelationVocab = {
      extraVerbs: [{ verb: 'acquired|bought', linkTypes: ['related_to'], direction: 'in' }],
    };
    const before = defaultRelationalPatterns();
    const withVocab = parseRelationalQuery('who acquired widget-co', vocab);
    expect(withVocab).not.toBeNull();
    expect(withVocab!.kind).toBe('who_rel');
    expect(withVocab!.linkTypes).toEqual(['related_to']);
    expect(withVocab!.seeds).toEqual(['widget-co']);
    // The default set is untouched and unchanged by the vocab call…
    expect(defaultRelationalPatterns()).toBe(before);
    // …so the same query WITHOUT the vocab still does not match.
    expect(parseRelationalQuery('who acquired widget-co')).toBeNull();
    // An empty vocab is equivalent to no vocab (shares the memoized set's result).
    expect(parseRelationalQuery('who invested in widget-co', {})).toEqual(parseRelationalQuery('who invested in widget-co'));
    expect(parseRelationalQuery('who invested in widget-co', { extraVerbs: [] })).toEqual(parseRelationalQuery('who invested in widget-co'));
  });
});
