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
 *     (truncated, limit, clamped_from, next), and MCP dispatch adds the
 *     model-visible `listing_truncated` notice while content[0] stays the
 *     bare array (#5954, agent contract v1 F3b)
 *
 * Runs against PGLite in-memory (both engines share the SQL surface; the
 * handler change touches no engine code).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall, __resetBackupNoticeForTests } from '../src/mcp/dispatch.ts';
import { __resetFactsDrainNoticesForTests } from '../src/core/facts/drain.ts';
import { withEnv } from './helpers/with-env.ts';
import { __resetBehaviorNoticeForTests } from '../src/core/behavior-change-notice.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// the server log, so before #5954 a remote caller holding exactly `limit`
// rows could not tell a full page from a complete listing.
describe('list_pages pagination meta for remote callers', () => {
  function remote(params: Record<string, unknown>) {
    const meta: Record<string, unknown> = {};
    const notices: unknown[] = [];
    const ctx = ctxOf({ remote: true, emitResponseMeta: (key, value) => { meta[key] = value; }, emitNotice: n => { notices.push(n); } });
    return runCapturing(ctx, params).then(({ result }) => ({ result, notices, pagination: meta.pagination as ListPagesPagination }));
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

  test('complete listing: truncated false, no next, no notice', async () => {
    await seed(5);
    const { result, pagination, notices } = await remote({ limit: 10 });
    expect(result.length).toBe(5);
    expect(pagination).toEqual({ truncated: false, limit: 10 });
    expect(notices).toEqual([]);
  }, 30_000);

  test('updated_asc: next is the keyset of the last row', async () => {
    await seed(12);
    const { result, pagination } = await remote({ limit: 10, sort: 'updated_asc' });
    const last = result[result.length - 1];
    expect(pagination.next).toEqual({ sort: 'updated_asc', updated_after: last.updated_at_iso, updated_after_slug: last.slug });
  }, 30_000);

  test('following the notice fix until no notice comes back enumerates every row exactly once', async () => {
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
        const { result, notices } = await remote(params);
        seen.push(...result.map(r => r.slug as string));
        const notice = notices[0] as { code: string; fix: { mcp: { tool: string; arguments: Record<string, unknown> } } } | undefined;
        if (!notice) break;
        expect(notice.code).toBe('listing_truncated');
        expect(notice.fix.mcp.tool).toBe('list_pages');
        params = notice.fix.mcp.arguments;
      }
      expect(seen.length).toBe(23);
      expect(new Set(seen).size).toBe(23);
    }
  }, 60_000);

  test('local CLI callers get no notice (stderr stays their channel)', async () => {
    await seed(12);
    const notices: unknown[] = [];
    await runCapturing(ctxOf({ remote: false, emitNotice: n => { notices.push(n); } }), { limit: 10 });
    expect(notices).toEqual([]);
  }, 30_000);

  test('MCP dispatch: content[0] stays the bare array; the listing_truncated notice names the next call', async () => {
    __resetBackupNoticeForTests();
    __resetFactsDrainNoticesForTests();
    await seed(12);
    // Once-per-process notices (backup coverage, post-upgrade, a pending facts-drain notice) depend on what other tests
    // in the same shard leave behind; switch them off or clear them so this test counts only the listing notice.
    // The one-time behavior_changes disclosure fires on a brain older than its fresh-install grace (the restored PGLite
    // snapshot is), once per brain per GBRAIN_HOME; a fresh brain in its own GBRAIN_HOME never owes it.
    await engine.executeRaw('UPDATE sources SET created_at = now()');
    __resetBehaviorNoticeForTests();
    const noticeHome = mkdtempSync(join(tmpdir(), 'gbrain-list-pages-notice-'));
    await withEnv({ GBRAIN_BACKUP_CHECK: 'off', GBRAIN_NO_ONBOARD_NUDGE: '1', GBRAIN_HOME: noticeHome }, async () => {
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
    const res = await dispatchToolCall(engine as any, 'list_pages', { limit: 10, type: 'note' }, opts);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toHaveLength(10);
    expect(res.content).toHaveLength(2);
    expect(res.content[1].text.split('\n')[0]).toBe('[gbrain notice listing_truncated kind=info]');
    expect(res.content[1].text).toContain('fix: list_pages {"type":"note","limit":10,"offset":10}');
    expect(res.content[1].text).toContain('next: run');
    expect(res._meta?.pagination).toEqual({ truncated: true, limit: 10, next: { offset: 10 } });
    // Per-call notice: never deduped, so the second truncated page carries it too.
    const again = await dispatchToolCall(engine as any, 'list_pages', { limit: 10, type: 'note' }, opts);
    expect(again.content).toHaveLength(2);

    const complete = await dispatchToolCall(engine as any, 'list_pages', { limit: 20 }, opts);
    expect(complete.content).toHaveLength(1);
    expect(complete._meta?.pagination).toEqual({ truncated: false, limit: 20 });
    });
  }, 30_000);
});
