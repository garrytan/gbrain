/**
 * A-49 (GBRA-130, hardening: the trigger is fault-injected): one expired
 * tombstone the belief-ledger expiry cannot delete never stops an unmanaged
 * brain's retention purge (src/core/persistence/purge-deleted.ts).
 *
 * Protects: on an unmanaged brain whose source the belief ledger records, a
 * tombstone whose delete fails is reported in `blocked` with a typed code and
 * counted in `failed` (the purge phase warns); the other recorded tombstones
 * and the bulk delete of the rest still run, and the bulk delete leaves the
 * failed tombstone alone (it would otherwise lose its page.expired event). A
 * content failure counts toward the shared purge park (PURGE_PARK_LIMIT, doctor
 * purge_parked_pages, `gbrain pages purge-deleted --retry-parked`); a
 * transient one is retried every run and never parked. A run-scoped failure or
 * a systemic run stops the purge and records no park.
 * Fails when: the per-row loop has no catch (the purge throws and the bulk
 * delete never runs), a failed tombstone is bulk-deleted, or a transient
 * failure parks.
 * Seams: none in production; failures come from a BEFORE DELETE trigger, run-scoped
 * errors from an engine wrapper. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { purgeDeletedPagesCoordinated, purgePhaseStatus, selectPurgeCandidates } from '../../src/core/persistence/purge-deleted.ts';
import { PURGE_PARK_LIMIT, readPurgeParks } from '../../src/core/persistence/purge-parks.ts';
import { checkPurgeParkedPages } from '../../src/commands/doctor/checks/purge-parks.ts';
import { beliefBrain, beliefPage, type BeliefBrain } from '../helpers/belief-ledger.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const POISON = 'notes/poison-example';
const RECORDED = ['notes/expired-a', 'notes/expired-b', 'notes/expired-c', 'notes/expired-d'];
const LIVE = 'notes/live-example';
const BULK = 'notes/unrecorded-expired';

/** Recorded tombstones (the poison one first in scan order), a live page, and an expired tombstone in a source the ledger does not record. */
async function seed(b: BeliefBrain): Promise<void> {
  for (const slug of [POISON, ...RECORDED, LIVE]) await b.put(slug, beliefPage({ title: slug, prose: `Body of ${slug}.` }));
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2`, [b.sourceId, POISON]);
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '90 hours' WHERE source_id = $1 AND slug = ANY($2::text[])`, [b.sourceId, RECORDED]);
  await b.engine.putPage(BULK, { type: 'note', title: 'bulk', compiled_truth: '# bulk', timeline: '' }, { sourceId: 'default' });
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = 'default' AND slug = $1`, [BULK]);
}

/** A BEFORE DELETE trigger that refuses deleting the listed slugs with SQLSTATE `state`. */
async function refuseDelete(engine: BrainEngine, slugs: string[], state: string): Promise<void> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION probe_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF OLD.slug = ANY(TG_ARGV) THEN RAISE EXCEPTION 'probe refuses deleting %', OLD.slug USING ERRCODE = '${state}'; END IF; RETURN OLD; END $fn$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS probe_refuse_delete ON pages');
  await engine.executeRaw(`CREATE TRIGGER probe_refuse_delete BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION probe_refuse_delete(${slugs.map(s => `'${s}'`).join(', ')})`);
}

const purge = (engine: BrainEngine, opts?: { retryParked?: boolean }) => purgeDeletedPagesCoordinated(engine, 72, opts);
const alive = async (engine: BrainEngine, sourceId: string) =>
  (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug', [sourceId])).map(r => r.slug);

/** The engine whose first `transaction` call throws `error` (a per-tombstone delete runs in its own transaction). */
function failingFirstTransaction(engine: BrainEngine, error: unknown): BrainEngine {
  let thrown = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return (...args: unknown[]) => { if (!thrown) { thrown = true; return Promise.reject(error); } return (target.transaction as (...a: unknown[]) => unknown)(...args); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-49 unmanaged recorded-tombstone purge (${backend})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: false, databaseUrl });

    test('item: a tombstone whose delete is refused is reported and kept; the other tombstones and the bulk delete still purge', async () => {
      await brain(async b => {
        await seed(b);
        await refuseDelete(b.engine, [POISON], '23514');
        const before = await snapshotItems(b.engine, b.sourceId);
        const result = await expectUnitNotAborted(() => purge(b.engine));
        expect(result.slugs.sort()).toEqual([...RECORDED, BULK].sort());
        expect({ failed: result.failed, parked: result.parked, status: purgePhaseStatus(result) }).toEqual({ failed: 1, parked: 0, status: 'warn' });
        expect(result.blocked.length).toBe(1);
        expectItemFailure({ key: `${result.blocked[0]!.source_id}/${result.blocked[0]!.slug}`, code: result.blocked[0]!.code ?? undefined, fix: result.blocked[0]!.reason },
          { key: `${b.sourceId}/${POISON}`, code: 'invalid_data', fix: /gbrain pages purge-deleted --retry-parked/ });
        expect(await alive(b.engine, b.sourceId)).toEqual([LIVE, POISON].sort());
        expect(await alive(b.engine, 'default')).not.toContain(BULK);
        expectOthersUnchanged(before, await snapshotItems(b.engine, b.sourceId), { changed: RECORDED });
        const [park] = [...(await readPurgeParks(b.engine)).values()];
        expect(park).toMatchObject({ source_id: b.sourceId, slug: POISON, failures: 1, code: 'invalid_data' });
      });
    }, 180_000);

    test('park: after PURGE_PARK_LIMIT content failures the tombstone is parked, previewed and named by doctor; --retry-parked purges it once the cause clears', async () => {
      await brain(async b => {
        await seed(b);
        await refuseDelete(b.engine, [POISON], '23514');
        for (let run = 1; run <= PURGE_PARK_LIMIT; run++) expect((await purge(b.engine)).failed).toBe(1);
        const parkedRun = await expectUnitNotAborted(() => purge(b.engine));
        expect({ failed: parkedRun.failed, parked: parkedRun.parked, status: purgePhaseStatus(parkedRun) }).toEqual({ failed: 0, parked: 1, status: 'warn' });
        expectItemFailure({ key: parkedRun.blocked[0]!.slug, code: parkedRun.blocked[0]!.code ?? undefined, fix: parkedRun.blocked[0]!.reason },
          { key: POISON, code: 'purge_parked', fix: /gbrain pages purge-deleted --retry-parked/ });
        const preview = await selectPurgeCandidates(b.engine, 72);
        expect({ count: preview.count, parked: preview.parked.map(p => [p.slug, p.failures]) }).toEqual({ count: 0, parked: [[POISON, PURGE_PARK_LIMIT]] });
        const doctor = await checkPurgeParkedPages(b.engine);
        expect(doctor).toMatchObject({ status: 'warn', details: { parked: 1, pages: [{ source_id: b.sourceId, slug: POISON, failures: PURGE_PARK_LIMIT }] } });
        await b.engine.executeRaw('DROP TRIGGER probe_refuse_delete ON pages');
        expect((await selectPurgeCandidates(b.engine, 72, { retryParked: true })).count).toBe(1);
        const retried = await expectUnitNotAborted(() => purge(b.engine, { retryParked: true }));
        expect({ slugs: retried.slugs, blocked: retried.blocked }).toEqual({ slugs: [POISON], blocked: [] });
        expect(await readPurgeParks(b.engine)).toEqual(new Map());
      });
    }, 300_000);

    test('transient: a lock timeout is reported and retried every run, never parked', async () => {
      await brain(async b => {
        await seed(b);
        await refuseDelete(b.engine, [POISON], '55P03');
        for (let run = 1; run <= PURGE_PARK_LIMIT + 1; run++) {
          const result = await expectUnitNotAborted(() => purge(b.engine));
          expect({ failed: result.failed, parked: result.parked, code: result.blocked[0]?.code }).toEqual({ failed: 1, parked: 0, code: 'lock_timeout' });
        }
        expect(await readPurgeParks(b.engine)).toEqual(new Map());
        await b.engine.executeRaw('DROP TRIGGER probe_refuse_delete ON pages');
        expect((await purge(b.engine)).slugs).toEqual([POISON]);
      });
    }, 300_000);

    test('breaker: when most recorded tombstones fail the purge stops item_failures_systemic and parks nothing', async () => {
      await brain(async b => {
        await seed(b);
        await refuseDelete(b.engine, [POISON, ...RECORDED], '23514');
        const before = await snapshotItems(b.engine, b.sourceId);
        const error = await purge(b.engine).catch(e => e);
        expect(error?.code).toBe('item_failures_systemic');
        expect(await readPurgeParks(b.engine)).toEqual(new Map());
        expectOthersUnchanged(before, await snapshotItems(b.engine, b.sourceId));
      });
    }, 180_000);

    for (const { name, error } of runScopedErrors()) {
      test(`run: a run-scoped failure (${name}) on a tombstone stops the purge and parks nothing`, async () => {
        await brain(async b => {
          await seed(b);
          const injected = error();
          const before = await snapshotItems(b.engine, b.sourceId);
          const thrown = await purge(failingFirstTransaction(b.engine, injected)).catch(e => e);
          expect(thrown).toBe(injected);
          expect(await readPurgeParks(b.engine)).toEqual(new Map());
          expect(await alive(b.engine, 'default')).toContain(BULK);
          expectOthersUnchanged(before, await snapshotItems(b.engine, b.sourceId));
        });
      }, 180_000);
    }
  });
}
