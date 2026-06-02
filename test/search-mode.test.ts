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
  // v0.36 cross-modal wave: shared defaults across all modes (opt-in).
  const CROSS_MODAL_DEFAULTS = {
    cross_modal_both_text_weight: 0.6,
    cross_modal_both_image_weight: 0.4,
    image_query_text_refinement_weight: 0.4,
    image_query_image_refinement_weight: 0.6,
    unified_multimodal: false,
    unified_multimodal_only: false,
    cross_modal_llm_intent: false,
  };

  // v0.40.3.0 contextual retrieval per-mode defaults. Tests below spread
  // this AFTER CROSS_MODAL_DEFAULTS so each per-mode block overrides
  // contextual_retrieval to its tier value.
  const CR_DISABLED_DEFAULT = { contextual_retrieval_disabled: false };

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
      floor_ratio: undefined,
      title_boost: 1.25,
      ...CROSS_MODAL_DEFAULTS,
      graph_signals: false,
      ...CR_DISABLED_DEFAULT,
      contextual_retrieval: 'none',
      // v0.42.3.0 — autocut OFF for conservative (no reranker).
      autocut: false,
      autocut_jump: 0.2,
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
      // v0.42.3.0 D4: topNIn = searchLimit (25), was 30.
      reranker_top_n_in: 25,
      reranker_top_n_out: null,
      reranker_timeout_ms: 5000,
      floor_ratio: undefined,
      title_boost: 1.25,
      ...CROSS_MODAL_DEFAULTS,
      graph_signals: true,
      ...CR_DISABLED_DEFAULT,
      contextual_retrieval: 'title',
      // v0.42.3.0 — autocut ON.
      autocut: true,
      autocut_jump: 0.2,
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
      // v0.42.3.0 D4: topNIn = searchLimit (50), was 30.
      reranker_top_n_in: 50,
      reranker_top_n_out: null,
      reranker_timeout_ms: 5000,
      floor_ratio: undefined,
      title_boost: 1.25,
      ...CROSS_MODAL_DEFAULTS,
      graph_signals: true,
      ...CR_DISABLED_DEFAULT,
      contextual_retrieval: 'per_chunk_synopsis',
      // v0.42.3.0 — autocut ON.
      autocut: true,
      autocut_jump: 0.2,
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

