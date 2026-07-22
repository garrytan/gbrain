import { describe, test, expect } from 'bun:test';
import { editDistance, suggestNearest } from '../src/core/levenshtein.ts';

describe('editDistance', () => {
  test('identical strings return 0', () => {
    expect(editDistance('embedding_model', 'embedding_model')).toBe(0);
  });

  test('empty vs non-empty returns length', () => {
    expect(editDistance('', 'foo')).toBe(3);
    expect(editDistance('foo', '')).toBe(3);
  });

  test('one substitution', () => {
    expect(editDistance('cat', 'bat')).toBe(1);
  });

  test('one insertion', () => {
    expect(editDistance('cat', 'cats')).toBe(1);
  });

  test('one deletion', () => {
    expect(editDistance('cats', 'cat')).toBe(1);
  });

  test('classic transposition (kitten → sitting)', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  test('case-sensitive', () => {
    // 'A' vs 'a' is a substitution
    expect(editDistance('OPENAI_API_KEY', 'openai_api_key')).toBeGreaterThan(0);
  });

  test('symmetric', () => {
    expect(editDistance('abc', 'xyz')).toBe(editDistance('xyz', 'abc'));
  });

  test('bug-reporter case: embedding.provider → embedding_model', () => {
    // 6 edits: replace 'p' with 'm', 'r' with 'o', 'o' with 'd', 'v' with 'e',
    // 'i' with 'l', and a couple more changes
    const d = editDistance('embedding.provider', 'embedding_model');
    // The exact number doesn't matter — we want it > 3 so it would NOT
    // suggest embedding_model for embedding.provider with default threshold.
    // The dot-vs-underscore case is handled by a different mapping (see
    // suggestNearest with higher threshold in the config.ts caller).
    expect(d).toBeGreaterThan(3);
  });

  test('bug-reporter case: embedding.model → embedding_model (1 edit)', () => {
    // Only '.' vs '_' differs. 1 substitution.
    expect(editDistance('embedding.model', 'embedding_model')).toBe(1);
  });

  test('typo: OPENAPI_API_KEY → OPENAI_API_KEY (1 deletion)', () => {
    expect(editDistance('OPENAPI_API_KEY', 'OPENAI_API_KEY')).toBe(1);
  });
});

describe('suggestNearest', () => {
  const KEYS = ['embedding_model', 'embedding_dimensions', 'expansion_model', 'chat_model', 'search.mode'];

  test('exact match returns identity', () => {
    expect(suggestNearest('chat_model', KEYS)).toBe('chat_model');
  });

  test('1-edit typo suggests within default threshold', () => {
    expect(suggestNearest('embedding.model', KEYS)).toBe('embedding_model');
  });

  test('returns null when no candidate is within threshold', () => {
    expect(suggestNearest('completely_unrelated_garbage_string', KEYS)).toBeNull();
  });

  test('returns null with empty candidates', () => {
    expect(suggestNearest('whatever', [])).toBeNull();
  });

  test('deterministic tiebreak on equal distance', () => {
    // Both 'a' and 'b' are at distance 1 from 'c'. Lex order: 'a' < 'b'.
    const got = suggestNearest('c', ['a', 'b']);
    expect(got).toBe('a');
  });

  test('respects maxDistance override', () => {
    // 4 edits away — outside the default 3, but inside an override of 5
    const far = 'fOOO_API_KEY';
    expect(suggestNearest(far, ['OPENAI_API_KEY'])).toBeNull();
    expect(suggestNearest(far, ['OPENAI_API_KEY'], 10)).toBe('OPENAI_API_KEY');
  });

  test('bug-reporter env-var typo case: OPENAPI_API_KEY → OPENAI_API_KEY', () => {
    expect(suggestNearest('OPENAPI_API_KEY', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']))
      .toBe('OPENAI_API_KEY');
  });
});
