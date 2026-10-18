/**
 * GBRA-130 A-60: after a publication commits, its post-commit belief mark (`markBeliefCommits`) is written with
 * `.catch(() => undefined)` at coordinator.ts, group-publish.ts, database-write.ts, memory-mutations.ts and
 * purge-deleted.ts, with no counter or receipt. Verdict: not a silent loss. A missing mark is exactly the state a
 * crash between commit and mark leaves, and the ledger already detects and repairs it: `unmarkedPublications` lists
 * the publication, doctor `belief_ledger_coverage` warns "N publication(s) without a commit mark" with the
 * `gbrain beliefs reconcile` fix, and the cycle's extract phase (`cycleBeliefReconcile`) fills it.
 * This probe fails every mark statement (a trigger on belief_commit_marks) through a page write and a remember
 * (memory-mutations.ts), and pins that chain.
 * Managed brain with certified coverage; PGLite, and Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { cycleBeliefReconcile, unmarkedPublications } from '../../src/core/belief/coverage-report.ts';
import { beliefLedgerEntry } from '../../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { beliefBrain, beliefPage, type BeliefBrain } from '../helpers/belief-ledger.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

/** Every belief commit-mark statement fails until the returned restore runs, as a lost connection right after commit would. */
async function failCommitMarks(engine: BrainEngine): Promise<() => Promise<void>> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION a60_fail_mark() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'injected commit-mark failure'; END $f$`);
  await engine.executeRaw('CREATE TRIGGER a60_fail_mark BEFORE INSERT ON belief_commit_marks FOR EACH STATEMENT EXECUTE FUNCTION a60_fail_mark()');
  return async () => { await engine.executeRaw('DROP TRIGGER IF EXISTS a60_fail_mark ON belief_commit_marks'); };
}

async function doctor(b: BeliefBrain): Promise<Check> {
  const [check] = await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId } as DoctorContext) as Check[];
  return check!;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`A-60 a swallowed belief commit mark (${backend})`, () => {
    test('A-60 item: a write whose commit mark failed is listed unmarked, doctor warns with the reconcile fix, and the cycle fills the mark', async () => {
      await beliefBrain(async b => {
        const restore = await failCommitMarks(b.engine);
        try {
          await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round'] }));
          const remembered = await operationsByName.remember!.handler(b.ctx, { fact: 'Acme Example hired a new CFO', provenance: 'fixture',
            entity: 'companies/acme-example', request_id: randomUUID() }) as Record<string, unknown>;
          expect(remembered).toMatchObject({ state: 'committed' });
        } finally { await restore(); }
        const unmarked = await unmarkedPublications(b.engine, b.sourceId);
        expect(unmarked).toHaveLength(2);
        expect(unmarked).toContain(String((await b.engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_requests WHERE operation='remember' ORDER BY sequence DESC LIMIT 1"))[0]!.id));
        const warned = await doctor(b);
        expect(warned).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'beliefs', 'reconcile', '--source', b.sourceId, '--json'] } });
        expect(warned.message).toContain(`${unmarked.length} publication(s) without a commit mark`);
        expect(await cycleBeliefReconcile(b.engine, b.sourceId)).toMatchObject({ belief_commit_marks_filled: unmarked.length });
        expect(await unmarkedPublications(b.engine, b.sourceId)).toEqual([]);
        expect((await doctor(b)).status).toBe('ok');
      }, { managed: true, databaseUrl });
    }, 180_000);
  });
}
