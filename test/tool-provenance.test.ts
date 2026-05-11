import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  collectChildPutPageSlugs,
  extractPutPageSlugFromToolInput,
} from '../src/core/cycle/tool-provenance.ts';

describe('tool provenance slug collection', () => {
  test('extracts put_page slugs from object and JSON-string inputs', () => {
    expect(extractPutPageSlugFromToolInput({ slug: 'wiki/a' })).toBe('wiki/a');
    expect(extractPutPageSlugFromToolInput('{"slug":"wiki/b"}')).toBe('wiki/b');
    expect(extractPutPageSlugFromToolInput('"{\\"slug\\":\\"wiki/c\\"}"')).toBe('wiki/c');
    expect(extractPutPageSlugFromToolInput({ slug: '' })).toBeNull();
    expect(extractPutPageSlugFromToolInput('{"content":"missing slug"}')).toBeNull();
    expect(extractPutPageSlugFromToolInput('not json')).toBeNull();
  });

  test('collects distinct slugs without relying on jsonb object operators', async () => {
    const engine = {
      async executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        expect(sql).toContain('SELECT input');
        expect(sql).not.toContain("input ? 'slug'");
        expect(params).toEqual([[8]]);
        return [
          { input: '{"slug":"wiki/a"}' },
          { input: '"{\\"slug\\":\\"wiki/b\\"}"' },
          { input: { slug: 'wiki/a' } },
          { input: '{"content":"missing slug"}' },
        ] as T[];
      },
    } as Pick<BrainEngine, 'executeRaw'> as BrainEngine;

    await expect(collectChildPutPageSlugs(engine, [8])).resolves.toEqual(['wiki/a', 'wiki/b']);
  });
});
