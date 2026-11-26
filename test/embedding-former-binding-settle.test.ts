/**
 * A failed embedding effect recorded under a worktree that writer deactivate retired has an exit once the source is
 * re-bound to this host: when the page is at a later revision with verified current vectors, repair settles it as
 * superseded instead of blocking it as owner_unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { settleEmbeddingEffect } from '../src/core/persistence/embedding-settlement.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
const signature = `${model}:1536`;

describe('embedding effect of a retired worktree', () => {
  let engine: BrainEngine;
  let scratch: string;
  let config: GBrainConfig;
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-former-binding-'));
    config = { engine: 'pglite', embedding_model: model, embedding_dimensions: 1536, database_path: join(scratch, 'brain') };
    engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine?.disconnect();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test('a later revision with verified vectors settles the failed effect as superseded', () => withEnv({ GBRAIN_HOME: scratch, GBRAIN_BRAIN_ID: 'host',
    GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    await registerLocalWriter(engine, 'cli');
    const hostId = localHostId();
    const sourceId = `emb-${randomUUID().slice(0, 16)}`;
    const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
    const authority = await submissionAuthority({ engine, config, remote: false, sourceId } as OperationContext, 'put_page', sourceId, source.incarnation, 'page');
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, pageId: null,
      sourceIncarnation: source.incarnation, slug: 'page', requestId: randomUUID(), callerIntent: { body: 'Old' }, intent: { body: 'Old' } });
    const row = (await claimNextWrite(engine, hostId))!;
    await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
      await tx.putPage('page', { type: 'note', title: 'Example', compiled_truth: 'Old' }, { sourceId }); return {};
    } }, hostId);
    // The effect failed under worktree W1, which deactivate retired; W2 is this host's current binding.
    const [w1] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,state) VALUES($1::uuid,'retired') RETURNING id", [hostId]);
    const [w2] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id,owner_epoch) VALUES($1::uuid,2) RETURNING id', [hostId]);
    await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [sourceId, source.incarnation, w2.id]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)',
      [w2.id, hostId, join(scratch, 'w2'), join(scratch, 'c2')]);
    const [effect] = await engine.executeRaw<{ id: string }>(`UPDATE persistence_effects SET state='failed',attempts=5,error_code='embedding_attempts_exhausted',
      worktree_id=$2::uuid WHERE request_id=$1::uuid AND kind='embedding' RETURNING id`, [row.id, w1.id]);
    // The page moved on to a later revision with verified current vectors.
    await engine.putPage('page', { type: 'note', title: 'Changed', compiled_truth: 'New' }, { sourceId });
    const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
    await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'New' }], { seal: true });
    const sealed = (await readProjectionSnapshot(engine, 'page', sourceId))!;
    await installPageEmbeddings(engine, sealed, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'New', embedding: new Float32Array(1536).fill(0.25), model }], signature);
    const settled = await settleEmbeddingEffect(engine, { effect_id: String(effect.id), state: 'failed', attempts: 5 }, { dryRun: true, config, hostId });
    expect(settled.outcome).toBe('superseded');
  }), 120_000);
});
