import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { claimWorktree, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, prepareRecovery, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-fairness-'));
const roots: string[] = [];
const hostId = randomUUID();
let engine: PGLiteEngine;
let consumer: PersistenceConsumer | undefined;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await consumer?.stop(); await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('sixteen blocked recovery roots cannot starve a later recoverable root or release a blocked FIFO head', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await registerLocalWriter(engine, 'cli');
  const requests: Array<{ id: string; path: string }> = [];
  let blockedFollower: string | undefined;
  for (let i = 0; i < 17; i++) {
    const sourceId = `recovery-${i}`;
    const root = mkdtempSync(join(tmpdir(), 'gbrain-recovery-root-')); roots.push(root);
    const path = join(root, 'page.md'); writeFileSync(path, 'Before');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root, hostId);
    const authority = await submissionAuthority({ engine, remote: false, sourceId, config: { engine: 'pglite' }, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext,
      'put_page', sourceId, binding.source_incarnation, 'page');
    const admission = { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'page', worktreeId: binding.worktree_id,
      topologyGeneration: binding.topology_generation, callerIntent: { content: 'After' }, intent: { content: 'After' } };
    const accepted = await admitWrite(engine, admission);
    const row = (await claimNextWrite(engine, hostId))!; expect(row.id).toBe(accepted.id);
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull();
    try {
      await prepareRecovery(engine, row, { version: 1, path, root, before: Buffer.from('Before').toString('base64'),
        beforeHash: sha256('Before'), afterHash: sha256('After'), mode: 0o600,
        ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token! }, 4096);
    } finally { await lock?.release(); }
    writeFileSync(path, i < 16 ? 'Unexpected external bytes' : 'After');
    requests.push({ id: row.id, path });
    if (i === 0) blockedFollower = (await admitWrite(engine, { ...admission, callerIntent: { content: 'Later' }, intent: { content: 'Later' } })).id;
  }
  consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('This test only runs recovery.'); },
    { hostId, concurrency: 0, pollMs: 5000 });
  await consumer.tick();
  expect((await getWriteRequestById(engine, requests[16].id))!.recovery).not.toBeNull();
  await consumer.tick();
  expect((await getWriteRequestById(engine, requests[16].id))!).toMatchObject({ state: 'queued', recovery: null });
  expect(readFileSync(requests[16].path, 'utf8')).toBe('Before');
  for (const blocked of requests.slice(0, 16)) {
    expect((await getWriteRequestById(engine, blocked.id))!).toMatchObject({ state: 'recovering', blocked_reason: 'unexpected_file_bytes' });
    expect(readFileSync(blocked.path, 'utf8')).toBe('Unexpected external bytes');
  }
  expect((await getWriteRequestById(engine, blockedFollower!))!.state).toBe('queued');
  const next = await claimNextWrite(engine, hostId);
  expect(next?.id).toBe(requests[16].id);
}), 120_000);
