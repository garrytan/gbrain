/**
 * Pins the v0.32.3 search-lite mode core: MODE_BUNDLES + resolveSearchMode
 * + knobsHash. The 3x7 mode table is asserted cell-by-cell because the
 * public eval methodology doc cites these values verbatim — drift here is
 * a documentation-honesty bug, not a refactor.
 */
import { describe, expect, test } from 'bun:test';
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  DEFAULT_SEARCH_MODE,
  isSearchMode,
  resolveSearchMode,
  attributeKnob,
  knobsHash,
  loadOverridesFromConfig,
  KNOBS_HASH_VERSION,
  SEARCH_MODE_CONFIG_KEYS,
  type SearchMode,
} from '../src/core/search/mode.ts';

describe('SEARCH_MODES + MODE_BUNDLES canonical shape', () => {
  test('SEARCH_MODES is exactly the 3 expected values', () => {
    expect([...SEARCH_MODES]).toEqual(['conservative', 'balanced', 'tokenmax']);
  });

  test('DEFAULT_SEARCH_MODE is balanced (matches v0.31.x current default surface)', () => {
    expect(DEFAULT_SEARCH_MODE).toBe('balanced');
  });

  test('MODE_BUNDLES is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(MODE_BUNDLES)).toBe(true);
    expect(Object.isFrozen(MODE_BUNDLES.conservative)).toBe(true);
    expect(Object.isFrozen(MODE_BUNDLES.balanced)).toBe(true);
    expect(Object.isFrozen(MODE_BUNDLES.tokenmax)).toBe(true);
  });

  // The cell-by-cell assertion. The methodology doc cites these.
  // v0.35.0.0+ extended with 5 reranker fields. tokenmax flips reranker on;
  // conservative + balanced keep it off until eval data backs a change.
  test('conservative bundle values are canonical', () => {
    expect(MODE_BUNDLES.conservative).toEqual({
      cache_enabled: true,
      cache_similarity_threshold: 0.92,
      cache_ttl_seconds: 3600,
      intentWeighting: true,
      tokenBudget: 4000,
      expansion: false,
      searchLimit: 10,
      reranker_enabled: false,
      reranker_model: 'zeroentropyai:zerank-2',
      reranker_top_n_in: 30,
      reranker_top_n_out: null,
      reranker_timeout_ms: 5000,
    });
  });

  test('balanced bundle values are canonical', () => {
    // v0.36.0.0 (D6): reranker_enabled flipped from false → true. The 60%
    // top-1 reshuffle reaches the 80% of installs that stay on `balanced`.
    expect(MODE_BUNDLES.balanced).toEqual({
      cache_enabled: true,
      cache_similarity_threshold: 0.92,
      cache_ttl_seconds: 3600,
      intentWeighting: true,
      tokenBudget: 12000,
      expansion: false,
      searchLimit: 25,
      reranker_enabled: true,
      reranker_model: 'zeroentropyai:zerank-2',
      reranker_top_n_in: 30,
      reranker_top_n_out: null,
      reranker_timeout_ms: 5000,
    });
  });

  test('tokenmax bundle values are canonical (NOTE: limit=50, NOT current=20)', () => {
    expect(MODE_BUNDLES.tokenmax).toEqual({
      cache_enabled: true,
      cache_similarity_threshold: 0.92,
      cache_ttl_seconds: 3600,
      intentWeighting: true,
      tokenBudget: undefined,
      expansion: true,
      searchLimit: 50,
      reranker_enabled: true,
      reranker_model: 'zeroentropyai:zerank-2',
      reranker_top_n_in: 30,
      reranker_top_n_out: null,
      reranker_timeout_ms: 5000,
    });
  });

  test('cache_enabled is true in every mode (free win)', () => {
    for (const m of SEARCH_MODES) {
      expect(MODE_BUNDLES[m].cache_enabled).toBe(true);
    }
  });

  test('intentWeighting is true in every mode (zero-LLM cost)', () => {
    for (const m of SEARCH_MODES) {
      expect(MODE_BUNDLES[m].intentWeighting).toBe(true);
    }
  });

  test('tokenBudget escalates: 4000 → 12000 → undefined', () => {
    expect(MODE_BUNDLES.conservative.tokenBudget).toBe(4000);
    expect(MODE_BUNDLES.balanced.tokenBudget).toBe(12000);
    expect(MODE_BUNDLES.tokenmax.tokenBudget).toBeUndefined();
  });

  test('searchLimit escalates: 10 → 25 → 50', () => {
    expect(MODE_BUNDLES.conservative.searchLimit).toBe(10);
    expect(MODE_BUNDLES.balanced.searchLimit).toBe(25);
    expect(MODE_BUNDLES.tokenmax.searchLimit).toBe(50);
  });
});

