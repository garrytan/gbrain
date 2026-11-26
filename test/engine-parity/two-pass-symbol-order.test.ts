/**
 * BrainEngine parity: the two-pass walk's symbol lookups (search/two-pass.ts, the typed read listSymbolChunkIds) order
 * their rows by the page's source and slug (byte order), then the chunk's index, then its id, on every engine. Master
 * ran four statements with LIMIT 50 and no ORDER BY, so past the limit the plan chose which rows were kept (and on
 * PGLite the choice could change once the statement's plan was cached). Now the same 50 rows come back, in the same
 * order, on PGLite, Postgres and Rust, and structural search built on them returns the same JSON on all three.
 *
 * The brain makes the orders differ where they can: symbols are inserted out of name order, half the pages are
 * rewritten before any edge is added (a rewrite gives chunks new ids on PGLite and Postgres and keeps them on Rust), and both lookups have
 * matches below and above the limit (7 and 54 near-symbol anchors; 10 and 80 unresolved targets).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: below the limit the rows are master's rows; at any size they are the first 50 of the asked symbols'
 *    chunks by (source, slug, chunk index), the same on every engine; structural search (near-symbol and a walk, with
 *    deterministic embeddings so the vector arm and the expansion run) returns the same JSON on every engine, and
 *    master's rows and score sequence when no lookup passes the limit (the near-symbol search with 7 anchors) (rows with tied scores now come in source,
 *    slug, chunk index order; master's came in plan order).
 *  - Failure it catches: a lookup that keeps the plan's rows or the lowest ids past the limit, an engine whose order
 *    differs, or search output that depends on chunk ids.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput, SearchResult } from '../../src/core/types.ts';
import { expandAnchors } from '../../src/core/search/two-pass.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

function codePage(slug: string): PageInput {
  return { type: 'code', page_kind: 'code', title: slug, compiled_truth: `${slug} source`, timeline: '', frontmatter: { file: `${slug}.ts` } } as PageInput;
}

function sym(i: number, text: string, qualified: string): ChunkInput {
  return chunk(i, text, { language: 'typescript', symbol_name: qualified.split('.').pop(), symbol_type: 'function',
    symbol_name_qualified: qualified, start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 5 } as Partial<ChunkInput>);
}

type Lookup = 'near_symbol' | 'edge_targets';

/** Master's four statements (search/two-pass.ts at a597e7a6c6), byte for byte, with master's parameters: the baseline. */
const MASTER = {
  near_symbol: { scoped: "SELECT cc.id FROM content_chunks cc\n             JOIN pages p ON p.id = cc.page_id\n             WHERE cc.symbol_name_qualified = $1 AND p.source_id = $2\n             LIMIT 50", any: "SELECT id FROM content_chunks WHERE symbol_name_qualified = $1 LIMIT 50" },
  edge_targets: { scoped: "SELECT cc.id FROM content_chunks cc\n                 JOIN pages p ON p.id = cc.page_id\n                 WHERE cc.symbol_name_qualified = ANY($1::text[])\n                   AND p.source_id = $2\n                 LIMIT 50", any: "SELECT id FROM content_chunks WHERE symbol_name_qualified = ANY($1::text[]) LIMIT 50" },
};

async function masterRows(engine: BrainEngine, lookup: Lookup, symbols: readonly string[], sourceId?: string): Promise<number[]> {
  const value = lookup === 'near_symbol' ? symbols[0] : [...symbols];
  const rows = sourceId
    ? await engine.executeRaw<{ id: number }>(MASTER[lookup].scoped, [value, sourceId])
    : await engine.executeRaw<{ id: number }>(MASTER[lookup].any, [value]);
  return rows.map(r => Number(r.id));
}

/** The engine with listSymbolChunkIds answered by master's statements through executeRaw; every other member is its own. */
function masterEngine(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'listSymbolChunkIds') return (lookup: Lookup, symbols: readonly string[], sourceId?: string) => masterRows(target, lookup, symbols, sourceId);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Chunk id -> `slug#index`, so ids (which differ between arms) are compared by label. */
async function labels(engine: BrainEngine, slugs: string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const slug of slugs) for (const c of await engine.getChunks(slug)) out.set(c.id, `${slug}#${c.chunk_index}`);
  return out;
}

/**
 * The brain: 54 chunks define `near.anchor` (above the anchor LIMIT) and 7 define `near.few` (below it), over pages
 * written out of name order; `src/start` calls four unresolved targets with 20 chunks each (80, above the per-hop
 * cap) and `src/small` calls two with 5 each (below it). Every other page is then rewritten, so on Postgres the
 * heap no longer follows id order.
 */
