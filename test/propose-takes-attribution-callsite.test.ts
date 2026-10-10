// #5425 [UC4] (wave 14 PR3 row P3.9): the one call from `propose-takes.ts`
// into `propose-takes-attribution.ts`, behind `dream.attribution_checks`.
// The call site is a stack hunk on a wave 13 hot file
// (`~/.capy/work/w14/pr3/stack-hunks/propose-takes.ts.p3.9.patch`, behind
// #6446); flip `test.todo` to `test` when it lands. The helper itself is
// pinned by test/propose-takes-attribution.test.ts.
//
// Protects: with the switch on, a person-holder proposal whose numbers only
// assistant turns of the page state is stored with holder `brain`; with the
// switch off (default) the stored holder is exactly what the extractor
// returned. Fails when: the phase never calls the check, or calls it with
// the switch off. Seam: the `extractor` option already exists.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseProposeTakes } from '../src/core/cycle/propose-takes.ts';
import { ATTRIBUTION_CHECKS_KEY } from '../src/core/cycle/attribution-checks.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const context = (): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default',
});
const PAGE = ['[user]', 'How should we price the pro tier?', '[assistant]', 'Price the pro tier at $49 per seat.', '[user]', 'Let me think about it.'].join('\n');
const proposal = { claim_text: 'Pro tier should be priced at $49 per seat.', kind: 'take' as const, holder: 'people/alice-example', weight: 0.6 };

async function storedHolders(): Promise<string[]> {
  await engine.putPage('wiki/conversations/pricing', { title: 'pricing', type: 'conversation' as never, compiled_truth: PAGE, frontmatter: {}, timeline: '' });
  await runPhaseProposeTakes(context(), { extractor: async () => [proposal] });
  return (await engine.executeRaw<{ holder: string }>(`SELECT holder FROM take_proposals WHERE page_slug = 'wiki/conversations/pricing'`)).map(r => r.holder);
}

describe('propose_takes calls the mechanical holder check (#5425 [UC4], P3.9)', () => {
  test('switch off (default): the extractor\'s holder is stored as is', async () => {
    expect(await storedHolders()).toEqual(['people/alice-example']);
  });

  test.todo('P3.9: switch on: an assistant-only person attribution is stored as brain', async () => {
    await engine.setConfig(ATTRIBUTION_CHECKS_KEY, 'true');
    expect(await storedHolders()).toEqual(['brain']);
  });
});
