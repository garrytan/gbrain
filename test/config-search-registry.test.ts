// #4605 — the `search.*` rows in KNOWN_CONFIG_KEYS were a hand-copied list
// that drifted from the keys mode.ts actually reads: three registered
// spellings (`search.token_budget`, `search.intent_weighting`,
// `search.limit_default`) had no reader, while 20 live knobs (the camelCase
// `search.tokenBudget` / `search.intentWeighting` / `search.searchLimit` the
// code and every hint print, the reranker.*, cross_modal.*, relational_*
// keys…) were accepted only through the `search.` prefix. Because the prefix
// swallows both spellings silently, neither the Levenshtein suggestion nor
// the --force "Nothing in gbrain reads this" warning could ever fire for a
// search.* key. These pins keep the registry and the read path in lockstep
// without config.ts importing mode.ts (config.ts is deliberately lean: its
// import closure serves engine-free hook children).
import { describe, expect, test } from 'bun:test';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { KNOB_CONFIG_KEY, SEARCH_MODE_CONFIG_KEYS, SEARCH_MODE_KEY } from '../src/core/search/mode.ts';
import { REMOTE_PRIVATE_PAGES_KEY } from '../src/core/search/private-visibility.ts';

/** search.* keys read directly via engine.getConfig (not mode-bundle knobs). */
const DIRECTLY_READ_SINGLETONS = [
  SEARCH_MODE_KEY,
  'search.mode_upgrade_notice_shown',        // commands/upgrade.ts
  'search.image_query.max_bytes',            // ops/image.ts
  'search.image_query.daily_budget_usd_per_client', // ops/image.ts
  'search.image_query.remote_max_bytes',     // ops/image.ts
  'search.mcp_keyword_only',                 // ops/search.ts
  REMOTE_PRIVATE_PAGES_KEY,                  // search/private-visibility.ts
  'search.track_retrieval',                  // last-retrieved.ts
  'search.intent_patterns',                  // search/query-intent.ts
  'search.adaptive_return',                  // return-policy.ts via loadConfigWithEngine
  'search.adaptive_return_entity_max',
  'search.adaptive_return_other_max',
  'search.adaptive_return_min_keep',
  'search.crag_escalation',                  // ops/search.ts
  'search.crag_think',                       // ops/search.ts
];

describe('KNOWN_CONFIG_KEYS search.* rows mirror what the code reads (#4605)', () => {
  test('the three dead snake_case spellings are gone', () => {
    for (const k of ['search.token_budget', 'search.intent_weighting', 'search.limit_default']) {
      expect(KNOWN_CONFIG_KEYS, `${k} has no reader`).not.toContain(k);
    }
  });

  test('every key mode.ts reads is registered', () => {
    const missing = SEARCH_MODE_CONFIG_KEYS.filter((k) => !KNOWN_CONFIG_KEYS.includes(k));
    expect(missing).toEqual([]);
  });

  test('every directly-read search.* singleton is registered', () => {
    const missing = DIRECTLY_READ_SINGLETONS.filter((k) => !KNOWN_CONFIG_KEYS.includes(k));
    expect(missing).toEqual([]);
  });

  test('every registered search.* key has a reader (mode knob or listed singleton)', () => {
    const readers = new Set<string>([...SEARCH_MODE_CONFIG_KEYS, ...DIRECTLY_READ_SINGLETONS]);
    const dead = KNOWN_CONFIG_KEYS.filter((k) => k.startsWith('search.') && !readers.has(k));
    expect(dead).toEqual([]);
  });

  test('no duplicate search.* rows', () => {
    const rows = KNOWN_CONFIG_KEYS.filter((k) => k.startsWith('search.'));
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe('KNOB_CONFIG_KEY is the single knob→config-key map', () => {
  test('SEARCH_MODE_CONFIG_KEYS is derived from it, 1:1, all under search.', () => {
    const keys = Object.values(KNOB_CONFIG_KEY);
    expect([...SEARCH_MODE_CONFIG_KEYS].sort()).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.startsWith('search.')).toBe(true);
    expect(keys).not.toContain(SEARCH_MODE_KEY);
  });
});
