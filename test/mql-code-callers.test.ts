/**
 * MQL code-intelligence — end-to-end code-callers / code-callees.
 *
 * Imports a small MQL class into PGLite and asserts the intra-class call edge
 * (CalculatePips -> PriceToPips) is queryable via getCallersOf / getCalleesOf.
 * This is the slice-1 tracer bullet: a call edge usable end-to-end for MQL
 * through importCodeFile, not just harvested by the chunker.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

// A representative MQL utility class with inline methods.
const PIP_CALCULATOR_MQH = `#property strict

class CPipCalculator
{
private:
   double m_pointSize;

public:
   double PriceToPips(double priceDifference)
   {
      if(m_pointSize == 0) return 0;
      return MathAbs(priceDifference) / m_pointSize;
   }

   double CalculatePips(double price1, double price2)
   {
      return PriceToPips(price1 - price2);
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
    'Include/Utils/PipCalculator.mqh',
    PIP_CALCULATOR_MQH,
    { noEmbed: true },
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 30_000);

describe('MQL — code-callers / code-callees end-to-end', () => {
  // Receiver-type resolution qualifies the implicit-this call
  // `PriceToPips(...)` inside CalculatePips to its enclosing class, so the edge
  // keys on `CPipCalculator.PriceToPips`. A BARE query still recalls it
  // (getCallersOf/getCalleesOf last-segment match), so short-name lookups keep
  // working while the qualified form is precise.
  test('CalculatePips is a caller of PriceToPips (bare query still recalls)', async () => {
    const callers = await engine.getCallersOf('PriceToPips', { allSources: true });
    const hit = callers.find(r => r.from_symbol_qualified.includes('CalculatePips'));
    expect(hit).toBeDefined();
    expect(hit!.edge_type).toBe('calls');
  });

  test('PriceToPips is a callee of CalculatePips, keyed on the qualified callee', async () => {
    const callees = await engine.getCalleesOf('CPipCalculator.CalculatePips', { allSources: true });
    expect(callees.some(r => r.to_symbol_qualified === 'CPipCalculator.PriceToPips')).toBe(true);
  });
});
