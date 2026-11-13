/**
 * #7774: a deleted page's fence hold (`no_proof`: its rows were not proven to come from a fence) used to survive the
 * page's purge. The purge deletes every fact row filed on the page and its takes, so the held retirement has nothing
 * left to act on, yet doctor `generation_held` kept warning with no reachable remedy. A purge now drops the fence holds
 * keyed to the purged page; a hold on a page that still exists (deleted, not purged) stays.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { FACT_FENCE_KIND, publishFenceGeneration } from '../src/core/generations/fence.ts';
import { generationHeldCheck } from '../src/commands/doctor/checks/generations.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const held = (engine: BrainEngine) => engine.executeRaw<{ owner_key: string; held_reason: string }>(
  "SELECT owner_key, held_reason FROM derived_generations WHERE source_id='default' AND state='held' ORDER BY owner_key");

async function deletedWithHold(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<void> {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: 'default', request_id: randomUUID(),
    content: '---\ntype: note\ntitle: Example\n---\nA synthetic page.\n' } });
  const live = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, source_id: 'default', request_id: randomUUID(), expected_revision: live!.revision } });
  const outcome = await engine.transaction(tx => publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId: 'default', slug, read: { state: 'absent' },
    items: [], originGone: true, retire: [{ key: `${slug}#1`, identityHash: 'synthetic' }] as never, writer: 'deleted_page' }));
  expect(outcome).toMatchObject({ state: 'held', reason: 'no_proof' });
}

test('purging a deleted page drops its fence hold; a hold on a page not purged stays', () => managedBrain(async ({ engine, ctx }) => {
  await deletedWithHold(engine, ctx, 'notes/alpha-example');
  await deletedWithHold(engine, ctx, 'notes/beta-example');
  expect(await held(engine)).toEqual([{ owner_key: 'page:notes/alpha-example', held_reason: 'no_proof' }, { owner_key: 'page:notes/beta-example', held_reason: 'no_proof' }]);

  const snapshot = await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default', includeDeleted: true });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/alpha-example', source_id: 'default', purge: true,
    request_id: randomUUID(), expected_revision: snapshot!.revision } });
  expect(await engine.readPageSnapshot('notes/alpha-example', { sourceId: 'default', includeDeleted: true })).toBeNull();

  expect(await held(engine)).toEqual([{ owner_key: 'page:notes/beta-example', held_reason: 'no_proof' }]);
  const check = await generationHeldCheck(engine);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('default/fact_fence no_proof: 1');
}), 120_000);
