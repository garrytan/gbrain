/**
 * Member-field call resolution — cross-file end-to-end.
 *
 * `m_x.Method()` / `obj.Method()` is the DOMINANT call shape in real MQL
 * (member objects + accessor methods). It resolves to the receiver's declared
 * class type, so the call graph spans files: a holder calling
 * `m_worker.DoWork()` keys on `CWorker.DoWork`, and `getCallersOf('CWorker.DoWork')`
 * finds it even though CWorker is defined in a different include.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';

// Import under a NON-default source — the multi-source shape of a real brain.
const SRC = 'mql-indicators';

const WORKER_MQH = `class CWorker
{
public:
   double DoWork(double x)
   {
      return x * 2.0;
   }
};
`;

const HOLDER_MQH = `#include "Worker.mqh"

class CHolder
{
private:
   CWorker m_worker;
public:
   double Run(double x)
   {
      return m_worker.DoWork(x);
   }
};
`;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', SRC, '--no-federated']);
  await importCodeFile(engine, 'Include/Worker.mqh', WORKER_MQH, { noEmbed: true, sourceId: SRC });
  await importCodeFile(engine, 'Include/Holder.mqh', HOLDER_MQH, { noEmbed: true, sourceId: SRC });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('MQL — member-field call resolution (cross-file)', () => {
  test('the call keys on the field type (CWorker.DoWork), not the holder', async () => {
    const callees = await engine.getCalleesOf('CHolder.Run', { allSources: true });
    expect(callees.some(c => c.to_symbol_qualified === 'CWorker.DoWork')).toBe(true);
    expect(callees.some(c => c.to_symbol_qualified === 'CHolder.DoWork')).toBe(false);
  });

  test('getCallersOf(CWorker.DoWork) finds the cross-file caller in CHolder', async () => {
    const callers = await engine.getCallersOf('CWorker.DoWork', { allSources: true });
    expect(callers.some(c => c.from_symbol_qualified.includes('CHolder'))).toBe(true);
    expect(callers.every(c => c.to_symbol_qualified === 'CWorker.DoWork')).toBe(true);
  });

  test('bare query "DoWork" still recalls the edge', async () => {
    const callers = await engine.getCallersOf('DoWork', { allSources: true });
    expect(callers.length).toBeGreaterThan(0);
  });

  // The jewel must reach a REAL brain, which is multi-source: querying SCOPED
  // (no allSources) is the user-visible path. Edges carry source_id, so the
  // scoped query lands and stays source-isolated.
  test('SCOPED (non-default source) caller/callee queries land and stay isolated', async () => {
    const scoped = await engine.getCallersOf('CWorker.DoWork', { sourceId: SRC });
    expect(scoped.some(c => c.from_symbol_qualified === 'CHolder.Run')).toBe(true);
    const callees = await engine.getCalleesOf('CHolder.Run', { sourceId: SRC });
    expect(callees.some(c => c.to_symbol_qualified === 'CWorker.DoWork')).toBe(true);
    // A different source scope must NOT see the edge.
    const other = await engine.getCallersOf('CWorker.DoWork', { sourceId: 'default' });
    expect(other.length).toBe(0);
  });
});