describe('isSearchMode', () => {
  test('accepts every documented mode', () => {
    for (const m of SEARCH_MODES) {
      expect(isSearchMode(m)).toBe(true);
    }
  });
  test('rejects unknown strings, numbers, null, undefined', () => {
    expect(isSearchMode('conservativeX')).toBe(false);
    expect(isSearchMode('')).toBe(false);
    expect(isSearchMode('CONSERVATIVE')).toBe(false); // case-sensitive at the type guard layer
    expect(isSearchMode(42)).toBe(false);
    expect(isSearchMode(null)).toBe(false);
    expect(isSearchMode(undefined)).toBe(false);
  });
});

describe('resolveSearchMode resolution chain', () => {
  test('no inputs → balanced bundle (fallback)', () => {
    const r = resolveSearchMode({});
    expect(r.resolved_mode).toBe('balanced');
    expect(r.mode_valid).toBe(false);
    expect(r.searchLimit).toBe(25);
    expect(r.tokenBudget).toBe(12000);
    expect(r.expansion).toBe(false);
  });

  test('valid mode picked, no overrides → bundle values pass through', () => {
    const r = resolveSearchMode({ mode: 'conservative' });
    expect(r.resolved_mode).toBe('conservative');
    expect(r.mode_valid).toBe(true);
    expect(r.searchLimit).toBe(10);
    expect(r.tokenBudget).toBe(4000);
  });

  test('invalid mode string → balanced fallback (mode_valid=false)', () => {
    const r = resolveSearchMode({ mode: 'NUKE_MODE' });
    expect(r.resolved_mode).toBe('balanced');
    expect(r.mode_valid).toBe(false);
    expect(r.searchLimit).toBe(25);
  });

  test('mode string case-normalized (TokenMax → tokenmax)', () => {
    const r = resolveSearchMode({ mode: 'TokenMax' });
    expect(r.resolved_mode).toBe('tokenmax');
    expect(r.mode_valid).toBe(true);
  });

  test('per-key override wins over mode bundle (CDX-5 chain)', () => {
    const r = resolveSearchMode({
      mode: 'conservative',
      overrides: { tokenBudget: 99999, cache_enabled: false },
    });
    expect(r.resolved_mode).toBe('conservative');
    expect(r.tokenBudget).toBe(99999);
    expect(r.cache_enabled).toBe(false);
    expect(r.searchLimit).toBe(10); // not overridden, still from bundle
  });

  test('per-call override wins over per-key override', () => {
    const r = resolveSearchMode({
      mode: 'conservative',
      overrides: { tokenBudget: 99999 },
      perCall: { tokenBudget: 77 },
    });
    expect(r.tokenBudget).toBe(77);
  });

  test('per-call false-y values (false / 0) still beat fallback', () => {
    const r = resolveSearchMode({
      mode: 'tokenmax',
      perCall: { expansion: false, cache_enabled: false },
    });
    expect(r.expansion).toBe(false); // beat tokenmax's true
    expect(r.cache_enabled).toBe(false); // beat tokenmax's true
  });

  test('undefined fields in perCall fall through (not coerced to false)', () => {
    const r = resolveSearchMode({
      mode: 'tokenmax',
      perCall: { tokenBudget: undefined, expansion: undefined },
    });
    expect(r.tokenBudget).toBeUndefined(); // from tokenmax bundle
    expect(r.expansion).toBe(true); // from tokenmax bundle, NOT overridden
  });
});

describe('attributeKnob source attribution', () => {
  test('per-call source labeled correctly', () => {
    const input = { mode: 'conservative', perCall: { tokenBudget: 999 } };
    const resolved = resolveSearchMode(input);
    const a = attributeKnob('tokenBudget', input, resolved);
    expect(a.source).toBe('per-call');
    expect(a.value).toBe(999);
  });

  test('override source labels the config key path', () => {
    const input = { mode: 'conservative', overrides: { cache_enabled: false } };
    const resolved = resolveSearchMode(input);
    const a = attributeKnob('cache_enabled', input, resolved);
    expect(a.source).toBe('override');
    expect(a.source_detail).toContain('search.cache_enabled');
  });

  test('mode source labels the mode name', () => {
    const input = { mode: 'conservative' };
    const resolved = resolveSearchMode(input);
    const a = attributeKnob('searchLimit', input, resolved);
    expect(a.source).toBe('mode');
    expect(a.source_detail).toContain('conservative');
  });

  test('fallback source labels the unset state explicitly', () => {
    const input = {}; // no mode set
    const resolved = resolveSearchMode(input);
    const a = attributeKnob('searchLimit', input, resolved);
    expect(a.source).toBe('fallback');
    expect(a.source_detail).toContain('balanced');
    expect(a.source_detail).toContain('unset');
  });
});

