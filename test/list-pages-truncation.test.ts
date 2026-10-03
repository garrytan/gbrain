/**
 * list_pages silent-truncation seal.
 *
 * The op defaults limit to 50 and clamps remote callers to max 100 (local
 * explicit limits are honored since #3322 — pinned in
 * test/list-clamp-local-trust.test.ts). Pre-fix, a caller whose limit was
 * defaulted (or remotely clamped) received a full-looking array with NO
 * signal that rows were dropped, and with the default updated_desc sort the
 * dropped rows are always the OLDEST — precisely what exhaustive consumers
 * (audits, scans, backfills) exist to find.
 *
 * Covers, at the op-handler layer (engine listPages surface unchanged —
 * the handler only probes limit+1):
 *   - default-limit truncation returns exactly 50 rows and warns on stderr
 *     (local ctx only)
 *   - an explicit, honored limit does NOT warn (ordinary pagination)
 *   - a clamped-but-complete result (requested > cap, rows ≤ cap) does NOT
 *     warn — nothing was dropped
 *   - remote ctx never writes to stderr (MCP server logs stay clean)
 *   - the pagination recipe in LIST_PAGES_DESCRIPTION (sort=updated_asc +
 *     updated_after cursor) actually enumerates every row to completion
 *   - remote callers get the same facts on the `pagination` response meta
 *     (truncated, limit, clamped_from, next), and MCP dispatch adds a
 *     model-visible block while content[0] stays the bare array
 *
 * Runs against PGLite in-memory (both engines share the SQL surface; the
 * handler change touches no engine code).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { ListPagesPagination } from '../src/core/ops/list-pages-pagination.ts';

const list_pages = operations.find(o => o.name === 'list_pages')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const page = (n: number) => ({
  type: 'note' as const,
  title: `Note ${String(n).padStart(3, '0')}`,
  compiled_truth: `Body of note ${n}.`,
  timeline: '',
  frontmatter: {},
});

async function seed(count: number) {
  for (let i = 1; i <= count; i++) {
    await engine.putPage(`notes/note-${String(i).padStart(3, '0')}`, page(i), { sourceId: 'default' });
  }
}

/** Run the handler while capturing stderr writes made through console.error. */
async function runCapturing(ctx: OperationContext, params: Record<string, unknown>) {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await list_pages.handler(ctx, params) as any[];
    const warnings = spy.mock.calls.map(args => args.join(' ')).filter(s => s.includes('[list_pages]'));
    return { result, warnings };
  } finally {
    spy.mockRestore();
  }
}

