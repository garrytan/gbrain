/**
 * Out-of-line method definition receiver resolution — end-to-end (the gate the
 * slice actually exists to move: a QUALIFIED `code-callers` query).
 *
 * An out-of-line method body — `void CFoo::Bar() { Baz(); }` at translation-unit
 * top level — has no ENCLOSING class_specifier for the call site to walk up to.
 * Pre-slice the sibling call `Baz()` keyed on the bare token, so
 * `getCallersOf('CStats.UpdateCache')` (qualified, exact) missed the edge while
 * the bare `getCallersOf('UpdateCache')` still recalled it. This slice resolves
 * the implicit receiver of an out-of-line method to the class named in the
 * definition's `qualified_identifier` scope, so the edge keys on the fully-
 * qualified callee and the qualified query lands.
 *
 * The honest precision boundary is unchanged from the inline slice:
 *   - exactly 1 declaration of the callee in the class → resolve `C.callee`
 *   - an overloaded callee (>1 declaration) → stay bare (no confident false edge)
 *   - a genuine library/global call (0 declarations) → stay bare
 *
 * Fixture mirrors the common out-of-line MQL idiom — prototypes in the class
 * body, bodies defined out-of-line, `Update()` calling the sibling
 * `UpdateCache()` and a library `TimeCurrent()`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

const OUT_OF_LINE_MQH = `#property strict

class CStats
{
private:
   void     UpdateCache();              // prototype; defined out-of-line below
   double   Scale(double x);            // overload prototype #1
   double   Scale(double x, double y);  // overload prototype #2
public:
   void     Update();
   double   Compute(double x);
};

void CStats::Update()
{
   UpdateCache();             // sibling → CStats.UpdateCache (exactly 1 decl)
   datetime t = TimeCurrent();// library → stays bare
}

void CStats::UpdateCache()
{
}

double CStats::Compute(double x)
{
   return Scale(x);           // overloaded sibling → stays bare
}

double CStats::Scale(double x)
{
   return x;
}

double CStats::Scale(double x, double y)
{
   return x + y;
}
`;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(
    engine,
    'Include/Stats.mqh',
    OUT_OF_LINE_MQH,
    { noEmbed: true },
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('out-of-line method receiver resolution — qualified code-callers', () => {
  test('getCallersOf(CStats.UpdateCache) finds the out-of-line caller', async () => {
    const callers = await engine.getCallersOf('CStats.UpdateCache', { allSources: true });
    // The qualified query must land at least one caller (CStats::Update).
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.every(c => c.to_symbol_qualified === 'CStats.UpdateCache')).toBe(true);
  });

  test('bare query "UpdateCache" still recalls the same caller', async () => {
    const callers = await engine.getCallersOf('UpdateCache', { allSources: true });
    expect(callers.length).toBeGreaterThan(0);
  });

  test('an overloaded sibling (Scale) is never falsely qualified', async () => {
    // >1 declaration → the call stays bare → no edge keys on CStats.Scale.
    const qualified = await engine.getCallersOf('CStats.Scale', { allSources: true });
    expect(qualified.length).toBe(0);
    // The bare token still recalls the call (ambiguity surfaced, not hidden).
    const bare = await engine.getCallersOf('Scale', { allSources: true });
    expect(bare.length).toBeGreaterThan(0);
  });

  test('a library call (TimeCurrent) never qualifies to CStats.TimeCurrent', async () => {
    const falseQualified = await engine.getCallersOf('CStats.TimeCurrent', { allSources: true });
    expect(falseQualified.length).toBe(0);
  });
});
