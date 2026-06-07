import { test, expect } from 'bun:test';
import { assessContentSanity } from '/Users/mgunnin/gbrain/src/core/content-sanity.ts';
import { parseMarkdown } from '/Users/mgunnin/gbrain/src/core/markdown.ts';

test('assessContentSanity does not throw when title is a number (YAML coercion)', () => {
  // @ts-expect-error — simulating runtime YAML coercion to number
  const r = assessContentSanity({ title: 20260517131712214848, compiled_truth: 'hello world', timeline: '' });
  expect(r).toBeDefined();
});

test('parseMarkdown coerces a numeric YAML title to string', () => {
  const md = '---\ntitle: 20260517_131712_214848\n---\n\nbody text';
  const p = parseMarkdown(md, '/tmp/x.md');
  expect(typeof p.title).toBe('string');
});

test('parseMarkdown coerces numeric type and slug too', () => {
  const md = '---\ntitle: 123\ntype: 456\nslug: 789\n---\n\nbody';
  const p = parseMarkdown(md, '/tmp/y.md');
  expect(typeof p.title).toBe('string');
  expect(typeof p.type).toBe('string');
  expect(typeof p.slug).toBe('string');
});
