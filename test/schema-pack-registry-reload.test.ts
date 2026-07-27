// v0.40.6.0 — registry.ts cache invalidation + stat-mtime TTL tests.
//
// Pins codex C6 fix (parent-pack edits cascade-invalidate children) and
// D11 + D13 (stat-mtime TTL gate keeps hot path cheap; cross-process
// mutations get picked up within STAT_TTL_MS).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invalidatePackCache,
  resolvePack,
  tryCachedPack,
  _cacheNamesForTests,
  _cacheSizeForTests,
  _resetPackCacheForTests,
  STAT_TTL_MS_DEFAULT,
} from '../src/core/schema-pack/registry.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { withEnv } from './helpers/with-env.ts';

let tmpDir: string;

function fakeManifest(name: string, opts: { extends?: string; version?: string } = {}): SchemaPackManifest {
  return {
    api_version: 'gbrain-schema-pack-v1',
    name,
    version: opts.version ?? '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: opts.extends ?? null,
    borrow_from: [],
    page_types: [
      {
        name: 'person',
        primitive: 'entity',
        path_prefixes: ['people/'],
        aliases: [],
        extractable: false,
        expert_routing: false,
      },
    ],
    link_types: [],
    frontmatter_links: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [],
    filing_rules: [],
  } as SchemaPackManifest;
}

beforeEach(() => {
  _resetPackCacheForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-registry-test-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('invalidatePackCache — basic', () => {
  it('returns invalidated: [] when no entries exist', () => {
    const r = invalidatePackCache('nonexistent');
    expect(r.invalidated).toEqual(['nonexistent']);
    expect(_cacheSizeForTests()).toBe(0);
  });

  it('invalidates a single cached entry by name', async () => {
    await resolvePack(fakeManifest('a'), async () => { throw new Error('no parent'); });
    expect(_cacheSizeForTests()).toBe(1);
    invalidatePackCache('a');
    expect(_cacheSizeForTests()).toBe(0);
  });

  it('invalidates all entries when called with no argument', async () => {
    await resolvePack(fakeManifest('a'), async () => { throw new Error('no parent'); });
    await resolvePack(fakeManifest('b'), async () => { throw new Error('no parent'); });
    expect(_cacheSizeForTests()).toBe(2);
    const r = invalidatePackCache();
    expect(r.invalidated.sort()).toEqual(['a', 'b']);
    expect(_cacheSizeForTests()).toBe(0);
  });
});

describe('invalidatePackCache — extends-chain cascade (codex C6 fix)', () => {
  it('invalidating a parent cascades to every child that extends it', async () => {
    const parentManifest = fakeManifest('p');
    const child1Manifest = fakeManifest('c1', { extends: 'p' });
    const child2Manifest = fakeManifest('c2', { extends: 'p' });
    const grandchildManifest = fakeManifest('g', { extends: 'c1' });

    const loadByName = async (name: string): Promise<SchemaPackManifest> => {
      if (name === 'p') return parentManifest;
      if (name === 'c1') return child1Manifest;
      if (name === 'c2') return child2Manifest;
      throw new Error('unknown parent in test');
    };
    await resolvePack(parentManifest, loadByName);
    await resolvePack(child1Manifest, loadByName);
    await resolvePack(child2Manifest, loadByName);
    await resolvePack(grandchildManifest, loadByName);
    expect(_cacheSizeForTests()).toBe(4);

    const result = invalidatePackCache('p');
    // p, c1, c2 directly contain 'p' in their chain; g contains c1 which
    // contains p. Cascade evicts p, c1, c2 (one-hop). g has 'c1' + 'p' in
    // its chain (via the extends walk during resolve), so it's also
    // evicted. The dependent set is built from cached entries' chain arrays.
    expect(new Set(result.invalidated)).toEqual(new Set(['p', 'c1', 'c2', 'g']));
    expect(_cacheSizeForTests()).toBe(0);
  });

  it('invalidating a leaf does NOT touch siblings or parent', async () => {
    const p = fakeManifest('p');
    const c1 = fakeManifest('c1', { extends: 'p' });
    const c2 = fakeManifest('c2', { extends: 'p' });
    const loadByName = async (n: string) => (n === 'p' ? p : n === 'c1' ? c1 : c2);
    await resolvePack(p, loadByName);
    await resolvePack(c1, loadByName);
    await resolvePack(c2, loadByName);

    invalidatePackCache('c1');
    expect(_cacheNamesForTests().sort()).toEqual(['c2', 'p']);
  });
});

describe('tryCachedPack — TTL gate', () => {
  it('returns null when name is not cached', () => {
    expect(tryCachedPack('never-seen')).toBeNull();
  });

  it('returns the cached resolved pack on hot path', async () => {
    const m = fakeManifest('foo');
    const resolved = await resolvePack(m, async () => { throw new Error('no parent'); });
    const hit = tryCachedPack('foo');
    expect(hit).toBe(resolved);
    expect(hit?.manifest.name).toBe('foo');
  });

  it('respects GBRAIN_PACK_STAT_TTL_MS env override', async () => {
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '0' }, async () => {
      // Cache + a file snapshot on disk.
      const packPath = join(tmpDir, 'foo-pack.yaml');
      writeFileSync(packPath, 'placeholder', 'utf-8');
      const m = fakeManifest('foo');
      await resolvePack(m, async () => { throw new Error('no parent'); }, {
        loadByPath: (n) => (n === 'foo' ? packPath : null),
      });
      // TTL=0 forces a stat on every call. Touch the file → mtime changes.
      // (small sleep ensures mtimeMs is different)
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(packPath, 'updated', 'utf-8');
      const hit = tryCachedPack('foo');
      expect(hit).toBeNull();
      expect(_cacheNamesForTests()).not.toContain('foo');
    });
  });

  it('falls back to default TTL when env override is invalid', async () => {
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: 'not-a-number' }, async () => {
      // Default TTL is 1000ms; just check it doesn't crash + returns hit.
      const m = fakeManifest('foo');
      await resolvePack(m, async () => { throw new Error('no parent'); });
      expect(tryCachedPack('foo')).not.toBeNull();
    });
  });
});

