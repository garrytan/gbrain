import { describe, expect, test } from 'bun:test';
import { dump, load } from 'js-yaml';
import { parseDataFrontmatter, stringifyDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { NAIVE_DATETIME } from '../src/core/effective-date.ts';

// js-yaml 4 parses YAML 1.2 core scalars. These cases pin what changed from
// js-yaml 3 (YAML 1.1 integers) and what must not change (dates, duplicate
// keys, merge keys), so a parser upgrade cannot silently rewrite page data.
const fm = (yaml: string) => parseDataFrontmatter(`---\n${yaml}\n---\nbody\n`).data;

describe('frontmatter scalars under YAML 1.2 (js-yaml 4)', () => {
  test('clock-like values stay strings instead of base-60 numbers', () => {
    expect(fm('start: 10:30')).toEqual({ start: '10:30' });
    expect(fm('duration: 1:20:05')).toEqual({ duration: '1:20:05' });
  });

  test('a leading zero is decimal, 0o is octal, underscores are not digit separators', () => {
    expect(fm('id: 010')).toEqual({ id: 10 });
    expect(fm('mode: 0o755')).toEqual({ mode: 0o755 });
    expect(fm('count: 1_000')).toEqual({ count: '1_000' });
  });

  test('yes/no/on/off stay strings; only true/false are booleans', () => {
    expect(fm('a: yes\nb: off\nc: true\nd: False')).toEqual({ a: 'yes', b: 'off', c: true, d: false });
  });

  test('dates still load as Date, calendar-invalid dates stay strings, naive datetimes keep their marker', () => {
    const data = fm('date: 2024-02-29\nbad: 2024-02-30\nat: 2024-03-01 09:15:00');
    expect(data.date).toBeInstanceOf(Date);
    expect((data.date as Date).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(data.bad).toBe('2024-02-30');
    expect((data.at as Date & Record<symbol, unknown>)[NAIVE_DATETIME]).toBe(true);
  });

  test('duplicate keys are refused and merge keys still merge', () => {
    expect(() => fm('title: a\ntitle: b')).toThrow(/Malformed YAML frontmatter/);
    expect(fm('base: &b {x: 1}\npage:\n  <<: *b\n  y: 2').page).toEqual({ x: 1, y: 2 });
  });
});

describe('frontmatter writes round-trip', () => {
  const risky = ['2024-01-01', 'yes', 'no', 'on', 'null', '~', '', '010', '0o10', '1e3', '0x10', '.inf',
    '12:30', ' lead', 'trail ', '# hash', 'a: b', '-x', '[x]', '{x}', '${{ github.token }}', '"q"', "'s'",
    'multi\nline', 'unicode é ✓', 'https://x.y/z?a=b#c', 'C:\\path', '<<', '---', '1_000'];

  test('every risky string survives stringify then parse as the same string', () => {
    for (const value of risky) {
      const text = stringifyDataFrontmatter('body\n', { value, list: [value] });
      expect(parseDataFrontmatter(text).data).toEqual({ value, list: [value] });
    }
  });

  test('an undefined field is refused, not dropped (js-yaml 4 would skip it)', () => {
    expect(() => stringifyDataFrontmatter('body\n', { title: 't', lesson: undefined })).toThrow(/"lesson" is undefined/);
    expect(() => stringifyDataFrontmatter('body\n', { tags: ['a', undefined] })).toThrow(/is undefined/);
    expect(() => stringifyDataFrontmatter('body\n', { nested: { x: undefined } })).toThrow(/"x" is undefined/);
  });

  test('dump never emits a value that load reads back as a different type', () => {
    for (const value of risky) expect(load(dump({ value }))).toEqual({ value });
  });
});
