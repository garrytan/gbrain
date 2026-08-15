/**
 * #1711 — skill catalog parses YAML block-scalar `description:` fields.
 *
 * Pre-fix `parseDescriptionField` matched `description: |` with a greedy regex
 * and captured the bare block indicator (`|` / `>`) as the description, so a
 * skill written with `description: |` showed a literal "|" in the catalog
 * instead of its text.
 */
import { describe, test, expect } from 'bun:test';
import { oneLineDescription } from '../src/core/skill-catalog.ts';

describe('oneLineDescription — block scalars', () => {
  test('literal block scalar (|) folds indented lines into the description', () => {
    const raw = ['name: demo', 'description: |', '  First line of the description.', '  Second line continues it.'].join('\n');
    const out = oneLineDescription(raw, 'body fallback');
    expect(out).toBe('First line of the description. Second line continues it.');
    expect(out).not.toContain('|');
  });

  test('folded block scalar (>) is parsed too', () => {
    const raw = ['description: >', '  Folded description', '  across two lines.'].join('\n');
    expect(oneLineDescription(raw, 'fallback')).toBe('Folded description across two lines.');
  });

  test('chomping/indent indicators (|-, >+, |2) are recognized', () => {
    const raw = ['description: |-', '  Trimmed block scalar.'].join('\n');
    expect(oneLineDescription(raw, 'fallback')).toBe('Trimmed block scalar.');
  });

  test('block scalar with no indented continuation falls back to body prose', () => {
    const raw = ['description: |', 'name: next-key'].join('\n');
    expect(oneLineDescription(raw, 'Body prose line')).toBe('Body prose line');
  });
});

describe('oneLineDescription — inline scalars still work', () => {
  test('plain inline description', () => {
    expect(oneLineDescription('description: A plain one-liner', 'fallback')).toBe('A plain one-liner');
  });

  test('quoted inline description strips surrounding quotes', () => {
    expect(oneLineDescription('description: "Quoted desc"', 'fallback')).toBe('Quoted desc');
    expect(oneLineDescription("description: 'Single quoted'", 'fallback')).toBe('Single quoted');
  });

  test('absent description falls back to first prose line', () => {
    expect(oneLineDescription('name: x', 'The first prose line.')).toBe('The first prose line.');
  });
});
