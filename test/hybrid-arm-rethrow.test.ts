/**
 * hybridSearch lexical-arm rethrow (db-availability loop) — per-arm fail-open
 * is for DEGRADED arms, never for a DEAD DATABASE:
 *
 *   - BOTH searchKeyword and searchTitles failing with a DB-ACCESS-class
 *     error (isDbAccessFailure) rethrows the keyword arm's error so the
 *     classified database_error envelope reaches the caller instead of a
 *     silent [].
 *   - One arm SUCCEEDING (even with zero rows) proves the DB is alive → no
 *     rethrow, the search completes fail-open.
 *   - Both arms failing with NON-access errors (schema gaps etc.) keeps the
 *     historical fail-open contract — no rethrow.
 *
 * Driven with a minimal fake engine: the two lexical arms are the variables;
 * every other engine surface hybridSearch's fail-open stages may touch
 * resolves benign-empty. The unit lane is hermetic-keyless (provider-keys
 * preload), so the vector leg short-circuits to the keyword-only path and
 * no gateway/network is ever hit.
 */

import { describe, test, expect } from 'bun:test';

import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sqlEngineKind } from '../src/core/sql-engine-kind.ts';
import { isEngineCapabilityRefusal } from '../src/core/engine-capability-refusal.ts';
import { capabilitiesForEngineKind } from '../src/core/engine-capabilities.ts';
import { remoteAccessRefusal } from '../src/mcp/engine-access-refusal.ts';

function accessError(msg = 'connect ECONNREFUSED 127.0.0.1:5432'): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'ECONNREFUSED';
  return e;
}

function fakeEngine(arms: {
  searchKeyword: () => Promise<SearchResult[]>;
  searchTitles: () => Promise<SearchResult[]>;
}): BrainEngine {
  return {
    kind: 'pglite',
    getConfig: async () => null,
    executeRaw: async () => [],
    resolveAliases: async () => new Map(),
    getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(),
    getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: async () => [],
    searchVector: async () => [],
    searchKeyword: arms.searchKeyword,
    searchTitles: arms.searchTitles,
  } as unknown as BrainEngine;
}

// A plain phrase: never parses as a relational query, never slug/image-shaped.
const QUERY = 'orchard telemetry notes';

