/**
 * #5629 residual + #5734: `gbrain repair embedding-effects` settles stale
 * queued and failed embedding effects of committed writes, which block
 * receipt compaction and activation. Each effect ends reconciled (current
 * vectors pass the effect projection verifier), superseded (page deleted, or
 * a newer revision owns its own effect), retry_queued for its owner, or
 * blocked with a reason. An exhausted retry allowance gets one new bounded
 * cycle per explicit run under a durable authorization id; a resumed run
 * replays it instead of granting another.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { listBlockingEffects } from '../src/core/persistence/blocking-effects.ts';
import { listEmbeddingCandidates, settleEmbeddingEffect } from '../src/core/persistence/embedding-settlement.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { staleEmbeddingEffectsCheck } from '../src/commands/doctor/checks/stale-embedding-effects.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;
const model = 'openai:text-embedding-3-small';
const signature = `${model}:1536`;
const vector = () => new Float32Array(1536).fill(0.25);

for (const kind of testBackends()) {
  describe(`repair embedding-effects ${kind}`, () => {
    let engine: BrainEngine;
    let scratch: string;
    let config: GBrainConfig;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-embedding-effects-'));
      config = { engine: kind, embedding_model: model, embedding_dimensions: 1536 };
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
        const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(databaseUrl!); url.pathname = `/${database.name}`; config.database_url = url.toString();
      } else {
        config.database_path = join(scratch, 'brain');
        engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
      }
      mkdirSync(join(scratch, '.gbrain'));
      writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify(config));
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await engine?.disconnect(); if (close) await close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: () => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: scratch, GBRAIN_BRAIN_ID: 'host',
      GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_EMBEDDING_MODEL: undefined,
      GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, fn), 120_000);

    async function publish(sourceId: string, incarnation: string, body: string) {
      const authority = await submissionAuthority({ engine, config, remote: false, sourceId } as OperationContext, 'put_page', sourceId, incarnation, 'page');
      const observed = await engine.readPageSnapshot('page', { sourceId });
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, pageId: observed?.page.id ?? null,
        sourceIncarnation: incarnation, slug: 'page', requestId: randomUUID(), callerIntent: { body }, intent: { body } });
      const row = (await claimNextWrite(engine, localHostId()))!;
      await publishMutation(engine, row, { observedRevision: observed?.revision ?? null, apply: async tx => {
        await tx.putPage('page', { type: 'note', title: 'Example', compiled_truth: body }, { sourceId }); return {};
      } }, localHostId());
      const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { seal: true });
      return row;
    }

    /** A committed write whose embedding effect is stale queued (two hours old) or failed with an exhausted allowance. */
    async function fixture(state: 'stale' | 'failed' | 'exhausted') {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `emb-${randomUUID().slice(0, 16)}`;
      const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
      const row = await publish(sourceId, source.incarnation, 'Current');
      const [effect] = await engine.executeRaw<{ id: string }>(`UPDATE persistence_effects SET state=$2,attempts=$3,next_attempt_at=now()+interval '1 day',
          error_code=$4, updated_at=now()-interval '2 hours', data=CASE WHEN $5 THEN data||'{"embedding_attempt_base":5,"embedding_retry_base":5}'::jsonb ELSE data END
        WHERE request_id=$1::uuid AND kind='embedding' RETURNING id`,
      [row.id, state === 'stale' ? 'queued' : 'failed', state === 'exhausted' ? 10 : state === 'failed' ? 5 : 0,
        state === 'stale' ? null : 'embedding_attempts_exhausted', state === 'exhausted']);
      return { sourceId, incarnation: source.incarnation, row, effectId: String(effect.id) };
    }
    const effect = async (id: string) => (await engine.executeRaw<Record<string, any>>('SELECT * FROM persistence_effects WHERE id=$1', [id]))[0];
    const embedVectors = async (sourceId: string) => {
      const prepared = (await readProjectionSnapshot(engine, 'page', sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vector(), model }], signature);
    };
    const repair = async (sourceId: string, apply: boolean) => (await repairRunner(engine, { apply })).run('embedding-effects',
      { brain_id: 'host', source_ids: [sourceId] }, { sourceFlag: sourceId });
    /** One owner consumer pass over this effect only (earlier fixtures' effects are pushed out of the way). */
    const runOwner = async (effectId: string, embed: () => Promise<Float32Array[]>) => {
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 day' WHERE id<>$1 AND state IN ('queued','running')", [effectId]);
      await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model, embed } });
    };

    check('reconciled: a stale queued effect with verified vectors commits with no provider work; compaction and activation proceed', async () => {
      const f = await fixture('stale');
      await embedVectors(f.sourceId);
      expect((await staleEmbeddingEffectsCheck(engine, [f.sourceId])).details).toMatchObject({ stale_effects: 1, resolution: 'repairable',
        command: `gbrain repair embedding-effects --source ${f.sourceId}` });
      expect((await listBlockingEffects(engine, { sourceId: f.sourceId })).map(e => e.effect_id)).toEqual([f.effectId]);
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '30 days' WHERE id=$1::uuid", [f.row.id]);
      const compactedBefore = await compactWriteReceipts(engine, 0);
      expect((await engine.executeRaw<{ compacted: boolean }>('SELECT compacted FROM persistence_requests WHERE id=$1::uuid', [f.row.id]))[0].compacted).toBe(false);

      const preview = await repair(f.sourceId, false);
      expect(preview.affected).toBe(1);
      expect(await effect(f.effectId)).toMatchObject({ state: 'queued' });
      const applied = await repair(f.sourceId, true);
      expect(applied.outcomes).toEqual({ reconciled: 1 });
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'reconciled' } });
      expect((await staleEmbeddingEffectsCheck(engine, [f.sourceId])).status).toBe('ok');
      expect(await listBlockingEffects(engine, { sourceId: f.sourceId })).toEqual([]);
      expect(compactedBefore + await compactWriteReceipts(engine, 0)).toBeGreaterThan(compactedBefore);
      expect((await engine.executeRaw<{ compacted: boolean }>('SELECT compacted FROM persistence_requests WHERE id=$1::uuid', [f.row.id]))[0].compacted).toBe(true);
    });

    check('superseded: a failed effect whose page has a newer revision with its own effect settles; without one it is blocked', async () => {
      const f = await fixture('failed');
      await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1', [f.sourceId]);
      const blocked = await repair(f.sourceId, false);
      expect(blocked.affected).toBe(0);
      expect(blocked.residuals).toEqual({ blocked_no_replacement_obligation: 1 });
      const newer = await publish(f.sourceId, f.incarnation, 'Newer');
      const applied = await repair(f.sourceId, true);
      expect(applied.outcomes).toEqual({ superseded: 1 });
      const [replacement] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [newer.id]);
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'superseded', reason: 'revision_changed', replaced_by: replacement.id } });
    });

    check('retry_queued: a stale queued effect without vectors is re-queued, doctor stays pending, and the owner run settles it', async () => {
      const f = await fixture('stale');
      const applied = await repair(f.sourceId, true);
      expect(applied.outcomes).toEqual({ retry_queued: 1 });
      expect(await effect(f.effectId)).toMatchObject({ state: 'queued' });
      const pending = await staleEmbeddingEffectsCheck(engine, [f.sourceId]);
      expect(pending.status).toBe('warn');
      expect(pending.details).toMatchObject({ stale_effects: 1, retry_queued_effects: 1 });
      await runOwner(f.effectId, async () => [vector()]);
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed' });
      expect((await staleEmbeddingEffectsCheck(engine, [f.sourceId])).status).toBe('ok');
    });

    check('a signature-mismatched vector is not reconciled', async () => {
      const f = await fixture('stale');
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vector(), model: 'openai:other-model' }], 'openai:other-model:1536');
      const settled = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'queued', attempts: 0 }, { dryRun: true, config, hostId: localHostId() });
      expect(settled.outcome).not.toBe('reconciled');
      expect(settled).toMatchObject({ outcome: 'retry_queued', pending_chunks: 1 });
    });

    check('blocked: embedding disabled, embedding unconfigured, and an effect owned by another host', async () => {
      const f = await fixture('failed');
      const byConfig = async (c: GBrainConfig | null) => settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: 5 }, { dryRun: true, config: c, hostId: localHostId() });
      expect(await byConfig({ ...config, embedding_disabled: true })).toEqual({ outcome: 'blocked', reason: 'embedding_disabled' });
      expect(await byConfig({ engine: kind })).toEqual({ outcome: 'blocked', reason: 'embedding_unconfigured' });
      const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id');
      await engine.executeRaw('UPDATE persistence_effects SET worktree_id=$2::uuid WHERE id=$1', [f.effectId, worktree.id]);
      expect(await byConfig(config)).toEqual({ outcome: 'blocked', reason: 'owner_unavailable' });
      const before = await effect(f.effectId);
      expect((await repair(f.sourceId, true)).residuals).toEqual({ blocked_owner_unavailable: 1 });
      expect(await effect(f.effectId)).toEqual(before);
    });

    check('exhausted: retry-effects names the repair; one apply grants one bounded cycle and a recovered provider commits it', async () => {
      const f = await fixture('exhausted');
      const refused = await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: f.sourceId, request_id: f.row.request_id });
      expect(refused).toMatchObject({ action: 'blocked', reason: 'embedding_retry_exhausted' });
      expect(refused.next_action).toContain(`gbrain repair embedding-effects --source ${f.sourceId}`);
      const preview = await repair(f.sourceId, false);
      expect(preview.cost.embedding_pages).toBe(1);
      const applied = await repair(f.sourceId, true);
      expect(applied.outcome_items).toEqual([{ item: `${f.sourceId}:page`, outcome: 'retry_queued', reason: 'granted_new_retry_cycle' }]);
      let calls = 0;
      await runOwner(f.effectId, async () => { calls++; return [vector()]; });
      expect(calls).toBe(1);
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed', attempts: 11 });
    });

    check('a resumed run replays its grant instead of granting a second cycle', async () => {
      const f = await fixture('exhausted');
      const runId = randomUUID();
      const first = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: 10 }, { dryRun: false, config, hostId: localHostId(), runId });
      expect(first).toMatchObject({ outcome: 'retry_queued', reason: 'granted_new_retry_cycle' });
      for (let n = 0; n < 6; n++) {
        await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [f.effectId]);
        await runOwner(f.effectId, async () => { throw new Error('network timeout'); });
      }
      const failedAgain = await effect(f.effectId);
      expect(failedAgain.state).toBe('failed');
      const replayed = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: Number(failedAgain.attempts) },
        { dryRun: false, config, hostId: localHostId(), runId });
      expect(replayed).toMatchObject({ outcome: 'retry_queued', reason: 'grant_replayed' });
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed', attempts: failedAgain.attempts });
      const nextRun = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: Number(failedAgain.attempts) },
        { dryRun: false, config, hostId: localHostId(), runId: randomUUID() });
      expect(nextRun).toMatchObject({ outcome: 'retry_queued', reason: 'granted_new_retry_cycle' });
    });

    check('an interrupted repair run keeps its run id, so resuming it reuses the same authorization', async () => {
      const a = await fixture('exhausted');
      const scope = { brain_id: 'host', source_ids: [a.sourceId] };
      const runner = await repairRunner(engine, { apply: true });
      const partial = await runner.run('embedding-effects', scope, { limit: 0 });
      expect(partial.complete).toBe(false);
      const [row] = await engine.executeRaw<{ completed_keys: Array<{ run_id?: string }> }>("SELECT completed_keys FROM op_checkpoints WHERE op='repair' AND completed_keys->0->>'kind'='embedding-effects'");
      expect(typeof row.completed_keys[0].run_id).toBe('string');
      const resumed = await runner.run('embedding-effects', scope, {});
      const [after] = await engine.executeRaw<{ data: { repair_authorizations?: string[] } }>('SELECT data FROM persistence_effects WHERE id=$1', [a.effectId]);
      const { embeddingGrantId } = await import('../src/core/persistence/embedding-settlement.ts');
      expect(after.data.repair_authorizations).toEqual([embeddingGrantId(row.completed_keys[0].run_id!, a.effectId)]);
      expect(resumed.complete).toBe(true);
    });

    check('the first retry a run grants a failed effect is recorded too, so resuming that run never grants a second cycle', async () => {
      const f = await fixture('failed');
      const runId = randomUUID();
      const first = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: 5 }, { dryRun: false, config, hostId: localHostId(), runId });
      expect(first).toMatchObject({ outcome: 'retry_queued', paid: true });
      for (let n = 0; n < 6; n++) {
        await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [f.effectId]);
        await runOwner(f.effectId, async () => { throw new Error('network timeout'); });
      }
      const failedAgain = await effect(f.effectId);
      expect(failedAgain.state).toBe('failed');
      const resumed = await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: Number(failedAgain.attempts) },
        { dryRun: false, config, hostId: localHostId(), runId });
      expect(resumed).toMatchObject({ outcome: 'retry_queued', reason: 'grant_replayed' });
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed' });
    });

    check('a withdrawal-target or source-scan effect is estimated from its pages, not as free', async () => {
      const f = await fixture('exhausted');
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1', [f.sourceId]);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_effects SET data=jsonb_build_object('version',2,'targets',jsonb_build_array(jsonb_build_object('slug','page','page_id',$2::int)))
          WHERE id=$1`, [f.effectId, page.id]);
      });
      const [withTargets] = await listEmbeddingCandidates(engine, [f.sourceId]);
      expect(withTargets.chars).toBeGreaterThan(0);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb WHERE id=$1`, [f.effectId]);
      });
      const [scan] = await listEmbeddingCandidates(engine, [f.sourceId]);
      expect(scan.chars).toBeGreaterThan(0);
    });

    check('a --limit run resumes after the last settled effect instead of reprocessing the first', async () => {
      const a = await fixture('stale');
      const b = await fixture('stale');
      const runner = await repairRunner(engine, { apply: true });
      const scope = { brain_id: 'host', source_ids: [a.sourceId, b.sourceId] };
      const first = await runner.run('embedding-effects', scope, { limit: 1 });
      const next = await runner.run('embedding-effects', scope, { limit: 1 });
      expect(next.resumed_from).not.toBeNull();
      expect([first.outcome_items![0].item, next.outcome_items![0].item].sort()).toEqual([`${a.sourceId}:page`, `${b.sourceId}:page`].sort());
    });

    check('an effect whose source was removed is superseded, and the brain-wide repair reaches it', async () => {
      const f = await fixture('stale');
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.sourceId]);
      const candidates = await listEmbeddingCandidates(engine, []);
      expect(candidates.map(c => c.effect_id)).toContain(f.effectId);
      expect(await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'queued', attempts: 0 }, { dryRun: false, config, hostId: localHostId() }))
        .toEqual({ outcome: 'superseded', reason: 'source_removed' });
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'superseded', reason: 'source_removed' } });
    });

    check('a withdrawal-target effect with pages left is blocked without an embedding model, never dropped', async () => {
      const f = await fixture('failed');
      const snapshot = (await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!;
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_effects SET data=jsonb_build_object('version',2,'targets',
          jsonb_build_array(jsonb_build_object('slug','page','page_id',$2::int,'revision',$3::text))) WHERE id=$1`, [f.effectId, snapshot.page.id, snapshot.revision]);
      });
      expect(await settleEmbeddingEffect(engine, { effect_id: f.effectId, state: 'failed', attempts: 5 }, { dryRun: false, config: { engine: kind }, hostId: localHostId(), runId: randomUUID() }))
        .toEqual({ outcome: 'blocked', reason: 'embedding_unconfigured' });
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed' });
    });
  });
}
