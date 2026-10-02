/**
 * #5455 on Postgres: an admission racing `sources writer deactivate` — exactly
 * one wins. Deactivate locks worktrees then sources FOR UPDATE (the order
 * admission uses) before it rechecks quiescence inside its transaction.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { deactivatePersistence } from '../../src/core/persistence/deactivation.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { hasDatabase } from './helpers.ts';
import { managedBrain } from '../helpers/managed-brain.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

async function admission(engine: BrainEngine, ctx: OperationContext) {
  const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, 'notes/race');
  return (target: BrainEngine) => admitWrite(target, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: binding.source_incarnation, slug: 'notes/race', requestId: randomUUID(), callerIntent: { body: 'x' }, intent: { body: 'x' },
    worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
}

describeE2E('deactivate x admission race (Postgres)', () => {
  test('deactivate holding its locks wins; the admission then fails', () => managedBrain(async ({ engine, ctx }) => {
    const admit = await admission(engine, ctx);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const atLocks = new Promise<void>(resolve => { reached = resolve; });
    const deactivating = deactivatePersistence(engine, { expectedState: await writerAdminState(engine), hooks: { afterLocks: async () => { reached(); await paused; } } });
    await atLocks;
    const admitting = admit(engine).then(() => 'admitted', (error: { code?: string }) => error.code);
    await new Promise(resolve => setTimeout(resolve, 300));
    release();
    expect((await deactivating).deactivated).toBe(true);
    expect(await admitting).toBe('source_changed');
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE slug='notes/race'")).toEqual([]);
  }, { databaseUrl: process.env.DATABASE_URL }), 120_000);

  test('an admission holding its worktree lock wins; deactivate then refuses as not quiesced', () => managedBrain(async ({ engine, ctx }) => {
    const admit = await admission(engine, ctx);
    const expectedState = await writerAdminState(engine);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let admitted!: () => void;
    const inside = new Promise<void>(resolve => { admitted = resolve; });
    const admitting = engine.transaction(async tx => { await admit(tx); admitted(); await paused; });
    await inside;
    const deactivating = deactivatePersistence(engine, { expectedState }).then(() => 'deactivated', (error: { code?: string }) => error.code);
    await new Promise(resolve => setTimeout(resolve, 300));
    release();
    await admitting;
    expect(await deactivating).toBe('writer_not_quiesced');
    expect((await runPersistenceAdministration(engine, 'writer_status', {}) as { mode: string }).mode).toBe('managed');
  }, { databaseUrl: process.env.DATABASE_URL }), 120_000);
});
