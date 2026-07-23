/**
 * list_pages silent-truncation seal.
 *
 * The op clamps limit to max 100 (default 50) — deliberate, pinned in
 * test/search-limit.test.ts. Pre-fix, a caller whose limit was clamped (or
 * defaulted) received a full-looking array with NO signal that rows were
 * dropped, and with the default updated_desc sort the dropped rows are
 * always the OLDEST — precisely what exhaustive consumers (audits, scans,
 * backfills) exist to find.
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
 *
 * Runs against PGLite in-memory (both engines share the SQL surface; the
 * handler change touches no engine code).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

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
    expect(warnings[0]).toContain('sort=updated_asc');
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

  test('requested above cap and rows above cap: 100 returned + warning', async () => {
    await seed(101);
    const { result, warnings } = await runCapturing(ctxOf(), { limit: 200 });
    expect(result.length).toBe(100);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('truncated at 100 rows');
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
