/**
 * MCP `search` tool — per-call source scoping (reported by morzu117/swairm,
 * a multi-source consumer wiring a 2nd repo into one shared brain).
 *
 * Pre-fix bug: the `search` op's params had no `source_id` field, and its
 * handler called plain `sourceScopeOpts(ctx)` — it could ONLY see the
 * source baked into the OperationContext (CLI `--source` / GBRAIN_SOURCE /
 * per-token grant). An MCP tool-caller had no way to scope a single
 * `search` tool call to one source; `query`, `search_by_image`, and the
 * code-intel ops already supported this via `resolveRequestedScope`.
 *
 * This test goes through `dispatchToolCall` — the same code path stdio MCP
 * and HTTP MCP both use — so it proves the fix end-to-end at the transport
 * boundary, not just at the op-handler unit level (see
 * test/source-scope-resolver.test.ts for the resolver's own unit matrix).
 *
 * Runs against PGLite in-memory. No DATABASE_URL, no API keys — the search
 * op is forced into its keyword-only path (`search.mcp_keyword_only`) so
 * the assertions don't depend on an embedding provider being configured.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
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
  await engine.setConfig('search.mcp_keyword_only', 'true');

  // Two sources, each with a page carrying a distinct, greppable keyword so
  // a cross-source leak is unambiguous in the assertions below.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('alpha', 'alpha', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('beta', 'beta', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage('notes/alpha-doc', {
    type: 'note',
    title: 'Alpha Doc',
    compiled_truth: 'This page mentions zylophant, a keyword unique to the alpha source.',
  }, { sourceId: 'alpha' });
  await engine.putPage('notes/beta-doc', {
    type: 'note',
    title: 'Beta Doc',
    compiled_truth: 'This page mentions quixotron, a keyword unique to the beta source.',
  }, { sourceId: 'beta' });

  // v0.42.x migration 124 dropped compiled_truth from the search vector
  // (#2704 — it was overflowing tsvector on large pages). searchKeyword
  // ranks off content_chunks.search_vector, so seed a chunk per page
  // directly (same pattern as test/pages-soft-delete.test.ts) — the schema
  // trigger populates search_vector from chunk_text.
  const alphaPage = await engine.getPage('notes/alpha-doc', { sourceId: 'alpha' });
  const betaPage = await engine.getPage('notes/beta-doc', { sourceId: 'beta' });
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, 'This page mentions zylophant, a keyword unique to the alpha source.', 'compiled_truth')`,
    [alphaPage!.id],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, 'This page mentions quixotron, a keyword unique to the beta source.', 'compiled_truth')`,
    [betaPage!.id],
  );
});

describe('MCP search tool — source_id per-call scope', () => {
  test('no source_id + ctx.sourceId=alpha: search "zylophant" hits, "quixotron" misses', async () => {
    const hit = await dispatchToolCall(engine, 'search', { query: 'zylophant' }, {
      remote: true,
      sourceId: 'alpha',
    });
    const hitResults = JSON.parse(hit.content[0].text);
    expect(hit.isError).toBeFalsy();
    expect(hitResults.length).toBeGreaterThan(0);
    expect(hitResults.every((r: any) => r.slug === 'notes/alpha-doc')).toBe(true);

    const miss = await dispatchToolCall(engine, 'search', { query: 'quixotron' }, {
      remote: true,
      sourceId: 'alpha',
    });
    const missResults = JSON.parse(miss.content[0].text);
    expect(missResults.length).toBe(0);
  });

  test('explicit source_id="beta" overrides ctx.sourceId="alpha" for a single tool call', async () => {
    // ctx.sourceId is 'alpha' (as if the token / stdio env defaulted there),
    // but this ONE tool call asks for beta — the whole point of the fix.
    const result = await dispatchToolCall(engine, 'search', {
      query: 'quixotron',
      source_id: 'beta',
    }, {
      remote: true,
      sourceId: 'alpha',
    });
    expect(result.isError).toBeFalsy();
    const results = JSON.parse(result.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: any) => r.slug === 'notes/beta-doc')).toBe(true);
  });

  test('a remote federated grant rejects an out-of-grant source_id (permission_denied)', async () => {
    const result = await dispatchToolCall(engine, 'search', {
      query: 'quixotron',
      source_id: 'beta',
    }, {
      remote: true,
      sourceId: 'alpha',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['alpha'] } as any,
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('permission_denied');
  });

  test('a remote federated grant allows an in-grant source_id', async () => {
    const result = await dispatchToolCall(engine, 'search', {
      query: 'quixotron',
      source_id: 'beta',
    }, {
      remote: true,
      sourceId: 'alpha',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['alpha', 'beta'] } as any,
    });
    expect(result.isError).toBeFalsy();
    const results = JSON.parse(result.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: any) => r.slug === 'notes/beta-doc')).toBe(true);
  });

  test('source_id="__all__" from a trusted local (remote:false) caller spans both sources', async () => {
    const result = await dispatchToolCall(engine, 'search', {
      query: 'zylophant OR quixotron',
      source_id: '__all__',
    }, {
      remote: false,
      sourceId: 'alpha',
    });
    expect(result.isError).toBeFalsy();
  });
});