describe('v0.40.6.1 — reranker_timeout_ms threads recipe default through resolution', () => {
  // The dead-default-timeout-ms class of bugs: hybridSearch always passes
  // resolvedMode.reranker_timeout_ms to gateway.rerank(). Pre-v0.40.6.1 the
  // mode bundle's 5000ms hardcoded value always won, so recipe-level
  // default_timeout_ms was dead. These tests pin the new precedence chain:
  //   per-call > config override > recipe touchpoint default > bundle.

  test('llama-server-reranker resolves to 30000ms recipe default (no override)', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { reranker_model: 'llama-server-reranker:qwen3-reranker-4b' },
    });
    expect(r.reranker_model).toBe('llama-server-reranker:qwen3-reranker-4b');
    expect(r.reranker_timeout_ms).toBe(30_000);
  });

  test('config override beats recipe default', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: {
        reranker_model: 'llama-server-reranker:qwen3-reranker-4b',
        reranker_timeout_ms: 90_000,
      },
    });
    expect(r.reranker_timeout_ms).toBe(90_000);
  });

  test('per-call override beats config override AND recipe default', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: {
        reranker_model: 'llama-server-reranker:qwen3-reranker-4b',
        reranker_timeout_ms: 90_000,
      },
      perCall: { reranker_timeout_ms: 100 },
    });
    expect(r.reranker_timeout_ms).toBe(100);
  });

  test('ZE (no recipe default) regression: still gets bundle default of 5000ms', () => {
    // ZeroEntropy's recipe does not declare default_timeout_ms — its hosted
    // path is fast enough that the bundle default suffices.
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { reranker_model: 'zeroentropyai:zerank-2' },
    });
    expect(r.reranker_timeout_ms).toBe(5000);
  });

  test('unknown provider id falls through to bundle default', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { reranker_model: 'made-up-provider:fake-model' },
    });
    expect(r.reranker_timeout_ms).toBe(5000);
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
    // v0.35.6.0 bumped 2→3 to fold floor_ratio (codex outside-voice T1 —
    // preventing cross-floor cache contamination).
    // v0.36 piggybacks on v=3 with 7 additional cross-modal knobs (D2) PLUS
    // embedding column + provider context (D8/CDX-2 cross-column isolation),
    // all appended per CDX2-F13 append-only convention so a text-mode cache
    // hit can never silently serve to an image-mode caller, and a query
    // against `embedding_voyage` never shares a cache row with `embedding`.
    // v0.40.4 (salem) + v0.39 T21 (master): bumped 3→4 to fold graph_signals
    // (so a graph-on cache write cannot be served to a graph-off lookup) AND
    // schema-pack hash fields (pack name + pack version, so cross-pack
    // contamination is structurally impossible).
    // v0.40.3.0 (D8): bumped 4→5 to add contextual_retrieval (CRMode) and
    // contextual_retrieval_disabled (kill switch). A query against a brain
    // on tokenmax (per-chunk synopsis) must not be served from a cache row
    // written when the brain was on balanced (title-only) — different
    // embedding spaces. Sequenced behind salem's v=4 graph-signals work.
    // v0.41.22.0 (type-unification): bumped 5→6 for the new alias_resolved
    // post-fusion boost stage. T2: bumped 6→7 for title_boost. v0.42.3.0:
    // bumped 7→8 for autocut (ac=/acj=). A query against a brain with
    // slug_aliases populated must not be served from a cache row written
    // before the boost stage existed.
    expect(KNOBS_HASH_VERSION).toBe(8);
  });

  test('T1 (codex): floor_ratio set vs unset produces DIFFERENT hashes (cache contamination prevention)', () => {
    // Without this, a no-floor write would be served to a floor-enabled read
    // — direct ranking-correctness leak. Same bug class CDX-4 closed in v0.32.3
    // for the other search-lite knobs.
    const noFloor = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const withFloor = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { floor_ratio: 0.85 } }));
    expect(noFloor).not.toBe(withFloor);
  });

  test('T1 (codex): different floor_ratio values produce different hashes', () => {
    // 0.85 and 0.90 are distinct cache rows. 4-decimal precision in the hash
    // input means 0.85 and 0.851 also differ (consumers tuning by hundredths
    // get a clean cache split).
    const a = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { floor_ratio: 0.85 } }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { floor_ratio: 0.90 } }));
    expect(a).not.toBe(b);
  });

  test('same floor_ratio produces same hash (idempotent cache key)', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { floor_ratio: 0.85 } }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { floor_ratio: 0.85 } }));
    expect(a).toBe(b);
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

  test('v0.35.6.0: floor_ratio parses valid 0..1 values', () => {
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '0.85' }).floor_ratio).toBe(0.85);
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '0' }).floor_ratio).toBe(0);
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '1' }).floor_ratio).toBe(1);
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '0.5' }).floor_ratio).toBe(0.5);
  });

  test('v0.35.6.0: floor_ratio rejects out-of-range values silently', () => {
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '-0.1' }).floor_ratio).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.floor_ratio': '1.5' }).floor_ratio).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.floor_ratio': 'NaN' }).floor_ratio).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.floor_ratio': 'cheese' }).floor_ratio).toBeUndefined();
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