async function seed(engine: BrainEngine): Promise<{ slugs: string[]; id: (label: string) => number; ids: Map<number, string> }> {
  const slugs: string[] = [];
  const page = async (slug: string, chunks: ChunkInput[]) => {
    await engine.putPage(slug, codePage(slug));
    await installChunks(engine, slug, chunks);
    slugs.push(slug);
  };
  // The two callers carry one embedding each, so structural search's vector arm finds them (the keyword-only path
  // skips the expansion). They are not rewritten below: their call edges are added after the seed.
  await page('src/start', [{ ...sym(0, 'function start() { t_d(); t_b(); t_c(); t_a(); }', 'mod.start'), embedding: basisEmbedding(1) } as ChunkInput]);
  await page('src/small', [{ ...sym(0, 'function small() { s_y(); s_x(); }', 'mod.small'), embedding: basisEmbedding(2) } as ChunkInput]);
  // Targets inserted interleaved and in reverse name order: t.d before t.a, chunks of each symbol spread over pages.
  const targets = ['t.d', 't.b', 't.c', 't.a'];
  for (let p = 0; p < 10; p++) {
    await page(`src/targets-${String(9 - p).padStart(2, '0')}`, targets.flatMap((t, k) => [0, 1].map(j => sym(2 * k + j, `function ${t.replace('.', '_')}_${p}_${j}() {}`, t))));
  }
  for (let p = 0; p < 5; p++) {
    await page(`src/small-targets-${p}`, [sym(0, `function s_y_${p}() {}`, 's.y'), sym(1, `function s_x_${p}() {}`, 's.x')]);
  }
  for (let p = 0; p < 13; p++) {
    const n = p === 12 ? 1 : 5;
    await page(`src/near-${String(12 - p).padStart(2, '0')}`, Array.from({ length: n }, (_, j) =>
      sym(j, `function near_${p}_${j}() { anchor(); }`, j === 0 && p < 7 ? 'near.few' : 'near.anchor')));
  }
  // Rewrite every other page's chunks in place (same chunk index, new text).
  for (const slug of slugs.filter((slug, i) => i % 2 === 0 && slug !== 'src/start' && slug !== 'src/small')) {
    const chunks = (await engine.getChunks(slug)).sort((a, b) => a.chunk_index - b.chunk_index).map(c => sym(c.chunk_index,
      `${c.chunk_text} // rewritten`, String((c as unknown as { symbol_name_qualified: string }).symbol_name_qualified)));
    await installChunks(engine, slug, chunks);
  }
  const ids = await labels(engine, slugs);
  const byLabel = new Map([...ids].map(([k, v]) => [v, k]));
  return { slugs, ids, id: (label: string) => byLabel.get(label)! };
}

