/**
 * #9842: on a managed brain, `repair generations --mode release-held` previewed a held chronicle_event key as
 * releasable while the apply refused it ("a managed release publishes atom page keys only"), so the printed apply
 * command could never succeed. The preview now refuses the key with the apply's reason. PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain, pathologicalArms } from './pathological/harness.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const selection = { kind: 'chronicle_event', mode: 'release-held' as const, held: true };

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#9842 managed release-held preview (${backend})`, () => {
    test('a held chronicle_event key is refused in the preview with the reason the apply gives', async () => {
      await managedBrain(async ({ engine }) => {
        await engine.executeRaw(
          `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, operation_id, hold_id, item_set_hash, held_reason, held_context, proposal, proposal_bytes, attempts)
           VALUES ('default', 'chronicle_event', 'depth:meetings/acme-example-sync', 0, 'held', 'held:h-9842', 'h-9842', 'hash-9842', 'shrunk', '{}'::jsonb, '[]'::jsonb, 2, 1)`);
        const scope = await resolveRepairScope(engine, 'default');
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet }))
          .run('generations', scope, { explicit: true, sourceFlag: 'default', generations: selection });
        expect(preview.listing).toEqual([
          expect.objectContaining({ class: 'refused', detail: expect.stringContaining('a managed release publishes atom page keys only') }),
        ]);
        const [row] = await engine.executeRaw<{ state: string }>(`SELECT state FROM derived_generations WHERE hold_id = 'h-9842'`);
        expect(row?.state).toBe('held');
      }, { databaseUrl });
    }, 240_000);
  });
}
