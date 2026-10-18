import { describe, expect, test } from 'bun:test';
import { mentionsWord } from '../src/core/chunkers/edge-extractor.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = 'ab_1 ,.{}()=\n\t$é';

describe('mentionsWord', () => {
  test('matches new RegExp(`\\b${name}\\b`) for word names over a seeded corpus', () => {
    const rand = lcg(6715);
    const names = ['a', 'ab', 'b_1', '_', 'a1b', 'ba'];
    let checked = 0;
    for (let n = 0; n < 4000; n++) {
      const len = Math.floor(rand() * 40);
      let text = '';
      for (let i = 0; i < len; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      for (const name of names) {
        expect(mentionsWord(text, name)).toBe(new RegExp(`\\b${name}\\b`).test(text));
        checked++;
      }
    }
    expect(checked).toBe(24000);
  });

  test('matches a receiver name literally instead of as a pattern', () => {
    expect(mentionsWord("import { $http } from 'ng'", '$http')).toBe(false);
    expect(mentionsWord("import { a$http } from 'ng'", '$http')).toBe(true);
    expect(mentionsWord('const xay = 1', 'a.y')).toBe(false);
    expect(mentionsWord('const obj = new Foo()', 'obj')).toBe(true);
    expect(mentionsWord('const objx = new Foo()', 'obj')).toBe(false);
    expect(mentionsWord('anything', '')).toBe(false);
  });
});