describe('v0.40.4 — graph_signals knob', () => {
  test('default per mode: conservative=false, balanced=true, tokenmax=true', () => {
    expect(MODE_BUNDLES.conservative.graph_signals).toBe(false);
    expect(MODE_BUNDLES.balanced.graph_signals).toBe(true);
    expect(MODE_BUNDLES.tokenmax.graph_signals).toBe(true);
  });

  test('config key search.graph_signals overrides bundle (true → false)', () => {
    const ov = loadOverridesFromConfig({ 'search.graph_signals': 'false' });
    expect(ov.graph_signals).toBe(false);
    const resolved = resolveSearchMode({ mode: 'balanced', overrides: ov });
    expect(resolved.graph_signals).toBe(false);
  });

  test('config key search.graph_signals overrides bundle (false → true)', () => {
    const ov = loadOverridesFromConfig({ 'search.graph_signals': '1' });
    expect(ov.graph_signals).toBe(true);
    const resolved = resolveSearchMode({ mode: 'conservative', overrides: ov });
    expect(resolved.graph_signals).toBe(true);
  });

  test('per-call overrides config + mode bundle', () => {
    const resolved = resolveSearchMode({
      mode: 'balanced',
      overrides: { graph_signals: false },
      perCall: { graph_signals: true },
    });
    expect(resolved.graph_signals).toBe(true);
  });

  test('knobsHash distinct for graph_signals=true vs =false', () => {
    const on = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { graph_signals: true } }));
    const off = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { graph_signals: false } }));
    expect(on).not.toBe(off);
  });

  test('SEARCH_MODE_CONFIG_KEYS includes search.graph_signals', () => {
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.graph_signals');
  });

  test('attributeKnob reports source correctly for graph_signals', () => {
    const input = { mode: 'balanced', perCall: { graph_signals: false } };
    const resolved = resolveSearchMode(input);
    const attr = attributeKnob('graph_signals', input, resolved);
    expect(attr.source).toBe('per-call');
    expect(attr.value).toBe(false);
  });

  test('attributeKnob mode source when no override', () => {
    const input = { mode: 'tokenmax' };
    const resolved = resolveSearchMode(input);
    const attr = attributeKnob('graph_signals', input, resolved);
    expect(attr.source).toBe('mode');
    expect(attr.value).toBe(true);
  });
});

describe('v0.42.3.0 — autocut knobs', () => {
  test('KNOBS_HASH_VERSION bumped to 7', () => {
    expect(KNOBS_HASH_VERSION).toBe(8);
  });

  test('bundle defaults: conservative off, balanced/tokenmax on @0.20', () => {
    expect(MODE_BUNDLES.conservative.autocut).toBe(false);
    expect(MODE_BUNDLES.balanced.autocut).toBe(true);
    expect(MODE_BUNDLES.tokenmax.autocut).toBe(true);
    for (const m of ['conservative', 'balanced', 'tokenmax'] as const) {
      expect(MODE_BUNDLES[m].autocut_jump).toBe(0.2);
    }
  });

  test('D4: reranked modes set top_n_in = searchLimit (no unscored tail)', () => {
    expect(MODE_BUNDLES.balanced.reranker_top_n_in).toBe(MODE_BUNDLES.balanced.searchLimit);
    expect(MODE_BUNDLES.tokenmax.reranker_top_n_in).toBe(MODE_BUNDLES.tokenmax.searchLimit);
    expect(MODE_BUNDLES.balanced.reranker_top_n_in).toBe(25);
    expect(MODE_BUNDLES.tokenmax.reranker_top_n_in).toBe(50);
  });

  test('resolveSearchMode threads autocut: per-call > config > bundle', () => {
    // per-call wins
    expect(resolveSearchMode({ mode: 'balanced', perCall: { autocut: false } }).autocut).toBe(false);
    // config override wins over bundle
    expect(resolveSearchMode({ mode: 'balanced', overrides: { autocut: false } }).autocut).toBe(false);
    // per-call beats config
    expect(
      resolveSearchMode({ mode: 'balanced', overrides: { autocut: false }, perCall: { autocut: true } }).autocut,
    ).toBe(true);
    // jump knob threads too
    expect(resolveSearchMode({ mode: 'balanced', perCall: { autocut_jump: 0.5 } }).autocut_jump).toBe(0.5);
  });

  test('loadOverridesFromConfig reads search.autocut + search.autocut_jump', () => {
    const ov = loadOverridesFromConfig({ 'search.autocut': 'false', 'search.autocut_jump': '0.35' });
    expect(ov.autocut).toBe(false);
    expect(ov.autocut_jump).toBe(0.35);
  });

  test('SEARCH_MODE_CONFIG_KEYS includes the autocut keys', () => {
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.autocut');
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.autocut_jump');
  });

  test('knobsHash includes ac= / acj= — autocut-on vs off differ', () => {
    const on = knobsHash(resolveSearchMode({ mode: 'balanced' })); // autocut true
    const off = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut: false } }));
    expect(on).not.toBe(off);
  });

  test('knobsHash differs on jump sensitivity', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut_jump: 0.5 } }));
    expect(a).not.toBe(b);
  });

  test('attributeKnob reports autocut source', () => {
    const input = { mode: 'balanced', perCall: { autocut: false } };
    const resolved = resolveSearchMode(input);
    const attr = attributeKnob('autocut', input, resolved);
    expect(attr.source).toBe('per-call');
    expect(attr.value).toBe(false);
  });
});