describe('hybridSearch both-lexical-arms-FAILED rethrow', () => {
  test('BOTH arms reject with a DB-access-class error → rethrows the keyword error (identity)', async () => {
    const kwErr = accessError();
    const titleErr = accessError('connection refused during titles scan');
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(kwErr),
      searchTitles: () => Promise.reject(titleErr),
    });
    let caught: unknown;
    try {
      await hybridSearch(engine, QUERY, { limit: 5 });
    } catch (e) {
      caught = e;
    }
    // The KEYWORD arm's error is the one rethrown (`throw keywordAccessError`)
    // — by identity, so dispatch's classifier sees the REAL error shape.
    expect(caught).toBe(kwErr);
  });

  test('keyword arm access-fails but titles SUCCEEDS with zero rows → NO rethrow (DB proven alive)', async () => {
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(accessError()),
      searchTitles: async () => [],
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });

  test('titles arm access-fails but keyword SUCCEEDS with zero rows → NO rethrow (symmetric)', async () => {
    const engine = fakeEngine({
      searchKeyword: async () => [],
      searchTitles: () => Promise.reject(accessError('ECONNREFUSED titles')),
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  test('BOTH arms reject with NON-access errors → fail-open preserved, no rethrow', async () => {
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(new Error('schema thing exploded')),
      searchTitles: () => Promise.reject(new Error('another schema thing')),
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });
});

describe('a failed lexical arm is stamped in meta.degraded (#5324)', () => {
  test('keyword arm failure → keyword_arm_failed; title arm failure → title_arm_failed', async () => {
    const run = async (arms: Parameters<typeof fakeEngine>[0]) => {
      let degraded: Array<{ stage: string; reason?: string }> = [];
      await hybridSearch(fakeEngine(arms), QUERY, { limit: 5, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
      return degraded;
    };
    expect(await run({ searchKeyword: () => Promise.reject(new Error('boom')), searchTitles: async () => [] }))
      .toContainEqual({ stage: 'keyword_arm_failed', reason: 'provider_error' });
    const titles = await run({ searchKeyword: async () => [], searchTitles: () => Promise.reject(new Error('boom')) });
    expect(titles).toContainEqual({ stage: 'title_arm_failed', reason: 'provider_error' });
    expect(titles.map(d => d.stage)).not.toContain('keyword_arm_failed');
  });

  test('a Postgres statement timeout (SQLSTATE 57014) is stamped reason timeout, not provider_error (#6495)', async () => {
    const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PostgresError', code: '57014' });
    const run = async (arms: Parameters<typeof fakeEngine>[0]) => {
      let degraded: Array<{ stage: string; reason?: string }> = [];
      await hybridSearch(fakeEngine(arms), QUERY, { limit: 5, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
      return degraded;
    };
    expect(await run({ searchKeyword: () => Promise.reject(statementTimeout()), searchTitles: async () => [] }))
      .toContainEqual({ stage: 'keyword_arm_failed', reason: 'timeout' });
    expect(await run({ searchKeyword: async () => [], searchTitles: () => Promise.reject(statementTimeout()) }))
      .toContainEqual({ stage: 'title_arm_failed', reason: 'timeout' });
  });

  test('healthy arms stamp neither stage', async () => {
    let degraded: Array<{ stage: string }> = [];
    await hybridSearch(fakeEngine({ searchKeyword: async () => [], searchTitles: async () => [] }), QUERY, {
      limit: 5, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; },
    });
    expect(degraded.map(d => d.stage)).not.toContain('keyword_arm_failed');
    expect(degraded.map(d => d.stage)).not.toContain('title_arm_failed');
  });
});

// An engine that refuses an option (engine_capability_missing, raised only by
// the Rust engine) must reach the caller, never read as an empty lexical arm.
// Any other error keeps the fail-open path above, which is all PGLite and
// Postgres can raise: neither engine produces engine_capability_missing.
describe('a refused lexical option reaches the caller', () => {
  const refusal = () => Object.assign(new Error('option excludePrivate'), { code: 'engine_capability_missing' });

  test('a refused keyword arm rethrows the refusal (identity), not an empty result', async () => {
    const err = refusal();
    const engine = fakeEngine({ searchKeyword: () => Promise.reject(err), searchTitles: async () => [] });
    let caught: unknown;
    try { await hybridSearch(engine, QUERY, { limit: 5 }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
  });

  test('a refused title arm rethrows the refusal (identity), not an empty result', async () => {
    const err = refusal();
    const engine = fakeEngine({ searchKeyword: async () => [], searchTitles: () => Promise.reject(err) });
    let caught: unknown;
    try { await hybridSearch(engine, QUERY, { limit: 5 }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
  });

  test('the envelope form of the refusal is rethrown too', async () => {
    const err = Object.assign(new Error('refused'), { envelope: { code: 'engine_capability_missing' } });
    const engine = fakeEngine({ searchKeyword: () => Promise.reject(err), searchTitles: async () => [] });
    let caught: unknown;
    try { await hybridSearch(engine, QUERY, { limit: 5 }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
  });
});

// The rethrow above is a no-op for PGLite and Postgres because neither engine
// raises engine_capability_missing: outside the Rust engine, the one raiser
// (`capabilityMissing`) is called only by `sqlEngineKind`, which returns for
// both SQL kinds and refuses any other kind.
describe('no PGLite or Postgres path raises engine_capability_missing', () => {
  test('sqlEngineKind returns for pglite and postgres and refuses anything else', () => {
    expect(sqlEngineKind('pglite', 'm')).toBe('pglite');
    expect(sqlEngineKind('postgres', 'm')).toBe('postgres');
    let caught: unknown;
    try { sqlEngineKind('rust', 'm'); } catch (e) { caught = e; }
    expect(isEngineCapabilityRefusal(caught)).toBe(true);
  });

  test('outside the Rust engine only sqlEngineKind calls capabilityMissing', () => {
    const root = join(import.meta.dir, '..', 'src');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith('.ts')) continue;
        const rel = relative(root, path).split(sep).join('/');
        if (rel.startsWith('core/rust-engine/') || rel === 'core/rust-engine.ts') continue;
        if (/\bcapabilityMissing\s*\(/.test(readFileSync(path, 'utf8'))) callers.push(rel);
      }
    };
    walk(root);
    // mcp/engine-access-refusal.ts refuses a remote caller only on an engine without `access_control`; PGLite and
    // Postgres report it, so they never reach that call (pinned by the next test).
    expect(callers.sort()).toEqual(['core/sql-engine-kind.ts', 'mcp/engine-access-refusal.ts']);
  });

  test('the MCP remote-caller refusal never fires on PGLite or Postgres', () => {
    for (const kind of ['pglite', 'postgres'] as const) {
      for (const remote of [true, undefined]) {
        expect(remoteAccessRefusal({ kind, capabilities: capabilitiesForEngineKind(kind) }, 'get_page', remote)).toBeNull();
      }
    }
    expect(isEngineCapabilityRefusal(remoteAccessRefusal({ kind: 'rust' }, 'get_page', true))).toBe(true);
  });
});
