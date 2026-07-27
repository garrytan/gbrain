import { describe, test, expect } from 'bun:test';
import {
  resolveContextualRetrievalMode,
  crModeDistinct,
  ALL_CR_MODES,
} from '../src/core/contextual-retrieval-resolver.ts';

describe('resolveContextualRetrievalMode — 9-combo override matrix', () => {
  // The override resolution chain (highest wins):
  //   page frontmatter > source row > global mode bundle
  //
  // For each (page-fm, source-row) pair × 3 global modes, the resolver
  // should return the highest-precedence non-NULL value. Mount-trust
  // gate flips the page-frontmatter eligibility for non-host sources.

  const HOST = {
    id: 'default',
    contextual_retrieval_mode: null as string | null,
    trust_frontmatter_overrides: true,
  };

  // 1. page-fm set + source set + global set → page wins
  test('page frontmatter wins over source and global', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: { ...HOST, contextual_retrieval_mode: 'title' },
      globalMode: 'none',
    });
    expect(r.mode).toBe('per_chunk_synopsis');
    expect(r.source).toBe('page_frontmatter');
  });

  // 2. page-fm absent + source set + global set → source wins
  test('source row wins when page frontmatter absent', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { ...HOST, contextual_retrieval_mode: 'title' },
      globalMode: 'per_chunk_synopsis',
    });
    expect(r.mode).toBe('title');
    expect(r.source).toBe('source_row');
  });

  // 3. page-fm absent + source absent + global set → global wins
  test('global mode wins when no overrides', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { ...HOST },
      globalMode: 'per_chunk_synopsis',
    });
    expect(r.mode).toBe('per_chunk_synopsis');
    expect(r.source).toBe('global_mode');
  });

  // 4. page-fm set + source absent + global set → page wins
  test('page frontmatter wins over global when source unset', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'none' },
      source: { ...HOST },
      globalMode: 'per_chunk_synopsis',
    });
    expect(r.mode).toBe('none');
    expect(r.source).toBe('page_frontmatter');
  });

  // 5. page-fm absent + source set to 'none' → source wins (explicit none)
  test('source explicit none beats global', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { ...HOST, contextual_retrieval_mode: 'none' },
      globalMode: 'per_chunk_synopsis',
    });
    expect(r.mode).toBe('none');
    expect(r.source).toBe('source_row');
  });

  // 6. page-fm 'none' set explicitly → page wins (even though falsy)
  test('page frontmatter explicit none beats source', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'none' },
      source: { ...HOST, contextual_retrieval_mode: 'per_chunk_synopsis' },
      globalMode: 'title',
    });
    expect(r.mode).toBe('none');
    expect(r.source).toBe('page_frontmatter');
  });

  // 7. each mode value is parseable
  test.each(ALL_CR_MODES.map((m) => [m]))('mode %s parses through page frontmatter', (mode) => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: mode },
      source: { ...HOST },
      globalMode: 'none',
    });
    expect(r.mode).toBe(mode);
    expect(r.source).toBe('page_frontmatter');
  });

  // 8. each mode value parses through source row
  test.each(ALL_CR_MODES.map((m) => [m]))('mode %s parses through source row', (mode) => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { ...HOST, contextual_retrieval_mode: mode },
      globalMode: 'none',
    });
    expect(r.mode).toBe(mode);
    expect(r.source).toBe('source_row');
  });

  // 9. each mode value as global default
  test.each(ALL_CR_MODES.map((m) => [m]))('mode %s as global default', (mode) => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { ...HOST },
      globalMode: mode,
    });
    expect(r.mode).toBe(mode);
    expect(r.source).toBe('global_mode');
  });
});

