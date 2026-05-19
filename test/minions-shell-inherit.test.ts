/**
 * Tests for `src/core/minions/handlers/shell-inherit.ts` — the single source
 * of truth for inheritable shell-job secrets.
 *
 * Goal: pin behavior, not shape. Codex F-CDX-7 critiqued the original test
 * plan for asserting "the array is exported" — that's shape-coupled and
 * tells you nothing if a contributor adds an array member but forgets the
 * resolver. These tests verify each INHERITABLE entry's resolver actually
 * reads the right config field AND its shadow-key set is consistent.
 */

import { describe, test, expect } from 'bun:test';
import {
  INHERITABLE,
  INHERITABLE_NAMES,
  ALL_SHADOW_KEYS,
  inheritedByShadowKey,
  isInheritableSecret,
} from '../src/core/minions/handlers/shell-inherit.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('INHERITABLE record', () => {
  test('database_url.read returns config.database_url', () => {
    const url = 'postgresql://x:y@host:5432/db';
    const cfg: GBrainConfig = { engine: 'postgres', database_url: url };
    expect(INHERITABLE.database_url.read(cfg)).toBe(url);
  });

  test('database_url.read returns undefined when config has no database_url', () => {
    expect(INHERITABLE.database_url.read({ engine: 'postgres' })).toBeUndefined();
  });

  test('database_url.read returns undefined for null config', () => {
    expect(INHERITABLE.database_url.read(null)).toBeUndefined();
  });

  test('every entry has a non-empty envKey + at least one shadowKey + a read fn', () => {
    for (const name of INHERITABLE_NAMES) {
      const spec = INHERITABLE[name];
      expect(typeof spec.envKey).toBe('string');
      expect(spec.envKey.length).toBeGreaterThan(0);
      expect(spec.shadowKeys.length).toBeGreaterThanOrEqual(1);
      expect(typeof spec.read).toBe('function');
    }
  });

  test('every entry: envKey is in its own shadowKeys (you cannot put the same env key in env: and inherit)', () => {
    for (const name of INHERITABLE_NAMES) {
      const spec = INHERITABLE[name];
      expect((spec.shadowKeys as readonly string[]).includes(spec.envKey)).toBe(true);
    }
  });
});

describe('inheritedByShadowKey', () => {
  test('GBRAIN_DATABASE_URL → database_url', () => {
    expect(inheritedByShadowKey('GBRAIN_DATABASE_URL')).toBe('database_url');
  });
  test('DATABASE_URL → database_url', () => {
    expect(inheritedByShadowKey('DATABASE_URL')).toBe('database_url');
  });
  test('unknown env key → undefined', () => {
    expect(inheritedByShadowKey('MY_RANDOM_VAR')).toBeUndefined();
  });
});

describe('isInheritableSecret type guard', () => {
  test('accepts known name', () => {
    expect(isInheritableSecret('database_url')).toBe(true);
  });
  test('rejects unknown name', () => {
    expect(isInheritableSecret('not_a_secret')).toBe(false);
  });
  test('rejects non-string', () => {
    expect(isInheritableSecret(1)).toBe(false);
    expect(isInheritableSecret(null)).toBe(false);
    expect(isInheritableSecret(undefined)).toBe(false);
  });
});

describe('ALL_SHADOW_KEYS', () => {
  test('contains every shadowKey from every entry', () => {
    for (const name of INHERITABLE_NAMES) {
      for (const sk of INHERITABLE[name].shadowKeys) {
        expect(ALL_SHADOW_KEYS.has(sk)).toBe(true);
      }
    }
  });
  test('no extra entries beyond what is declared', () => {
    const declared = new Set<string>();
    for (const name of INHERITABLE_NAMES) {
      for (const sk of INHERITABLE[name].shadowKeys) {
        declared.add(sk);
      }
    }
    expect(ALL_SHADOW_KEYS.size).toBe(declared.size);
  });
});
