/**
 * openclaw.json is JSON5: comments, bare keys, single quotes and trailing
 * commas all have to read, and comment or string text must never be rewritten.
 */
import { describe, expect, test } from 'bun:test';
import { parseJson5ish } from '../src/core/setup/brain-first.ts';

describe('parseJson5ish', () => {
  test('a line comment above a bare key', () => {
    expect(parseJson5ish('{\n  // x\n  a: 1\n}')).toEqual({ a: 1 });
  });

  test('a block comment above a bare key, and one between entries', () => {
    expect(parseJson5ish('{\n  /* note */\n  a: 1,\n  /* b */ b: { c: true, },\n}')).toEqual({ a: 1, b: { c: true } });
  });

  test('a comment that ends with a comma or brace does not leak into the next key', () => {
    expect(parseJson5ish('{\n  a: 1, // old: 2,\n  // }\n  b: 2\n}')).toEqual({ a: 1, b: 2 });
  });

  test('// and key-like text inside strings stay as written', () => {
    expect(parseJson5ish(`{ url: "http://example.invalid/a", note: 'x: y // z', q: 'say "hi"', e: "a\\nb", s: 'it\\'s' }`))
      .toEqual({ url: 'http://example.invalid/a', note: 'x: y // z', q: 'say "hi"', e: 'a\nb', s: "it's" });
  });

  test('a raw tab inside a string and old Mac (CR-only) line endings', () => {
    expect(parseJson5ish("{ a: 'x\ty', b: \"p\tq\" }")).toEqual({ a: 'x\ty', b: 'p\tq' });
    expect(parseJson5ish('// header\r{\r  // x\r  a: 1,\r}\r')).toEqual({ a: 1 });
  });

  test('a realistic config with comments everywhere', () => {
    const text = `// OpenClaw config
{
  // agents
  agents: {
    defaults: {
      workspace: '~/work', // home
    },
  },
  /* plugins */
  plugins: { entries: { 'gbrain-turn-rule': { enabled: true } } },
}
`;
    expect(parseJson5ish(text)).toEqual({ agents: { defaults: { workspace: '~/work' } }, plugins: { entries: { 'gbrain-turn-rule': { enabled: true } } } });
  });

  test('plain JSON still parses and garbage does not', () => {
    expect(parseJson5ish('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parseJson5ish('{ a: }')).toBeUndefined();
  });
});
