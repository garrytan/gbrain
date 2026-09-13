// v0.41 T11 → E4: envelope contract for the one surviving eval scaffold,
// `gbrain eval synthesize-concepts`.
//
// The v0.41 T11 wave shipped three undispatched eval scaffolds. Two of them
// (extract-atoms, markdown-greenfield) returned ok:true for work they never
// ran and were deleted by E4 — an eval surface that reads "pass" without
// evaluating anything corrodes every other receipt. synthesize-concepts is
// the one that stayed: dispatched (#4198) with an honest
// {ok:false, status:'not_implemented'} envelope, pinned here. The
// eval-schema-authoring runner's matching envelope is pinned next to its real
// aggregator in test/eval-schema-authoring.test.ts.

import { describe, test, expect } from 'bun:test';
import { runEvalSynthesizeConcepts } from '../src/commands/eval-synthesize-concepts.ts';

describe('eval synthesize-concepts scaffold envelope (#4198)', () => {
  test('runEvalSynthesizeConcepts returns an HONEST not_implemented envelope', async () => {
    const result = await runEvalSynthesizeConcepts({});
    expect(result.schema_version).toBe(1);
    // #4198: an eval that ran nothing must not read as a pass.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_implemented');
    expect(result.details).toBeDefined();
  });

  test('runEvalSynthesizeConcepts preserves --parity-baseline + --sample', async () => {
    const result = await runEvalSynthesizeConcepts({
      parityBaseline: '~/git/brain/concepts',
      sample: 500,
    });
    expect(result.details.parity_baseline_path).toBe('~/git/brain/concepts');
    expect(result.details.sample_size).toBe(500);
  });

  test('details carry the planned-evaluator pointer', async () => {
    const result = await runEvalSynthesizeConcepts({});
    // #4198: synthesize-concepts renamed its pointer when the envelope
    // flipped to the honest not_implemented shape.
    expect(result.details.planned).toBeDefined();
  });
});
