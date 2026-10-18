/**
 * GBRA-130 A-15: `writer deactivate` blocked on every effect whose state was not
 * `committed`, terminal failures included, and several blockers printed exits that
 * could not clear them: retry-effects refused a failed Git effect without parked
 * targets (`source_changed` after an archive and restore) with `invalid_params`,
 * and `repair embedding-effects` re-queued a zero-norm embedding effect that fails
 * the same way by design. Activation already blocked only on queued, running or
 * recovering effects.
 *
 * Authoring gate: (1) protects "only work that can still change blocks deactivate,
 * and every exit it prints clears what it names": terminal failures are listed in
 * `failed_effects` with their code and a real exit (or none when nothing can retry
 * them), and running each printed exit removes its entry. (2) Reverting the
 * blocker predicate in deactivation.ts lists the failures as blockers again and the
 * cases go red. (3) persistence-deactivate.test.ts covers requests and leases, not
 * failed effects or their exits. (4) No seam: the failures are real or built rows.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { deactivatePersistence } from '../../src/core/persistence/deactivation.ts';
import { retryRequestEffects } from '../../src/core/persistence/effect-retry.ts';
import { PARK_AFTER_FAILURES } from '../../src/core/persistence/effect-model.ts';
import { failLocks, passes } from './effects-fixture.ts';
import { expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, snapshotItems } from './harness.ts';

const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n` } });

async function effectOf(engine: BrainEngine, slug: string, kind: string) {
  const [row] = await engine.executeRaw<{ id: string; request_id: string; state: string; error_code: string | null }>(`SELECT e.id::text AS id,
    r.request_id::text AS request_id,e.state,e.error_code FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.slug=$1 AND e.kind=$2`, [slug, kind]);
  return row;
}
async function setEffect(engine: BrainEngine, id: string, sql: string) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(`UPDATE persistence_effects SET ${sql} WHERE id=$1`, [id]); });
}
const preview = (engine: BrainEngine) => deactivatePersistence(engine, { dryRun: true });

/** Runs one printed exit the way an agent would: the retry-effects preview's apply step, or the owner's effect worker. */
async function runExit(engine: BrainEngine, ctx: OperationContext, exit: string): Promise<void> {
  const retry = /^gbrain sources writer retry-effects (\S+) --request-id (\S+) --dry-run$/.exec(exit);
  if (retry) {
    await retryRequestEffects(engine, retry[1], retry[2], true, ctx.config);
    await retryRequestEffects(engine, retry[1], retry[2], false, ctx.config);
    await passes(engine, ctx.config, 2);
    return;
  }
  if (/^wait for the owner to drain it/.test(exit)) { await passes(engine, ctx.config, PARK_AFTER_FAILURES + 1); return; }
  throw new Error(`unrecognized exit: ${exit}`);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-15 deactivate blocks only on work that can still change (${backend})`, () => {
    test('A-15 item: terminal effect failures are history with a real exit, and each printed exit clears its entry', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await put(ctx, 'notes/archived', 'Its Git effect fails while the source is archived.');
        await put(ctx, 'notes/zero', 'The provider returns a zero vector for this text.');
        await disposePersistenceConsumer(engine);
        await passes(engine, ctx.config, 2);
        // A Git effect that failed source_changed while its source was archived, after the source was restored.
        const git = await effectOf(engine, 'notes/archived', 'git');
        await setEffect(engine, git.id, `state='failed',attempts=1,outcome=NULL,error_code='source_changed'`);
        const zero = await effectOf(engine, 'notes/zero', 'embedding');
        await setEffect(engine, zero.id, `state='failed',error_code='embedding_zero_norm',outcome=NULL`);
        const before = await snapshotItems(engine, 'default');

        const report = await expectUnitNotAborted(() => preview(engine));
        expect(report.blockers.filter(b => b.kind === 'effect')).toEqual([]);
        const failed = new Map((report.failed_effects ?? []).map(entry => [entry.effect_id, entry]));
        expect(failed.get(git.id)).toMatchObject({ kind: 'git', code: 'source_changed',
          exit: `gbrain sources writer retry-effects default --request-id ${git.request_id} --dry-run` });
        expect(failed.get(zero.id)).toMatchObject({ kind: 'embedding', code: 'embedding_zero_norm', exit: null });

        for (const entry of failed.values()) if (entry.exit) await runExit(engine, ctx, entry.exit);
        const after = await preview(engine);
        expect(after.blockers.filter(b => b.kind === 'effect')).toEqual([]);
        expect((after.failed_effects ?? []).map(entry => entry.effect_id)).toEqual([zero.id]);
        expect(await effectOf(engine, 'notes/archived', 'git')).toMatchObject({ state: 'committed' });
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
      }, { databaseUrl });
    }, 180_000);

    test('A-15 item: every exit an effect blocker prints clears that blocker', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await put(ctx, 'notes/target-example', 'The target.');
        await put(ctx, 'notes/stuck', 'See [[notes/target-example]].');
        await put(ctx, 'notes/queued', 'An embedding effect still queued.');
        await disposePersistenceConsumer(engine);
        await passes(engine, ctx.config, 2);
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
            SELECT e.request_id,'links',e.revision,e.data,e.source_id,e.source_incarnation,e.worktree_id FROM persistence_effects e
            JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='embedding' AND r.slug='notes/stuck'`);
          await tx.executeRaw(`UPDATE persistence_effects e SET state='queued',outcome=NULL,error_code=NULL,attempts=0 FROM persistence_requests r
            WHERE r.id=e.request_id AND e.kind='embedding' AND r.slug='notes/queued'`);
        });
        const restore = failLocks(engine, new Set(['notes/stuck']), () => new OperationError('page_body_segmented', 'A block of this page exceeds the segmented block limit.'));
        try {
          const blockers = (await preview(engine)).blockers.filter(b => b.kind === 'effect');
          expect(blockers.map(b => b.detail.split(' ')[0]).sort()).toEqual(['embedding', 'links']);
          for (const blocker of blockers) {
            await runExit(engine, ctx, blocker.exit);
            const remaining = (await preview(engine)).blockers.filter(b => b.kind === 'effect').map(b => b.id);
            expect({ exit: blocker.exit, cleared: !remaining.includes(blocker.id) }).toEqual({ exit: blocker.exit, cleared: true });
          }
        } finally { restore(); }
      }, { databaseUrl });
    }, 180_000);
  });
}
