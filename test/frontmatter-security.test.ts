import { describe, expect, test } from 'bun:test';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { mergeCaptureFrontmatter } from '../src/core/capture-content.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('data-only frontmatter boundary', () => {
  // The expression is inert: it creates an object and has no filesystem,
  // process, network, or other side effects, even against the old parser.
  const executable = '---javascript\n({title: "example", type: "note"})\n---\n# Body';

  test('executable selectors produce a validation error', () => {
    const parsed = parseMarkdown(executable, 'notes/example.md', { validate: true });
    expect(parsed.errors?.some(error => error.code === 'YAML_PARSE')).toBe(true);
  });

  test('capture rejects an executable selector before wrapping its body', () => {
    expect(() => mergeCaptureFrontmatter(executable, { type: 'note' })).toThrow(/frontmatter|language/i);
  });

  test('import rejects executable frontmatter before accessing the engine', async () => {
    const engine = new Proxy({}, { get() { throw new Error('unexpected engine access'); } }) as BrainEngine;
    const result = await importFromContent(engine, 'notes/example', executable, { noEmbed: true });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/frontmatter|language/i);
  });

  test('serialization never interprets a body beginning with frontmatter', () => {
    const body = '---\nbody_field: retained\n---\n# Body';
    const result = serializeMarkdown({}, body, '', { type: 'note', title: 'Example', tags: [] });
    expect(result).toContain('\n\n' + body + '\n');
  });
});