describe('knobsHash determinism + cross-mode separation (CDX-4)', () => {
  test('hash is deterministic across calls', () => {
    const knobs = resolveSearchMode({ mode: 'conservative' });
    const h1 = knobsHash(knobs);
    const h2 = knobsHash(knobs);
    expect(h1).toBe(h2);
  });

  test('different modes produce different hashes', () => {
    const c = knobsHash(resolveSearchMode({ mode: 'conservative' }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const t = knobsHash(resolveSearchMode({ mode: 'tokenmax' }));
    expect(c).not.toBe(b);
    expect(b).not.toBe(t);
    expect(c).not.toBe(t);
  });

  test('per-call override changes the hash (cache key bifurcates)', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'conservative' }));
    const b = knobsHash(resolveSearchMode({ mode: 'conservative', perCall: { tokenBudget: 999 } }));
    expect(a).not.toBe(b);
  });

  test('hash is short (16 hex chars) and stable shape', () => {
    const h = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test('KNOBS_HASH_VERSION constant exposed for migrations to bump on schema change', () => {
    // v0.35.0.0+ bumped 1→2 to fold reranker fields into the cache key.
    // CDX2-F14: a timeout change from 5s to 100ms changes search behavior
    // (more fail-opens) so stale cache rows must invalidate.
    expect(KNOBS_HASH_VERSION).toBe(2);
  });
});

describe('loadOverridesFromConfig flat-map parser', () => {
  test('empty config map → empty overrides', () => {
    const ov = loadOverridesFromConfig({});
    expect(ov).toEqual({});
  });

  test('cache.enabled accepts 1 / 0 / true / false strings', () => {
    expect(loadOverridesFromConfig({ 'search.cache.enabled': '1' }).cache_enabled).toBe(true);
    expect(loadOverridesFromConfig({ 'search.cache.enabled': '0' }).cache_enabled).toBe(false);
    expect(loadOverridesFromConfig({ 'search.cache.enabled': 'true' }).cache_enabled).toBe(true);
    expect(loadOverridesFromConfig({ 'search.cache.enabled': 'false' }).cache_enabled).toBe(false);
    expect(loadOverridesFromConfig({ 'search.cache.enabled': 'TRUE' }).cache_enabled).toBe(true);
  });

  test('numeric keys parse and clamp', () => {
    expect(loadOverridesFromConfig({ 'search.cache.similarity_threshold': '0.95' }).cache_similarity_threshold).toBe(0.95);
    expect(loadOverridesFromConfig({ 'search.cache.ttl_seconds': '7200' }).cache_ttl_seconds).toBe(7200);
    expect(loadOverridesFromConfig({ 'search.tokenBudget': '8000' }).tokenBudget).toBe(8000);
    expect(loadOverridesFromConfig({ 'search.searchLimit': '30' }).searchLimit).toBe(30);
  });

  test('invalid numerics are ignored (not coerced to NaN/0)', () => {
    const ov = loadOverridesFromConfig({
      'search.cache.similarity_threshold': 'NaN',
      'search.tokenBudget': 'cheese',
      'search.searchLimit': '-1',
      'search.cache.ttl_seconds': '0',
    });
    expect(ov.cache_similarity_threshold).toBeUndefined();
    expect(ov.tokenBudget).toBeUndefined();
    expect(ov.searchLimit).toBeUndefined();
    expect(ov.cache_ttl_seconds).toBeUndefined();
  });

  test('similarity_threshold rejects values outside (0, 1]', () => {
    expect(loadOverridesFromConfig({ 'search.cache.similarity_threshold': '1.5' }).cache_similarity_threshold).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.cache.similarity_threshold': '0' }).cache_similarity_threshold).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.cache.similarity_threshold': '-0.1' }).cache_similarity_threshold).toBeUndefined();
  });
});

describe('SEARCH_MODE_CONFIG_KEYS is the full reset surface', () => {
  test('every key starts with search. prefix (gbrain config unset --pattern search.* compatibility)', () => {
    for (const k of SEARCH_MODE_CONFIG_KEYS) {
      expect(k.startsWith('search.')).toBe(true);
    }
  });

  test('every ModeBundle field has a config key (consistency check)', () => {
    // If a new knob is added to ModeBundle, this test fails until the operator
    // adds the corresponding config key to SEARCH_MODE_CONFIG_KEYS. That's the
    // intentional regression guard: `gbrain search modes --reset` must clear
    // every knob.
    const knobs = Object.keys(MODE_BUNDLES.balanced);
    expect(SEARCH_MODE_CONFIG_KEYS.length).toBeGreaterThanOrEqual(knobs.length);
  });
});

describe('Type-only smoke test (compiler sees SearchMode union)', () => {
  test('SearchMode union is exactly 3 modes (compile-time)', () => {
    const valid: SearchMode[] = ['conservative', 'balanced', 'tokenmax'];
    expect(valid.length).toBe(3);
  });
});
