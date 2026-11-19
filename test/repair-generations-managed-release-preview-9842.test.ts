/**
 * #9842: on a managed brain the release-held preview listed a held chronicle_event key as releasable (refused: 0) while the
 * apply refused it ("a managed release publishes atom page keys only"). The preview now refuses it with the same reason.
 */
import { describe, expect, test } from 'bun:test';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain, pathologicalArms } from './pathological/harness.ts';

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`managed release-held preview (${backend})`, () => {
    test('a held chronicle_event key is refused in the preview', async () => {
      await managedBrain(async ({ engine }) => {
        await engine.executeRaw(
          `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, operation_id, hold_id, item_set_hash, held_reason, held_context, proposal, proposal_bytes, attempts)
           VALUES ('default','chronicle_event','depth:meetings/acme-call',0,'held','held:h1','h1','hash1','shrunk','{}'::text::jsonb,'[]'::text::jsonb,2,1)`);
        const scope = await resolveRepairScope(engine, 'default');
        const quiet = { info: () => {}, warn: () => {}, error: () => {} };
        const preview = await (await repairRunner(engine, { apply: false, logger: quiet })).run('generations', scope,
          { explicit: true, sourceFlag: 'default', generations: { kind: 'chronicle_event', mode: 'release-held' as const, held: true } });
        expect(preview.listing).toEqual([expect.objectContaining({ class: 'refused', detail: expect.stringContaining('a managed release publishes atom page keys only') })]);
      }, { databaseUrl });
    }, 240_000);
  });
}
