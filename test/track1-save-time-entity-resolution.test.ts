/**
 * Save-time entity resolution — hook contract only.
 *
 * The read-time cascade (including alias_exact) already ships on master
 * via #3730. This file covers the write-path caller that the original
 * #4052 PR added, rewritten onto that shipped vocabulary. It does not
 * re-test resolve.ts.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import type { ResolveResult } from '../src/core/entities/resolve.ts';
import * as resolve from '../src/core/entities/resolve.ts';
import {
  formatSaveTimeResolutionCounts,
  resolveExtractedEntitiesForSave,
} from '../src/core/entities/resolve-on-save.ts';

function fact(entity_slug: string | null, text = 'a fact'): ExtractedFact {
  return {
    fact: text,
    kind: 'event',
    entity_slug,
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  };
}

function stubResolve(
  impl: (raw: string) => Promise<ResolveResult | null>,
): ReturnType<typeof spyOn> {
  return spyOn(resolve, 'resolveEntitySlugWithSource').mockImplementation(
    async (_engine, _sourceId, raw) => impl(raw),
  );
}

describe('save-time resolution vocabulary', () => {
  test('logs shipped alias_exact, never alias_match or alias_redirect', () => {
    expect(formatSaveTimeResolutionCounts({
      alias_exact: 2,
      fallback_slugify: 1,
    })).toBe('{"alias_exact":2,"fallback_slugify":1}');
    const rendered = formatSaveTimeResolutionCounts({
      exact_page: 1,
      alias_exact: 1,
      fuzzy_match: 1,
      fallback_slugify: 1,
    });
    expect(rendered).toContain('alias_exact');
    expect(rendered).not.toContain('alias_match');
    expect(rendered).not.toContain('alias_redirect');
  });
});

describe('resolveExtractedEntitiesForSave', () => {
  const engine = {} as BrainEngine;

  test('rewrites slugs, preserves null, and counts fallback_slugify', async () => {
    const spy = stubResolve(async (raw) => {
      if (raw === 'Brian') {
        return { slug: 'people/brian-example', source: 'alias_exact' };
      }
      if (raw === 'Unlisted Person') {
        return { slug: 'unlisted-person', source: 'fallback_slugify' };
      }
      return { slug: raw, source: 'fallback_slugify' };
    });
    try {
      const facts = [
        fact('Brian'),
        fact('Unlisted Person'),
        fact(null),
      ];
      const stats = await resolveExtractedEntitiesForSave(engine, 'default', facts);
      expect(facts.map((row) => row.entity_slug)).toEqual([
        'people/brian-example',
        'unlisted-person',
        null,
      ]);
      expect(stats.counts).toEqual({
        alias_exact: 1,
        fallback_slugify: 1,
      });
      expect(stats.fallback_slugify_count).toBe(1);
      expect(stats.resolution_errors).toBe(0);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('best-effort resolver failure keeps the raw value', async () => {
    const spy = stubResolve(async (raw) => {
      if (raw === 'Unlisted Person') throw new Error('resolver unavailable');
      return { slug: 'people/brian-example', source: 'alias_exact' };
    });
    const errors: Array<{ raw: string; message: string }> = [];
    try {
      const facts = [fact('Brian'), fact('Unlisted Person')];
      const stats = await resolveExtractedEntitiesForSave(
        engine,
        'default',
        facts,
        (raw, message) => errors.push({ raw, message }),
      );
      expect(facts.map((row) => row.entity_slug)).toEqual([
        'people/brian-example',
        'Unlisted Person',
      ]);
      expect(stats.resolution_errors).toBe(1);
      expect(stats.fallback_slugify_count).toBe(0);
      expect(errors).toEqual([
        { raw: 'Unlisted Person', message: 'resolver unavailable' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('BudgetExhausted from resolution propagates and is not a resolution error', async () => {
    const spy = stubResolve(async () => {
      throw new BudgetExhausted('resolver budget exhausted', {
        reason: 'cost',
        spent: 2,
        cap: 1,
      });
    });
    try {
      const facts = [fact('Brian')];
      await expect(resolveExtractedEntitiesForSave(engine, 'default', facts))
        .rejects.toBeInstanceOf(BudgetExhausted);
      expect(facts[0].entity_slug).toBe('Brian');
    } finally {
      spy.mockRestore();
    }
  });

  test('abort from resolution propagates', async () => {
    const spy = stubResolve(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    try {
      await expect(resolveExtractedEntitiesForSave(engine, 'default', [fact('Brian')]))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      spy.mockRestore();
    }
  });
});
