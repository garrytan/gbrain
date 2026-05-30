// Commit 1 (Phase 1): cross-modal intent + hybrid routing + knobsHash + RRF.
//
// Covers:
//   - suggestedModality regex matches (positive + negative + plural-safe)
//   - isAmbiguousModalityQuery heuristic
//   - SEARCH_MODE_CONFIG_KEYS registry includes new keys (D3)
//   - knobsHash differs across cross-modal knob values (D2)
//   - knobsHash version bumped to 3
//   - MODE_BUNDLES carry cross-modal defaults

import { describe, expect, test } from 'bun:test';
import {
  classifyQuery,
  isAmbiguousModalityQuery,
  type ModalityMode,
} from '../src/core/search/query-intent.ts';
import {
  KNOBS_HASH_VERSION,
  MODE_BUNDLES,
  SEARCH_MODE_CONFIG_KEYS,
  knobsHash,
  resolveSearchMode,
  type ResolvedSearchKnobs,
} from '../src/core/search/mode.ts';

describe('query-intent — suggestedModality regex (D6 + D14)', () => {
  test('"show me photos from the hackathon" → image', () => {
    expect(classifyQuery('show me photos from the hackathon').suggestedModality).toBe('image');
  });

  test('"what is founder mode?" → text (default)', () => {
    expect(classifyQuery('what is founder mode?').suggestedModality).toBe('text');
  });

  const imagePhrasings: Array<[string, ModalityMode]> = [
    ['find images from last week', 'image'],
    ['find me images of acme', 'image'],
    ['what does the OG photo look like', 'image'],
    ['screenshot of the dashboard', 'image'],
    ['diagram of the architecture', 'image'],
    ['visuals showing the trends', 'image'],
    ['whiteboard from the offsite', 'image'],
    ['pictures of the team', 'image'],
    ['pull me the screenshots', 'image'],
  ];

  for (const [query, expected] of imagePhrasings) {
    test(`image phrasing: "${query}" → ${expected}`, () => {
      expect(classifyQuery(query).suggestedModality).toBe(expected);
    });
  }

  const textPhrasings = [
    'who is acme corp',
    'tell me about founder mode',
    'what happened at the hackathon',
    'meeting notes from yesterday',
    'most recent take on AI',
  ];

  for (const query of textPhrasings) {
    test(`text phrasing: "${query}" → text`, () => {
      expect(classifyQuery(query).suggestedModality).toBe('text');
    });
  }
});

describe('isAmbiguousModalityQuery (Commit 4 prep)', () => {
  // Genuinely ambiguous = visual noun present + reference marker present BUT
  // CROSS_MODAL_PATTERNS doesn't catch it (otherwise regex already classified
  // confidently and the LLM call would be wasted).

  test('"any picture during last week" → ambiguous', () => {
    // "picture during" doesn't match (of|from|at|with|...) so CROSS_MODAL
    // doesn't fire; "any pictures" does match the AMBIGUOUS_REFERENCE marker.
    // Actually "any picture" matches /\b(any|some|...)\s+(pics?|photos?|images?...)/ — but
    // the CROSS_MODAL pattern needs "pictures from/of/at/...". This phrasing
    // has neither — so it's genuinely ambiguous.
    expect(isAmbiguousModalityQuery('any picture during last week')).toBe(true);
  });

  test('"what is founder mode" → not ambiguous (plain text query)', () => {
    expect(isAmbiguousModalityQuery('what is founder mode')).toBe(false);
  });

  test('"show me photos of acme" → not ambiguous (regex catches it)', () => {
    // Already-confident classification, no LLM needed.
    expect(isAmbiguousModalityQuery('show me photos of acme')).toBe(false);
  });

  test('"any pictures from the meeting" → not ambiguous (regex catches "pictures from")', () => {
    // CROSS_MODAL fires on "pictures from" — confident classification.
    expect(isAmbiguousModalityQuery('any pictures from the meeting')).toBe(false);
  });

  test('"chart" without article/determiner → not ambiguous (bare visual noun has no reference marker)', () => {
    // No "any|some|that|the" determiner in front of the visual noun, and no
    // "from last/this/the X" phrase — pure text query.
    expect(isAmbiguousModalityQuery('chart')).toBe(false);
  });

  test('"the chart" alone → ambiguous (determiner+visual-noun is a real reference marker)', () => {
    // "the chart" is the canonical ambiguous case — user references a
    // specific visual asset without confirming they want image search.
    // LLM tie-break decides.
    expect(isAmbiguousModalityQuery('the chart')).toBe(true);
  });

  test('"the diagram in last week\'s deck" → ambiguous', () => {
    // "diagram in" doesn't match CROSS_MODAL (of|from|about|showing only).
    // "the diagram" matches AMBIGUOUS_REFERENCE first pattern.
    expect(isAmbiguousModalityQuery("the diagram in last week's deck")).toBe(true);
  });
});

describe('D3 — SEARCH_MODE_CONFIG_KEYS registry includes cross-modal keys', () => {
  const expected = [
    'search.cross_modal.both_mode_text_weight',
    'search.cross_modal.both_mode_image_weight',
    'search.image_query.text_refinement_weight',
    'search.image_query.image_refinement_weight',
    'search.unified_multimodal',
    'search.unified_multimodal_only',
    'search.cross_modal.llm_intent',
  ];

  for (const key of expected) {
    test(`registry contains ${key}`, () => {
      expect(SEARCH_MODE_CONFIG_KEYS).toContain(key);
    });
  }
});

