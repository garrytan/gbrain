/**
 * matchingCloseBracket: the scanner the chronicle judge, propose_takes,
 * extract_atoms and the quoted-fence recovery in parseLlmJson use to end a
 * JSON value at its own bracket. Caller behavior is pinned in each caller's
 * suite; this file pins the scanner's contract once, including the inputs a
 * hostile or truncated model reply can produce.
 */
import { describe, expect, test } from 'bun:test';
import { matchingCloseBracket } from '../src/core/llm-json.ts';

describe('matchingCloseBracket', () => {
  test('stops at the value, not at a later citation', () => {
    const text = '[{"k":"v"}] see [Source: memo]';
    expect(matchingCloseBracket(text)).toBe(text.indexOf('] see'));
  });

  test('scans from openAt and returns an absolute index', () => {
    const text = 'Answer: {"list":[1,2],"n":{}} and {later}';
    const openAt = text.indexOf('{');
    expect(text.slice(openAt, matchingCloseBracket(text, openAt) + 1)).toBe('{"list":[1,2],"n":{}}');
  });

  test('counts nesting of the same kind', () => {
    expect(matchingCloseBracket('[[],[[]]] ]')).toBe(8);
  });

  test('skips string literals whole: brackets, escaped quotes, escaped backslashes', () => {
    expect(matchingCloseBracket('["]]"] x]')).toBe(5);
    expect(matchingCloseBracket('{"q":"a\\"}"} }')).toBe(11);
    expect(matchingCloseBracket('["c:\\\\"] x]')).toBe(7);
  });

  test('a closer of the other kind is not counted', () => {
    expect(matchingCloseBracket('[}]')).toBe(2);
    expect(matchingCloseBracket('{]}')).toBe(2);
  });

  test('returns -1 when the value never closes', () => {
    expect(matchingCloseBracket('[{"k":1}')).toBe(-1);
    expect(matchingCloseBracket('["open string]')).toBe(-1);
    expect(matchingCloseBracket('["trailing backslash\\')).toBe(-1);
  });

  test('returns -1 when openAt is not an opening bracket or is out of range', () => {
    expect(matchingCloseBracket('see [x]')).toBe(-1);
    expect(matchingCloseBracket('')).toBe(-1);
    expect(matchingCloseBracket('[1]', -1)).toBe(-1);
    expect(matchingCloseBracket('[1]', 3)).toBe(-1);
    expect(matchingCloseBracket('a[1]', 0)).toBe(-1);
  });

  test('a deep unclosed run returns -1 without recursion', () => {
    expect(matchingCloseBracket('['.repeat(200_000))).toBe(-1);
    expect(matchingCloseBracket(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).toBe(199_999);
  });
});
