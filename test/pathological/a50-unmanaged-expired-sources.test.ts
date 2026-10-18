/**
 * A-50 (GBRA-130, hardening: the failure is fault-injected): one expired
 * archived source that cannot be deleted never stops an unmanaged brain's
 * retention sweep (src/core/destructive-guard.ts purgeExpiredSources).
 *
 * Protects: a source whose cascade delete fails with an item-scoped error (a
 * statement timeout on a large source, a lock timeout) is reported in
 * `blocked` with its typed code and the manual purge as a fix
 * (`tell_user_to_run gbrain sources purge <id> --confirm-destructive`), and the
 * sweep goes on to the next source, so the purge phase's page purge and GC
 * still run. A run-scoped failure (lost connection, failed transaction) still
 * stops the sweep. Nothing is persisted, so the next sweep retries the source.
 * Fails when: a non-FK error rethrows and aborts the sweep (the catch keeps
 * only SQLSTATE 23503), or a run-scoped error is swallowed as blocked.
 * Seams: none in production; failures come from a BEFORE DELETE trigger, run-scoped
 * errors from an engine wrapper. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { purgeExpiredSources, softDeleteSource } from '../../src/core/destructive-guard.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

/** Expired archived sources (the poison one sorts first) plus a live source, each with two pages. */
async function seed(engine: BrainEngine): Promise<{ poison: string; healthy: string[]; live: string }> {
  const tag = randomUUID().slice(0, 6);
  const [poison, healthy1, healthy2, live] = [`a-${tag}-poison`, `b-${tag}-expired`, `c-${tag}-expired`, `d-${tag}-live`];
  for (const id of [poison, healthy1, healthy2, live]) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
    for (const slug of ['notes/one', 'notes/two']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}`, timeline: '' }, { sourceId: id });
  }
  for (const id of [poison, healthy1, healthy2]) await softDeleteSource(engine, id);
  await engine.executeRaw(`UPDATE sources SET archive_expires_at = now() - interval '1 hour' WHERE id IN ($1, $2, $3)`, [poison, healthy1, healthy2]);
  return { poison, healthy: [healthy1, healthy2], live };
}

async function refuseDelete(engine: BrainEngine, id: string, state: string): Promise<void> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION probe_refuse_source_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF OLD.id = TG_ARGV[0] THEN RAISE EXCEPTION 'probe refuses deleting source %', OLD.id USING ERRCODE = '${state}'; END IF; RETURN OLD; END $fn$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS probe_refuse_source_delete ON sources');
  await engine.executeRaw(`CREATE TRIGGER probe_refuse_source_delete BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION probe_refuse_source_delete('${id}')`);
}

const sourceIds = async (engine: BrainEngine, ids: string[]) =>
  (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [ids])).map(r => r.id);

/** The engine whose first source DELETE throws `error`. */
function failingFirstSourceDelete(engine: BrainEngine, error: unknown): BrainEngine {
  let thrown = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => {
        if (!thrown && sql.includes('DELETE FROM sources')) { thrown = true; return Promise.reject(error); }
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-50 unmanaged expired-source sweep (${backend})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      if (databaseUrl) ({ engine, close: closePostgres } = await isolatedPersistencePostgres(databaseUrl));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 180_000);

    afterAll(async () => {
      if (closePostgres) await closePostgres();
      else await engine.disconnect();
    });

    test('item: a source whose delete times out is blocked with its code and the manual purge; the other expired sources purge', async () => {
      const { poison, healthy, live } = await seed(engine);
      await refuseDelete(engine, poison, '57014');
      const [poisonBefore, liveBefore] = [await snapshotItems(engine, poison), await snapshotItems(engine, live)];
      const result = await expectUnitNotAborted(() => purgeExpiredSources(engine));
      expect(result.purged).toEqual(healthy);
      const blocked = result.blocked.find(b => b.id === poison);
      expectItemFailure(blocked ? { key: blocked.id, code: blocked.code, fix: blocked.fix } : undefined,
        { key: poison, code: 'statement_timeout', fix: new RegExp(`"next":"tell_user_to_run".*"command":"gbrain sources purge ${poison} --confirm-destructive"|"command":"gbrain sources purge ${poison} --confirm-destructive".*"next":"tell_user_to_run"`) });
      expect(await sourceIds(engine, [poison, ...healthy, live])).toEqual([poison, live]);
      expectOthersUnchanged(poisonBefore, await snapshotItems(engine, poison));
      expectOthersUnchanged(liveBefore, await snapshotItems(engine, live));
      for (const id of healthy) expect((await snapshotItems(engine, id)).size).toBe(0);

      await engine.executeRaw('DROP TRIGGER probe_refuse_source_delete ON sources');
      const retried = await expectUnitNotAborted(() => purgeExpiredSources(engine));
      expect({ purged: retried.purged, blocked: retried.blocked.filter(b => b.id === poison) }).toEqual({ purged: [poison], blocked: [] });
    });

    test('item: a lock timeout is blocked the same way and retried on the next sweep', async () => {
      const { poison, healthy } = await seed(engine);
      await refuseDelete(engine, poison, '55P03');
      const result = await expectUnitNotAborted(() => purgeExpiredSources(engine));
      expect(result.purged).toEqual(healthy);
      expect(result.blocked.find(b => b.id === poison)).toMatchObject({ code: 'lock_timeout' });
      await engine.executeRaw('DROP TRIGGER probe_refuse_source_delete ON sources');
      expect((await purgeExpiredSources(engine)).purged).toEqual([poison]);
    });

    for (const { name, error } of runScopedErrors()) {
      test(`run: a run-scoped failure (${name}) deleting a source stops the sweep`, async () => {
        const { poison, healthy, live } = await seed(engine);
        const injected = error();
        const thrown = await purgeExpiredSources(failingFirstSourceDelete(engine, injected)).catch(e => e);
        expect(thrown).toBe(injected);
        expect(await sourceIds(engine, [poison, ...healthy, live])).toEqual([poison, ...healthy, live].sort());
        await purgeExpiredSources(engine);
      });
    }
  });
}
