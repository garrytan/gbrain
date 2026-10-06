import { describe, expect, test } from 'bun:test';
import { buildCandidate } from '../../src/core/schema-pack/detect.ts';

function typeNames(prefixes: string[]): string[] {
  const candidate = buildCandidate({
    prefixes: prefixes.map(prefix => ({ prefix, cnt: 10, sample_types: [] })),
    types: [],
    minPagesPerPrefix: 1,
    maxTypes: 50,
  });
  return candidate.page_types.map(t => t.name);
}

// The suggested type name used to keep only ASCII letters, so every Cyrillic
// folder became the type `-` and all of them collided on it.
describe('buildCandidate type names (#21)', () => {
  test('ASCII prefixes keep their existing names', () => {
    expect(typeNames(['people/', 'wiki/originals/', 'notes_2026/'])).toEqual(['people', 'wiki-originals', 'notes-2026']);
  });

  test('non-Latin prefixes keep their letters and stay distinct', () => {
    expect(typeNames(['люди/', 'проекты/', 'wiki/заметки/'])).toEqual(['люди', 'проекты', 'wiki-заметки']);
  });
});
