/**
 * v0.41.13 (#1436) — MCP fuzzy `get_page` resolver scopes by source.
 *
 * Pre-fix bug (infiniteGameExp): the `get_page` op handler in
 * operations.ts called `ctx.engine.resolveSlugs(slug)` with no source
 * filter. When the caller's MCP context bound them to a specific
 * source (or a federated_read array), the fuzzy resolver could return
 * candidates from sources they shouldn't see. The handler then loaded
 * each candidate via `getPage(..., sourceOpts)` which IS scoped — so
 * the visible failure mode was "fuzzy returned a candidate but exact
 * lookup 404'd it." The bigger concern is that the candidate slug
 * leaks via the `ambiguous_slug` error envelope.
 *
 * Fix: thread `sourceScopeOpts(ctx)` into the `resolveSlugs(slug, opts)`
 * call. Engine method signature accepts `{sourceId?, sourceIds?}` —
 * field names match `sourceScopeOpts` output so callers spread cleanly.
 * Unscoped behavior preserved when both fields are undefined (back-compat
 * for internal CLI callers).
 *
 * This test seeds the same slug under two source_ids, runs the fuzzy
 * resolver under each context, and asserts the right candidates surface.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Register two sources we can isolate against. addSource via raw SQL is
  // cleaner here than going through runSources (less argv plumbing).
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);

  // Seed the SAME slug under both sources. Pre-fix, fuzzy resolveSlugs
  // would return both candidates regardless of which source the caller
  // was scoped to.
  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice (alpha)',
    compiled_truth: 'Alpha-source Alice page.',
    frontmatter: { type: 'person' },
  }, { sourceId: 'alpha' });
  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice (beta)',
    compiled_truth: 'Beta-source Alice page.',
    frontmatter: { type: 'person' },
  }, { sourceId: 'beta' });
});

describe('#1436 — resolveSlugs honors source scope', () => {
  test('opts.sourceId scopes exact match to a single source', async () => {
    const alphaHit = await engine.resolveSlugs('people/alice', { sourceId: 'alpha' });
    expect(alphaHit).toEqual(['people/alice']);
    const betaHit = await engine.resolveSlugs('people/alice', { sourceId: 'beta' });
    expect(betaHit).toEqual(['people/alice']);
    // Both return the same slug, but the calling op will then load the
    // page under the SAME sourceId, so cross-source leak is closed.
  });

  test('opts.sourceIds (federated_read array) restricts to the listed sources', async () => {
    const both = await engine.resolveSlugs('people/alice', { sourceIds: ['alpha', 'beta'] });
    expect(both).toEqual(['people/alice']);

    const alphaOnly = await engine.resolveSlugs('people/alice', { sourceIds: ['alpha'] });
    expect(alphaOnly).toEqual(['people/alice']);
  });

  test('unscoped call (no opts) preserves pre-fix back-compat for internal callers', async () => {
    // Internal CLI callers (gbrain query --resolve, etc.) walk every source.
    const unscoped = await engine.resolveSlugs('people/alice');
    expect(unscoped).toEqual(['people/alice']);
  });

  test('opts.sourceId for a source with NO matching slug returns empty', async () => {
    // Register a third source with nothing in it.
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('gamma', 'gamma', '/tmp/gamma') ON CONFLICT (id) DO NOTHING`);
    const gamma = await engine.resolveSlugs('people/alice', { sourceId: 'gamma' });
    expect(gamma).toEqual([]);
  });

  test('fuzzy match honors source scope', async () => {
    // 'people/alic' (typo) should fuzzy-resolve in each scope but only
    // see candidates in that source. With our seed of just two
    // 'people/alice' rows, both scopes should each return a single match.
    const alphaFuzzy = await engine.resolveSlugs('people/alic', { sourceId: 'alpha' });
    expect(alphaFuzzy.length).toBeGreaterThan(0);
    expect(alphaFuzzy[0]).toBe('people/alice');

    const gamma = await engine.resolveSlugs('people/alic', { sourceId: 'gamma' });
    expect(gamma).toEqual([]);
  });

  test('soft-deleted rows are excluded from fuzzy candidates', async () => {
    // Delete the alpha row; resolveSlugs should NOT return its slug
    // anymore under scope:alpha. Beta row stays visible.
    await engine.softDeletePage('people/alice', { sourceId: 'alpha' });
    const alpha = await engine.resolveSlugs('people/alice', { sourceId: 'alpha' });
    expect(alpha).toEqual([]);
    const beta = await engine.resolveSlugs('people/alice', { sourceId: 'beta' });
    expect(beta).toEqual(['people/alice']);
  });
});
