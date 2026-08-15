// v0.38 registry gap-fill (T2 from gap audit).
//
// Pins the extends-chain depth ladder (soft warn >4, hard cap >8) and
// resolvePack's caching / cyclic-extends behavior. Pure unit tests with
// the loader dependency injected — never touches disk.
//
// resolveActivePackName (the 7-tier resolver) is already covered by
// schema-pack-loader.test.ts; this file targets resolvePack only.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  EXTENDS_DEPTH_HARD_CAP,
  EXTENDS_DEPTH_WARN,
  ExtendsChainTooDeepError,
  resolvePack,
  _resetPackCacheForTests,
} from '../src/core/schema-pack/registry.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { SCHEMA_PACK_API_VERSION } from '../src/core/schema-pack/manifest-v1.ts';

function makeManifest(name: string, extendsName: string | null = null): SchemaPackManifest {
  return {
    api_version: SCHEMA_PACK_API_VERSION,
    name,
    version: '1.0.0',
    description: '',
    gbrain_min_version: '0.38.0',
    extends: extendsName,
    borrow_from: [],
    page_types: [],
    link_types: [],
    frontmatter_links: [],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    enrichable_types: [],
    filing_rules: [],
  } as SchemaPackManifest;
}

function chainLoader(byName: Record<string, SchemaPackManifest>) {
  return async (name: string): Promise<SchemaPackManifest> => {
    if (!byName[name]) throw new Error(`unexpected lookup: ${name}`);
    return byName[name];
  };
}

beforeEach(() => {
  _resetPackCacheForTests();
});

describe('resolvePack — happy path', () => {
  test('resolves leaf with no extends', async () => {
    const manifest = makeManifest('leaf');
    const resolved = await resolvePack(manifest, async () => {
      throw new Error('loader should not be called');
    });
    expect(resolved.identity).toMatch(/^leaf@1\.0\.0\+[0-9a-f]{8}$/);
    expect(resolved.manifest_sha8).toMatch(/^[0-9a-f]{8}$/);
    expect(resolved.alias_closure_hash).toMatch(/^[0-9a-f]{8,}$/);
  });

  test('caches by pack identity across repeat calls', async () => {
    const manifest = makeManifest('cached');
    const first = await resolvePack(manifest, async () => {
      throw new Error('unused');
    });
    const second = await resolvePack(manifest, async () => {
      throw new Error('unused');
    });
    expect(first).toBe(second);
  });

  test('different manifests get different identities', async () => {
    const a = makeManifest('a');
    const b = makeManifest('b');
    const noop = async () => { throw new Error('unused'); };
    const ra = await resolvePack(a, noop);
    const rb = await resolvePack(b, noop);
    expect(ra.identity).not.toBe(rb.identity);
  });
});

describe('resolvePack — extends-chain depth ladder', () => {
  test('two-link chain succeeds with no warn callback', async () => {
    // child -> parent.
    const child = makeManifest('child', 'parent');
    const parent = makeManifest('parent', null);
    const warns: number[] = [];
    const resolved = await resolvePack(child, chainLoader({ parent }), {
      onDepthWarn: depth => warns.push(depth),
    });
    expect(resolved).toBeDefined();
    expect(warns).toEqual([]);
  });

  test('chain of EXTENDS_DEPTH_WARN+1 fires soft-warn callback', async () => {
    // Build chain: a0 -> a1 -> a2 -> a3 -> a4 (5 packs; depth tracked = 5 once a4 is appended).
    const len = EXTENDS_DEPTH_WARN + 1; // 5
    const packs: SchemaPackManifest[] = [];
    for (let i = 0; i < len; i++) {
      packs.push(makeManifest(`a${i}`, i < len - 1 ? `a${i + 1}` : null));
    }
    const byName: Record<string, SchemaPackManifest> = {};
    for (const p of packs) byName[p.name] = p;
    const warns: Array<{ depth: number; chain: string[] }> = [];
    await resolvePack(packs[0], chainLoader(byName), {
      onDepthWarn: (depth, chain) => warns.push({ depth, chain: [...chain] }),
    });
    // The chain crosses the warn threshold once it lengthens beyond
    // EXTENDS_DEPTH_WARN; verify at least one warn fired and that the
    // chain it reports is increasing in length.
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w.depth).toBeGreaterThan(EXTENDS_DEPTH_WARN);
      expect(w.chain[0]).toBe('a0');
    }
  });

  test('chain exceeding EXTENDS_DEPTH_HARD_CAP throws ExtendsChainTooDeepError', async () => {
    // Build a chain longer than the hard cap so the walker has to refuse.
    const len = EXTENDS_DEPTH_HARD_CAP + 3;
    const packs: SchemaPackManifest[] = [];
    for (let i = 0; i < len; i++) {
      packs.push(makeManifest(`p${i}`, i < len - 1 ? `p${i + 1}` : null));
    }
    const byName: Record<string, SchemaPackManifest> = {};
    for (const p of packs) byName[p.name] = p;

    let caught: unknown;
    try {
      await resolvePack(packs[0], chainLoader(byName));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtendsChainTooDeepError);
    if (caught instanceof ExtendsChainTooDeepError) {
      expect(caught.depth).toBeGreaterThan(EXTENDS_DEPTH_HARD_CAP);
      expect(caught.chain.length).toBeGreaterThan(EXTENDS_DEPTH_HARD_CAP);
      expect(caught.chain[0]).toBe('p0');
      expect(caught.message).toContain('extends chain depth');
      expect(caught.message).toContain('→');
    }
  });

  test('cyclic extends rejected as too-deep before infinite loop', async () => {
    // a -> b -> a -> b -> ...
    const a = makeManifest('a', 'b');
    const b = makeManifest('b', 'a');
    let caught: unknown;
    try {
      await resolvePack(a, chainLoader({ a, b }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtendsChainTooDeepError);
    if (caught instanceof ExtendsChainTooDeepError) {
      // The cycle detector should fire on the SECOND visit to 'a' (chain becomes [a,b,a]).
      // chain.length captures the offending walk path.
      expect(caught.chain).toContain('a');
      expect(caught.chain).toContain('b');
    }
  });

  test('warn callback is optional (no opts arg works)', async () => {
    const child = makeManifest('child', 'parent');
    const parent = makeManifest('parent', null);
    // Should not throw even without onDepthWarn registered.
    const resolved = await resolvePack(child, chainLoader({ parent }));
    expect(resolved).toBeDefined();
  });
});

describe('ExtendsChainTooDeepError shape', () => {
  test('exposes depth + chain fields for caller diagnostics', () => {
    const err = new ExtendsChainTooDeepError(10, ['x', 'y', 'z']);
    expect(err.name).toBe('ExtendsChainTooDeepError');
    expect(err.depth).toBe(10);
    expect(err.chain).toEqual(['x', 'y', 'z']);
    expect(err.message).toContain('x → y → z');
  });
});
