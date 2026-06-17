// v0.42 Type Unification (T27) — findPackSuccessors + version helpers.
//
// Coverage: scalar literal exact match, major wildcard, minor wildcard,
// semver descending compare, transitive walking (gbrain-base@1.x →
// gbrain-base-v2 via bundled packs).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  findPackSuccessors,
  _versionRangeMatches,
  _versionDescCompare,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

// Reset BEFORE every test too — sibling test files in the same bun shard
// (schema-pack-mutate.test.ts, schema-pack-registry-reload.test.ts, etc.)
// can pollute the module-level pack cache. afterEach alone isn't enough
// because the first test in this file runs against whatever state the
// previous file left behind.
beforeEach(() => {
  _resetPackCacheForTests();
});

afterEach(() => {
  _resetPackCacheForTests();
});

describe('_versionRangeMatches', () => {
  it('matches exact literal', () => {
    expect(_versionRangeMatches('1.0.0', '1.0.0')).toBe(true);
    expect(_versionRangeMatches('1.0.1', '1.0.0')).toBe(false);
  });

  it('matches major wildcard `1.x`', () => {
    expect(_versionRangeMatches('1.0.0', '1.x')).toBe(true);
    expect(_versionRangeMatches('1.5.2', '1.x')).toBe(true);
    expect(_versionRangeMatches('2.0.0', '1.x')).toBe(false);
  });

  it('matches minor wildcard `1.0.x`', () => {
    expect(_versionRangeMatches('1.0.0', '1.0.x')).toBe(true);
    expect(_versionRangeMatches('1.0.5', '1.0.x')).toBe(true);
    expect(_versionRangeMatches('1.1.0', '1.0.x')).toBe(false);
  });

  it('matches `*` as alias for `x`', () => {
    expect(_versionRangeMatches('1.0.0', '1.*')).toBe(true);
  });
});

describe('_versionDescCompare', () => {
  it('sorts descending', () => {
    const versions = ['1.0.0', '2.0.0', '1.5.0'];
    versions.sort((a, b) => _versionDescCompare(b, a));
    expect(versions).toEqual(['2.0.0', '1.5.0', '1.0.0']);
  });

  it('handles equal versions', () => {
    expect(_versionDescCompare('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('findPackSuccessors (against bundled packs)', () => {
  it('finds gbrain-base-v2 as successor of gbrain-base@1.0.0', async () => {
    const successors = await findPackSuccessors('gbrain-base', '1.0.0');
    expect(successors.length).toBe(1);
    expect(successors[0].manifest.name).toBe('gbrain-base-v2');
    expect(successors[0].manifest.migration_from?.pack).toBe('gbrain-base');
    expect(successors[0].manifest.migration_from?.version).toBe('1.x');
  });

  it('returns empty array when no successor declared', async () => {
    // gbrain-base-v2 itself has no successor declared
    const successors = await findPackSuccessors('gbrain-base-v2', '1.0.0');
    expect(successors).toEqual([]);
  });

  it('returns empty array for unknown pack', async () => {
    const successors = await findPackSuccessors('nonexistent-pack', '1.0.0');
    expect(successors).toEqual([]);
  });
});
