/**
 * The new-name page prefilter must require every token of a name, not just its longest one.
 * Regression: a name whose longest word is common ("program") passed most of the brain through the LIKE prefilter.
 */
import { describe, expect, test } from 'bun:test';
import * as pass from '../src/core/mentions/pass.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('pagesMatchingNames prefilter', () => {
  test('a page with only the common longest word does not pass the LIKE patterns', async () => {
    const added: Gazetteer = new Map([['acme', [{ slug: 'programs/acme-program', source_id: 'default', title: 'Acme Program', tokens: ['acme', 'program'] }]]]);
    let patterns: string[] = [];
    const engine = {
      executeRaw: async (_sql: string, params: unknown[]) => { patterns = (params[3] as string[]) ?? []; return []; },
    } as unknown as BrainEngine;
    const pagesMatchingNames = (pass as Record<string, unknown>).pagesMatchingNames as typeof import('../src/core/mentions/pass.ts')['pagesMatchingNames'];
    expect(typeof pagesMatchingNames).toBe('function');
    await pagesMatchingNames(engine, ['default'], added, false, Date.now() + 10_000);
    const like = (text: string) => patterns.some(p => new RegExp(`^${p.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`).test(text));
    expect(patterns.length).toBeGreaterThan(0);
    expect(like('the exchange program ran all year')).toBe(false);
    expect(like('we joined the acme program last week')).toBe(true);
  });
});
