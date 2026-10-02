/**
 * Fix wave 4 lane B (DX O1, #5673 interplay): autopilot dispatches a Google
 * or GitHub source only after its first recorded sync attempt. PGLite here,
 * PostgreSQL through test/e2e/connector-holds.test.ts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { attemptedConnectorSourceIds, seedConnectorDispatchAttempts } from '../src/core/persistence/connector-state.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { createConnectorFixture, githubConfig, options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

function fakeQueue() {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  let id = 0;
  return { added, queue: { add: async (name: string, data: Record<string, unknown>) => { added.push({ name, data }); return { id: ++id, coalesced: false }; } } as unknown as MinionQueue };
}

async function freshnessTick(engine: BrainEngine) {
  const { added, queue } = fakeQueue();
  const lines: string[] = [];
  const write = spyOn(process.stderr, 'write').mockImplementation(((line: string) => { lines.push(String(line)); return true; }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try { await dispatchFreshnessSyncs(engine, queue, { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: false }); }
  finally { write.mockRestore(); log.mockRestore(); }
  return { synced: added.filter(job => job.name === 'sync').map(job => job.data.sourceId as string), lines };
}

test('a never-attempted connector is idle in the freshness loop and the fan-out, with a one-time notice; a first run that fails still enables it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const f = await source(engine, githubConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const first = await freshnessTick(engine);
    expect(first.synced).not.toContain(f.id);
    expect(first.lines.filter(line => line.includes(`gbrain sync --source ${f.id}`))).toHaveLength(1);
    const second = await freshnessTick(engine);
    expect(second.synced).not.toContain(f.id);
    expect(second.lines.some(line => line.includes(f.id))).toBe(false);
    const fanout = fakeQueue();
    const result = await dispatchPerSource(engine, fanout.queue, { repoPath: '/tmp/none', slot: 's', timeoutMs: 1000, fanoutMax: 50, jsonMode: true, emit: () => {}, log: () => {} });
    expect(result.dispatched.map(d => (d as { source_id?: string }).source_id ?? d)).not.toContain(f.id);
    expect(fanout.added.some(job => job.data.sourceId === f.id || job.data.source_id === f.id)).toBe(false);
    // The operator's first explicit sync is the opt-in, even when it fails before any provider answer.
    await withEnv({ CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      const failed = await runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), options, async () => { throw new Error('synthetic network failure'); })
        .catch((error: Error) => ({ status: error.name }));
      expect(failed.status).not.toBe('synced');
    });
    expect((await attemptedConnectorSourceIds(engine)).has(f.id)).toBe(true);
    expect((await freshnessTick(engine)).synced).toContain(f.id);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

test('the v181 migration records an attempt for every connector the pre-upgrade loop dispatched (local_path set, sync not disabled)', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const dispatched = await source(engine, githubConfig);
    const disabled = await source(engine, { ...githubConfig, syncEnabled: false });
    const pathless = await source(engine, githubConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [pathless.id]);
    await seedConnectorDispatchAttempts(engine);
    await seedConnectorDispatchAttempts(engine);
    const attempted = await attemptedConnectorSourceIds(engine);
    expect(attempted.has(dispatched.id)).toBe(true);
    expect(attempted.has(disabled.id)).toBe(false);
    expect(attempted.has(pathless.id)).toBe(false);
    expect((await freshnessTick(engine)).synced).toContain(dispatched.id);
  }
}), 120_000);