describe('list_pages truncation signal', () => {
  test('default limit: 51 rows → exactly 50 returned + stderr warning', async () => {
    await seed(51);
    const { result, warnings } = await runCapturing(ctxOf(), {});
    expect(result.length).toBe(50);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('truncated at 50 rows');
    expect(warnings[0]).toContain('updated_after_slug');
  }, 30_000);

  test('explicit honored limit: no warning even when more rows exist', async () => {
    await seed(12);
    const { result, warnings } = await runCapturing(ctxOf(), { limit: 10 });
    expect(result.length).toBe(10);
    expect(warnings.length).toBe(0);
  }, 30_000);

  test('clamped but complete: requested > cap with rows ≤ cap → all rows, no warning', async () => {
    await seed(12);
    const { result, warnings } = await runCapturing(ctxOf(), { limit: 200 });
    expect(result.length).toBe(12);
    expect(warnings.length).toBe(0);
  }, 30_000);

  test('local explicit limit above 100 is honored (#3322) — all rows, no warning', async () => {
    await seed(101);
    const { result, warnings } = await runCapturing(ctxOf(), { limit: 200 });
    expect(result.length).toBe(101);
    expect(warnings.length).toBe(0);
  }, 60_000);

  test('remote requested above cap: clamped to 100, truncation stays off stderr', async () => {
    await seed(101);
    const { result, warnings } = await runCapturing(ctxOf({ remote: true }), { limit: 200 });
    expect(result.length).toBe(100);
    // The #3322 clamp warning goes through ctx.logger.warn; the [list_pages]
    // truncation hint is local-only, so console.error stays clean here.
    expect(warnings.length).toBe(0);
  }, 60_000);

  test('remote ctx: truncation stays silent on stderr (MCP logs clean)', async () => {
    await seed(51);
    const { result, warnings } = await runCapturing(ctxOf({ remote: true }), {});
    expect(result.length).toBe(50);
    expect(warnings.length).toBe(0);
  }, 30_000);

  test('documented cursor recipe enumerates all rows to completion', async () => {
    await seed(23);
    // Spread updated_at deterministically: back-to-back putPage calls can land
    // on identical timestamps, and a strict `updated_at > cursor` walk would
    // then skip the tied rows — that would be a flake in THIS test, not a
    // property of the recipe (real corpora update over time).
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() - (interval '1 minute' * (100 - id)) WHERE slug LIKE 'notes/note-%'`,
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    // sort=updated_asc + updated_after=<last row's updated_at>, stop when a
    // page returns fewer rows than the limit — verbatim the recipe in
    // LIST_PAGES_DESCRIPTION.
    for (let guard = 0; guard < 10; guard++) {
      const params: Record<string, unknown> = { limit: 10, sort: 'updated_asc' };
      if (cursor !== undefined) params.updated_after = cursor;
      const { result } = await runCapturing(ctxOf(), params);
      for (const row of result) seen.add(row.slug);
      if (result.length < 10) break;
      cursor = result[result.length - 1].updated_at instanceof Date
        ? result[result.length - 1].updated_at.toISOString()
        : String(result[result.length - 1].updated_at);
    }
    expect(seen.size).toBe(23);
  }, 30_000);
});

// The stderr notice above is local-only and the remote clamp warning goes to
// the server log, so before this a remote caller holding exactly `limit` rows
// could not tell a full page from a complete listing.
describe('list_pages pagination meta for remote callers', () => {
  function remote(params: Record<string, unknown>) {
    const meta: Record<string, unknown> = {};
    const ctx = ctxOf({ remote: true, emitResponseMeta: (key, value) => { meta[key] = value; } });
    return runCapturing(ctx, params).then(({ result }) => ({ result, pagination: meta.pagination as ListPagesPagination }));
  }

  test('limit below the row count: truncated, with an offset continuation', async () => {
    await seed(12);
    const { result, pagination } = await remote({ limit: 10 });
    expect(result.length).toBe(10);
    expect(pagination).toEqual({ truncated: true, limit: 10, next: { offset: 10 } });
  }, 30_000);

  test('limit above the remote cap: clamped_from carries the requested limit', async () => {
    await seed(101);
    const { result, pagination } = await remote({ limit: 200 });
    expect(result.length).toBe(100);
    expect(pagination).toEqual({ truncated: true, limit: 100, clamped_from: 200, next: { offset: 100 } });
  }, 60_000);

  test('complete listing: truncated false, no next', async () => {
    await seed(5);
    const { result, pagination } = await remote({ limit: 10 });
    expect(result.length).toBe(5);
    expect(pagination).toEqual({ truncated: false, limit: 10 });
  }, 30_000);

  test('updated_asc: next is the keyset of the last row', async () => {
    await seed(12);
    const { result, pagination } = await remote({ limit: 10, sort: 'updated_asc' });
    const last = result[result.length - 1];
    expect(pagination.next).toEqual({ sort: 'updated_asc', updated_after: last.updated_at_iso, updated_after_slug: last.slug });
  }, 30_000);

  test('following next until truncated is false enumerates every row exactly once', async () => {
    await seed(23);
    // updated_asc pages a bulk-sync cluster (one shared timestamp) through the
    // keyset; offset under updated_desc needs distinct timestamps, which has
    // no tiebreaker.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sort: 'updated_asc' }, `UPDATE pages SET updated_at = '2026-08-10T12:00:00.000123Z'::timestamptz WHERE slug LIKE 'notes/note-%'`],
      [{}, `UPDATE pages SET updated_at = now() - (interval '1 minute' * (100 - id)) WHERE slug LIKE 'notes/note-%'`],
    ];
    for (const [base, spread] of cases) {
      await engine.executeRaw(spread);
      const seen: string[] = [];
      let params: Record<string, unknown> = { ...base, limit: 10 };
      for (let guard = 0; guard < 10; guard++) {
        const { result, pagination } = await remote(params);
        seen.push(...result.map(r => r.slug as string));
        if (!pagination.truncated) break;
        params = { ...params, ...pagination.next };
      }
      expect(seen.length).toBe(23);
      expect(new Set(seen).size).toBe(23);
    }
  }, 60_000);

  test('MCP dispatch: content[0] stays the bare array, a second block names the next page', async () => {
    await seed(12);
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
    const res = await dispatchToolCall(engine as any, 'list_pages', { limit: 10 }, opts);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toHaveLength(10);
    expect(res.content).toHaveLength(2);
    expect(res.content[1].text).toBe('truncated: more rows match than the 10 returned. Next page: repeat the call with {"offset":10}, all other params unchanged.');
    expect(res._meta?.pagination).toEqual({ truncated: true, limit: 10, next: { offset: 10 } });

    const complete = await dispatchToolCall(engine as any, 'list_pages', { limit: 20 }, opts);
    expect(complete.content).toHaveLength(1);
    expect(complete._meta?.pagination).toEqual({ truncated: false, limit: 20 });
  }, 30_000);
});