describe('two-pass symbol lookups order the same on every engine', () => {
  const setup = async (engine: BrainEngine) => {
    const brain = await seed(engine);
    const edge = (from: string, fromSym: string, to: string) => ({ from_chunk_id: brain.id(from), from_symbol_qualified: fromSym, to_symbol_qualified: to, edge_type: 'calls' });
    await engine.addCodeEdges([
      ...['t.d', 't.b', 't.c', 't.a'].map(t => edge('src/start#0', 'mod.start', t)),
      ...['s.y', 's.x'].map(t => edge('src/small#0', 'mod.small', t)),
    ] as never);
    const anchor = (label: string, score: number) => ({ chunk_id: brain.id(label), score, slug: label.split('#')[0] }) as SearchResult;
    return { ...brain, anchor };
  };
  const label = (ids: Map<number, string>, rows: number[]) => sorted(rows.map(id => ids.get(id) ?? `foreign:${id}`));

  parityTest('below the limit every engine returns master\'s rows, and the walk built on them is master\'s',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'listSymbolChunkIds'] }, async (engine) => {
      const { ids, anchor } = await setup(engine);
      const out: Record<string, unknown> = {};
      for (const sourceId of ['default', undefined]) {
        const tag = sourceId ?? 'any-source';
        const near = await engine.listSymbolChunkIds('near_symbol', ['near.few'], sourceId);
        const targets = await engine.listSymbolChunkIds('edge_targets', ['s.y', 's.x'], sourceId);
        const walks = {
          near: await expandAnchors(engine, [anchor('src/start#0', 0.9)], { nearSymbol: 'near.few', sourceId }),
          targets: await expandAnchors(engine, [anchor('src/small#0', 0.4)], { walkDepth: 1, sourceId }),
        };
        const walkView = (rows: Array<{ chunk_id: number; score: number; hop: number; source: string }>) =>
          sorted(rows.map(r => `${ids.get(r.chunk_id)}:${r.hop}:${r.source}:${r.score}`));
        if (engine.kind !== 'rust') {
          // Statement for statement: the typed read returns the rows master's statement returns.
          expect(sorted(near)).toEqual(sorted(await masterRows(engine, 'near_symbol', ['near.few'], sourceId)));
          expect(sorted(targets)).toEqual(sorted(await masterRows(engine, 'edge_targets', ['s.y', 's.x'], sourceId)));
          const master = masterEngine(engine);
          expect(walkView(walks.near)).toEqual(walkView(await expandAnchors(master, [anchor('src/start#0', 0.9)], { nearSymbol: 'near.few', sourceId })));
          expect(walkView(walks.targets)).toEqual(walkView(await expandAnchors(master, [anchor('src/small#0', 0.4)], { walkDepth: 1, sourceId })));
        }
        out[tag] = { near: label(ids, near), targets: label(ids, targets), walkNear: walkView(walks.near), walkTargets: walkView(walks.targets) };
      }
      expect((out.default as { near: string[] }).near).toHaveLength(7);
      expect((out.default as { targets: string[] }).targets).toHaveLength(10);
      return out;
    });

  parityTest('past the limit every engine keeps the first 50 by source, slug and chunk index',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'listSymbolChunkIds'] }, async (engine) => {
      const { ids, anchor } = await setup(engine);
      const matches = new Map<number, string>();
      for (const slug of new Set([...ids.values()].map(l => l.split('#')[0]!))) {
        for (const c of await engine.getChunks(slug)) matches.set(c.id, String((c as unknown as { symbol_name_qualified: string }).symbol_name_qualified));
      }
      // The expected cut, from labels only (no ids): source is 'default' for every page, so slug then chunk index.
      const byKey = (a: string, b: string) => {
        const [sa, ia] = a.split('#'); const [sb, ib] = b.split('#');
        return sa! < sb! ? -1 : sa! > sb! ? 1 : Number(ia) - Number(ib);
      };
      const out: Record<string, unknown> = {};
      for (const sourceId of ['default', undefined]) {
        const tag = sourceId ?? 'any-source';
        const asks: Array<[Lookup, string[]]> = [['near_symbol', ['near.anchor']], ['edge_targets', ['t.d', 't.b', 't.c', 't.a']]];
        for (const [lookup, symbols] of asks) {
          const rows = (await engine.listSymbolChunkIds(lookup, symbols, sourceId)).map(id => ids.get(id) ?? `foreign:${id}`);
          const pool = [...ids].filter(([id]) => symbols.includes(matches.get(id) ?? '')).map(([, l]) => l).sort(byKey);
          expect(rows).toEqual(pool.slice(0, 50));
          out[`${lookup}:${tag}`] = rows;
        }
        const walk = await expandAnchors(engine, [anchor('src/start#0', 0.9), anchor('src/small#0', 0.4)], { nearSymbol: 'near.anchor', walkDepth: 1, sourceId });
        out[`walk:${tag}`] = walk.map(r => `${ids.get(r.chunk_id)}:${r.hop}:${r.source}:${r.score}`);
      }
      return out;
    });

  parityTest('structural search returns the same JSON on every engine, and master\'s rows and scores when no lookup passes the limit',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'listSymbolChunkIds', 'listWalkChunkRows'] }, async (engine) => {
      const { ids } = await setup(engine);
      const relabel = ids;
      const base = { sourceId: 'default', expansion: false, useCache: false, limit: 100, excludePrivate: false, queryEmbedFn: () => basisEmbedding(1) };
      const asks: Array<[string, string, Record<string, unknown>]> = [
        ['near-below', 'start', { nearSymbol: 'near.few' }],
        ['walk-small', 'small', { walkDepth: 1, queryEmbedFn: () => basisEmbedding(2) }],
        ['near-above', 'start', { nearSymbol: 'near.anchor' }],
        ['walk-above', 'start', { walkDepth: 2 }],
      ];
      // Labelled JSON: chunk and page ids differ between engines (and change on a PGLite or Postgres rewrite).
      const view = (rows: SearchResult[]) => JSON.stringify(rows.map(r => {
        const { chunk_id, page_id, ...rest } = r as SearchResult & { page_id?: number };
        void page_id;
        return { ...rest, chunk: relabel.get(chunk_id) ?? `foreign:${chunk_id}` };
      }));
      const out: Record<string, string> = {};
      for (const [name, query, extra] of asks) {
        const rows = await hybridSearch(engine, query, { ...base, ...extra } as never);
        out[name] = view(rows);
        if (engine.kind !== 'rust' && name === 'near-below') {
          // Only near-below keeps every lookup under the limit (the walks start from every top result, and src/start
          // calls 80 targets). There master's statements return the same rows, so the search returns master's rows; only the
          // order of rows with tied scores can differ (master's came in plan order, these in source, slug, index order).
          const master = JSON.parse(view(await hybridSearch(masterEngine(engine), query, { ...base, ...extra } as never))) as Array<{ chunk: string; score: number }>;
          const mine = JSON.parse(out[name]!) as Array<{ chunk: string; score: number }>;
          const bySort = (rows: Array<Record<string, unknown>>) => rows.map(r => JSON.stringify(r)).sort();
          expect(bySort(mine)).toEqual(bySort(master));
          expect(mine.map(r => r.score)).toEqual(master.map(r => r.score));
        }
      }
      for (const name of Object.keys(out)) expect(JSON.parse(out[name]!).length).toBeGreaterThan(1);
      // The hydration read itself: rows in the order of the ids asked, an unknown id skipped.
      const asked = ['src/targets-03#2', 'src/near-01#0', 'src/small#0'].map(l => [...ids].find(([, v]) => v === l)![0]);
      const hydrated = await engine.listWalkChunkRows([...asked, 999_999]);
      expect(hydrated.map(r => `${r.slug}#${r.chunk_index}`)).toEqual(['src/targets-03#2', 'src/near-01#0', 'src/small#0']);
      out.hydrated = JSON.stringify(hydrated.map(r => ({ ...r, chunk_id: ids.get(r.chunk_id), page_id: r.slug })));
      return out;
    });
});
