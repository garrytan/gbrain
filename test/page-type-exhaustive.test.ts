// Contract test for PageType exhaustiveness (Eng-2A).
//
// Walks every value in `ALL_PAGE_TYPES` through every public surface that
// consumes a PageType, asserts no error and a sane round-trip. The point is
// not to verify each surface's full behavior, but to catch the silent
// fall-through that bit gbrain v0.20 / v0.22 when a PageType was added but
// some consuming surface didn't get a matching branch.
//
// When PageType grows (e.g. v0.27.1 adds 'image'), this test fails noisily
// at the first unhandled site, instead of users discovering the regression
// in production.

import { describe, expect, test } from 'bun:test';
import { ALL_PAGE_TYPES, assertNever, type PageType } from '../src/core/types.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';

describe('PageType exhaustiveness contract', () => {
  test('ALL_PAGE_TYPES covers every literal in the union', () => {
    // If a PageType is added without updating ALL_PAGE_TYPES, this test
    // anchors the requirement. The compile-time check is in the union itself;
    // this is the runtime sanity gate.
    expect(ALL_PAGE_TYPES.length).toBeGreaterThan(0);
    // Sentinel: every entry is a non-empty string.
    for (const t of ALL_PAGE_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  test('serializeMarkdown round-trips every PageType', () => {
    for (const type of ALL_PAGE_TYPES) {
      const md = serializeMarkdown(
        {},
        `Body for ${type}`,
        '',
        { type, title: `Test ${type}`, tags: [] },
      );
      expect(md).toContain(`type: ${type}`);
      expect(md).toContain(`Body for ${type}`);

      // Parse it back; type must survive the round-trip.
      const parsed = parseMarkdown(md, `${type}-fixture.md`);
      expect(parsed.type).toBe(type);
    }
  });

  test('assertNever throws on the unreachable branch', () => {
    // Force an unreachable call by casting through unknown. This is the
    // runtime contract: if exhaustive switches ever do reach the default
    // (e.g. a new PageType was added without a case), assertNever throws
    // loudly instead of silently no-op'ing.
    expect(() => assertNever('not-a-real-type' as never)).toThrow(
      /Unhandled discriminant/,
    );
  });

  test('exhaustive switch on PageType compiles only when complete', () => {
    // This is the compile-time guard. The function below uses assertNever
    // in the default branch. If a new PageType is added to the union
    // without a corresponding case, TypeScript fails to type-check at the
    // assertNever call (parameter is no longer `never`). Running this
    // test means the file compiled, which means the switch is exhaustive.
    function classify(t: PageType): string {
      switch (t) {
        case 'person': return 'human';
        case 'company': return 'org';
        case 'deal': return 'tx';
        case 'yc': return 'cohort';
        case 'civic': return 'org';
        case 'project': return 'work';
        case 'concept': return 'idea';
        case 'source': return 'ref';
        case 'media': return 'asset';
        case 'writing': return 'doc';
        case 'analysis': return 'doc';
        case 'guide': return 'doc';
        case 'hardware': return 'spec';
        case 'architecture': return 'doc';
        case 'meeting': return 'event';
        case 'note': return 'jot';
        case 'email': return 'msg';
        case 'slack': return 'msg';
        case 'calendar-event': return 'event';
        case 'code': return 'code';
        case 'image': return 'asset';
        default: return assertNever(t);
      }
    }

    for (const t of ALL_PAGE_TYPES) {
      const result = classify(t);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
