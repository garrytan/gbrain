/**
 * Golden: the SQL text of the five typed reads that replaced raw SQL in rank_entities' remote coverage,
 * search_exact's held-snippet check, the held fence cells of a world-only fact read and the fence overlay of a page
 * body (readRankCoverage, readExactSnippetChunks, listExactRescanChunks, listHeldFenceCells, readFenceOverlayRows).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLiteEngine and PostgresEngine send byte-identical statement text and parameters for each member
 *    (Postgres also sends readRankCoverage's 10 s statement timeout, which PGLite has no way to apply), and
 *    that text is pinned in `test/fixtures/goldens/remote-reads/statements.json`.
 *  - Regression: an edit to one engine's delegation, or to the shared statement in engine-sql/cli-reads-ops.ts, changes
 *    what a remote caller's coverage or exact search reads; the golden makes that change a reviewer-visible diff.
 *  - Why existing coverage misses it: the SQL-text goldens (test/engine-sql-sql-text.test.ts) classify the CLI-read
 *    members out of scope, and the parity cases compare results, not statement text.
 *  - Seam: an engine object made from each prototype with a recording `executeRaw` (both engines route these members
 *    through it); no database runs. The caller access is pinned with `withCallerAccess`.
 */
import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { IDENTITY, expectGolden } from './helpers/golden.ts';

interface Recorded { sql: string; params: unknown[]; opts: unknown }

/** An engine of `proto` whose `executeRaw` records each statement and answers with one canned row. */
function recordingEngine(proto: object, rows: Record<string, unknown>[]): { engine: BrainEngine; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const engine = Object.create(proto) as BrainEngine;
  Object.defineProperty(engine, 'executeRaw', {
    value: async (sql: string, params?: unknown[], opts?: unknown) => {
      calls.push({ sql, params: params ?? [], opts: opts ?? null });
      return rows;
    },
  });
  return { engine, calls };
}

async function capture(proto: object): Promise<Record<string, Recorded[]>> {
  const run = async (rows: Record<string, unknown>[], fn: (engine: BrainEngine) => Promise<unknown>, identity: string[] = []) => {
    const { engine, calls } = recordingEngine(proto, rows);
    await withCallerAccess(identity.length ? { hidePrivate: true, identity } : { hidePrivate: true }, () => fn(engine));
    return calls;
  };
  const cells = [
    { sourceId: 'default', slug: 'people/held-example', rowNum: 2, claim: 'Ana keeps bees', partial: false },
    { sourceId: 'default', slug: 'people/held-example', rowNum: -1, claim: 'Ana walks', partial: true },
  ];
  const page = { sourceId: 'default', slug: 'people/held-example' };
  const incoming = [{ row_num: 2, claim: 'Ana keeps bees', visibility: 'world', fp: 'fp-2' }, { row_num: 3, claim: 'Ana walks', visibility: 'world', fp: null }];
  const coverage = [{ link_behind: false, mention_due: false }];
  const keys = [{ pageId: 7, chunkIndex: 0, snippet: 'needle' }, { pageId: 9, chunkIndex: 2, snippet: 'thread' }];
  return {
    readRankCoverage_private: await run(coverage, e => e.readRankCoverage({ sourceId: 'default', excludePrivate: true, versionTs: '2026-01-01T00:00:00Z', mentionTypes: ['person'] }, 10_000)),
    readRankCoverage_trusted: await run(coverage, e => e.readRankCoverage({ sourceId: 'default', excludePrivate: false, versionTs: '2026-01-01T00:00:00Z' }, 10_000)),
    readExactSnippetChunks_private: await run([], e => e.readExactSnippetChunks(keys, { excludePrivate: true })),
    readExactSnippetChunks_trusted: await run([], e => e.readExactSnippetChunks(keys, { excludePrivate: false })),
    readExactSnippetChunks_empty: await run([], e => e.readExactSnippetChunks([], { excludePrivate: true })),
    listExactRescanChunks_private: await run([], e => e.listExactRescanChunks([9, 7], { excludePrivate: true })),
    listExactRescanChunks_trusted: await run([], e => e.listExactRescanChunks([9, 7], { excludePrivate: false })),
    listExactRescanChunks_empty: await run([], e => e.listExactRescanChunks([], { excludePrivate: true })),
    listHeldFenceCells_world: await run([], e => e.listHeldFenceCells(cells)),
    listHeldFenceCells_member: await run([], e => e.listHeldFenceCells(cells), ['member:alice-example']),
    listHeldFenceCells_empty: await run([], e => e.listHeldFenceCells([])),
    readFenceOverlayRows_open: await run([], e => e.readFenceOverlayRows(page, incoming, { hideHeld: false })),
    readFenceOverlayRows_world: await run([], e => e.readFenceOverlayRows(page, incoming, { hideHeld: true })),
    readFenceOverlayRows_member: await run([], e => e.readFenceOverlayRows(page, incoming, { hideHeld: true }), ['member:alice-example']),
    readFenceOverlayRows_empty: await run([], e => e.readFenceOverlayRows(page, [], { hideHeld: true })),
  };
}

describe('remote read statements', () => {
  test('PGLite and Postgres send byte-identical statements, pinned by a golden', async () => {
    const pglite = await capture(PGLiteEngine.prototype);
    const postgres = await capture(PostgresEngine.prototype);
    // PGLite's executeRaw takes no statement timeout, so its raw-read seam drops the option; text and params match.
    const statements = (calls: Record<string, Recorded[]>) =>
      Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v.map(({ sql, params }) => ({ sql, params }))]));
    expect(JSON.stringify(statements(postgres))).toBe(JSON.stringify(statements(pglite)));
    expect(postgres.readRankCoverage_private![0]!.opts).toEqual({ timeoutMs: 10_000 });
    // An empty key or id list sends no statement at all.
    expect(pglite.readExactSnippetChunks_empty).toEqual([]);
    expect(pglite.listExactRescanChunks_empty).toEqual([]);
    expect(pglite.listHeldFenceCells_empty).toEqual([]);
    // A member caller's own page facts widen the held check; the world-only form names no member.
    expect(pglite.listHeldFenceCells_member![0]!.sql).toContain('member:alice-example');
    expect(pglite.listHeldFenceCells_world![0]!.sql).not.toContain('member:');
    expect(pglite.readFenceOverlayRows_empty).toEqual([]);
    expect(pglite.readFenceOverlayRows_member![0]!.sql).toContain('member:alice-example');
    expect(pglite.readFenceOverlayRows_world![0]!.sql).not.toContain('member:');
    expect(pglite.readFenceOverlayRows_open![0]!.sql).not.toContain('FROM facts hr');
    // The private variant adds the caller's page filter; the trusted one does not.
    expect(pglite.readRankCoverage_private![0]!.sql).not.toBe(pglite.readRankCoverage_trusted![0]!.sql);
    expect(pglite.listExactRescanChunks_private![0]!.sql).not.toBe(pglite.listExactRescanChunks_trusted![0]!.sql);
    expectGolden('remote-reads/statements', statements(pglite), IDENTITY);
  });
});
