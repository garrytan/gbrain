import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { claimWorktree, prepareWriterTransfer, acceptWriterTransfer, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, prepareRecovery, getWriteRequestById, completeWrite, clearResolvedRecovery } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-commit-durability-'));
const engines: BrainEngine[] = [];
const roots: string[] = [];
const hostId = randomUUID();
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    const [{ database }] = await isolated.engine.executeRaw<{ database: string }>('SELECT current_database() AS database');
    await isolated.engine.disconnect();
    // Pin one actual session so its async default and post-transaction restore
    // can both be observed without relying on pool checkout order.
    const url = new URL(process.env.DATABASE_URL); url.pathname = `/${database}`;
    const pg = new PostgresEngine(); await pg.connect({ database_url: url.toString(), poolSize: 1 }); engines.push(pg);
    closePostgres = isolated.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function setting(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ value: string }>("SELECT current_setting('synchronous_commit') AS value");
  return row.value;
}
async function durable<T>(engine: BrainEngine, run: (observed: BrainEngine) => Promise<T>): Promise<T> {
  const previous = await setting(engine);
  await engine.executeRaw("SELECT set_config('synchronous_commit','off',false)");
  let transactions = 0;
  const observed = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return <R>(fn: (tx: BrainEngine) => Promise<R>) => target.transaction(async tx => {
      expect(await setting(tx)).toBe('off');
      const result = await fn(tx);
      expect(await setting(tx)).toBe('on'); transactions++;
      return result;
    });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const result = await run(observed);
    expect(transactions).toBe(1);
    expect(await setting(engine)).toBe('off');
    return result;
  } finally { await engine.executeRaw("SELECT set_config('synchronous_commit',$1,false)", [previous]); }
}

test('recovery, cancellation, transfer drain and successor epoch force durable commits under an async session', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const sourceId = `durable-${randomUUID().slice(0, 20)}`;
    const root = mkdtempSync(join(tmpdir(), 'gbrain-durable-owner-')); roots.push(root);
    const path = join(root, 'page.md'); const before = 'Before the attempted publication'; writeFileSync(path, before);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root, hostId);
    await registerLocalWriter(engine, 'cli');
    const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
      'put_page', sourceId, binding.source_incarnation, 'page');
    const accepted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'page', pageId: null, worktreeId: binding.worktree_id,
      topologyGeneration: binding.topology_generation, callerIntent: { content: 'After' }, intent: { content: 'After' } });
    const row = (await claimNextWrite(engine, hostId))!; expect(row.id).toBe(accepted.id);
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull();
    try {
      await durable(engine, observed => prepareRecovery(observed, row, { version: 1, path, root,
        before: Buffer.from(before).toString('base64'), beforeHash: sha256(before), afterHash: sha256('After'),
        mode: 0o600, ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token! }, 4096));
    } finally { await lock?.release(); }
    // This fixture reserved recovery without publishing any bytes. Complete its
    // known pre-publication failure; a size-one pool intentionally cannot run physical recovery.
    await engine.transaction(tx => completeWrite(tx, row, 'failed', {}));
    await clearResolvedRecovery(engine, row.id);
    const cancellation = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'page', callerIntent: { content: 'Cancel' }, intent: { content: 'Cancel' } });
    const cancelled = await durable(engine, observed => cancelWriteRequest(observed, authority.principal, cancellation.request_id));
    expect(cancelled?.state).toBe('cancelled');
    expect((await getWriteRequestById(engine, cancellation.id))?.state).toBe('cancelled');
    const transfer = await durable(engine, observed => prepareWriterTransfer(observed, sourceId, hostId));
    await durable(engine, observed => acceptWriterTransfer(observed, sourceId, root, transfer.owner_epoch, transfer.manifest.digest, hostId));
    const [owner] = await engine.executeRaw<{ owner_epoch: string; state: string }>('SELECT owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]);
    expect(String(owner.owner_epoch)).toBe(String(BigInt(transfer.owner_epoch) + 1n)); expect(owner.state).toBe('active');
  }
}), 120_000);
