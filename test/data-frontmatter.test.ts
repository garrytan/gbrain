import { describe, expect, test } from 'bun:test';
import { parseDataFrontmatter, stringifyDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('frontmatter data and serialization compatibility', () => {
  test('preserves independently specified field order, scalar types and quoting', () => {
    const data = { title: 'A title', count: 3, enabled: true, date: new Date('2024-06-01'), code: '001', multiline: 'one\ntwo\n' };
    const expected = "---\ntitle: A title\ncount: 3\nenabled: true\ndate: 2024-06-01T00:00:00.000Z\ncode: '001'\nmultiline: |\n  one\n  two\n---\n# Body\n\n---\nend\n";
    expect(stringifyDataFrontmatter('# Body\n\n---\nend', data)).toBe(expected);
    const parsed = parseDataFrontmatter(expected);
    expect(parsed.data).toEqual(data);
    expect(parsed.content).toBe('# Body\n\n---\nend\n');
  });

  test('preserves empty metadata/body and final-newline conventions', () => {
    expect(stringifyDataFrontmatter('', {})).toBe('\n');
    expect(stringifyDataFrontmatter('body\n\n', {})).toBe('body\n\n');
    expect(stringifyDataFrontmatter('body', { title: 'foo: bar' })).toBe("---\ntitle: 'foo: bar'\n---\nbody\n");
  });

  test('body text is opaque, including apparent executable frontmatter', () => {
    const body = '---javascript\n({title: "example"})\n---\n# Body';
    expect(stringifyDataFrontmatter(body, { type: 'note' })).toBe('---\ntype: note\n---\n' + body + '\n');
  });

  test('recognizes BOM, leading blank lines, CRLF and explicit data languages', () => {
    for (const prefix of ['', '\uFEFF', '\n \n', '\uFEFF\r\n']) {
      for (const language of ['', 'yaml', 'yml', 'json']) {
        const block = language === 'json' ? '{"title":"Example","count":3}' : 'title: Example\r\ncount: 3';
        const input = prefix + '---' + language + '\r\n' + block + '\r\n---\r\nbody\r\n';
        expect(parseDataFrontmatter(input).data).toEqual({ title: 'Example', count: 3 });
        expect(parseDataFrontmatter(input).content).toBe('body\r\n');
        expect(parseMarkdown(input, 'notes/example.md', { validate: true }).errors).toEqual([]);
      }
    }
  });

  test('safe YAML aliases and merge keys retain their ordinary meaning', () => {
    const parsed = parseDataFrontmatter('---\ndefaults: &defaults\n  enabled: true\ncopy:\n  <<: *defaults\n---\nbody');
    expect(parsed.data.copy).toEqual({ enabled: true });
  });

  test('rejects unknown engines and YAML executable tags without echoing content', () => {
    for (const language of ['javascript', 'js', 'toml', 'unknown']) {
      expect(() => parseDataFrontmatter(`---${language}\n{}\n---\nbody`)).toThrow(/Unsupported frontmatter language/);
    }
    expect(() => parseDataFrontmatter('---\nvalue: !!js/function "private-marker"\n---\nbody')).toThrow('Malformed YAML frontmatter');
    try { parseDataFrontmatter('---\ntitle: [private-marker\n---\nbody'); }
    catch (error) { expect((error as Error).message).not.toContain('private-marker'); }
  });
});
