// synthesize_concepts: a T1/T2 group whose concept page already carries an
// LLM narrative for the same atom count is skipped, so the bounded budget
// rotates to groups that never got one instead of re-spending on the same
// top slice every run. A changed atom count re-synthesizes. The budget cap
// reads `cycle.synthesize_concepts.budget_usd` (mirrors extract_atoms).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
}, 120000);

// Five atoms on one concept → T2 → LLM path. (Atoms are not real pages, so
// provenance links warn; status is not asserted — calls + details are.)
function atomsFor(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    slug: `a${i}`, title: `A${i}`, body: `body ${i}`, concept_refs: ['theme'],
  }));
}

function chatStub() {
  const calls: number[] = [];
  const chat = (async () => {
    calls.push(1);
    return {
      text: 'A synthesized narrative about the theme.',
      blocks: [],
      stopReason: 'end',
      model: 'stub',
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  }) as unknown as NonNullable<Parameters<typeof runPhaseSynthesizeConcepts>[1]>['_chat'];
  return { chat, calls };
}

describe('synthesize_concepts skips already-synthesized groups', () => {
  test('second run with the same atoms makes no LLM call; a changed atom count re-synthesizes', async () => {
    const { chat, calls } = chatStub();

    const first = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(5), _chat: chat });
    expect(calls.length).toBe(1);
    expect((first.details as { skipped_fresh: number }).skipped_fresh).toBe(0);

    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(5), _chat: chat });
    expect(calls.length).toBe(1);
    expect((second.details as { skipped_fresh: number }).skipped_fresh).toBe(1);
    expect((second.details as { concepts_written: number }).concepts_written).toBe(0);

    const third = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(6), _chat: chat });
    expect(calls.length).toBe(2);
    expect((third.details as { skipped_fresh: number }).skipped_fresh).toBe(0);
  }, 120000);

  test('budget cap reads cycle.synthesize_concepts.budget_usd', async () => {
    await engine.setConfig('cycle.synthesize_concepts.budget_usd', '12.5');
    const { chat } = chatStub();
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atomsFor(5), _chat: chat, dryRun: true });
    expect((result.details as { budget_usd: number }).budget_usd).toBe(12.5);
  }, 120000);
});
