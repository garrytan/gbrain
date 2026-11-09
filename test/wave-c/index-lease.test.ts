/**
 * Wave C 1I-a (spec §3.6, unsplit): the per-page index lease. While one index job holds a live claim on a page, no worker
 * claims another index job for that page (an append's newer commit queues its own job behind it); once the holder ends,
 * the next one is claimable. A running job renews its claim, so a long import keeps the lease instead of letting a second
 * worker stage the same page.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { claimPersistenceEffect, effectClaimWork } from '../../src/core/persistence/effect-journal.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { _indexLeaseTiming, indexSplitPage } from '../../src/core/persistence/index-split-page.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const indexEffects = (engine: BrainEngine, slug: string) => engine.executeRaw<PersistenceEffect & { request_state: string }>(
  `SELECT e.*, r.state AS request_state FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.kind = 'index-split-page' AND e.data->>'slug' = $1 ORDER BY e.id`, [slug]);
const requestOf = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ state: string; outcome: Record<string, any> }>(
  'SELECT state, outcome FROM persistence_requests WHERE id = $1::uuid', [id]))[0]!;
/** Claims until nothing is claimable (other kinds included), returning the ids claimed. */
const claimAll = async (engine: BrainEngine) => {
  const claimed: PersistenceEffect[] = [];
  for (let i = 0; i < 50; i++) {
    const next = await claimPersistenceEffect(engine, localHostId());
    if (!next) break;
    claimed.push(next);
  }
  return claimed;
};
/** Effect rows change only under the persistence protocol declaration. */
const setEffect = (engine: BrainEngine, sql: string, params: unknown[]) => engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
const paused = { run: async () => { throw new Error('paused'); } };

for (const backend of testBackends()) describe(`[${backend}] the per-page index lease (1I-a)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const renewMs = _indexLeaseTiming.renewMs;
  beforeEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });
  afterEach(() => { _indexLeaseTiming.renewMs = renewMs; _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a live index job on a page keeps a second job for the same page unclaimed until it ends', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    registerIndexSplitPageConsumer(paused);
    const slug = 'notes/leased';
    const first = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERLEASEFIRST'), 'put');
    expect(first.state).toBe('indexing');
    await op('append_page').handler(ctx, { slug, text: '\nMARKERLEASEAPPEND line.\n', request_id: randomUUID(), wait_ms: 3_000 }).catch(() => undefined);
    const [e1, e2] = await indexEffects(engine, slug);
    expect(e1?.request_id).toBe(first.id);
    expect(e2?.request_state).toBe('indexing');
    await setEffect(engine, `UPDATE persistence_effects SET state = 'running', execution_token = $2::uuid, claim_expires_at = now() + interval '2 minutes', next_attempt_at = now()
      WHERE id = $1`, [e1!.id, randomUUID()]);
    await setEffect(engine, "UPDATE persistence_effects SET state = 'queued', execution_token = NULL, claim_expires_at = NULL, next_attempt_at = now() - interval '1 second' WHERE id = $1", [e2!.id]);
    const before = (await indexEffects(engine, slug))[1]!.attempts;

    const claimed = await claimAll(engine);
    expect(claimed.map(e => e.id)).not.toContain(e2!.id);
    const [, held] = await indexEffects(engine, slug);
    expect(held!.state).toBe('queued');
    expect(held!.attempts).toBe(before);

    await setEffect(engine, "UPDATE persistence_effects SET state = 'committed', execution_token = NULL, claim_expires_at = NULL WHERE id = $1", [e1!.id]);
    expect((await claimAll(engine)).map(e => e.id)).toContain(e2!.id);
  }, { databaseUrl, setup }), 240_000);

  test('a running index job renews its claim and flips the page', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    registerIndexSplitPageConsumer(paused);
    const slug = 'notes/renewed';
    const row = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERRENEWED'), 'put');
    expect(row.state).toBe('indexing');
    const [effect] = await indexEffects(engine, slug);
    await setEffect(engine, "UPDATE persistence_effects SET state = 'queued', execution_token = NULL, claim_expires_at = NULL, next_attempt_at = now() - interval '1 second' WHERE id = $1", [effect!.id]);
    _resetIndexSplitPageConsumerForTests();
    registerIndexSplitPageConsumer(paused);
    const claimed = (await claimAll(engine)).find(e => e.id === effect!.id);
    expect(claimed).toBeDefined();
    _indexLeaseTiming.renewMs = 1;
    const renewals = effectClaimWork['index-split-page'] ?? 0;
    await indexSplitPage.run(engine, { engine: engine.kind } as never, claimed!, localHostId());
    expect(effectClaimWork['index-split-page'] ?? 0).toBeGreaterThan(renewals);
    const done = await requestOf(engine, row.id);
    expect(done.state).toBe('committed');
    expect(done.outcome.index).toMatchObject({ state: 'indexed' });
    expect((await indexEffects(engine, slug))[0]!.state).toBe('committed');
  }, { databaseUrl, setup }), 240_000);
});