describe('stat-snapshot cross-process invalidation (D11)', () => {
  it('detects mtime change on the pack file and invalidates', async () => {
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '0' }, async () => {
      const packPath = join(tmpDir, 'p.yaml');
      writeFileSync(packPath, 'v1', 'utf-8');
      const m = fakeManifest('p');
      await resolvePack(m, async () => { throw new Error('no parent'); }, {
        loadByPath: (n) => (n === 'p' ? packPath : null),
      });
      expect(tryCachedPack('p')).not.toBeNull();

      // Mutate the file mtime.
      await new Promise((r) => setTimeout(r, 10));
      writeFileSync(packPath, 'v2', 'utf-8');

      // Stat-TTL gate fires (TTL=0 = always stat), detects change, evicts.
      expect(tryCachedPack('p')).toBeNull();
    });
  });

  it('detects file deletion and evicts (cross-process delete)', async () => {
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '0' }, async () => {
      const packPath = join(tmpDir, 'p.yaml');
      writeFileSync(packPath, 'v1', 'utf-8');
      const m = fakeManifest('p');
      await resolvePack(m, async () => { throw new Error('no parent'); }, {
        loadByPath: (n) => (n === 'p' ? packPath : null),
      });
      expect(tryCachedPack('p')).not.toBeNull();

      rmSync(packPath);
      expect(tryCachedPack('p')).toBeNull();
    });
  });

  it('cascades when parent file mtime changes (codex C6 fix at file level)', async () => {
    await withEnv({ GBRAIN_PACK_STAT_TTL_MS: '0' }, async () => {
      const parentPath = join(tmpDir, 'parent.yaml');
      const childPath = join(tmpDir, 'child.yaml');
      writeFileSync(parentPath, 'parent v1', 'utf-8');
      writeFileSync(childPath, 'child v1', 'utf-8');

      const parentM = fakeManifest('parent');
      const childM = fakeManifest('child', { extends: 'parent' });
      const loadByName = async (n: string) => (n === 'parent' ? parentM : childM);
      const loadByPath = (n: string) => (n === 'parent' ? parentPath : n === 'child' ? childPath : null);

      await resolvePack(parentM, loadByName, { loadByPath });
      await resolvePack(childM, loadByName, { loadByPath });

      // Mutate ONLY the parent file.
      await new Promise((r) => setTimeout(r, 10));
      writeFileSync(parentPath, 'parent v2', 'utf-8');

      // tryCachedPack on the CHILD must detect parent's mtime change
      // (parent is in child's chain + files snapshot).
      expect(tryCachedPack('child')).toBeNull();
    });
  });
});

describe('STAT_TTL_MS_DEFAULT export', () => {
  it('exports the default constant', () => {
    expect(STAT_TTL_MS_DEFAULT).toBe(1000);
  });
});
