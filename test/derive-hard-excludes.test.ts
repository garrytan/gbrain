// #2780 (privacy) — derive phases (chronicle events, facts, takes) must
// skip pages under hard-excluded prefixes (defaults ∪ GBRAIN_SEARCH_EXCLUDE).
// Pre-fix, excluded-prefix content was re-materialized as searchable
// rows/pages outside the excluded prefix, silently defeating the exclusion.
//
// Hermetic: mock engines, env via withEnv. The atoms-phase gate is pinned
// in test/extract-atoms-page-discovery.test.ts (PGLite fixture lives there).

import { describe, expect, test } from 'bun:test';
import { isHardExcludedSlug, resolveDeriveExcludes } from '../src/core/search/source-boost.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

describe('isHardExcludedSlug', () => {
  test('matches env prefixes and defaults, prefix-anchored', () => {
    expect(isHardExcludedSlug('private/journal', ['private/'])).toBe(true);
    expect(isHardExcludedSlug('people/private', ['private/'])).toBe(false);
    // Defaults apply when no explicit list is passed.
    expect(isHardExcludedSlug('attachments/x')).toBe(true);
    expect(isHardExcludedSlug('people/alice-example')).toBe(false);
  });

  test('reads GBRAIN_SEARCH_EXCLUDE by default', async () => {
    await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'journal/' }, () => {
      expect(isHardExcludedSlug('journal/2026-01-01')).toBe(true);
    });
    await withEnv({ GBRAIN_SEARCH_EXCLUDE: undefined }, () => {
      expect(isHardExcludedSlug('journal/2026-01-01')).toBe(false);
    });
  });
});

describe('resolveDeriveExcludes', () => {
  test('env privacy prefixes only — NOT the search-noise defaults', async () => {
    await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'private/,journal/' }, () => {
      expect(resolveDeriveExcludes()).toEqual(['private/', 'journal/']);
    });
    // test/ etc. stay derivable (pinned by the extract-takes holder suites).
    await withEnv({ GBRAIN_SEARCH_EXCLUDE: undefined }, () => {
      expect(resolveDeriveExcludes()).toEqual([]);
    });
  });
});

describe('extract_facts skips excluded-prefix pages (#2780)', () => {
  test('excluded slug never reaches getPage', async () => {
    const fetched: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        if (sql.includes('row_num IS NULL')) return [{ n: '0' }];
        return [];
      },
      getPage: async (slug: string) => { fetched.push(slug); return null; },
    } as unknown as BrainEngine;

    const result = await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'private/' }, () =>
      runExtractFacts(engine, { slugs: ['private/journal', 'people/alice-example'], dryRun: true }),
    );
    expect(fetched).toEqual(['people/alice-example']);
    expect(result.pagesScanned).toBe(1);
  });
});

describe('extract_takes skips excluded-prefix pages (#2780)', () => {
  test('db path: excluded slug never reaches getPage', async () => {
    const fetched: string[] = [];
    const engine = {
      getPage: async (slug: string) => { fetched.push(slug); return null; },
    } as unknown as BrainEngine;

    const result = await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'private/' }, () =>
      extractTakesFromDb(engine, { slugs: ['private/journal', 'people/alice-example'], dryRun: true }),
    );
    expect(fetched).toEqual(['people/alice-example']);
    expect(result.pagesScanned).toBe(1);
  });
});

describe('chronicle extract skips excluded-prefix pages (#2780)', () => {
  test('excluded slug returns skipped/excluded_prefix without reading the page', async () => {
    let getPageCalled = false;
    const engine = {
      getPage: async () => { getPageCalled = true; return null; },
    } as unknown as BrainEngine;

    const result = await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'private/' }, () =>
      runChronicleExtract(engine, { slug: 'private/journal' }),
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('excluded_prefix');
    expect(getPageCalled).toBe(false);
  });
});
