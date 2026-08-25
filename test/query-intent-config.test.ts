/**
 * #4415 — query-intent classifier: per-brain pattern extensions.
 *
 * Every shipped bank is English-only `\b`-anchored regex, so on a
 * non-English brain `classifyQuery` fell to intent 'general' with recency
 * AND salience permanently 'off' — the ranking stages never executed at
 * all. Pins:
 *
 *   1. the unextended banks miss a Hebrew recency query (the bug — kept as
 *      a documented baseline);
 *   2. `search.intent_patterns` config merges per-brain patterns OVER the
 *      shipped banks (recency_on / strong_recency / salience_on / temporal
 *      etc.) and the axes fire;
 *   3. bad config fail-opens per entry (unparseable JSON, unknown bank,
 *      invalid regex) — shipped banks stay in force, errors are reported;
 *   4. classifyQueryWithBrainPatterns loads via engine.getConfig and
 *      fail-opens on a throwing engine;
 *   5. the `search` op now carries the same explicit salience/recency
 *      params `query` has (the per-call override surface — CLI --salience /
 *      --recency come from the op contract).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  classifyQuery,
  classifyQueryWithBrainPatterns,
  applyIntentPatternConfig,
  clearIntentPatternConfigForTests,
  intentPatternFingerprint,
  loadEngineIntentPatterns,
  INTENT_PATTERN_BANKS,
} from '../src/core/search/query-intent.ts';
import { operations } from '../src/core/operations.ts';

// The issue's own repro sentence: "what's new recently with the car".
const HEBREW_RECENCY_QUERY = 'מה חדש לאחרונה עם הרכב';

afterEach(() => {
  clearIntentPatternConfigForTests();
});

describe('query-intent — shipped banks are English-only (#4415 baseline)', () => {
  test('Hebrew recency query: recency and salience never fire unextended', () => {
    const s = classifyQuery(HEBREW_RECENCY_QUERY);
    expect(s.intent).toBe('general');
    expect(s.suggestedRecency).toBe('off');
    expect(s.suggestedSalience).toBe('off');
  });
});

describe('applyIntentPatternConfig (#4415)', () => {
  test('recency_on extension fires the recency stage for a Hebrew query', () => {
    const errors = applyIntentPatternConfig(JSON.stringify({
      recency_on: ['לאחרונה', 'מה חדש'],
    }));
    expect(errors).toEqual([]);
    expect(classifyQuery(HEBREW_RECENCY_QUERY).suggestedRecency).toBe('on');
  });

  test('strong_recency + salience_on extensions drive both axes', () => {
    applyIntentPatternConfig(JSON.stringify({
      strong_recency: ['היום'],
      salience_on: ['מה קורה עם'],
    }));
    expect(classifyQuery('מה קורה עם הרכב היום').suggestedRecency).toBe('strong');
    expect(classifyQuery('מה קורה עם הרכב').suggestedSalience).toBe('on');
  });

  test('temporal extension routes intent (and its high-detail mapping)', () => {
    applyIntentPatternConfig(JSON.stringify({ temporal: ['לאחרונה'] }));
    const s = classifyQuery(HEBREW_RECENCY_QUERY);
    expect(s.intent).toBe('temporal');
    expect(s.suggestedDetail).toBe('high');
  });

  test('extensions only ADD: shipped English behavior is unchanged', () => {
    applyIntentPatternConfig(JSON.stringify({ recency_on: ['לאחרונה'] }));
    expect(classifyQuery("what's new recently with the car").suggestedRecency).toBe('on');
    expect(classifyQuery('who is alice-example').suggestedRecency).toBe('off'); // canonical stays off
  });

  test('clearing config restores the shipped-only banks', () => {
    applyIntentPatternConfig(JSON.stringify({ recency_on: ['לאחרונה'] }));
    expect(classifyQuery(HEBREW_RECENCY_QUERY).suggestedRecency).toBe('on');
    applyIntentPatternConfig(null);
    expect(classifyQuery(HEBREW_RECENCY_QUERY).suggestedRecency).toBe('off');
  });

  test('unparseable JSON fail-opens with an error and shipped banks intact', () => {
    const errors = applyIntentPatternConfig('{not json');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('not valid JSON');
    expect(classifyQuery('what happened recently').suggestedRecency).toBe('on');
  });

  test('unknown bank and invalid regex are per-entry errors; valid entries still apply', () => {
    const errors = applyIntentPatternConfig(JSON.stringify({
      no_such_bank: ['x'],
      recency_on: ['לאחרונה', '(unclosed'],
    }));
    expect(errors.some((e) => e.includes("unknown pattern bank 'no_such_bank'"))).toBe(true);
    expect(errors.some((e) => e.includes('invalid regex'))).toBe(true);
    // The valid pattern in the same config still landed.
    expect(classifyQuery(HEBREW_RECENCY_QUERY).suggestedRecency).toBe('on');
  });

  test('non-object / non-array-bank shapes are rejected loudly', () => {
    expect(applyIntentPatternConfig(JSON.stringify(['not', 'an', 'object']))[0])
      .toContain('must be a JSON object');
    expect(applyIntentPatternConfig(JSON.stringify({ recency_on: 'not-an-array' }))[0])
      .toContain("must be an array");
  });

  test('every documented bank name is accepted', () => {
    const cfg = Object.fromEntries(INTENT_PATTERN_BANKS.map((b) => [b, ['בדיקה']]));
    expect(applyIntentPatternConfig(JSON.stringify(cfg))).toEqual([]);
  });
});

describe('classifyQueryWithBrainPatterns (#4415)', () => {
  test('loads search.intent_patterns via engine.getConfig', async () => {
    const engine = {
      getConfig: async (key: string) =>
        key === 'search.intent_patterns' ? JSON.stringify({ recency_on: ['לאחרונה'] }) : null,
    };
    const s = await classifyQueryWithBrainPatterns(engine, HEBREW_RECENCY_QUERY);
    expect(s.suggestedRecency).toBe('on');
  });

  test('a throwing engine fail-opens to the shipped banks', async () => {
    const engine = { getConfig: async () => { throw new Error('db down'); } };
    const s = await classifyQueryWithBrainPatterns(engine, HEBREW_RECENCY_QUERY);
    expect(s.suggestedRecency).toBe('off');
    expect((await classifyQueryWithBrainPatterns(engine, 'what happened recently')).suggestedRecency).toBe('on');
  });
});

describe('loadEngineIntentPatterns — per-engine cache (wave-g)', () => {
  const RAW = JSON.stringify({ recency_on: ['לאחרונה'] });

  test('two engines keep their own banks — no cross-brain contamination', async () => {
    const engineA = { getConfig: async () => RAW };
    const engineB = { getConfig: async () => null };
    expect((await classifyQueryWithBrainPatterns(engineA, HEBREW_RECENCY_QUERY)).suggestedRecency).toBe('on');
    expect((await classifyQueryWithBrainPatterns(engineB, HEBREW_RECENCY_QUERY)).suggestedRecency).toBe('off');
    // A's banks survive B's classify (pre-wave-g the process-global state
    // let the LAST engine's config win for every engine in the process).
    expect((await classifyQueryWithBrainPatterns(engineA, HEBREW_RECENCY_QUERY)).suggestedRecency).toBe('on');
  });

  test('engine.getConfig is TTL-cached — one read per window, not one per classify', async () => {
    let reads = 0;
    const engine = { getConfig: async () => { reads++; return RAW; } };
    await classifyQueryWithBrainPatterns(engine, HEBREW_RECENCY_QUERY);
    await classifyQueryWithBrainPatterns(engine, HEBREW_RECENCY_QUERY);
    await classifyQueryWithBrainPatterns(engine, HEBREW_RECENCY_QUERY);
    expect(reads).toBe(1);
  });

  test('fingerprint: none when unset; stable 12-hex when set; exposed on the state', async () => {
    expect(intentPatternFingerprint(null)).toBe('none');
    expect(intentPatternFingerprint(undefined)).toBe('none');
    expect(intentPatternFingerprint('')).toBe('none');
    expect(intentPatternFingerprint(RAW)).toMatch(/^[0-9a-f]{12}$/);
    expect(intentPatternFingerprint(RAW)).toBe(intentPatternFingerprint(RAW));
    const state = await loadEngineIntentPatterns({ getConfig: async () => RAW });
    expect(state.fingerprint).toBe(intentPatternFingerprint(RAW));
    expect(state.errors).toEqual([]);
  });

  test('a throwing engine fail-opens per engine and still stamps the TTL anchor', async () => {
    let reads = 0;
    const engine = { getConfig: async () => { reads++; throw new Error('db down'); } };
    const s1 = await loadEngineIntentPatterns(engine);
    expect(s1.fingerprint).toBe('none');
    // Within the TTL the down config plane is not hammered again.
    await loadEngineIntentPatterns(engine);
    expect(reads).toBe(1);
  });
});

describe('search op — explicit salience/recency params (#4415)', () => {
  const search = operations.find((o) => o.name === 'search')!;
  const query = operations.find((o) => o.name === 'query')!;

  test('search now carries the same salience/recency override params as query', () => {
    for (const op of [search, query]) {
      expect(op.params.salience).toBeDefined();
      expect(op.params.recency).toBeDefined();
    }
    expect(search.params.salience.enum).toEqual(['off', 'on', 'strong']);
    expect(search.params.recency.enum).toEqual(['off', 'on', 'strong']);
  });
});
