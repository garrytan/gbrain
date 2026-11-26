/**
 * BrainEngine parity: the two-pass walk's symbol lookups (search/two-pass.ts, the typed read listSymbolChunkIds) leave
 * structural search on PGLite and Postgres exactly as master had it. Master ran four statements with LIMIT 50 and no
 * ORDER BY; the typed read runs the same four statements, so which rows come back past the limit, and their order, is
 * still the plan's. The Rust store answers in id order: past the limit it keeps the 50 lowest ids, an expected
 * difference (test/rust-expected-divergence/two_pass.tsv: master's order past LIMIT is unspecified and unstable on
 * PGLite).
 *
 * The brain makes the orders differ where they can: symbols are inserted out of name order, half the pages are
 * rewritten (a rewrite moves rows on Postgres), and both lookups have matches below and above the limit (7 and 54
 * near-symbol anchors; 10 and 80 unresolved targets).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite and Postgres the typed read returns what master's statement returns, and the walk built on it
 *    is master's walk; below the limit every engine returns the same rows; above it every engine returns 50 rows that
 *    define the asked symbols, and Rust's are the 50 lowest ids.
 *  - Failure it catches: a lookup that changes master's statements, drops or adds rows below the limit, or returns
 *    the wrong count or foreign rows past it.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput, SearchResult } from '../../src/core/types.ts';
import { expandAnchors } from '../../src/core/search/two-pass.ts';
import { parityArms, sorted } from './harness.ts';
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

/** Master's four statements (search/two-pass.ts at a597e7a6c6), byte for byte, with master's parameters. */
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
  await page('src/start', [sym(0, 'function start() { t_d(); t_b(); t_c(); t_a(); }', 'mod.start')]);
  await page('src/small', [sym(0, 'function small() { s_y(); s_x(); }', 'mod.small')]);
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
  for (const slug of slugs.filter((_, i) => i % 2 === 0)) {
    const chunks = (await engine.getChunks(slug)).sort((a, b) => a.chunk_index - b.chunk_index).map(c => sym(c.chunk_index,
      `${c.chunk_text} // rewritten`, String((c as unknown as { symbol_name_qualified: string }).symbol_name_qualified)));
    await installChunks(engine, slug, chunks);
  }
  const ids = await labels(engine, slugs);
  const byLabel = new Map([...ids].map(([k, v]) => [v, k]));
  return { slugs, ids, id: (label: string) => byLabel.get(label)! };
}

describe('two-pass symbol lookups keep master\'s statements', () => {
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

  parityTest('past the limit every engine returns 50 rows of the asked symbols; Rust keeps the 50 lowest ids',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'listSymbolChunkIds'] }, async (engine) => {
      const { ids, anchor } = await setup(engine);
      const all = async (symbols: string[]) => [...ids.keys()].filter(id => symbols.includes(matches.get(id) ?? ''));
      const matches = new Map<number, string>();
      for (const slug of new Set([...ids.values()].map(l => l.split('#')[0]!))) {
        for (const c of await engine.getChunks(slug)) matches.set(c.id, String((c as unknown as { symbol_name_qualified: string }).symbol_name_qualified));
      }
      const out: Record<string, unknown> = {};
      let rustCut: Record<string, boolean> | undefined;
      for (const sourceId of ['default', undefined]) {
        const tag = sourceId ?? 'any-source';
        const asks: Array<[Lookup, string[]]> = [['near_symbol', ['near.anchor']], ['edge_targets', ['t.d', 't.b', 't.c', 't.a']]];
        for (const [lookup, symbols] of asks) {
          const rows = await engine.listSymbolChunkIds(lookup, symbols, sourceId);
          const pool = await all(symbols);
          const view = { count: rows.length, distinct: new Set(rows).size, of: pool.length, foreign: rows.filter(id => !pool.includes(id)).length };
          if (engine.kind !== 'rust') {
            // Master's statement returns the same count, all of the asked symbols (which 50 is the plan's).
            const master = await masterRows(engine, lookup, symbols, sourceId);
            expect({ count: master.length, foreign: master.filter(id => !pool.includes(id)).length }).toEqual({ count: view.count, foreign: 0 });
          } else {
            (rustCut ??= {})[`${lookup}:${tag}`] = JSON.stringify(rows) === JSON.stringify([...pool].sort((a, b) => a - b).slice(0, 50));
          }
          out[`${lookup}:${tag}`] = view;
        }
        const walk = await expandAnchors(engine, [anchor('src/start#0', 0.9), anchor('src/small#0', 0.4)], { nearSymbol: 'near.anchor', walkDepth: 1, sourceId });
        out[`walk:${tag}`] = { rows: walk.length, anchors: walk.filter(r => r.source === 'anchor').length, neighbors: walk.filter(r => r.source === 'neighbor').length };
      }
      expect(out['near_symbol:default']).toEqual({ count: 50, distinct: 50, of: 54, foreign: 0 });
      expect(out['edge_targets:default']).toEqual({ count: 50, distinct: 50, of: 80, foreign: 0 });
      // The Rust store's cut is deterministic: the 50 lowest ids (rust-expected-divergence/two_pass.tsv sets it aside).
      if (rustCut) {
        expect(Object.values(rustCut).every(Boolean)).toBe(true);
        out.rust_limit_cut = rustCut;
      }
      return out;
    });
});