describe('mount-trust gate (D15)', () => {
  // Per D15, a per-page `contextual_retrieval` frontmatter key in a
  // MOUNTED source's page is honored ONLY when that source's
  // trust_frontmatter_overrides is true. Host source (id='default') is
  // always trusted regardless.

  test('host source always trusts page frontmatter', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: {
        id: 'default',
        contextual_retrieval_mode: null,
        trust_frontmatter_overrides: false, // <-- false but host is trusted regardless
      },
      globalMode: 'none',
    });
    expect(r.mode).toBe('per_chunk_synopsis');
    expect(r.source).toBe('page_frontmatter');
    expect(r.frontmatter_rejected_untrusted_mount).toBeUndefined();
  });

  test('mounted source with trust_frontmatter_overrides=true honors frontmatter', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: {
        id: 'team-brain',
        contextual_retrieval_mode: null,
        trust_frontmatter_overrides: true,
      },
      globalMode: 'none',
    });
    expect(r.mode).toBe('per_chunk_synopsis');
    expect(r.source).toBe('page_frontmatter');
  });

  test('mounted source with trust_frontmatter_overrides=false rejects frontmatter', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: {
        id: 'team-brain',
        contextual_retrieval_mode: 'title',
        trust_frontmatter_overrides: false,
      },
      globalMode: 'none',
    });
    // Frontmatter rejected; source row wins.
    expect(r.mode).toBe('title');
    expect(r.source).toBe('source_row');
    expect(r.frontmatter_rejected_untrusted_mount).toBe(true);
  });

  test('mounted source with no source override + rejected frontmatter falls to global', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: {
        id: 'team-brain',
        contextual_retrieval_mode: null,
        trust_frontmatter_overrides: false,
      },
      globalMode: 'title',
    });
    expect(r.mode).toBe('title');
    expect(r.source).toBe('global_mode');
    expect(r.frontmatter_rejected_untrusted_mount).toBe(true);
  });
});

describe('invalid frontmatter values (D13)', () => {
  test('typo falls through to source/global with invalid_frontmatter_value surfaced', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk' }, // typo!
      source: {
        id: 'default',
        contextual_retrieval_mode: 'title',
        trust_frontmatter_overrides: true,
      },
      globalMode: 'none',
    });
    expect(r.mode).toBe('title'); // source wins after typo rejection
    expect(r.source).toBe('source_row');
    expect(r.invalid_frontmatter_value).toBe('per_chunk');
  });

  test('non-string frontmatter value rejected, falls through', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 42 as unknown as string },
      source: { id: 'default', contextual_retrieval_mode: null, trust_frontmatter_overrides: true },
      globalMode: 'none',
    });
    expect(r.mode).toBe('none');
    expect(r.source).toBe('global_mode');
    expect(r.invalid_frontmatter_value).toBe('42');
  });

  test('empty string frontmatter falls through', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: '' },
      source: { id: 'default', contextual_retrieval_mode: null, trust_frontmatter_overrides: true },
      globalMode: 'title',
    });
    expect(r.mode).toBe('title');
    expect(r.source).toBe('global_mode');
    expect(r.invalid_frontmatter_value).toBe('');
  });
});

describe('kill switch (D18)', () => {
  test('kill switch short-circuits to none regardless of overrides', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: { contextual_retrieval: 'per_chunk_synopsis' },
      source: {
        id: 'default',
        contextual_retrieval_mode: 'per_chunk_synopsis',
        trust_frontmatter_overrides: true,
      },
      globalMode: 'per_chunk_synopsis',
      killSwitchDisabled: true,
    });
    expect(r.mode).toBe('none');
    expect(r.source).toBe('kill_switch');
  });

  test('kill switch false runs the normal chain', () => {
    const r = resolveContextualRetrievalMode({
      pageFrontmatter: {},
      source: { id: 'default', contextual_retrieval_mode: null, trust_frontmatter_overrides: true },
      globalMode: 'title',
      killSwitchDisabled: false,
    });
    expect(r.mode).toBe('title');
    expect(r.source).toBe('global_mode');
  });
});

describe('crModeDistinct (D26 P0-4)', () => {
  test('NULL distinct from defined value', () => {
    expect(crModeDistinct(undefined, 'title')).toBe(true);
    expect(crModeDistinct(null, 'title')).toBe(true);
    expect(crModeDistinct('title', undefined)).toBe(true);
    expect(crModeDistinct('title', null)).toBe(true);
  });

  test('NULL not distinct from NULL', () => {
    expect(crModeDistinct(undefined, undefined)).toBe(false);
    expect(crModeDistinct(null, null)).toBe(false);
    expect(crModeDistinct(null, undefined)).toBe(false);
    expect(crModeDistinct(undefined, null)).toBe(false);
  });

  test('equal values not distinct', () => {
    expect(crModeDistinct('title', 'title')).toBe(false);
    expect(crModeDistinct('per_chunk_synopsis', 'per_chunk_synopsis')).toBe(false);
  });

  test('different values distinct', () => {
    expect(crModeDistinct('title', 'per_chunk_synopsis')).toBe(true);
    expect(crModeDistinct('none', 'title')).toBe(true);
  });
});
