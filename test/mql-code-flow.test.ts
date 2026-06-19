/**
 * MQL recursive code walk (code_blast / code_flow) end-to-end.
 *
 * The receiver-resolution slice made MQL call edges precise and dotted-
 * qualified. This enables the recursive BFS walk to traverse a real intra-class
 * call chain. Before this slice the walk's language gate rejected MQL with
 * `unsupported_language`; now it walks `CChain.Top → CChain.Mid → CChain.Leaf`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runRecursiveWalk } from '../src/core/code-intel/recursive-walk.ts';

// A 3-deep intra-class chain plus a terminal MQL built-in call.
const CHAIN_MQH = `class CChain
{
public:
   double Leaf(double x)
   {
      return MathAbs(x);
   }

   double Mid(double x)
   {
      return Leaf(x);
   }

   double Top(double x)
   {
      return Mid(x);
   }
};
`;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(engine, 'Include/Chain.mqh', CHAIN_MQH, { noEmbed: true });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('MQL — recursive code walk', () => {
  test('code_flow (callees) walks the resolved intra-class chain', async () => {
    const r = await runRecursiveWalk(engine, 'CChain.Top', {
      direction: 'callees',
      sourceId: 'default',
      depth: 5,
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      const d1 = r.depth_groups.find(g => g.depth === 1);
      const d2 = r.depth_groups.find(g => g.depth === 2);
      expect(d1?.nodes.some(n => n.symbol === 'CChain.Mid')).toBe(true);
      expect(d2?.nodes.some(n => n.symbol === 'CChain.Leaf')).toBe(true);
    }
  });

  test('code_blast (callers) walks back up the chain', async () => {
    const r = await runRecursiveWalk(engine, 'CChain.Leaf', {
      direction: 'callers',
      sourceId: 'default',
      depth: 5,
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      const d1 = r.depth_groups.find(g => g.depth === 1);
      expect(d1?.nodes.some(n => n.symbol === 'CChain.Mid')).toBe(true);
    }
  });

  // C++ shares the same resolution + edge path as MQL, so the walk is enabled
  // for it too — assert it isn't gated out.
  test('cpp is also walkable (shares the receiver-resolution path)', async () => {
    const CPP = `class CGraph {
public:
  int leaf() { return 1; }
  int top() { return leaf(); }
};
`;
    await importCodeFile(engine, 'src/graph.hpp', CPP, { noEmbed: true });
    const r = await runRecursiveWalk(engine, 'CGraph.top', {
      direction: 'callees',
      sourceId: 'default',
      depth: 5,
    });
    expect(r.result).toBe('ok');
    if (r.result === 'ok') {
      const d1 = r.depth_groups.find(g => g.depth === 1);
      expect(d1?.nodes.some(n => n.symbol === 'CGraph.leaf')).toBe(true);
    }
  });
});
