/**
 * adversarial-injections.ts tests — Day 6 of BrainBench v1 Complete.
 *
 * Covers every injection kind:
 *   - Each produces deterministic output under same seed
 *   - goldDelta.must_not_extract lists the adversarial slug for negative injections
 *   - goldDelta.must_extract lists real targets for positive assertions
 *   - applyInjection dispatcher returns the same output as the direct function
 */

import { describe, test, expect } from 'bun:test';
import {
  applyInjection,
  injectCodeFenceLeak,
  injectInlineCodeSlug,
  injectSubstringCollision,
  injectAmbiguousRole,
  injectProseOnlyMention,
  injectMultiEntitySentence,
  ALL_INJECTION_KINDS,
  type EntityRef,
} from '../../eval/runner/adversarial-injections.ts';

const REFS: EntityRef[] = [
  { slug: 'people/amara-okafor', name: 'Amara Okafor' },
  { slug: 'people/jordan-park', name: 'Jordan Park' },
  { slug: 'people/mina-kapoor', name: 'Mina Kapoor' },
  { slug: 'people/sarah-chen', name: 'Sarah Chen' },
  { slug: 'people/priya-patel', name: 'Priya Patel' },
  { slug: 'companies/halfway-capital', name: 'Halfway Capital' },
  { slug: 'companies/novamind', name: 'NovaMind' },
];

const BASE_CONTENT = 'This is a fictional biographical page. She is well-known in the climate deals space.';

// ─── Per-kind assertions ─────────────────────────────────────────────

describe('injectCodeFenceLeak', () => {
  test('wraps a fake slug inside triple-backtick fence', () => {
    const res = injectCodeFenceLeak({ content: BASE_CONTENT, seed: 1, refs: REFS });
    expect(res.content).toContain('```');
    const fakeSlug = res.goldDelta.must_not_extract[0].slug;
    expect(fakeSlug).toMatch(/^people\/fake-\d+$/);
    expect(res.content).toContain(fakeSlug);
  });

  test('leaves a real mention outside the fence', () => {
    const res = injectCodeFenceLeak({ content: BASE_CONTENT, seed: 1, refs: REFS });
    expect(res.goldDelta.must_extract.length).toBeGreaterThan(0);
    const realSlug = res.goldDelta.must_extract[0].slug;
    // Real slug should appear OUTSIDE the fence
    const fenceEnd = res.content.lastIndexOf('```');
    const afterFence = res.content.slice(fenceEnd + 3);
    expect(afterFence).toContain(realSlug);
  });

  test('deterministic under same seed', () => {
    const a = injectCodeFenceLeak({ content: BASE_CONTENT, seed: 42, refs: REFS });
    const b = injectCodeFenceLeak({ content: BASE_CONTENT, seed: 42, refs: REFS });
    expect(a.content).toEqual(b.content);
  });
});

describe('injectInlineCodeSlug', () => {
  test('wraps slug in single-backtick inline code', () => {
    const res = injectInlineCodeSlug({ content: BASE_CONTENT, seed: 1, refs: REFS });
    const fakeSlug = res.goldDelta.must_not_extract[0].slug;
    expect(res.content).toContain(`\`${fakeSlug}\``);
  });
});

describe('injectSubstringCollision', () => {
  test('injects a "<Name>AI" substring near a real mention', () => {
    const forced: EntityRef[] = [{ slug: 'people/sam', name: 'Sam' }];
    const res = injectSubstringCollision({ content: BASE_CONTENT, seed: 1, refs: REFS, forcedRefs: forced });
    expect(res.content).toContain('SamAI');
    expect(res.content).toContain('[Sam](people/sam)');
    expect(res.goldDelta.must_not_extract[0].slug).toBe('people/samai');
  });
});

