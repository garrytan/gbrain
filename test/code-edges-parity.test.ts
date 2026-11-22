/**
 * Code edges parity: addCodeEdges, deleteCodeEdgesForChunks, getCallersOf,
 * getCalleesOf and getEdgesByChunk store, return and refuse the same things on
 * PGLite and Postgres (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * Rust engine contract. Differences pinned here, with the engine the Rust
 * engine must match:
 * - An undefined argument. PGLite binds undefined as SQL NULL: an insert fails
 *   the not-null check (23502), a read matches nothing and a delete removes
 *   nothing. Postgres refuses it before SQL (UNDEFINED_VALUE). Rust matches
 *   Postgres.
 * - Serial ids. A PGLite insert refused by the not-null check still uses a
 *   sequence value; a Postgres refusal before SQL does not. Ids are compared
 *   only as order, never as numbers.
 * Everything else below is one answer on both engines, and Rust must give it:
 * - addCodeEdges returns the rows it inserted. An edge with a to_chunk_id goes
 *   to code_edges_chunk, one without goes to code_edges_symbol. A duplicate key
 *   (also inside one call) is skipped; a null source_id is stored as 'default';
 *   the source_id is stored as given, not taken from the chunk's page. An
 *   unknown chunk or source is 23503, a NaN or fractional chunk id is 22P02, a
 *   NUL byte is 22021 in text and 22P05 in metadata.
 * - getCallersOf and getCalleesOf read both tables and list resolved edges
 *   first, then unresolved ones, each in id order, before the limit (default
 *   100, at most 500; a negative limit is 2201W, a fractional or NaN one 22P02).
 *   They skip an edge whose endpoint page is soft-deleted. sourceId scopes the
 *   read unless allSources is set. A symbol edge stamped with
 *   edge_metadata.resolved_chunk_id counts as resolved and is found by chunkId.
 *   bareFallback re-reads a missed name without '.', '#' or ':' by the chunk's
 *   bare symbol_name.
 * - getEdgesByChunk reads code_edges_chunk in the asked direction and, unless
 *   the direction is 'in', code_edges_symbol rows leaving the chunk. Each table
 *   is in id order and has its own limit (default 50, at most 200). Any other
 *   direction reads both ways. It does not skip soft-deleted endpoints.
 * - deleteCodeEdgesForChunks removes resolved edges at either end and symbol
 *   edges leaving the chunks; unknown ids are a no-op.
 *
 * 1. Protects: the five methods above: table routing, dedup, stored columns,
 *    read order and limits, direction, edge type and source scope, the
 *    soft-delete gate, resolved symbol edges, the bare-name fallback, deletes
 *    and the refusal for each invalid input.
 * 2. Fails when: an engine routes, stores or skips an edge differently,
 *    changes a read's order, limit, scope or gate, or starts to accept or
 *    refuse an input with another code.
 * 3. Existing coverage: test/engine-parity (typed-methods branch) has happy
 *    path cases for each method; test/code-edges.test.ts and
 *    test/code-read-currency.test.ts cover features on PGLite. No file
 *    compares edge inputs, refusals or row order across the two engines.
 * 4. Real seams: the engines' public methods. Soft deletes and row moves
 *    inside a table are set with SQL so each case is pinned.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

/** One case result per engine, compared at the end of the file. */
const seen = new Map<TestBackend, Record<string, unknown>>();
/** Results that differ by design, checked against the pinned values per engine. */
const pinned = new Map<TestBackend, Record<string, unknown>>();
const backends = testBackends();

function record(kind: TestBackend, name: string, value: unknown, into = seen): void {
  const run = into.get(kind) ?? {};
  run[name] = value;
  into.set(kind, run);
}

/** 'done' for a call that returns nothing, the value otherwise, or the refusal code (the message when there is no code). */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    return value === undefined ? 'done' : { ok: value };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { refused: err.code ?? (e instanceof TypeError ? 'TypeError' : String(err.message)) };
  }
}

