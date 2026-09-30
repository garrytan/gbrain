import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let ctx: OperationContext;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  ctx = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

const call = (name: string, params: Record<string, unknown>, context = ctx) => operations.find(op => op.name === name)!.handler(context, params);

test('owner policy operation returns the real CAS epoch and preserves an explicit policy on stale edits', async () => {
  const before = await call('get_skill_policy', { source_id: 'default' }) as { policy_epoch: string };
  const policy = { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: false };
  const changed = await call('set_skill_policy', { source_id: 'default', expected_policy_epoch: before.policy_epoch, policy }) as { policy_epoch: string };
  expect(changed.policy_epoch).not.toBe(before.policy_epoch);
  const after = await call('get_skill_policy', { source_id: 'default' }) as { policy_epoch: string };
  expect(after.policy_epoch).toBe(changed.policy_epoch);
  await expect(call('set_skill_policy', { source_id: 'default', expected_policy_epoch: before.policy_epoch, policy }))
    .rejects.toMatchObject({ code: 'revision_conflict' });
});

test('retention operations expose real bounded state locally and independently deny remote callers', async () => {
  const state = await call('get_skill_retention', { source_id: 'default' }) as { retained_revisions: number };
  expect(state.retained_revisions).toBe(0);
  const pruned = await call('prune_skill_revisions', { source_id: 'default' }) as { pruned_revisions: number };
  expect(pruned.pruned_revisions).toBe(0);
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const pin = { source_id: 'default', source_incarnation: source.incarnation, pack_id: 'fixture-pack', name: 'fixture-skill', revision: randomUUID(), hours: 1 };
  await expect(call('retain_skill_revision', pin)).rejects.toMatchObject({ code: 'revision_unavailable' });
  for (const name of ['get_skill_retention', 'prune_skill_revisions', 'retain_skill_revision', 'import_skill_proposal']) {
    expect(operations.find(op => op.name === name)?.localOnly).toBe(true);
    await expect(call(name, pin, { ...ctx, remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
  }
});