describe('injectAmbiguousRole', () => {
  test('replaces "works at" with "works with" when present', () => {
    const input = 'Alice works at [Acme](companies/acme).';
    const res = injectAmbiguousRole({ content: input, seed: 1, refs: REFS });
    expect(res.content).toContain('works with');
    expect(res.content).not.toContain('works at');
  });

  test('appends a works-with sentence when source has no "works at"', () => {
    const res = injectAmbiguousRole({ content: 'plain prose.', seed: 1, refs: REFS });
    expect(res.content).toContain('works with');
  });

  test('goldDelta says type must be mentions, not works_at', () => {
    const res = injectAmbiguousRole({ content: 'plain prose.', seed: 1, refs: REFS });
    expect(res.goldDelta.must_extract[0].type).toBe('mentions');
  });
});

describe('injectProseOnlyMention', () => {
  test('strips [name](slug) syntax leaving bare name', () => {
    const forced: EntityRef[] = [{ slug: 'people/jordan-park', name: 'Jordan Park' }];
    const input = 'I met [Jordan Park](people/jordan-park) yesterday.';
    const res = injectProseOnlyMention({ content: input, seed: 1, refs: REFS, forcedRefs: forced });
    expect(res.content).not.toContain('[Jordan Park]');
    expect(res.content).not.toContain('(people/jordan-park)');
    expect(res.content).toContain('Jordan Park');
  });

  test('goldDelta requires extraction as mentions', () => {
    const forced: EntityRef[] = [{ slug: 'people/jordan-park', name: 'Jordan Park' }];
    const input = 'I met [Jordan Park](people/jordan-park) yesterday.';
    const res = injectProseOnlyMention({ content: input, seed: 1, refs: REFS, forcedRefs: forced });
    expect(res.goldDelta.must_extract[0]).toEqual({
      slug: 'people/jordan-park',
      type: 'mentions',
      reason: expect.any(String),
    });
  });
});

describe('injectMultiEntitySentence', () => {
  test('packs 4+ entities into one clause', () => {
    const res = injectMultiEntitySentence({ content: BASE_CONTENT, seed: 1, refs: REFS });
    expect(res.goldDelta.must_extract.length).toBeGreaterThanOrEqual(4);
    // Every must_extract slug should appear in content as markdown link
    for (const m of res.goldDelta.must_extract) {
      expect(res.content).toContain(`](${m.slug})`);
    }
  });

  test('skips gracefully when fewer than 4 refs are available', () => {
    const res = injectMultiEntitySentence({
      content: BASE_CONTENT,
      seed: 1,
      refs: REFS.slice(0, 2),
    });
    expect(res.goldDelta.must_extract.length).toBe(0);
    expect(res.goldDelta.note).toContain('skipped');
  });

  test('picks are unique (no duplicate slugs in one clause)', () => {
    const res = injectMultiEntitySentence({ content: BASE_CONTENT, seed: 1, refs: REFS });
    const slugs = res.goldDelta.must_extract.map(m => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

// ─── Dispatcher + kind coverage ──────────────────────────────────────

describe('applyInjection dispatcher', () => {
  test('ALL_INJECTION_KINDS lists exactly 6 kinds', () => {
    expect(ALL_INJECTION_KINDS.length).toBe(6);
  });

  test('dispatcher produces same output as the direct function (code_fence_leak)', () => {
    const direct = injectCodeFenceLeak({ content: BASE_CONTENT, seed: 5, refs: REFS });
    const viaDispatch = applyInjection('code_fence_leak', { content: BASE_CONTENT, seed: 5, refs: REFS });
    expect(viaDispatch.content).toBe(direct.content);
  });

  test('every kind produces a non-empty note in goldDelta', () => {
    for (const kind of ALL_INJECTION_KINDS) {
      const res = applyInjection(kind, { content: BASE_CONTENT, seed: 7, refs: REFS });
      expect(res.goldDelta.note.length).toBeGreaterThan(0);
    }
  });

  test('every kind produces valid slug format in gold entries', () => {
    const SLUG_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
    for (const kind of ALL_INJECTION_KINDS) {
      const res = applyInjection(kind, { content: BASE_CONTENT, seed: 9, refs: REFS });
      for (const m of res.goldDelta.must_extract) expect(m.slug).toMatch(SLUG_RE);
      for (const m of res.goldDelta.must_not_extract) {
        // Fake slugs are built to resemble real slug shape
        expect(m.slug).toMatch(SLUG_RE);
      }
    }
  });
});