describe('D2 — knobsHash differs across cross-modal knob values', () => {
  function baseKnobs(): ResolvedSearchKnobs {
    return resolveSearchMode({ mode: 'balanced' });
  }

  test('KNOBS_HASH_VERSION is 6 (v=4 graph_signals + schema-pack; v=5 contextual_retrieval; v=6 alias_resolved; cross-modal still appended)', () => {
    // v0.35 ladder: 1→2 reranker, 2→3 floor_ratio. v0.36 piggybacks on v=3
    // with 7 cross-modal knobs + column/provider context. v0.40.4 (salem) +
    // v0.39 T21 (master) bump to v=4 for graph_signals + schema-pack fields.
    // v0.40.3.0 D8 bumps to v=5 (sequenced behind salem's v=4 graph-signals).
    // v0.41.22.0 (type-unification): 5→6 for alias_resolved post-fusion boost.
    expect(KNOBS_HASH_VERSION).toBe(7);
  });

  test('flipping unified_multimodal changes the hash', () => {
    const k1 = baseKnobs();
    const k2 = { ...k1, unified_multimodal: true };
    expect(knobsHash(k1)).not.toBe(knobsHash(k2));
  });

  test('flipping unified_multimodal_only changes the hash', () => {
    const k1 = baseKnobs();
    const k2 = { ...k1, unified_multimodal_only: true };
    expect(knobsHash(k1)).not.toBe(knobsHash(k2));
  });

  test('flipping cross_modal_llm_intent changes the hash', () => {
    const k1 = baseKnobs();
    const k2 = { ...k1, cross_modal_llm_intent: true };
    expect(knobsHash(k1)).not.toBe(knobsHash(k2));
  });

  test('changing cross_modal_both_text_weight changes the hash', () => {
    const k1 = baseKnobs();
    const k2 = { ...k1, cross_modal_both_text_weight: 0.5 };
    expect(knobsHash(k1)).not.toBe(knobsHash(k2));
  });

  test('changing image_query_text_refinement_weight changes the hash', () => {
    const k1 = baseKnobs();
    const k2 = { ...k1, image_query_text_refinement_weight: 0.7 };
    expect(knobsHash(k1)).not.toBe(knobsHash(k2));
  });

  test('identical knobs produce identical hashes (regression sanity)', () => {
    expect(knobsHash(baseKnobs())).toBe(knobsHash(baseKnobs()));
  });
});

describe('D6 — MODE_BUNDLES carry cross-modal defaults', () => {
  test('all three modes default cross_modal_both_text_weight to 0.6', () => {
    expect(MODE_BUNDLES.conservative.cross_modal_both_text_weight).toBe(0.6);
    expect(MODE_BUNDLES.balanced.cross_modal_both_text_weight).toBe(0.6);
    expect(MODE_BUNDLES.tokenmax.cross_modal_both_text_weight).toBe(0.6);
  });

  test('all three modes default cross_modal_both_image_weight to 0.4', () => {
    expect(MODE_BUNDLES.conservative.cross_modal_both_image_weight).toBe(0.4);
    expect(MODE_BUNDLES.balanced.cross_modal_both_image_weight).toBe(0.4);
    expect(MODE_BUNDLES.tokenmax.cross_modal_both_image_weight).toBe(0.4);
  });

  test('all three modes default image_query weights (D13: 0.4 text / 0.6 image)', () => {
    expect(MODE_BUNDLES.conservative.image_query_text_refinement_weight).toBe(0.4);
    expect(MODE_BUNDLES.conservative.image_query_image_refinement_weight).toBe(0.6);
    expect(MODE_BUNDLES.tokenmax.image_query_image_refinement_weight).toBe(0.6);
  });

  test('all three modes default unified_multimodal to false (opt-in)', () => {
    expect(MODE_BUNDLES.conservative.unified_multimodal).toBe(false);
    expect(MODE_BUNDLES.balanced.unified_multimodal).toBe(false);
    expect(MODE_BUNDLES.tokenmax.unified_multimodal).toBe(false);
  });

  test('all three modes default cross_modal_llm_intent to false (opt-in)', () => {
    expect(MODE_BUNDLES.conservative.cross_modal_llm_intent).toBe(false);
    expect(MODE_BUNDLES.balanced.cross_modal_llm_intent).toBe(false);
    expect(MODE_BUNDLES.tokenmax.cross_modal_llm_intent).toBe(false);
  });
});

describe('resolveSearchMode threads cross-modal overrides', () => {
  test('per-call override beats config override beats mode default', () => {
    const k = resolveSearchMode({
      mode: 'balanced',
      overrides: { cross_modal_both_text_weight: 0.5 },
      perCall: { cross_modal_both_text_weight: 0.8 },
    });
    expect(k.cross_modal_both_text_weight).toBe(0.8);
  });

  test('config override wins when no per-call override', () => {
    const k = resolveSearchMode({
      mode: 'balanced',
      overrides: { unified_multimodal: true },
    });
    expect(k.unified_multimodal).toBe(true);
  });

  test('mode default fires when neither override is set', () => {
    const k = resolveSearchMode({ mode: 'balanced' });
    expect(k.cross_modal_both_text_weight).toBe(0.6);
    expect(k.cross_modal_both_image_weight).toBe(0.4);
  });
});