const PAGES = [['code-a', 'run'], ['code-b', 'helper'], ['code-c', 'util'], ['code-d', 'helper', 'src-b'], ['code-e', 'gone']] as const;

for (const kind of backends) {
  describe(`code edges (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const raw = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql);
    const chunk: Record<string, number> = {};
    const name = (id: unknown) => (id == null ? '-' : Object.entries(chunk).find(([, v]) => v === id)?.[0] ?? `chunk ${String(id)}`);
    const add = (edges: unknown) => outcome(() => engine.addCodeEdges(edges as never));
    /** An edge as one line: R(esolved)/U, endpoints, symbols, type, source, metadata. */
    const lines = (r: unknown) => {
      const x = r as { ok?: Array<Record<string, unknown>> };
      return x.ok ? x.ok.map((e) => `${e.resolved ? 'R' : 'U'} ${name(e.from_chunk_id)}->${name(e.to_chunk_id)} ${e.from_symbol_qualified}>${e.to_symbol_qualified} ${e.edge_type} ${e.source_id} ${JSON.stringify(e.edge_metadata)}`) : r;
    };
    const callers = (n: string, opts?: unknown) => outcome(() => engine.getCallersOf(n, opts as never)).then(lines);
    const callees = (n: string, opts?: unknown) => outcome(() => engine.getCalleesOf(n, opts as never)).then(lines);
    const byChunk = (id: number, opts?: unknown) => outcome(() => engine.getEdgesByChunk(id, opts as never)).then(lines);
    const counts = async () => (await raw(`SELECT (SELECT count(*)::int FROM code_edges_chunk) AS c, (SELECT count(*)::int FROM code_edges_symbol) AS s`)).map((r) => `chunk ${r.c}, symbol ${r.s}`)[0];

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await raw(`INSERT INTO sources (id, name) VALUES ('src-b', 'src-b') ON CONFLICT DO NOTHING`);
      for (const [slug, symbol, sourceId] of PAGES) {
        const scope = sourceId ? { sourceId } : undefined;
        await engine.putPage(slug, { type: 'code', page_kind: 'code', title: slug, compiled_truth: `function ${symbol}() {}`, timeline: '' } as never, scope as never);
        await installFixtureChunks(engine, slug, [{
          chunk_index: 0, chunk_text: `function ${symbol}() {}`, chunk_source: 'compiled_truth', language: 'typescript',
          symbol_name: symbol, symbol_type: 'function', symbol_name_qualified: `M.${symbol}`,
        } as never], scope);
        chunk[slug] = (await engine.getChunks(slug, scope as never))[0]!.id;
      }
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('addCodeEdges: table routing, dedup, stored columns and refusals', async () => {
      const { 'code-a': A, 'code-b': B, 'code-c': C, 'code-d': D, 'code-e': E } = chunk;
      const edge = (from: number, to: number | null | undefined, fromSym: string, toSym: string, type: unknown, extra: Record<string, unknown> = {}) =>
        ({ from_chunk_id: from, ...(to === undefined ? {} : { to_chunk_id: to }), from_symbol_qualified: fromSym, to_symbol_qualified: toSym, edge_type: type, ...extra });
      const inserted = {
        none: await add([]),
        resolved: await add([edge(A, B, 'M.run', 'M.helper', 'calls', { edge_metadata: { line: 3 } })]),
        duplicateKey: await add([edge(A, B, 'other', 'names', 'calls')]),
        duplicateInOneCall: await add([edge(C, B, 'M.util', 'M.helper', 'calls'), edge(C, B, 'M.util', 'M.helper', 'calls')]),
        unresolvedTwo: await add([edge(A, undefined, 'M.run', 'M.helper', 'imports'), edge(A, null, 'M.run', 'Ext.thing', 'calls', { source_id: null })]),
        fromDeletedPage: await add([edge(E, B, 'M.gone', 'M.helper', 'calls')]),
        otherSource: await add([edge(D, B, 'M.helper', 'M.helper', 'calls', { source_id: 'src-b' })]),
        sourceNotFromChunk: await add([edge(C, null, 'M.util', 'Ext.other', 'type_refs', { source_id: 'src-b' })]),
        stampedSymbol: await add([edge(C, null, 'M.util', 'helper', 'calls', { edge_metadata: { resolved_chunk_id: B } })]),
        arrayMetadata: await add([edge(A, null, 'a', 'c', 'arr', { edge_metadata: [1] })]),
        selfEdge: await add([edge(A, A, 'M.run', 'M.run', 'calls')]),
      };
      expect(inserted).toEqual({
        none: { ok: 0 }, resolved: { ok: 1 }, duplicateKey: { ok: 0 }, duplicateInOneCall: { ok: 1 }, unresolvedTwo: { ok: 2 },
        fromDeletedPage: { ok: 1 }, otherSource: { ok: 1 }, sourceNotFromChunk: { ok: 1 }, stampedSymbol: { ok: 1 }, arrayMetadata: { ok: 1 }, selfEdge: { ok: 1 },
      });
      const refusals = {
        unknownSource: await add([edge(A, C, 'a', 'c', 'calls', { source_id: 'nope' })]),
        unknownChunk: await add([edge(999_999, C, 'a', 'c', 'calls')]),
        nanChunk: await add([edge(Number.NaN, null, 'a', 'c', 'calls')]),
        fractionalChunk: await add([edge(1.5, null, 'a', 'c', 'calls')]),
        nullType: await add([edge(A, null, 'a', 'c', null)]),
        nulInText: await add([edge(A, null, 'a\u0000', 'c', 'calls')]),
        nulInMetadata: await add([edge(A, null, 'a', 'c', 'nm', { edge_metadata: { s: 'a\u0000' } })]),
        notAList: await add(undefined),
      };
      expect(refusals).toEqual({
        unknownSource: { refused: '23503' }, unknownChunk: { refused: '23503' }, nanChunk: { refused: '22P02' }, fractionalChunk: { refused: '22P02' },
        nullType: { refused: '23502' }, nulInText: { refused: '22021' }, nulInMetadata: { refused: '22P05' }, notAList: { refused: 'TypeError' },
      });
      record(kind, 'undefinedEdgeFields', {
        type: await add([edge(A, null, 'a', 'c', undefined)]),
        fromSymbol: await add([{ from_chunk_id: A, to_chunk_id: C, to_symbol_qualified: 'c', edge_type: 'calls' }]),
      }, pinned);
      const rows = (await raw(`SELECT 'chunk' AS t, id, from_chunk_id, to_chunk_id, edge_type, edge_metadata, source_id FROM code_edges_chunk
          UNION ALL SELECT 'symbol', id, from_chunk_id, NULL, edge_type, edge_metadata, source_id FROM code_edges_symbol ORDER BY 1, 2`))
        .map((r) => `${r.t} ${name(r.from_chunk_id)}->${name(r.to_chunk_id)} ${r.edge_type} ${r.source_id} ${JSON.stringify(r.edge_metadata)}`);
      expect(rows).toEqual([
        'chunk code-a->code-b calls default {"line":3}', 'chunk code-c->code-b calls default {}', 'chunk code-e->code-b calls default {}',
        'chunk code-d->code-b calls src-b {}', 'chunk code-a->code-a calls default {}',
        'symbol code-a->- imports default {}', 'symbol code-a->- calls default {}', 'symbol code-c->- type_refs src-b {}',
        `symbol code-c->- calls default {"resolved_chunk_id":${B}}`, 'symbol code-a->- arr default [1]',
      ]);
      record(kind, 'add', { inserted, refusals, rows: rows.map((r) => r.replace(`:${B}}`, ':B}')) });
    });

    test('getCallersOf and getCalleesOf: order, limits, scope, soft delete and bare names', async () => {
      const { 'code-a': A, 'code-b': B } = chunk;
      await raw(`UPDATE pages SET deleted_at = now() WHERE slug = 'code-e'`);
      // Rewrite the oldest edge of each table so it moves to the end of the table; the read order must not follow storage.
      await raw(`UPDATE code_edges_chunk SET edge_metadata = edge_metadata || '{}' WHERE from_chunk_id = ${A} AND to_chunk_id = ${B}`);
      await raw(`UPDATE code_edges_symbol SET edge_metadata = edge_metadata || '{}' WHERE edge_type = 'imports'`);
      const stamped = `{"resolved_chunk_id":${B}}`;
      const reads = {
        callers: await callers('M.helper'),
        callersAllSources: await callers('M.helper', { allSources: true }),
        callersOtherSource: await callers('M.helper', { sourceId: 'src-b' }),
        callersDefault: await callers('M.helper', { sourceId: 'default' }),
        allSourcesWins: await callers('M.helper', { sourceId: 'src-b', allSources: true }),
        callersByChunk: await callers('ignored', { chunkId: B }),
        callersBareName: await callers('helper'),
        callersLimit1: await callers('M.helper', { limit: 1 }),
        callersLimit0: await callers('M.helper', { limit: 0 }),
        callees: await callees('M.run'),
        calleesLimit3: await callees('M.run', { limit: 3 }),
        calleesByChunk: await callees('ignored', { chunkId: A }),
        bareMiss: await callees('run'),
        bareFallback: await callees('run', { bareFallback: true }),
        bareFallbackWithDot: await callees('M.nope', { bareFallback: true }),
        bareFallbackDeletedPage: await callees('gone', { bareFallback: true }),
        fromDeletedPage: await callees('M.gone'),
        unknownName: await callers('M.none'),
      };
      const ab = 'R code-a->code-b M.run>M.helper calls default {"line":3}';
      const cb = 'R code-c->code-b M.util>M.helper calls default {}';
      const db = 'R code-d->code-b M.helper>M.helper calls src-b {}';
      const aa = 'R code-a->code-a M.run>M.run calls default {}';
      const imp = 'U code-a->- M.run>M.helper imports default {}';
      const ext = 'U code-a->- M.run>Ext.thing calls default {}';
      const arr = 'U code-a->- a>c arr default [1]';
      expect(reads).toEqual({
        callers: [ab, cb, db, imp], callersAllSources: [ab, cb, db, imp], callersOtherSource: [db], callersDefault: [ab, cb, imp],
        allSourcesWins: [ab, cb, db, imp], callersByChunk: [ab, cb, db, `R code-c->- M.util>helper calls default ${stamped}`],
        callersBareName: [`R code-c->- M.util>helper calls default ${stamped}`], callersLimit1: [ab], callersLimit0: [],
        callees: [ab, aa, imp, ext], calleesLimit3: [ab, aa, imp], calleesByChunk: [ab, aa, imp, ext, arr],
        bareMiss: [], bareFallback: [ab, aa, imp, ext, arr], bareFallbackWithDot: [], bareFallbackDeletedPage: [], fromDeletedPage: [], unknownName: [],
      } as never);
      const refusals = {
        negativeLimit: await callers('M.helper', { limit: -1 }),
        nanLimit: await callers('M.helper', { limit: Number.NaN }),
        fractionalLimit: await callees('M.run', { limit: 1.5 }),
        nanChunk: await callers('x', { chunkId: Number.NaN }),
      };
      expect(refusals).toEqual({ negativeLimit: { refused: '2201W' }, nanLimit: { refused: '22P02' }, fractionalLimit: { refused: '22P02' }, nanChunk: { refused: '22P02' } });
      record(kind, 'undefinedNames', { callers: await callers(undefined as never), callees: await callees(undefined as never) }, pinned);
      record(kind, 'callersAndCallees', { reads: JSON.parse(JSON.stringify(reads).replaceAll(`:${B}}`, ':B}')), refusals });
    });

    test('getEdgesByChunk and deleteCodeEdgesForChunks: direction, per-table limit, no soft-delete gate', async () => {
      const { 'code-a': A, 'code-b': B, 'code-e': E } = chunk;
      const reads = {
        both: await byChunk(A),
        in: await byChunk(A, { direction: 'in' }),
        out: await byChunk(A, { direction: 'out' }),
        otherDirection: await byChunk(A, { direction: 'sideways' }),
        edgeType: await byChunk(A, { edgeType: 'imports' }),
        limit1PerTable: await byChunk(A, { limit: 1 }),
        target: await byChunk(B),
        targetIn2: await byChunk(B, { direction: 'in', limit: 2 }),
        deletedPage: await byChunk(E),
        unknownChunk: await byChunk(999_999),
      };
      const ab = 'R code-a->code-b M.run>M.helper calls default {"line":3}';
      const aa = 'R code-a->code-a M.run>M.run calls default {}';
      const imp = 'U code-a->- M.run>M.helper imports default {}';
      const ext = 'U code-a->- M.run>Ext.thing calls default {}';
      const arr = 'U code-a->- a>c arr default [1]';
      const cb = 'R code-c->code-b M.util>M.helper calls default {}';
      const eb = 'R code-e->code-b M.gone>M.helper calls default {}';
      const db = 'R code-d->code-b M.helper>M.helper calls src-b {}';
      expect(reads).toEqual({
        both: [ab, aa, imp, ext, arr], in: [aa], out: [ab, aa, imp, ext, arr], otherDirection: [ab, aa, imp, ext, arr], edgeType: [imp],
        limit1PerTable: [ab, imp], target: [ab, cb, eb, db], targetIn2: [ab, cb], deletedPage: [eb], unknownChunk: [],
      } as never);
      const refusals = { negativeLimit: await byChunk(A, { limit: -1 }), nanChunk: await byChunk(Number.NaN) };
      expect(refusals).toEqual({ negativeLimit: { refused: '2201W' }, nanChunk: { refused: '22P02' } });
      record(kind, 'undefinedChunkRead', await byChunk(undefined as never), pinned);
      const deletes = {
        none: await outcome(() => engine.deleteCodeEdgesForChunks([])),
        nan: await outcome(() => engine.deleteCodeEdgesForChunks([Number.NaN])),
        notAList: await outcome(() => engine.deleteCodeEdgesForChunks(undefined as never)),
        before: await counts(),
        target: await outcome(() => engine.deleteCodeEdgesForChunks([B])),
        afterTarget: await counts(),
        sourceAndUnknown: await outcome(() => engine.deleteCodeEdgesForChunks([A, 999_999])),
        afterSource: await counts(),
      };
      // Deleting chunk B removes every resolved edge into it; symbol edges point at names, so they stay.
      expect(deletes).toEqual({
        none: 'done', nan: { refused: '22P02' }, notAList: { refused: 'TypeError' }, before: 'chunk 5, symbol 5',
        target: 'done', afterTarget: 'chunk 1, symbol 5', sourceAndUnknown: 'done', afterSource: 'chunk 0, symbol 2',
      });
      record(kind, 'undefinedChunkDelete', await outcome(() => engine.deleteCodeEdgesForChunks([undefined as never])), pinned);
      record(kind, 'byChunkAndDelete', { reads, refusals, deletes });
    });
  });
}

describe('code edges: engines agree', () => {
  test('every shared case gives one answer, and each pinned difference holds', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    const undefinedValue = { refused: 'UNDEFINED_VALUE' };
    const expected: Record<TestBackend, Record<string, unknown>> = {
      pglite: {
        undefinedEdgeFields: { type: { refused: '23502' }, fromSymbol: { refused: '23502' } },
        undefinedNames: { callers: [], callees: [] }, undefinedChunkRead: [], undefinedChunkDelete: 'done',
      },
      postgres: {
        undefinedEdgeFields: { type: undefinedValue, fromSymbol: undefinedValue },
        undefinedNames: { callers: undefinedValue, callees: undefinedValue }, undefinedChunkRead: undefinedValue, undefinedChunkDelete: undefinedValue,
      },
    };
    for (const b of backends) expect({ engine: b, pins: pinned.get(b) }).toEqual({ engine: b, pins: expected[b] });
  });
});
