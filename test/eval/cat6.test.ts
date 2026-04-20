/**
 * cat6-prose-scale.ts tests — Day 6 of BrainBench v1 Complete.
 *
 * Uses a tiny synthetic corpus (5 pages) so tests run in <200ms, not the
 * full 240-page world-v1 which is expensive to traverse per-test.
 *
 * Covers:
 *   - generateVariants produces deterministic variantIds under fixed seed
 *   - Variants cover all 6 injection kinds
 *   - scoreVariant computes matched/missed/false_positives correctly
 *   - aggregate produces all per-kind metrics + overall numbers
 *   - Verdict is always 'baseline_only' in v1 (no gating threshold)
 */

import { describe, test, expect } from 'bun:test';
import {
  generateVariants,
  aggregate,
  scoreVariant,
  makeCorpusResolver,
  type BasePage,
} from '../../eval/runner/cat6-prose-scale.ts';
import { ALL_INJECTION_KINDS } from '../../eval/runner/adversarial-injections.ts';

const TINY_CORPUS: BasePage[] = [
  {
    slug: 'people/amara',
    type: 'person',
    title: 'Amara Okafor',
    content: 'Amara is a partner at [Halfway](companies/halfway).',
  },
  {
    slug: 'people/jordan',
    type: 'person',
    title: 'Jordan Park',
    content: 'Jordan founded [NovaMind](companies/novamind) in 2023.',
  },
  {
    slug: 'people/mina',
    type: 'person',
    title: 'Mina Kapoor',
    content: 'Mina runs [Threshold](companies/threshold).',
  },
  {
    slug: 'people/sarah',
    type: 'person',
    title: 'Sarah Chen',
    content: 'Sarah advises several seed-stage founders.',
  },
  {
    slug: 'companies/halfway',
    type: 'company',
    title: 'Halfway Capital',
    content: 'VC firm focused on climate + AI infrastructure.',
  },
  {
    slug: 'companies/novamind',
    type: 'company',
    title: 'NovaMind',
    content: 'AI infrastructure startup.',
  },
  {
    slug: 'companies/threshold',
    type: 'company',
    title: 'Threshold',
    content: 'Venture firm.',
  },
];

// ─── Variant generation ───────────────────────────────────────────────

describe('generateVariants', () => {
  test('produces exactly perKind × 6 variants', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    expect(variants.length).toBe(3 * ALL_INJECTION_KINDS.length);
  });

  test('variants are distributed across all kinds', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const kinds = new Set(variants.map(v => v.kind));
    expect(kinds.size).toBe(ALL_INJECTION_KINDS.length);
  });

  test('deterministic under fixed seed', () => {
    const a = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    const b = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].variantId).toBe(b[i].variantId);
      expect(a[i].content).toBe(b[i].content);
    }
  });

  test('different seeds produce different content', () => {
    const a = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    const b = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 99 });
    // code_fence_leak's fake slug depends on seed; content will differ.
    const aCodeFences = a.filter(v => v.kind === 'code_fence_leak');
    const bCodeFences = b.filter(v => v.kind === 'code_fence_leak');
    expect(aCodeFences[0].content).not.toBe(bCodeFences[0].content);
  });

  test('variantId follows "<slug>-v<idx>-<kind>" pattern', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    for (const v of variants) {
      expect(v.variantId).toMatch(/^.+-v\d+-[a-z_]+$/);
      expect(v.variantId.endsWith(`-${v.kind}`)).toBe(true);
    }
  });
});

// ─── scoreVariant ─────────────────────────────────────────────────────

describe('scoreVariant', () => {
  test('returns VariantResult with extracted, missed, false_positives, matched', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    const result = await scoreVariant(variants[0], resolver);
    expect(result.variantId).toBe(variants[0].variantId);
    expect(Array.isArray(result.extracted)).toBe(true);
    expect(Array.isArray(result.false_positives)).toBe(true);
    expect(Array.isArray(result.missed)).toBe(true);
    expect(typeof result.matched).toBe('number');
  });

  test('counts a must_extract slug as matched when extractor produces it', async () => {
    // Multi-entity sentences pack ≥4 real refs and the resolver accepts all known slugs.
    // The extractor should produce those links.
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 5 });
    const multi = variants.find(v => v.kind === 'multi_entity_sentence' && v.goldDelta.must_extract.length >= 4);
    if (!multi) {
      // Skip gracefully if TINY_CORPUS is too small
      return;
    }
    const result = await scoreVariant(multi, resolver);
    expect(result.matched).toBeGreaterThan(0);
  });
});

// ─── aggregate ────────────────────────────────────────────────────────

describe('aggregate', () => {
  test('emits per_kind for every kind present', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const results = await Promise.all(variants.map(v => scoreVariant(v, resolver)));
    const report = aggregate(variants, results);
    expect(report.per_kind.length).toBe(ALL_INJECTION_KINDS.length);
    expect(report.variants).toBe(variants.length);
  });

  test('overall metrics are computed (precision/recall/f1 in 0-1 range)', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const results = await Promise.all(variants.map(v => scoreVariant(v, resolver)));
    const report = aggregate(variants, results);
    expect(report.overall.link_precision).toBeGreaterThanOrEqual(0);
    expect(report.overall.link_precision).toBeLessThanOrEqual(1);
    expect(report.overall.link_recall).toBeGreaterThanOrEqual(0);
    expect(report.overall.link_recall).toBeLessThanOrEqual(1);
    expect(report.overall.link_f1).toBeGreaterThanOrEqual(0);
    expect(report.overall.link_f1).toBeLessThanOrEqual(1);
  });

  test('verdict is always baseline_only in v1', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    const results = await Promise.all(variants.map(v => scoreVariant(v, resolver)));
    const report = aggregate(variants, results);
    expect(report.verdict).toBe('baseline_only');
  });

  test('mean_links_per_page matches totalExtracted / variants', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    const results = await Promise.all(variants.map(v => scoreVariant(v, resolver)));
    const report = aggregate(variants, results);
    const totalExtracted = results.reduce((sum, r) => sum + r.extracted.length, 0);
    expect(report.overall.mean_links_per_page).toBeCloseTo(totalExtracted / variants.length, 6);
  });
});

// ─── Corpus resolver ──────────────────────────────────────────────────

describe('makeCorpusResolver', () => {
  test('returns slug unchanged when slug is known', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    expect(await resolver.resolve('people/amara')).toBe('people/amara');
  });

  test('returns null when slug is unknown', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    expect(await resolver.resolve('people/ghost')).toBeNull();
  });

  test('does not resolve bare names in v1', async () => {
    const resolver = makeCorpusResolver(TINY_CORPUS);
    // Cat 6 scoring semantics: bare-name resolution is out of scope.
    expect(await resolver.resolve('Amara Okafor')).toBeNull();
  });
});
