/**
 * T8 — `gbrain config set` strict unknown-key rejection + --force + Levenshtein.
 *
 * These tests probe the pure helpers (KNOWN_CONFIG_KEYS list, prefix list,
 * Levenshtein suggestion against the list). The full `runConfig` CLI
 * integration that calls `engine.setConfig` is exercised E2E in T12.
 */

import { describe, test, expect } from 'bun:test';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';
import { suggestNearest } from '../src/core/levenshtein.ts';

describe('KNOWN_CONFIG_KEYS', () => {
  test('contains the canonical embedding keys', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_model');
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_dimensions');
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_disabled');  // v0.37 D9
    expect(KNOWN_CONFIG_KEYS).toContain('expansion_model');
    expect(KNOWN_CONFIG_KEYS).toContain('chat_model');
  });

  test('contains the search-mode keys (v0.32.3)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('search.mode');
    expect(KNOWN_CONFIG_KEYS).toContain('search.cache.enabled');
  });

  test('contains the models-tier keys (v0.31.12)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('models.default');
    expect(KNOWN_CONFIG_KEYS).toContain('models.tier.subagent');
  });

  test('contains the spend-control keys (v0.42.42.0, #2139) — no --force archaeology', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('spend.posture');
    expect(KNOWN_CONFIG_KEYS).toContain('sync.cost_gate_min_usd');
    expect(KNOWN_CONFIG_KEYS).toContain('sync.federated_v2');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_cooldown_min');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_max_usd_per_source_24h');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_max_usd');
  });

  test('no duplicate entries', () => {
    const set = new Set(KNOWN_CONFIG_KEYS);
    expect(set.size).toBe(KNOWN_CONFIG_KEYS.length);
  });
});

describe('KNOWN_CONFIG_KEY_PREFIXES', () => {
  test('includes the well-known prefixes', () => {
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('search.');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('models.');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('dream.');
  });

  test('prefixes end in `.` (consistent shape)', () => {
    for (const p of KNOWN_CONFIG_KEY_PREFIXES) {
      expect(p).toMatch(/\.$/);
    }
  });
});

describe('Levenshtein suggestion against KNOWN_CONFIG_KEYS', () => {
  test('bug-reporter case: embedding.model → embedding_model', () => {
    const got = suggestNearest('embedding.model', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_model');
  });

  test('bug-reporter case: embedding.dimensions → embedding_dimensions', () => {
    const got = suggestNearest('embedding.dimensions', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_dimensions');
  });

  test('bug-reporter case: embedding.provider has no perfect match', () => {
    // `embedding.provider` is 6+ edits from any canonical key. Either no
    // suggestion (returns null) OR suggests a close-ish key like
    // `embedding_model`. Either outcome means the user sees a clear
    // "unknown key" message + must pick a different name.
    const got = suggestNearest('embedding.provider', KNOWN_CONFIG_KEYS, 3);
    // The exact mapping depends on Levenshtein bucket; we just verify it
    // doesn't accidentally suggest something completely unrelated.
    if (got !== null) {
      expect(got).toMatch(/^embedding/);
    }
  });

  test('typo: chat_modle → chat_model', () => {
    const got = suggestNearest('chat_modle', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('chat_model');
  });

  test('typo: search.modes → search.mode', () => {
    const got = suggestNearest('search.modes', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('search.mode');
  });

  test('completely-unrelated key returns null', () => {
    const got = suggestNearest('xyzzy_quux_blah_unrelated', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBeNull();
  });

  test('exact match returns identity (no suggestion noise)', () => {
    const got = suggestNearest('embedding_model', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_model');
  });
});

describe('prefix vs known-key gate logic (mirrored from runConfig)', () => {
  // Replicate the gate logic the CLI uses to validate test coverage of
  // the decision tree.
  function gate(key: string): 'known' | 'prefix' | 'unknown' {
    if (KNOWN_CONFIG_KEYS.includes(key)) return 'known';
    if (KNOWN_CONFIG_KEY_PREFIXES.some(p => key.startsWith(p))) return 'prefix';
    return 'unknown';
  }

  test('explicit known key → "known"', () => {
    expect(gate('embedding_model')).toBe('known');
  });

  test('search.foo.bar (under prefix) → "prefix"', () => {
    expect(gate('search.foo.bar')).toBe('prefix');
  });

  test('models.custom.x (under prefix) → "prefix"', () => {
    expect(gate('models.custom.x')).toBe('prefix');
  });

  test('bug-reporter: embedding.provider → "unknown" (no prefix match)', () => {
    expect(gate('embedding.provider')).toBe('unknown');
  });

  test('bug-reporter: embedding.model → "unknown"', () => {
    expect(gate('embedding.model')).toBe('unknown');
  });

  test('bug-reporter: embedding.dimensions → "unknown"', () => {
    expect(gate('embedding.dimensions')).toBe('unknown');
  });
});
