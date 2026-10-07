/**
 * Security review (fix wave 11, W5.1): frontmatter is untrusted input. A YAML
 * alias bomb (a few hundred bytes of nested `&a [*b, *b]` anchors) expands
 * exponentially when its parsed value is walked. The whole-block checks added
 * for #6157 must treat a block with more aliases than the limit as "does not
 * parse": the per-line heuristics apply as before and nothing on that path is
 * rewritten. Valid folded YAML still validates clean and is left untouched.
 * Pure: parseMarkdown / autoFixFrontmatter, no DB.
 */
import { describe, expect, test } from 'bun:test';
import { autoFixFrontmatter } from '../src/core/brain-writer.ts';
import { parseMarkdown, yamlAliasesWithinLimit } from '../src/core/markdown.ts';

const fence = '---';
function bomb(key: string, depth = 26): string {
  let items = `&l0 ["x", "x"]`;
  for (let i = 1; i < depth; i++) items += `, &l${i} [*l${i - 1}, *l${i - 1}]`;
  return `${key}: [${items}]`;
}
const page = (line: string) => `${fence}\ntype: note\ntitle: x\n${line}\n${fence}\n\nbody`;

describe('frontmatter alias bomb (W5.1 security review)', () => {
  for (const key of ['tags', 'aliases', 'related']) {
    test(`autoFixFrontmatter returns fast and rewrites nothing on a ${key}: bomb`, () => {
      const input = page(bomb(key));
      const started = performance.now();
      const { content } = autoFixFrontmatter(input);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(content).toBe(input);
    });
  }

  test('validation of a bomb in a non-tag key returns fast', () => {
    const started = performance.now();
    parseMarkdown(page(bomb('related')), undefined, { validate: true });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // Pre-existing on master (not from #6157): tag extraction stringified nested
  // tag arrays, which expands the same bomb. Only scalar tags are kept.
  test('parsing a tags: bomb returns fast; nested tag arrays are not tags', () => {
    const started = performance.now();
    const parsed = parseMarkdown(page(bomb('tags')));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parsed.tags).toEqual([]);
    expect(parseMarkdown(page('tags: [yc, 2025, "w25"]')).tags).toEqual(['yc', '2025', 'w25']);
  });

  test('the alias limit counts aliases outside quotes only', () => {
    expect(yamlAliasesWithinLimit(bomb('tags'))).toBe(false);
    expect(yamlAliasesWithinLimit('base: &b {a: 1}\nother: *b\nnote: "a *star* in a string"')).toBe(true);
    expect(yamlAliasesWithinLimit(`quote: "${'*a '.repeat(40)}"`)).toBe(true);
  });

  test('valid folded YAML still passes and is left byte-identical', () => {
    const input = `${fence}\ntype: concept\ntitle: Notes\nclaim: >-\n  The founder said\n  Reply: "Ship it", then "measure it" twice\n${fence}\n\nbody`;
    expect(parseMarkdown(input, undefined, { validate: true }).errors!.filter(e => e.code === 'NESTED_QUOTES' || e.code === 'YAML_PARSE')).toHaveLength(0);
    expect(autoFixFrontmatter(input).content).toBe(input);
  });
});
