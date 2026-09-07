/**
 * Ranker wave, Phase E3 (Cat 13 conceptual recall) — pure pins for
 * metadata-boost-gate.ts, its thread through `runPostFusionStages`, and the
 * `metadata_boost_gate` knob plane (bundle, config parse, resolution chain,
 * knobs hash `mbg=`, registry, dashboard).
 *
 * The measured defect (E1 localization, tuning split): gbrain's own vector arm
 * nDCG@5 60.3 vs live hybrid 50.6 — post-fusion metadata boosts (backlink,
 * graph adjacency, recency) promote hub pages over gold concept pages when the
 * vector arm is the only voter (73/105 gaps had both lexical arms empty). The
 * ONE pre-registered mechanism: `search.metadata_boost_gate = lexical` skips
 * those stages when no strict keyword / title / relational row fused. Every
 * bundle lands at `always` (today's pipeline).
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_METADATA_BOOST_GATE,
  METADATA_BOOST_GATES,
  decideMetadataBoosts,
  lexicalArmsVoted,
  normalizeMetadataBoostGate,
  type MetadataBoostGateDecision,
} from '../../src/core/search/metadata-boost-gate.ts';
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  SEARCH_MODE_CONFIG_KEYS,
  attributeKnob,
  knobsHash,
  loadOverridesFromConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
} from '../../src/core/search/mode.ts';
import { KNOB_DESCRIPTIONS, formatKnobValue } from '../../src/core/search/modes-report.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import { runPostFusionStages, type PostFusionOpts } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, page_id: number, score: number): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body`,
    chunk_source: 'timeline',
    chunk_id: page_id,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
  } as SearchResult;
}

describe('normalizeMetadataBoostGate — the ONE parse contract for metadata_boost_gate', () => {
  test('the two literals pass through; case + surrounding whitespace ignored', () => {
    expect(METADATA_BOOST_GATES).toEqual(['always', 'lexical']);
    expect(DEFAULT_METADATA_BOOST_GATE).toBe('always');
    expect(normalizeMetadataBoostGate('always')).toBe('always');
    expect(normalizeMetadataBoostGate('lexical')).toBe('lexical');
    expect(normalizeMetadataBoostGate(' LEXICAL ')).toBe('lexical');
    expect(normalizeMetadataBoostGate('Always')).toBe('always');
  });

  test('no on/off aliases, no booleans, no numbers — anything else is unset (undefined)', () => {
    for (const v of ['', '   ', 'on', 'off', 'true', 'false', 'null', 'lexical-only', 'always ', 'x'.repeat(1) + 'always']) {
      if (v.trim().toLowerCase() === 'always' || v.trim().toLowerCase() === 'lexical') continue;
      expect(normalizeMetadataBoostGate(v)).toBeUndefined();
    }
    expect(normalizeMetadataBoostGate(undefined)).toBeUndefined();
    expect(normalizeMetadataBoostGate(null)).toBeUndefined();
    expect(normalizeMetadataBoostGate(true)).toBeUndefined();
    expect(normalizeMetadataBoostGate(false)).toBeUndefined();
    expect(normalizeMetadataBoostGate(0)).toBeUndefined();
    expect(normalizeMetadataBoostGate(1)).toBeUndefined();
    expect(normalizeMetadataBoostGate({})).toBeUndefined();
    expect(normalizeMetadataBoostGate(['lexical'])).toBeUndefined();
  });
});

describe('decideMetadataBoosts — the gate × lexicalVoted matrix', () => {
  test('always × {voted, not voted} → apply (reason gate_always); the vote is still reported', () => {
    expect(decideMetadataBoosts({ gate: 'always', lexicalVoted: true })).toEqual({
      gate: 'always', lexical_voted: true, boosts_applied: true, reason: 'gate_always',
    });
    expect(decideMetadataBoosts({ gate: 'always', lexicalVoted: false })).toEqual({
      gate: 'always', lexical_voted: false, boosts_applied: true, reason: 'gate_always',
    });
  });

  test('lexical × voted → apply (lexical_voted); lexical × vector-only → skip (vector_only_voter)', () => {
    expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: true })).toEqual({
      gate: 'lexical', lexical_voted: true, boosts_applied: true, reason: 'lexical_voted',
    });
    const skip: MetadataBoostGateDecision = decideMetadataBoosts({ gate: 'lexical', lexicalVoted: false });
    expect(skip).toEqual({
      gate: 'lexical', lexical_voted: false, boosts_applied: false, reason: 'vector_only_voter',
    });
  });

  test('skip is the ONLY ranking-changing outcome: exactly one cell of the matrix has boosts_applied false', () => {
    const cells = (['always', 'lexical'] as const).flatMap((gate) =>
      [true, false].map((lexicalVoted) => decideMetadataBoosts({ gate, lexicalVoted })),
    );
    expect(cells.filter((c) => !c.boosts_applied)).toHaveLength(1);
  });

  test('image modality is exempt from lexical: no lexical arm ever runs for an image query, so boosts apply (image_modality)', () => {
    // hybrid.ts skips the keyword/title arms and excludes the relational arm
    // for image modality by construction — lexicalVoted is false for EVERY
    // image query. Without the exemption `lexical` would silently disable the
    // backlink/salience/recency/graph boosts for the whole modality.
    expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: false, modality: 'image' })).toEqual({
      gate: 'lexical', lexical_voted: false, boosts_applied: true, reason: 'image_modality',
    });
    // `always` keeps its own reason (byte-identical pre-knob pipeline).
    expect(decideMetadataBoosts({ gate: 'always', lexicalVoted: false, modality: 'image' })).toEqual({
      gate: 'always', lexical_voted: false, boosts_applied: true, reason: 'gate_always',
    });
    // text / both / unset take the vote-based decision unchanged.
    for (const modality of ['text', 'both', undefined] as const) {
      expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: false, modality }).reason).toBe('vector_only_voter');
      expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: true, modality }).reason).toBe('lexical_voted');
    }
    // Across the full gate × voted × modality matrix, only vector_only_voter skips.
    const cells = (['always', 'lexical'] as const).flatMap((gate) =>
      [true, false].flatMap((lexicalVoted) =>
        (['text', 'image', 'both', undefined] as const).map((modality) => decideMetadataBoosts({ gate, lexicalVoted, modality })),
      ),
    );
    expect(cells.filter((c) => !c.boosts_applied).every((c) => c.reason === 'vector_only_voter')).toBe(true);
    expect(cells.filter((c) => !c.boosts_applied)).toHaveLength(3); // lexical × not-voted × {text, both, undefined}
  });
});

describe('lexicalArmsVoted — mirrors composeFusionLists inclusion rules', () => {
  const r = row('notes/a', 1, 0.5);
  test('all lists empty → false; each lexical class alone → true', () => {
    expect(lexicalArmsVoted({ keywordFusionList: [], titleFusionList: [], relationalList: [], includeRelational: true })).toBe(false);
    expect(lexicalArmsVoted({ keywordFusionList: [r], titleFusionList: [], relationalList: [], includeRelational: true })).toBe(true);
    expect(lexicalArmsVoted({ keywordFusionList: [], titleFusionList: [r], relationalList: [], includeRelational: true })).toBe(true);
    expect(lexicalArmsVoted({ keywordFusionList: [], titleFusionList: [], relationalList: [r], includeRelational: true })).toBe(true);
  });

  test('a relational list that composeFusionLists would NOT fuse (image modality) does not count', () => {
    expect(lexicalArmsVoted({ keywordFusionList: [], titleFusionList: [], relationalList: [r], includeRelational: false })).toBe(false);
  });

  test('the caller passes the POST-demotion lists: a relaxed row that was dropped never reaches this function', () => {
    // hybrid.ts filters `keyword_relaxed` rows before composing (vector-healthy
    // runs); what remains is what votes. An empty post-demotion list is a
    // vector-only run even if the raw keyword arm returned OR-fallback noise.
    const raw = [{ ...r, keyword_relaxed: true as const }];
    const postDemotion = raw.filter((x) => !x.keyword_relaxed);
    expect(lexicalArmsVoted({ keywordFusionList: postDemotion, titleFusionList: [], relationalList: [], includeRelational: true })).toBe(false);
    // ...and on a vector-DEAD run the same rows are kept and DO vote.
    expect(lexicalArmsVoted({ keywordFusionList: raw, titleFusionList: [], relationalList: [], includeRelational: true })).toBe(true);
  });
});

describe('runPostFusionStages — skipMetadataBoosts threads through as ONE block', () => {
  function stubEngine() {
    const calls: string[] = [];
    const engine = {
      getBacklinkCounts: async (ids: number[]) => { calls.push('backlinks'); return new Map(ids.map((id) => [id, 50])); },
      getSalienceScores: async () => { calls.push('salience'); return new Map([['default::hub', 10]]); },
      getEffectiveDates: async () => { calls.push('dates'); return new Map([['default::hub', new Date()]]); },
      executeRaw: async (sql: string) => { calls.push(`raw:${/slug_aliases/.test(sql) ? 'alias' : /supersedes/.test(sql) ? 'supersede' : 'other'}`); return []; },
      // Graph-signals stage (applyGraphSignals → engine.getAdjacencyBoosts). Without
      // this the stub throws and BOTH paths fail open, so the assertions below
      // could not tell a skipped stage from a broken one.
      getAdjacencyBoosts: async () => { calls.push('graph'); return new Map(); },
    };
    return { engine, calls };
  }
  const opts = (skip: boolean | undefined): PostFusionOpts => ({
    applyBacklinks: true,
    salience: 'on',
    recency: 'on',
    graphSignalsEnabled: true,
    ...(skip === undefined ? {} : { skipMetadataBoosts: skip }),
  });

  test('skipMetadataBoosts: true → no backlink/salience/recency/alias roundtrips, scores untouched, base_score still stamped, supersede probe still runs', async () => {
    const { engine, calls } = stubEngine();
    const results = [row('hub', 1, 1.0), row('gold', 2, 0.95)];
    await runPostFusionStages(engine as never, results, opts(true));
    expect(results.map((r) => r.score)).toEqual([1.0, 0.95]);
    expect(results.every((r) => r.base_score === r.score)).toBe(true);
    expect(results[0].backlink_boost).toBeUndefined();
    expect(calls).not.toContain('backlinks');
    expect(calls).not.toContain('salience');
    expect(calls).not.toContain('dates');
    expect(calls).not.toContain('raw:alias');
    expect(calls).not.toContain('graph');
    // Correctness stage untouched: the supersede-edge probe still fires.
    expect(calls).toContain('raw:supersede');
  });

  test('skipMetadataBoosts false / undefined → today\'s behavior (backlink boost fires, engine consulted)', async () => {
    for (const skip of [false, undefined]) {
      const { engine, calls } = stubEngine();
      const results = [row('hub', 1, 1.0), row('gold', 2, 0.95)];
      await runPostFusionStages(engine as never, results, opts(skip));
      expect(results[0].score).toBeGreaterThan(1.0);
      expect(results[0].backlink_boost).toBeGreaterThan(1.0);
      expect(calls).toContain('backlinks');
      expect(calls).toContain('salience');
      expect(calls).toContain('dates');
      expect(calls).toContain('graph');
      expect(calls).toContain('raw:alias');
    }
  });
});

describe('metadata_boost_gate knob plane — bundle, config parse, resolution chain', () => {
  test('every bundle is `lexical` since the Phase E3 held-out receipt (57.8 vs 53.0; gates unchanged); `always` is the pre-wave pipeline', () => {
    for (const m of SEARCH_MODES) {
      expect(MODE_BUNDLES[m].metadata_boost_gate).toBe('lexical');
    }
  });

  test('loadOverridesFromConfig: literals parse via the ONE contract; garbage falls through (key absent)', () => {
    expect(loadOverridesFromConfig({ 'search.metadata_boost_gate': 'lexical' }).metadata_boost_gate).toBe('lexical');
    expect(loadOverridesFromConfig({ 'search.metadata_boost_gate': ' Always ' }).metadata_boost_gate).toBe('always');
    for (const bad of ['', 'off', 'on', 'true', '1', 'null', 'lexicl']) {
      expect(loadOverridesFromConfig({ 'search.metadata_boost_gate': bad })).not.toHaveProperty('metadata_boost_gate');
    }
    expect(loadOverridesFromConfig({})).not.toHaveProperty('metadata_boost_gate');
  });

  test('resolution chain: per-call > config override > bundle; an invalid config value resolves to the bundle', () => {
    expect(resolveSearchMode({ mode: 'balanced' }).metadata_boost_gate).toBe('lexical');
    expect(resolveSearchMode({ mode: 'balanced', overrides: { metadata_boost_gate: 'always' } }).metadata_boost_gate).toBe('always');
    expect(resolveSearchMode({
      mode: 'balanced', overrides: { metadata_boost_gate: 'lexical' }, perCall: { metadata_boost_gate: 'always' },
    }).metadata_boost_gate).toBe('always');
    expect(resolveSearchMode({
      mode: 'tokenmax', overrides: loadOverridesFromConfig({ 'search.metadata_boost_gate': 'off' }),
    }).metadata_boost_gate).toBe('lexical');
    const input = { mode: 'conservative', overrides: { metadata_boost_gate: 'always' as const } };
    expect(attributeKnob('metadata_boost_gate', input, resolveSearchMode(input)).source).toBe('override');
    expect(attributeKnob('metadata_boost_gate', { mode: 'conservative' }, resolveSearchMode({ mode: 'conservative' })).source).toBe('mode');
  });

  test('registry: the config key is in SEARCH_MODE_CONFIG_KEYS (reset lane) AND KNOWN_CONFIG_KEYS (config set)', () => {
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.metadata_boost_gate');
    expect(KNOWN_CONFIG_KEYS).toContain('search.metadata_boost_gate');
  });

  test('dashboard: KNOB_DESCRIPTIONS names the knob; the value renders as its literal', () => {
    expect(KNOB_DESCRIPTIONS.metadata_boost_gate).toMatch(/lexical/);
    expect(formatKnobValue('metadata_boost_gate', 'always')).toBe('always');
    expect(formatKnobValue('metadata_boost_gate', 'lexical')).toBe('lexical');
  });
});

describe('knobsHash — mbg= participates under the v=29 epoch', () => {
  test('always vs lexical → distinct hashes; a partial-knobs literal hashes as always', () => {
    const base = resolveSearchMode({ mode: 'balanced' });
    const always = knobsHash({ ...base, metadata_boost_gate: 'always' });
    const lexical = knobsHash({ ...base, metadata_boost_gate: 'lexical' });
    expect(always).not.toBe(lexical);
    expect(knobsHash(base)).toBe(lexical); // bundle default since the Phase E3 flip
    const { metadata_boost_gate: _drop, ...partial } = base;
    expect(knobsHash(partial as ResolvedSearchKnobs)).toBe(always); // absent field = pre-wave identity
  });

  test('the per-call and config planes reach the hash identically', () => {
    const viaConfig = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: loadOverridesFromConfig({ 'search.metadata_boost_gate': 'always' }) }));
    const viaPerCall = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { metadata_boost_gate: 'always' } }));
    expect(viaConfig).toBe(viaPerCall);
    expect(viaConfig).not.toBe(knobsHash(resolveSearchMode({ mode: 'balanced' })));
  });
});
