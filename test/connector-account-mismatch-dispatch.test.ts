/**
 * #6803 (4): a connector source whose credential resolves to a different
 * account than its pin refuses every sync with `connector_account_changed`.
 * Autopilot used to dispatch a `sync` and an `autopilot-cycle` for it every
 * interval forever (44 dead syncs a day on a production brain). The refused
 * run now records the mismatch in the source's connector state, and both
 * autopilot loops classify the source unavailable-path until the operator
 * repins it (a sync that passes the account check) or changes its connector config.
 *
 * Real connector sync refusal, then the real freshness loop and per-source
 * fan-out, on every configured engine. The fixture toggles the
 * brain-wide persistence switch and process env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { recordConnectorSyncAttempt } from '../src/core/persistence/connector-state.ts';
import { connectorAccountMismatches } from '../src/core/persistence/connector-account-mismatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { contact, createConnectorFixture, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const contacts = async (url: string) => url.includes('/settings/sendAs') ? json({ sendAs: [] })
  : json({ connections: [contact('first', 'First Example')], nextSyncToken: 'contacts-1' });
const sync = (engine: BrainEngine, f: { id: string; dir: string }, account: string, config: Record<string, unknown> = googleConfig) =>
  runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, withGoogleAccount(contacts, account));

async function queued(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ name: string }>(
    "SELECT name FROM minion_jobs WHERE COALESCE(data->>'sourceId', data->>'source_id')=$1 ORDER BY id", [sourceId]);
  return rows.map(r => r.name);
}

async function tick(engine: BrainEngine, lines: string[]) {
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: string) => { lines.push(String(chunk)); return true; };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const queue = new MinionQueue(engine);
    const slot = `slot-${Math.random()}`;
    await dispatchFreshnessSyncs(engine, queue, { baseInterval: 60, slot, timeoutMs: 60_000, jsonMode: true });
    return await dispatchPerSource(engine, queue, { repoPath: '/nonexistent', slot, timeoutMs: 60_000, fanoutMax: 10, jsonMode: true,
      emit: line => { lines.push(line); }, log: line => { lines.push(line); } });
  } finally {
    (process.stderr as { write: unknown }).write = write;
    console.log = log;
  }
}

async function makeStale(engine: BrainEngine, sourceId: string) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE sources SET last_sync_at=NULL,
    config=config - 'last_full_cycle_at' - 'last_source_cycle_at' WHERE id=$1`, [sourceId]);
  await engine.executeRaw("DELETE FROM minion_jobs WHERE COALESCE(data->>'sourceId', data->>'source_id')=$1", [sourceId]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

describe('#6803 mis-pinned connector source in autopilot dispatch', () => {
  test('a refused account check makes the source unavailable-path until it is repinned', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await source(engine, googleConfig);
      await recordConnectorSyncAttempt(engine, f.id);
      expect((await sync(engine, f, googleConfig.g_account)).added).toBe(1);
      await disposePersistenceConsumer(engine);

      // A healthy, attempted connector is dispatched by both loops.
      await makeStale(engine, f.id);
      const healthy = await tick(engine, []);
      expect(healthy.skipped_unavailable_path).not.toContain(f.id);
      expect(await queued(engine, f.id)).toEqual(['sync', 'autopilot-cycle']);

      // The credential now resolves to another account: the sync refuses and records it.
      await expect(sync(engine, f, 'someone-else@example.invalid')).rejects.toMatchObject({ code: 'connector_account_changed' });
      await disposePersistenceConsumer(engine);
      expect([...(await connectorAccountMismatches(engine)).keys()]).toContain(f.id);

      await makeStale(engine, f.id);
      const lines: string[] = [];
      const skipped = await tick(engine, lines);
      expect(skipped.skipped_unavailable_path).toContain(f.id);
      expect(await queued(engine, f.id)).toEqual([]);
      const events = lines.flatMap(l => l.split('\n')).filter(l => l.startsWith('{')).map(l => JSON.parse(l) as Record<string, unknown>);
      expect(events.some(e => e.event === 'freshness_source_path_skipped' && e.source_id === f.id && e.code === 'connector_account_changed')).toBe(true);
      expect(events.some(e => e.event === 'fanout_source_path_skipped' && e.source_id === f.id && String(e.reason).includes(`gbrain sync --source ${f.id}`))).toBe(true);

      // The operator restores the credential and syncs by hand: the account check passes and clears the record.
      await sync(engine, f, googleConfig.g_account);
      await disposePersistenceConsumer(engine);
      expect([...(await connectorAccountMismatches(engine)).keys()]).not.toContain(f.id);
      await makeStale(engine, f.id);
      const repinned = await tick(engine, []);
      expect(repinned.skipped_unavailable_path).not.toContain(f.id);
      expect(await queued(engine, f.id)).toEqual(['sync', 'autopilot-cycle']);
    }
  }), 180_000);

  test('a changed connector config re-arms the source for one more automatic try', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await source(engine, googleConfig);
      await recordConnectorSyncAttempt(engine, f.id);
      expect((await sync(engine, f, googleConfig.g_account)).added).toBe(1);
      await expect(sync(engine, f, 'someone-else@example.invalid')).rejects.toMatchObject({ code: 'connector_account_changed' });
      await disposePersistenceConsumer(engine);
      expect([...(await connectorAccountMismatches(engine)).keys()]).toContain(f.id);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`UPDATE sources SET config=jsonb_set(config, '{g_token_env}', '"CONNECTOR_TEST_TOKEN_NEW"') WHERE id=$1`, [f.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect([...(await connectorAccountMismatches(engine)).keys()]).not.toContain(f.id);
    }
  }), 180_000);
});
