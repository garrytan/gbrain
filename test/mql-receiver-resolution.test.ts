/**
 * MQL receiver-type resolution — precision slice (the "no false edges" gate).
 *
 * Two classes each define a same-named method (`Calculate`), each called by a
 * sibling via the MQL implicit-`this` idiom (bare `Calculate(x)`, no receiver
 * token). Before receiver-type resolution the call edges keyed on the bare
 * token `Calculate`, so `code-callers` conflated the two classes. This slice
 * resolves the implicit receiver to the ENCLOSING class so each edge keys on
 * the fully-qualified callee (`CAlpha.Calculate` vs `CBeta.Calculate`).
 *
 * The honest ceiling we assert here:
 *   - PRECISION: a qualified query (`CAlpha.Calculate`) returns ONLY that
 *     class's callers — never the other class's same-named method.
 *   - RECALL: a bare query (`Calculate`) still returns BOTH callers (the
 *     ambiguity is surfaced as two distinct qualified callees, not hidden).
 *   - NO FALSE QUALIFICATION: a genuine library/global call (`MathAbs`) is NOT
 *     a sibling method, so it stays bare — never `CAlpha.MathAbs`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

// Two real-shaped MQL classes with a colliding method name, in the common MQL
// idiom: inline class methods calling siblings without `this.`.
const TWO_CLASSES_MQH = `#property strict

class CAlpha
{
public:
   double Calculate(double x)
   {
      return MathAbs(x);
   }

   double Run(double x)
   {
      return Calculate(x);
   }
};

class CBeta
{
public:
   double Calculate(double x)
   {
      return x + 1.0;
   }

   double Start(double x)
   {
      return Calculate(x);
   }
};
`;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(
    engine,
    'Include/TwoClasses.mqh',
    TWO_CLASSES_MQH,
    { noEmbed: true },
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('MQL receiver-type resolution — no conflation', () => {
  test('callers of CAlpha.Calculate include CAlpha.Run and EXCLUDE CBeta', async () => {
    const callers = await engine.getCallersOf('CAlpha.Calculate', { allSources: true });
    const froms = callers.map(c => c.from_symbol_qualified);
    expect(froms.some(f => f.includes('Run'))).toBe(true);
    expect(froms.some(f => f.includes('CBeta'))).toBe(false);
  });

  test('callers of CBeta.Calculate include CBeta.Start and EXCLUDE CAlpha', async () => {
    const callers = await engine.getCallersOf('CBeta.Calculate', { allSources: true });
    const froms = callers.map(c => c.from_symbol_qualified);
    expect(froms.some(f => f.includes('Start'))).toBe(true);
    expect(froms.some(f => f.includes('CAlpha'))).toBe(false);
  });

  test('bare query "Calculate" still recalls BOTH callers (ambiguity surfaced, not hidden)', async () => {
    const callers = await engine.getCallersOf('Calculate', { allSources: true });
    const froms = callers.map(c => c.from_symbol_qualified);
    expect(froms.some(f => f.includes('CAlpha') && f.includes('Run'))).toBe(true);
    expect(froms.some(f => f.includes('CBeta') && f.includes('Start'))).toBe(true);
  });

  test('a genuine library call (MathAbs) stays bare — never qualified to CAlpha.MathAbs', async () => {
    const bare = await engine.getCallersOf('MathAbs', { allSources: true });
    expect(bare.some(c => c.from_symbol_qualified.includes('CAlpha'))).toBe(true);
    // The edge target must be the bare token, not a false-qualified sibling.
    expect(bare.every(c => c.to_symbol_qualified === 'MathAbs')).toBe(true);
    const falseQualified = await engine.getCalleesOf('CAlpha.Calculate', { allSources: true });
    expect(falseQualified.some(c => c.to_symbol_qualified === 'CAlpha.MathAbs')).toBe(false);
  });
});
