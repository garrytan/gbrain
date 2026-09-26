import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { jsonBytes } from '../src/core/persistence/digest.ts';
import { localHostId, registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { principalKey } from '../src/core/persistence/model.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { recordTopologyChange, releaseTopologyReservation, type TopologyChange } from '../src/core/persistence/topology-receipts.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); });
async function fixture(run: (engine: BrainEngine, home: string, principal: string, worktree: string) => Promise<void>) {
  for (const engine of engines) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-topology-quota-'));
    try { await withEnv({ GBRAIN_HOME: home }, async () => {
      await resetPgliteState(engine as PGLiteEngine);
      const principal = (await registerLocalWriter(engine, 'cli')).id;
      const worktree = randomUUID();
      await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktree, localHostId()]);
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('quota-source','Quota source')");
      await run(engine, home, principal, worktree);
    }); } finally { rmSync(home, { recursive: true, force: true }); }
  }
}
async function record(engine: BrainEngine, principal: string, worktree: string, intent: unknown, pending = true) {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [worktree]);
    await tx.executeRaw("SELECT id FROM sources WHERE id='quota-source' FOR UPDATE");
    await tx.executeRaw('SELECT id FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [principal]);
    return recordTopologyChange(tx, { principal, requestId: randomUUID(), intent, operation: 'reclone', sourceId: 'quota-source', incarnation: null, worktrees: [worktree] },
      { operation: 'reclone' }, pending ? { attempt: randomUUID() } : null, pending ? 1024 : 0);
  });
}
async function counters(engine: BrainEngine, key: string) {
  const [row] = await engine.executeRaw<Record<string, string | number>>('SELECT outstanding_count,intent_bytes,recovery_bytes,lifetime_ids,terminal_bytes FROM persistence_counters WHERE key=$1', [key]);
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)]));
}
async function finish(engine: BrainEngine, row: TopologyChange) {
  return engine.transaction(async tx => {
    const released = await releaseTopologyReservation(tx, row);
    if (released) await tx.executeRaw("UPDATE persistence_topology_changes SET state='failed' WHERE id=$1::uuid", [row.id]);
    return released;
  });
}

test('recovering clones share principal and brain outstanding quotas with ordinary page admission', () => fixture(async (engine, home, principal, worktree) => {
  await engine.setConfig('persistence.limits.principal_outstanding', '1');
  await engine.setConfig('persistence.limits.brain_outstanding', '2');
  const first = await record(engine, principal, worktree, { operation: 'reclone', sourceId: 'quota-source' });
  await expect(record(engine, principal, worktree, { operation: 'reclone', sourceId: 'another' })).rejects.toMatchObject({ code: 'queue_capacity' });
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='quota-source'");
  const authority = await submissionAuthority({ engine, config: { engine: engine.kind }, remote: false, sourceId: 'quota-source', dryRun: false, logger: { info() {}, warn() {}, error() {} } },
    'put_page', 'quota-source', source.incarnation, 'page');
  await expect(admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'quota-source', sourceIncarnation: source.incarnation,
    slug: 'page', callerIntent: { content: 'Example' }, intent: { content: 'Example' } })).rejects.toMatchObject({ code: 'queue_capacity' });
  const otherHome = join(home, 'other-user'); mkdirSync(otherHome);
  const other = await withEnv({ GBRAIN_HOME: otherHome }, () => registerLocalWriter(engine, 'cli'));
  const second = await record(engine, other.id, worktree, { operation: 'reclone', sourceId: 'second' });
  await engine.setConfig('persistence.limits.principal_outstanding', '10');
  await expect(record(engine, other.id, worktree, { operation: 'reclone', sourceId: 'third' })).rejects.toMatchObject({ code: 'queue_capacity' });
  expect((await counters(engine, 'brain')).outstanding_count).toBe(2);
  await finish(engine, first); await finish(engine, second);
  expect((await counters(engine, 'brain')).outstanding_count).toBe(0);
}), 120_000);

test('normalized intent bytes are exact and release once even after principal revocation', () => fixture(async (engine, _home, principal, worktree) => {
  const intent = { operation: 'reclone', sourceId: 'quota-source', ignored: undefined, config: { note: 'Example café' } };
  const bytes = jsonBytes(intent);
  await engine.setConfig('persistence.limits.principal_intent_bytes', String(bytes - 1));
  await expect(record(engine, principal, worktree, intent)).rejects.toMatchObject({ code: 'queue_capacity' });
  await engine.setConfig('persistence.limits.principal_intent_bytes', String(bytes));
  await engine.setConfig('persistence.limits.brain_intent_bytes', String(bytes - 1));
  await expect(record(engine, principal, worktree, intent)).rejects.toMatchObject({ code: 'queue_capacity' });
  await engine.setConfig('persistence.limits.brain_intent_bytes', String(bytes));
  const row = await record(engine, principal, worktree, intent);
  expect(Number(row.intent_bytes)).toBe(bytes);
  const key = principalKey({ kind: 'local_cli', id: principal });
  expect(await counters(engine, key)).toMatchObject({ outstanding_count: 1, intent_bytes: bytes, lifetime_ids: 1, terminal_bytes: 16384 });
  await revokeLocalWriter(engine, principal);
  const released = await Promise.all([finish(engine, row), finish(engine, row)]);
  expect(released.filter(Boolean)).toHaveLength(1);
  expect(await counters(engine, key)).toMatchObject({ outstanding_count: 0, intent_bytes: 0, lifetime_ids: 1, terminal_bytes: 16384 });
  expect(await counters(engine, 'brain')).toMatchObject({ outstanding_count: 0, intent_bytes: 0, recovery_bytes: 0, lifetime_ids: 1, terminal_bytes: 16384 });
  expect((await counters(engine, `worktree:${worktree}`)).recovery_bytes).toBe(0);
}), 120_000);

test('clone capacity refusal happens before provider work and immediate lifecycle receipts need no pending slot', () => fixture(async (engine, home, principal, worktree) => {
  await engine.setConfig('persistence.limits.principal_outstanding', '0');
  await engine.setConfig('persistence.limits.principal_intent_bytes', '0');
  const target = join(home, 'new-clone');
  const input = { operation: 'add' as const, sourceId: 'new-clone', path: target, remoteUrl: 'https://example.invalid/brain.git', requestId: randomUUID() };
  let providers = 0;
  await expect(runManagedSourceClone(engine, input, principal, input.requestId, { ...input, requestId: undefined },
    { clone: async () => { providers++; } })).rejects.toMatchObject({ code: 'queue_capacity' });
  expect(providers).toBe(0); expect(existsSync(target)).toBe(false);
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
  const immediate = await record(engine, principal, worktree, { operation: 'archive' }, false);
  expect(immediate.state).toBe('committed'); expect(Number(immediate.intent_bytes)).toBe(0);
  expect(await counters(engine, 'brain')).toMatchObject({ outstanding_count: 0, intent_bytes: 0, recovery_bytes: 0, lifetime_ids: 1 });
}), 120_000);
