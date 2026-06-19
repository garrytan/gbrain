/**
 * Engine-general: short-name recall against qualified call edges.
 *
 * The `code_callers` / `code_callees` ops document their `symbol` param as
 * "bare or qualified name" — both forms must resolve. Receiver-type resolution
 * emits QUALIFIED callees (e.g. a `this.compute()` call inside class Widget
 * emits `Widget::compute`). Without last-segment matching, a bare-name lookup
 * (`getCallersOf('compute')`) exact-matches nothing and silently returns zero —
 * breaking the documented contract and the North Star's 100% recall bar.
 *
 * This asserts: a qualified edge is reachable by BOTH its bare last segment
 * (recall) AND its exact qualified name (precision). Uses the existing JS/TS
 * `this.`-resolution path so it's independent of the cpp/mql slice.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

const WIDGET_TS = `class Widget {
  render() {
    return this.compute();
  }

  compute() {
    return 42;
  }
}
`;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(engine, 'src/widget.ts', WIDGET_TS, { noEmbed: true });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('code-callers — short-name recall of qualified edges', () => {
  test('the this.compute() call resolves to a qualified edge (Widget::compute)', async () => {
    // Precondition: confirms the W1 receiver resolver actually qualified the
    // edge, so the recall assertion below is testing the right thing.
    const callees = await engine.getCalleesOf('Widget.render', { allSources: true });
    expect(callees.some(c => c.to_symbol_qualified === 'Widget::compute')).toBe(true);
  });

  test('bare name "compute" recalls the qualified edge', async () => {
    const callers = await engine.getCallersOf('compute', { allSources: true });
    expect(callers.some(c => c.from_symbol_qualified.includes('render'))).toBe(true);
  });

  test('exact qualified name "Widget::compute" still resolves precisely', async () => {
    const callers = await engine.getCallersOf('Widget::compute', { allSources: true });
    expect(callers.some(c => c.from_symbol_qualified.includes('render'))).toBe(true);
  });

  // The last-segment recall only affects edges with a QUALIFIED to_symbol. In
  // this pipeline that is exclusively receiver-resolved CALL edges: `imports`
  // edges are qualified but never persist (top-level import statements fall
  // outside every semantic chunk, so findChunkForOffset drops them), and
  // `references` edges carry a BARE type name. So the recall widening is inert
  // for non-call edges — no edge_type scoping needed.
});
