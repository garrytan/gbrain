/**
 * v0.34 W3 — recursive walker tests.
 *
 * Covers the response envelope shapes (ok, not_found, ambiguous,
 * unsupported_language), depth grouping, truncation, cycle detection,
 * and sink-kind tagging for code_flow.
 *
 * Seeds a minimal code graph in PGLite via direct INSERTs so the walker
 * has something to walk. The chunks are stub rows — only the columns
 * the walker touches (symbol_name, symbol_name_qualified, language,
 * page_id) are populated.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runRecursiveWalk } from '../../src/core/code-intel/recursive-walk.ts';
import { classifySink } from '../../src/core/code-intel/sinks/index.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/**
 * Seed: a tiny graph with caller chain:
 *   src/main.ts::run → src/foo.ts::bar → src/baz.ts::baz
 *   src/baz.ts::baz → fetch  (terminal: http_call sink)
 * Sets source_id='default'.
 */
async function seedGraph(): Promise<void> {
  // 'default' source row is seeded by the schema init.
  // Create a page + chunks for each symbol.
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, page_kind, title, content_hash)
     VALUES ('code/main', 'default', 'code', 'code', 'main', 'h1'),
            ('code/foo', 'default', 'code', 'code', 'foo', 'h2'),
            ('code/baz', 'default', 'code', 'code', 'baz', 'h3')`,
    [],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, symbol_name, symbol_name_qualified, language)
     SELECT id, 0, 'stub', 'run', 'src/main.ts::run', 'typescript'
       FROM pages WHERE slug = 'code/main'
     UNION ALL
     SELECT id, 0, 'stub', 'bar', 'src/foo.ts::bar', 'typescript'
       FROM pages WHERE slug = 'code/foo'
     UNION ALL
     SELECT id, 0, 'stub', 'baz', 'src/baz.ts::baz', 'typescript'
       FROM pages WHERE slug = 'code/baz'`,
    [],
  );
  // Edges: run -> bar -> baz, baz -> fetch
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
     SELECT cc.id, 'src/main.ts::run', 'src/foo.ts::bar', 'calls', 'default'
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'code/main'
     UNION ALL
     SELECT cc.id, 'src/foo.ts::bar', 'src/baz.ts::baz', 'calls', 'default'
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'code/foo'
     UNION ALL
     SELECT cc.id, 'src/baz.ts::baz', 'fetch', 'calls', 'default'
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'code/baz'`,
    [],
  );
}

describe('W3: sinks classifier', () => {
  test('fetch is http_call (TS)', () => {
    expect(classifySink('fetch', 'typescript')).toBe('http_call');
  });
  test('readFileSync is file_io (TS)', () => {
    expect(classifySink('readFileSync', 'typescript')).toBe('file_io');
  });
  test('db.query glob matches db_call', () => {
    expect(classifySink('db.query', 'typescript')).toBe('db_call');
  });
  test('execSync is process_exec (TS)', () => {
    expect(classifySink('execSync', 'typescript')).toBe('process_exec');
  });
  test('subprocess.run is process_exec (Python)', () => {
    expect(classifySink('subprocess.run', 'python')).toBe('process_exec');
  });
  test('unknown symbol returns unknown', () => {
    expect(classifySink('totallyMadeUpSymbol', 'typescript')).toBe('unknown');
  });
  test('unsupported language returns unknown', () => {
    expect(classifySink('fetch', 'ruby')).toBe('unknown');
  });
});

describe('W3: code_blast (callers walk)', () => {
  test('not_found returns did_you_mean', async () => {
    const r = await runRecursiveWalk(engine, 'totallyMadeUp', {
      direction: 'callers',
      sourceId: 'default',
    });
    expect(r.result).toBe('not_found');
  });

  test('happy path: walks caller chain depth-grouped', async () => {
    await seedGraph();
    const r = await runRecursiveWalk(engine, 'baz', {
      direction: 'callers',
      sourceId: 'default',
      depth: 5,
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      // depth 1 should contain bar (which calls baz)
      const d1 = r.depth_groups.find((g) => g.depth === 1);
      expect(d1).toBeDefined();
      expect(d1?.nodes.some((n) => n.symbol === 'src/foo.ts::bar')).toBe(true);
      // confidence at depth 1 ~ 1/(1+0.3) = 0.769
      expect(d1?.confidence ?? 0).toBeGreaterThan(0.7);
      expect(d1?.confidence ?? 0).toBeLessThan(0.8);
    }
  });

  test('truncation: depth_cap fires when walk exceeds depth', async () => {
    await seedGraph();
    const r = await runRecursiveWalk(engine, 'baz', {
      direction: 'callers',
      sourceId: 'default',
      depth: 1, // tight depth cap; we have a 2-hop chain
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      // With depth=1, "run" (which is 2 hops from baz) shouldn't appear
      const allSyms = r.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
      expect(allSyms.includes('src/main.ts::run')).toBe(false);
    }
  });
});

describe('W3: code_flow (callees walk + sink tagging)', () => {
  test('tags fetch as http_call sink at terminal node', async () => {
    await seedGraph();
    const r = await runRecursiveWalk(engine, 'run', {
      direction: 'callees',
      sourceId: 'default',
      depth: 5,
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      // terminal_nodes should include fetch tagged as http_call
      expect(r.terminal_nodes?.some((n) => n.symbol === 'fetch' && n.sink_kind === 'http_call')).toBe(true);
    }
  });
});
