/**
 * GBRA-130 A-13: a targeted (withdrawal) or scan embedding effect never set its
 * failing target, so one page whose provider call failed every time used up the
 * whole effect's retry budget: the effect failed `embedding_attempts_exhausted`
 * and every later target stayed without vectors (the withdrawal had deleted
 * their chunks). Git and mirror scans already parked one target and moved on.
 *
 * Authoring gate: (1) protects "one page the provider refuses never leaves the
 * other withdrawn pages vectorless": the failing page is parked with its code
 * after the per-page budget, the scan embeds the later targets and ends
 * `targets_parked`, retry-effects re-embeds the parked page once the provider
 * accepts it, while configuration and run-scoped failures stay effect-wide and
 * park nothing. (2) Reverting the per-target park in effects.ts fails the whole
 * effect at the first page and the item case goes red. (3) No existing test fails
 * one target of a multi-target embedding effect. (4) The provider is the effect
 * worker's embedding stub, the seam every embedding-effect test uses.
 */
import { describe, expect, test } from 'bun:test';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { retryRequestEffects } from '../../src/core/persistence/effect-retry.ts';
import { drain, effectsOf, embedAll, embeddedPages, SOURCE, TARGETS, UNTOUCHED, withdrawalBrain, type Embed } from './effects-fixture.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const [W1, W2, W3] = TARGETS;
/** The provider refuses W2's text every time (a non-retriable, non-configuration server error) and embeds every other text. */
const refusing = (error: () => unknown): Embed => async (texts, options) => {
  if (texts.some(text => text.includes(W2))) throw error();
  return embedAll(texts, options);
};
const providerRefusal = () => Object.assign(new Error('The provider could not embed this input'), { status: 500 });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-13 an embedding scan parks the page the provider refuses (${backend})`, () => {
    test('A-13 item: the refused page is parked with its code, the later targets are embedded, and retry-effects re-embeds it', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, request, ctx }) => {
        const before = await snapshotItems(engine, SOURCE);
        await expectUnitNotAborted(() => drain(engine, 14, { embed: refusing(providerRefusal) }));
        const { embedding, git } = await effectsOf(engine, request.id);
        expect({ state: embedding.state, error_code: embedding.error_code }).toEqual({ state: 'failed', error_code: 'targets_parked' });
        const [parked] = embedding.data.parked ?? [];
        expectItemFailure(parked && { key: parked.slug, code: parked.error_code }, { key: W2, code: 'effect_unavailable' });
        expect(embedding.data.parked).toHaveLength(1);
        expect(await embeddedPages(engine)).toEqual([W1, W3]);
        expect(git.state).toBe('committed');
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { changed: TARGETS });
        expect((await snapshotItems(engine, SOURCE)).get(UNTOUCHED)).toEqual(before.get(UNTOUCHED));

        const preview = await retryRequestEffects(engine, SOURCE, request.request_id, true, ctx.config);
        expect((preview.effects as Array<{ kind: string; action: string }>).find(e => e.kind === 'embedding')?.action).toBe('would_retry');
        await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config);
        await drain(engine, 4);
        expect((await effectsOf(engine, request.id)).embedding).toMatchObject({ state: 'committed', error_code: null });
        expect(await embeddedPages(engine)).toEqual(TARGETS);
      });
    }, 180_000);

    test('A-13 item: a configuration error stays effect-wide and parks nothing', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, request }) => {
        await expectUnitNotAborted(() => drain(engine, 8, { embed: refusing(() => new AIConfigError('The embedding model is not configured for this provider.')) }));
        const { embedding } = await effectsOf(engine, request.id);
        expect({ state: embedding.state, error_code: embedding.error_code, parked: embedding.data.parked ?? null })
          .toEqual({ state: 'failed', error_code: 'embedding_configuration', parked: null });
      });
    }, 180_000);

    for (const injected of runScopedErrors()) {
      test(`A-13 run: a run-scoped failure (${injected.name}) at one page parks nothing and does not move the scan past it`, async () => {
        await withdrawalBrain(databaseUrl, async ({ engine, request }) => {
          await expectUnitNotAborted(() => drain(engine, 14, { embed: refusing(injected.error) }));
          const { embedding } = await effectsOf(engine, request.id);
          expect({ parked: embedding.data.parked ?? null, error_code: embedding.error_code === 'targets_parked' ? 'targets_parked' : 'not parked' })
            .toEqual({ parked: null, error_code: 'not parked' });
          expect(await embeddedPages(engine)).toEqual([W1]);
        });
      }, 180_000);
    }
  });
}
