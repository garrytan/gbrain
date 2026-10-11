/**
 * #6331 (P2.13): graduation's verify-step doctor runs on the fenced target while `persistence_brain.enabled` is still
 * false (cutover sets it), so a writer-owned content directory failed `sync_freshness` as "never been synced" and
 * blocked the graduation. The parent passes the source's flag; the target honors it only while its graduation row is
 * this run's `verifying` target. A missing row, another run id, another state or a `disabled` source still fail.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const home = mkdtempSync(join(tmpdir(), 'graduation-verify-freshness-'));
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePg = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePg?.();
  rmSync(home, { recursive: true, force: true });
});

/** A receipt-proven content directory on a target whose cutover has not happened yet (`enabled=false`). */
async function fencedTarget(engine: BrainEngine) {
  const sourceId = `content-${randomUUID().slice(0, 8)}`, root = join(home, sourceId); mkdirSync(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  const binding = await claimWorktree(engine, sourceId, root);
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  await engine.setConfig(`shared_skills.content.v1.${sourceId}.${binding.source_incarnation}`, JSON.stringify({ version: 1, brain_id: brain.brain_id,
    source_id: sourceId, source_incarnation: binding.source_incarnation, root, owned_root: true, repository_kind: 'content_directory', status: 'ready', stage: 'complete' }));
  await engine.executeRaw('DELETE FROM persistence_graduation');
  const runId = randomUUID();
  await engine.executeRaw("INSERT INTO persistence_graduation(role,run_id,state) VALUES('target',$1::uuid,'verifying')", [runId]);
  return { sourceId, runId };
}

test('the verifying target of this run inherits the source flag; every other combination still fails never-synced', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const { sourceId, runId } = await fencedTarget(engine);
    const freshness = (env: Record<string, string | undefined>) => withEnv({ GBRAIN_HOME: home, ...env }, () => checkSyncFreshness(engine));
    expect(await freshness({ GBRAIN_GRADUATION_RUN: runId, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'enabled' }))
      .toMatchObject({ status: 'ok', details: { writer_owned_count: 1, stale_count: 0 } });
    for (const env of [{ GBRAIN_GRADUATION_RUN: runId, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'disabled' },
      { GBRAIN_GRADUATION_RUN: runId, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: undefined },
      { GBRAIN_GRADUATION_RUN: randomUUID(), GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'enabled' },
      { GBRAIN_GRADUATION_RUN: undefined, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'enabled' }]) {
      const check = await freshness(env);
      expect(check.status).toBe('fail');
      expect(check.message).toContain(`'${sourceId}' has never been synced`);
    }
    for (const row of ["state='verified'", "role='source'"]) {
      await engine.executeRaw(`UPDATE persistence_graduation SET ${row}`);
      expect((await freshness({ GBRAIN_GRADUATION_RUN: runId, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'enabled' })).status).toBe('fail');
      await engine.executeRaw("UPDATE persistence_graduation SET state='verifying',role='target'");
    }
    await engine.executeRaw('DELETE FROM persistence_graduation');
    expect((await freshness({ GBRAIN_GRADUATION_RUN: runId, GBRAIN_GRADUATION_SOURCE_PERSISTENCE: 'enabled' })).status).toBe('fail');
  }
}), 120_000);
