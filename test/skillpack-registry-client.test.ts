/**
 * Tests for src/core/skillpack/registry-client.ts — fetch + cache +
 * stale-fallback semantics.
 *
 * Network is exercised via an injected fetchImpl test seam so tests are
 * deterministic and fast.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_REGISTRY_URL,
  RegistryClientError,
  findPack,
  findPackWithTier,
  loadRegistry,
  resolveRegistryUrl,
  searchPacks,
} from '../src/core/skillpack/registry-client.ts';
import {
  ENDORSEMENTS_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  type RegistryCatalog,
  type EndorsementsFile,
  type RegistryEntry,
} from '../src/core/skillpack/registry-schema.ts';

const ENTRY: RegistryEntry = {
  name: 'hackathon-evaluation',
  description: 'Score hackathon submissions',
  author: 'Garry Tan',
  author_handle: 'garrytan',
  homepage: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
  source: {
    kind: 'git',
    url: 'https://github.com/garrytan/skillpack-hackathon-evaluation.git',
    pinned_commit: 'a'.repeat(40),
  },
  tarball_sha256: 'b'.repeat(64),
  gbrain_min_version: '0.36.0',
  default_tier: 'community',
  tags: ['evaluation', 'yc'],
  validated_at: '2026-05-18T20:00:00Z',
  validation_run_id: 'r1',
  skills_count: 2,
  skills: ['skills/judge-submission', 'skills/score-rubric'],
  version: '0.1.0',
};

const SECOND_ENTRY: RegistryEntry = {
  ...ENTRY,
  name: 'founder-scorecard',
  description: 'Rate a founder',
  tags: ['founder'],
};

const CATALOG: RegistryCatalog = {
  schema_version: REGISTRY_SCHEMA_VERSION,
  updated_at: '2026-05-18T20:00:00Z',
  skillpacks: [ENTRY, SECOND_ENTRY],
};

const ENDORSEMENTS: EndorsementsFile = {
  schema_version: ENDORSEMENTS_SCHEMA_VERSION,
  endorsements: {
    'hackathon-evaluation': { tier: 'endorsed', endorsed_at: '2026-05-18' },
  },
};

let tmp: string;
let cacheDir: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reg-client-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmp, 'cache-'));
});

function makeFetchImpl(
  responses: Record<string, { body: unknown; etag?: string; status?: number; ok?: boolean }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const r = responses[url];
    if (!r) {
      throw new Error(`fetch test seam: no fixture for ${url}`);
    }
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    const headers = new Headers();
    if (r.etag) headers.set('etag', r.etag);
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      headers,
      json: async () => r.body,
    } as Response;
  }) as typeof fetch;
}

describe('resolveRegistryUrl', () => {
  test('defaults to the canonical URL when no override', () => {
    expect(resolveRegistryUrl({})).toBe(DEFAULT_REGISTRY_URL);
  });

  test('opts.url wins', () => {
    expect(resolveRegistryUrl({ url: 'https://example.com/r.json' })).toBe(
      'https://example.com/r.json',
    );
  });
});

describe('loadRegistry — fresh fetch path', () => {
  test('fetches catalog + endorsements, writes cache, returns fresh_fetch', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG, etag: 'abc' },
      [eurl]: { body: ENDORSEMENTS },
    });
    const r = await loadRegistry({ url, cacheDir, fetchImpl });
    expect(r.origin).toBe('fresh_fetch');
    expect(r.catalog.skillpacks).toHaveLength(2);
    expect(r.endorsements?.endorsements['hackathon-evaluation']?.tier).toBe('endorsed');
    expect(r.registry_url).toBe(url);
  });

  test('missing endorsements.json is treated as null, not failure', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: {}, status: 404, ok: false },
    });
    const r = await loadRegistry({ url, cacheDir, fetchImpl });
    expect(r.endorsements).toBeNull();
  });

  test('schema-invalid response throws fetch_succeeded_but_schema_invalid', async () => {
    const url = 'https://example.com/registry.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: { schema_version: 'wrong' } },
    });
    try {
      await loadRegistry({ url, cacheDir, fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistryClientError).code).toBe('fetch_succeeded_but_schema_invalid');
    }
  });
});

describe('loadRegistry — cache fallback', () => {
  test('uses cache_warm when cache < 1h old and refresh=false', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    await loadRegistry({ url, cacheDir, fetchImpl });
    // Second call should hit cache_warm without calling fetch.
    let calls = 0;
    const noFetch = (async () => {
      calls++;
      throw new Error('should not have been called');
    }) as unknown as typeof fetch;
    const r2 = await loadRegistry({ url, cacheDir, fetchImpl: noFetch });
    expect(r2.origin).toBe('cache_warm');
    expect(calls).toBe(0);
  });

  test('falls back to cache_soft_stale when network fails', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    // Seed cache.
    const fetchImpl1 = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    await loadRegistry({ url, cacheDir, fetchImpl: fetchImpl1 });
    // Hand-edit the cache file to make it look 2 hours old (past SOFT_TTL).
    const cacheFiles = require('fs').readdirSync(cacheDir);
    const cf = join(cacheDir, cacheFiles[0]);
    const data = JSON.parse(require('fs').readFileSync(cf, 'utf-8'));
    data.fetched_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(cf, JSON.stringify(data));
    // Now fail network.
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await loadRegistry({ url, cacheDir, fetchImpl: failing });
    expect(r.origin).toBe('cache_soft_stale');
  });

  test('falls back to cache_hard_stale when cache > 7d', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl1 = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    await loadRegistry({ url, cacheDir, fetchImpl: fetchImpl1 });
    const cacheFiles = require('fs').readdirSync(cacheDir);
    const cf = join(cacheDir, cacheFiles[0]);
    const data = JSON.parse(require('fs').readFileSync(cf, 'utf-8'));
    data.fetched_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(cf, JSON.stringify(data));
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await loadRegistry({ url, cacheDir, fetchImpl: failing });
    expect(r.origin).toBe('cache_hard_stale');
  });

  test('throws no_cache_no_network on first run with no network', async () => {
    const url = 'https://example.com/registry.json';
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    try {
      await loadRegistry({ url, cacheDir, fetchImpl: failing });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistryClientError).code).toBe('no_cache_no_network');
    }
  });

  test('noNetwork=true uses cache when present', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    await loadRegistry({ url, cacheDir, fetchImpl });
    const r = await loadRegistry({ url, cacheDir, noNetwork: true });
    expect(['cache_warm', 'cache_soft_stale', 'cache_hard_stale']).toContain(r.origin);
  });

  test('noNetwork=true throws when no cache', async () => {
    const url = 'https://example.com/registry.json';
    try {
      await loadRegistry({ url, cacheDir, noNetwork: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RegistryClientError).code).toBe('no_cache_no_network');
    }
  });
});

describe('findPack + findPackWithTier', () => {
  test('finds entry by name; returns null when missing', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    const r = await loadRegistry({ url, cacheDir, fetchImpl });
    expect(findPack(r, 'hackathon-evaluation')?.name).toBe('hackathon-evaluation');
    expect(findPack(r, 'nonexistent')).toBeNull();
  });

  test('findPackWithTier resolves endorsement overlay', async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    const r = await loadRegistry({ url, cacheDir, fetchImpl });
    const found = findPackWithTier(r, 'hackathon-evaluation');
    expect(found?.tier).toBe('endorsed');
    const community = findPackWithTier(r, 'founder-scorecard');
    expect(community?.tier).toBe('community');
  });
});

describe('searchPacks', () => {
  let loaded: Awaited<ReturnType<typeof loadRegistry>>;
  beforeEach(async () => {
    const url = 'https://example.com/registry.json';
    const eurl = 'https://example.com/endorsements.json';
    const fetchImpl = makeFetchImpl({
      [url]: { body: CATALOG },
      [eurl]: { body: ENDORSEMENTS },
    });
    loaded = await loadRegistry({ url, cacheDir, fetchImpl });
  });

  test('no query returns all entries, endorsed first', () => {
    const results = searchPacks(loaded);
    expect(results).toHaveLength(2);
    expect(results[0]?.entry.name).toBe('hackathon-evaluation');
    expect(results[0]?.tier).toBe('endorsed');
    expect(results[1]?.entry.name).toBe('founder-scorecard');
    expect(results[1]?.tier).toBe('community');
  });

  test('query matches against name', () => {
    const r = searchPacks(loaded, { query: 'founder' });
    expect(r).toHaveLength(1);
    expect(r[0]?.entry.name).toBe('founder-scorecard');
  });

  test('query matches against tags', () => {
    const r = searchPacks(loaded, { query: 'yc' });
    expect(r).toHaveLength(1);
    expect(r[0]?.entry.name).toBe('hackathon-evaluation');
  });

  test('query matches against description', () => {
    const r = searchPacks(loaded, { query: 'rate' });
    expect(r).toHaveLength(1);
    expect(r[0]?.entry.name).toBe('founder-scorecard');
  });

  test('tier filter narrows to just that tier', () => {
    const r = searchPacks(loaded, { tier: 'community' });
    expect(r).toHaveLength(1);
    expect(r[0]?.entry.name).toBe('founder-scorecard');
  });

  test('empty result when nothing matches', () => {
    expect(searchPacks(loaded, { query: 'nothing-here' })).toEqual([]);
  });
});
