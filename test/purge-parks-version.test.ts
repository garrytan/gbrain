/**
 * A purge park (purge-parks.ts) left by another gbrain version. A tombstone parked after PURGE_PARK_LIMIT failed purges
 * stayed parked until an operator ran `gbrain pages purge-deleted --retry-parked`, even when the refusal behind it was
 * gone in the running version (#7311: the shared-origin refusal), so the purge phase warned and doctor
 * `purge_parked_pages` stayed warning. A park now records the gbrain version that wrote it, as a global-maintenance phase
 * streak does: a park another version wrote, or one written before parks recorded a version, gets one automatic
 * attempt, and a failure re-parks it under the running version. A park the running version wrote is not retried
 * automatically; `--retry-parked` still retries it once.
 *
 * PGLite always; Postgres through test/e2e/purge-parks-version-postgres.test.ts. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { VERSION } from '../src/version.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated, purgePhaseStatus } from '../src/core/persistence/purge-deleted.ts';
import { PURGE_PARK_LIMIT, PURGE_PARK_OP, readPurgeParks } from '../src/core/persistence/purge-parks.ts';
import { checkPurgeParkedPages } from '../src/commands/doctor/checks/purge-parks.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'notes/expired-example';

async function raw<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const tombstone = async (engine: BrainEngine) => (await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug=$1", [SLUG])).length > 0;
const purgeRequests = async (engine: BrainEngine) => (await engine.executeRaw(
  "SELECT 1 FROM persistence_requests WHERE source_id='default' AND operation='delete_page' AND (intent->>'purge')::boolean IS TRUE")).length;
const park = async (engine: BrainEngine) => [...(await readPurgeParks(engine)).values()][0];
const automatic = (engine: BrainEngine) => purgeDeletedPagesCoordinated(engine, 72, { automatic: true });

/** An expired tombstone whose hard delete the database refuses, parked by PURGE_PARK_LIMIT real automatic purges. */
async function parkedTombstone(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content: '---\ntitle: Expired\ntype: note\n---\nA synthetic page that expires.', request_id: randomUUID() } });
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: SLUG, expected_revision: snapshot!.revision, request_id: randomUUID() } });
  await raw(engine, () => engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id='default' AND slug=$1", [SLUG]));
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION purge_parks_version_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic purge refusal'; END $$`);
  await engine.executeRaw(`CREATE TRIGGER purge_parks_version_refuse BEFORE DELETE ON pages FOR EACH ROW WHEN (OLD.slug = '${SLUG}') EXECUTE FUNCTION purge_parks_version_refuse()`);
  for (let attempt = 1; attempt <= PURGE_PARK_LIMIT; attempt++) expect(await automatic(engine)).toMatchObject({ count: 0, failed: 1, parked: 0 });
  expect(await automatic(engine)).toMatchObject({ count: 0, failed: 0, parked: 1 });
  expect(await purgeRequests(engine)).toBe(PURGE_PARK_LIMIT);
}
const allowPurge = (engine: BrainEngine) => engine.executeRaw('DROP TRIGGER IF EXISTS purge_parks_version_refuse ON pages');
/** Rewrites the park as an older gbrain left it: another version's stamp, or (null) none at all. */
const parkedBy = (engine: BrainEngine, version: string | null) => engine.executeRaw(
  `UPDATE op_checkpoints SET completed_keys = jsonb_build_array(CASE WHEN $2::text IS NULL THEN (completed_keys->0) - 'version'
    ELSE (completed_keys->0) || jsonb_build_object('version', $2::text) END) WHERE op=$1`, [PURGE_PARK_OP, version]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`purge parks across gbrain versions (${backend})`, () => {
    test('a park the running version wrote records it and is not retried automatically; --retry-parked still retries it once', () => managedBrain(async ({ engine, ctx }) => {
      await parkedTombstone(engine, ctx);
      expect(await park(engine)).toMatchObject({ failures: PURGE_PARK_LIMIT, version: VERSION });
      await allowPurge(engine);
      const run = await automatic(engine);
      expect({ count: run.count, parked: run.parked, status: purgePhaseStatus(run) }).toEqual({ count: 0, parked: 1, status: 'warn' });
      expect(await purgeRequests(engine)).toBe(PURGE_PARK_LIMIT);
      expect((await checkPurgeParkedPages(engine)).status).toBe('warn');
      expect(await purgeDeletedPagesCoordinated(engine, 72, { retryParked: true })).toMatchObject({ count: 1, failed: 0 });
      expect(await tombstone(engine)).toBe(false);
    }), 300_000);

    for (const older of ['0.60.1.0', null]) test(`a park ${older ? 'an older version wrote' : 'written before parks recorded a version'} gets one automatic attempt after the upgrade and is purged`, () => managedBrain(async ({ engine, ctx }) => {
      await parkedTombstone(engine, ctx);
      await parkedBy(engine, older);
      expect((await checkPurgeParkedPages(engine)).status).toBe('ok');
      await allowPurge(engine);
      const run = await automatic(engine);
      expect({ count: run.count, slugs: run.slugs, parked: run.parked, blocked: run.blocked, status: purgePhaseStatus(run) })
        .toEqual({ count: 1, slugs: [SLUG], parked: 0, blocked: [], status: 'ok' });
      expect(await tombstone(engine)).toBe(false);
      expect(await park(engine)).toBeUndefined();
    }), 300_000);

    test('the attempt is bounded: a failure re-parks it under the running version, and the next run does not retry it', () => managedBrain(async ({ engine, ctx }) => {
      await parkedTombstone(engine, ctx);
      await parkedBy(engine, null);
      expect(await automatic(engine)).toMatchObject({ count: 0, failed: 1, parked: 0 });
      expect(await purgeRequests(engine)).toBe(PURGE_PARK_LIMIT + 1);
      expect(await park(engine)).toMatchObject({ failures: PURGE_PARK_LIMIT + 1, version: VERSION });
      expect(await automatic(engine)).toMatchObject({ count: 0, failed: 0, parked: 1 });
      expect(await purgeRequests(engine)).toBe(PURGE_PARK_LIMIT + 1);
      expect(await tombstone(engine)).toBe(true);
      await allowPurge(engine);
    }), 300_000);
  });
}
