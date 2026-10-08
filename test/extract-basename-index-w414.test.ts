/**
 * Wave 12 W4.14: the filesystem extract path resolved every bare `[[name]]`
 * wikilink by rebuilding the whole basename index (O(N) per wikilink). The
 * index is now built once per slug set and rebuilt only when the set grows
 * (alias slugs are added before extraction starts).
 */
import { describe, expect, test } from 'bun:test';
import { resolveBasenameMatchesFromSlugs, resolveSlugAll } from '../src/commands/extract.ts';

/** A slug set that counts full iterations (one per index build). */
class CountingSet extends Set<string> {
  iterations = 0;
  override [Symbol.iterator](): SetIterator<string> {
    this.iterations++;
    return super[Symbol.iterator]();
  }
}

describe('W4.14: one basename index per slug set', () => {
  test('a thousand lookups build the index once and resolve like before', () => {
    const slugs = new CountingSet(Array.from({ length: 2000 }, (_, i) => `notes/topic-${i}`));
    slugs.add('people/alice-example');
    slugs.iterations = 0;
    for (let i = 0; i < 1000; i++) {
      expect(resolveSlugAll('daily', `topic-${i}.md`, slugs, { globalBasename: true })).toEqual([`notes/topic-${i}`]);
    }
    expect(resolveBasenameMatchesFromSlugs('alice-example', slugs)).toEqual(['people/alice-example']);
    expect(slugs.iterations).toBe(1);
  });

  test('a slug added to the set is found (the index is rebuilt once)', () => {
    const slugs = new CountingSet(['notes/a', 'notes/b']);
    slugs.iterations = 0;
    expect(resolveBasenameMatchesFromSlugs('c', slugs)).toEqual([]);
    slugs.add('wiki/c');
    expect(resolveBasenameMatchesFromSlugs('c', slugs)).toEqual(['wiki/c']);
    expect(resolveBasenameMatchesFromSlugs('a', slugs)).toEqual(['notes/a']);
    expect(slugs.iterations).toBe(2);
  });
});
