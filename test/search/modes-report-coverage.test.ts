/**
 * #4604 — `gbrain search modes` resolves EVERY ModeBundle knob.
 *
 * buildModesReport used to hardcode a 12-knob literal array, so live
 * overrides like search.reranker.* and search.relational_retrieval were
 * invisible on the dashboard while they steered every real search. The knob
 * list now derives from KNOB_DESCRIPTIONS (a Record over every ModeBundle
 * key — the type system forces a description, and therefore a dashboard row,
 * for each new knob). Drift guard: resolved keys == bundle keys, forever.
 *
 * Also pins the #4604 honesty note: the report labels itself as brain-level
 * resolution only (per-call SearchOpts overrides are not represented).
 */

import { describe, test, expect } from 'bun:test';
import { buildModesReport, formatKnobValue, KNOB_DESCRIPTIONS, MODES_REPORT_PER_CALL_NOTE } from '../../src/core/search/modes-report.ts';
import { _exports_for_test as searchCmd } from '../../src/commands/search.ts';
import { MODE_BUNDLES } from '../../src/core/search/mode.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const stubEngine = (configRows: Record<string, string> = {}) =>
  ({
    getConfig: async (k: string) => configRows[k] ?? null,
  }) as unknown as BrainEngine;

describe('#4604 buildModesReport — full-bundle knob coverage', () => {
  test('resolved covers EVERY ModeBundle key (drift guard)', async () => {
    const report = await buildModesReport(stubEngine());
    const bundleKeys = Object.keys(MODE_BUNDLES.balanced).sort();
    expect(Object.keys(report.resolved).sort()).toEqual(bundleKeys);
    // And every row carries value/source/description.
    for (const [k, row] of Object.entries(report.resolved)) {
      expect(typeof row.source).toBe('string');
      expect(typeof row.source_detail).toBe('string');
      expect(row.description).toBe(KNOB_DESCRIPTIONS[k as keyof typeof KNOB_DESCRIPTIONS]);
    }
  });

  test('the previously-hardcoded-out knobs now resolve (reranker + relational)', async () => {
    const report = await buildModesReport(stubEngine());
    // The 12-knob literal array omitted all of these — the issue's headline.
    for (const k of [
      'reranker_enabled',
      'reranker_model',
      'reranker_top_n_in',
      'reranker_top_n_out',
      'reranker_timeout_ms',
      'relationalRetrieval',
      'relational_retrieval_depth',
      'relational_rerank_pin',
      'keyword_arm_confidence_floor',
      'metadata_boost_gate',
      'graph_signals',
      'autocut',
      'title_boost',
    ] as const) {
      expect(report.resolved[k]).toBeDefined();
    }
  });

  test('ranker wave (Phase E2): keyword_arm_confidence_floor resolves to null (off) from the bundle and attributes a 0.6 / off override', async () => {
    const dflt = await buildModesReport(stubEngine({ 'search.mode': 'balanced' }));
    expect(dflt.resolved.keyword_arm_confidence_floor.value).toBeNull();
    expect(dflt.resolved.keyword_arm_confidence_floor.source).toBe('mode');
    const six = await buildModesReport(stubEngine({ 'search.keyword_arm_confidence_floor': '0.6' }));
    expect(six.resolved.keyword_arm_confidence_floor.value).toBe(0.6);
    expect(six.resolved.keyword_arm_confidence_floor.source).toBe('override');
    const off = await buildModesReport(stubEngine({ 'search.keyword_arm_confidence_floor': 'off' }));
    expect(off.resolved.keyword_arm_confidence_floor.value).toBeNull();
    expect(off.resolved.keyword_arm_confidence_floor.source).toBe('override');
    expect(searchCmd.formatModesText(off)).toMatch(/keyword_arm_confidence_floor\s+= off \(null\)\s+\[/);
    expect(searchCmd.formatModesText(six)).toMatch(/keyword_arm_confidence_floor\s+= 0\.6\s+\[/);
  });

  test('ranker wave (Phase E3): metadata_boost_gate resolves to lexical from the bundle and attributes an always override; garbage falls through', async () => {
    const dflt = await buildModesReport(stubEngine({ 'search.mode': 'balanced' }));
    expect(dflt.resolved.metadata_boost_gate.value).toBe('lexical');
    expect(dflt.resolved.metadata_boost_gate.source).toBe('mode');
    const lexical = await buildModesReport(stubEngine({ 'search.metadata_boost_gate': 'always' }));
    expect(lexical.resolved.metadata_boost_gate.value).toBe('always');
    expect(lexical.resolved.metadata_boost_gate.source).toBe('override');
    expect(searchCmd.formatModesText(lexical)).toMatch(/metadata_boost_gate\s+= always\s+\[/);
    const garbage = await buildModesReport(stubEngine({ 'search.metadata_boost_gate': 'off' }));
    expect(garbage.resolved.metadata_boost_gate.value).toBe('lexical');
    expect(garbage.resolved.metadata_boost_gate.source).toBe('fallback');
  });

  test('ranker wave (R1): relational_rerank_pin resolves to 3 from the bundle and attributes an off override', async () => {
    // search.mode set → attribution is 'mode'; unset would read 'fallback' (balanced default).
    const dflt = await buildModesReport(stubEngine({ 'search.mode': 'balanced' }));
    expect(dflt.resolved.relational_rerank_pin.value).toBe(3);
    expect(dflt.resolved.relational_rerank_pin.source).toBe('mode');
    expect((await buildModesReport(stubEngine())).resolved.relational_rerank_pin.source).toBe('fallback');
    const off = await buildModesReport(stubEngine({ 'search.relational_rerank_pin': 'off' }));
    expect(off.resolved.relational_rerank_pin.value).toBe(0);
    expect(off.resolved.relational_rerank_pin.source).toBe('override');
    expect(formatKnobValue('relational_rerank_pin', 0)).toBe('0');
  });

  test('a live config override on a formerly-invisible knob is attributed', async () => {
    const report = await buildModesReport(stubEngine({
      'search.relational_retrieval': 'false',
      'search.reranker.enabled': 'true',
    }));
    expect(report.resolved.relationalRetrieval.value).toBe(false);
    expect(report.resolved.relationalRetrieval.source).toBe('override');
    expect(report.resolved.reranker_enabled.value).toBe(true);
    expect(report.resolved.reranker_enabled.source).toBe('override');
  });

  test('effective semantic caching stays disabled despite an enabling override', async () => {
    const report = await buildModesReport(stubEngine({ 'search.cache.enabled': 'true' }));
    expect(report.resolved.cache_enabled.value).toBe(false);
    expect(report.resolved.cache_enabled.source).toBe('availability');
    expect(report.resolved.cache_enabled.source_detail).toContain('temporarily disabled');
    expect(report.bundles.balanced.cache_enabled).toBe(true); // retained configuration
  });

  test('per_call_note labels the report as brain-level resolution only', async () => {
    const report = await buildModesReport(stubEngine());
    expect(report.per_call_note).toBe(MODES_REPORT_PER_CALL_NOTE);
    expect(report.per_call_note).toContain('Per-call');
  });
});

describe('formatKnobValue — a legitimate null is not "(undefined)" (adversarial finding)', () => {
  test('null renders distinctly per knob; undefined keeps "(undefined)"; values stringify', () => {
    expect(formatKnobValue('expansion_variant_budget', null)).toBe('legacy (null)');
    expect(formatKnobValue('reranker_top_n_out', null)).toBe('no truncate (null)');
    expect(formatKnobValue('keyword_arm_confidence_floor', null)).toBe('off (null)');
    expect(formatKnobValue('tokenBudget', null)).toBe('(null)');
    expect(formatKnobValue('tokenBudget', undefined)).toBe('(undefined)');
    expect(formatKnobValue('expansion_variant_budget', undefined)).toBe('(undefined)');
    expect(formatKnobValue('expansion_variant_budget', 0.5)).toBe('0.5');
    expect(formatKnobValue('expansion', false)).toBe('false');
  });

  test('`gbrain search modes` text at bundle defaults prints expansion_variant_budget = legacy (null)', async () => {
    const report = await buildModesReport(stubEngine());
    expect(report.resolved.expansion_variant_budget.value).toBeNull();
    const text = searchCmd.formatModesText(report);
    const row = text.split('\n').find((l) => /^\s+expansion_variant_budget\s+=/.test(l));
    expect(row).toBeDefined();
    expect(row).toContain('= legacy (null)');
    expect(row).not.toContain('(undefined)');
    // reranker_top_n_out's bundle-default null gets its own label too.
    const tn = text.split('\n').find((l) => /^\s+reranker_top_n_out\s+=/.test(l));
    expect(tn).toContain('= no truncate (null)');
  });

  test('a numeric config override renders the number, and the literal legacy renders legacy (null) as an override', async () => {
    const half = await buildModesReport(stubEngine({ 'search.expansion_variant_budget': '0.5' }));
    expect(searchCmd.formatModesText(half)).toMatch(/expansion_variant_budget\s+= 0\.5\s+\[/);
    const legacy = await buildModesReport(stubEngine({ 'search.expansion_variant_budget': 'legacy' }));
    expect(legacy.resolved.expansion_variant_budget.source).toBe('override');
    expect(searchCmd.formatModesText(legacy)).toMatch(/expansion_variant_budget\s+= legacy \(null\)\s+\[/);
  });
});
