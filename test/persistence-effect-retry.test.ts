import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId, readLocalWriter, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { persistenceSocketPathForConfig, requestPersistenceAdministration, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;
const model = 'openai:text-embedding-3-small';
const signature = `${model}:1536`;
for (const kind of testBackends()) {
  describe(`effect retry ${kind}`, () => {
    let engine: BrainEngine;
    let scratch: string;
    let config: GBrainConfig;
    let close: (() => Promise<void>) | undefined;
    let reopen: () => Promise<void>;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-effect-retry-'));
      config = { engine: kind, embedding_model: model, embedding_dimensions: 1536 };
      reopen = async () => { engine = new PGLiteEngine(); await engine.connect(config); };
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
    async function fixture(failed = true) {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `retry-${randomUUID().slice(0, 16)}`;
      const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
      const authority = await submissionAuthority({ engine, config, remote: false, sourceId } as OperationContext, 'put_page', sourceId, source.incarnation, 'page');
      const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: source.incarnation, slug: 'page', requestId: randomUUID(), callerIntent: { body: 'Current' }, intent: { body: 'Current' } });
      const row = (await claimNextWrite(engine, localHostId()))!;
      expect(row.id).toBe(admitted.id);
      await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage('page', { type: 'note', title: 'Example', compiled_truth: 'Current' }, { sourceId }); return {};
      } }, localHostId());
      const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current' }], { seal: true });
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      const [effect] = await engine.executeRaw<{ id: string }>(`UPDATE persistence_effects SET state=$2,attempts=$3,next_attempt_at=now(),error_code=$4
        WHERE request_id=$1::uuid AND kind='embedding' RETURNING id`, [row.id, failed ? 'failed' : 'queued', failed ? 5 : 0, failed ? 'embedding_attempts_exhausted' : null]);
      return { sourceId, row, effectId: effect.id };
    }
    const retry = (f: Awaited<ReturnType<typeof fixture>>, dryRun = false) => runPersistenceAdministration(engine, 'writer_retry_effects',
      { source_id: f.sourceId, request_id: f.row.request_id, dry_run: dryRun });
    const effect = async (id: string) => (await engine.executeRaw('SELECT * FROM persistence_effects WHERE id=$1', [id]))[0];
    async function cli(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = [], expectedCode = 0) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'sources', 'writer', 'retry-effects', f.sourceId,
        '--request-id', f.row.request_id, '--json', ...flags], { cwd: scratch, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toMatchObject({ code: expectedCode });
      return JSON.parse(stdout);
    }

    check('dry-run is read-only; explicit retry is bounded, duplicate-safe, and retains lifetime attempts', async () => {
      const f = await fixture();
      const before = await effect(f.effectId);
      expect(await retry(f, true)).toMatchObject({ action: 'would_retry', state: 'failed', attempts: 5 });
      expect(await effect(f.effectId)).toEqual(before);
      const approved = await Promise.all([retry(f), retry(f)]);
      expect(approved.map(result => result.action).sort()).toEqual(['retry_queued', 'unchanged']);
      expect(approved.every(result => result.state === 'queued' && result.attempts === 5)).toBe(true);
      let calls = 0;
      for (let n = 0; n < 5; n++) {
        await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [f.effectId]);
        await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model,
          embed: async () => { calls++; throw new Error('network timeout'); } } });
      }
      expect(calls).toBe(5);
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed', attempts: 10 });
      expect(await retry(f)).toMatchObject({ action: 'blocked', reason: 'embedding_retry_exhausted', attempts: 10 });
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed', attempts: 10 });
    });

    check('successful explicit retry installs once while lifetime attempts and canonical receipt remain intact', async () => {
      const f = await fixture();
      expect(await retry(f)).toMatchObject({ action: 'retry_queued' });
      let calls = 0;
      const options = { hostId: localHostId(), limit: 1, embedding: { signature, model,
        embed: async () => { calls++; return [new Float32Array(1536).fill(0.25)]; } } };
      await runPersistenceEffects(engine, config, options);
      expect(await effect(f.effectId)).toMatchObject({ state: 'committed', attempts: 6 });
      expect(await retry(f)).toMatchObject({ action: 'unchanged', state: 'committed', attempts: 6 });
      await runPersistenceEffects(engine, config, options);
      expect(calls).toBe(1);
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [f.row.id]))[0].state).toBe('committed');
    });

    check('reconciliation uses existing vectors without reopening provider work or changing canonical data', async () => {
      const f = await fixture();
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current',
        embedding: new Float32Array(1536).fill(0.25), model }], signature);
      expect(await retry(f, true)).toMatchObject({ action: 'would_reconcile', state: 'failed' });
      expect(await retry(f)).toMatchObject({ action: 'reconciled', state: 'committed', attempts: 5 });
      let calls = 0;
      await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model,
        embed: async () => { calls++; return []; } } });
      expect(calls).toBe(0);
      expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.revision).toBe(prepared.snapshot.revision);
    });

    check('wrong source, replaced source, active claim, and superseded revision refuse retry', async () => {
      const f = await fixture();
      await expect(runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: 'other', request_id: f.row.request_id })).rejects.toMatchObject({ code: 'invalid_params' });
      await engine.executeRaw('UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [f.effectId, randomUUID()]);
      await expect(retry(f)).rejects.toMatchObject({ code: 'source_changed' });
      const active = await fixture(false);
      await expect(retry(active)).rejects.toMatchObject({ code: 'effect_not_failed' });
      await engine.executeRaw("UPDATE persistence_effects SET state='failed',execution_token=$2::uuid WHERE id=$1", [active.effectId, randomUUID()]);
      await expect(retry(active)).rejects.toMatchObject({ code: 'write_claim_lost' });
      const stale = await fixture();
      await engine.putPage('page', { type: 'note', title: 'New revision', compiled_truth: 'Changed' }, { sourceId: stale.sourceId });
      await expect(retry(stale)).rejects.toMatchObject({ code: 'revision_conflict' });
    });

    check('disabled embeddings and revoked original grants cannot authorize paid retry', async () => {
      const f = await fixture();
      writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify({ ...config, embedding_disabled: true }));
      try { expect(await retry(f)).toMatchObject({ action: 'blocked', reason: 'embedding_disabled', state: 'failed' }); }
      finally { writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify(config)); }
      expect(await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: f.sourceId, request_id: f.row.request_id },
        { ...config, embedding_disabled: true })).toMatchObject({ action: 'blocked', reason: 'embedding_disabled' });
      expect(await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: f.sourceId, request_id: f.row.request_id },
        { engine: engine.kind })).toMatchObject({ action: 'blocked', reason: 'embedding_unconfigured' });
      await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [f.row.principal_id]);
      try { await expect(retry(f)).rejects.toMatchObject({ code: 'permission_denied' }); }
      finally { await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=$1::uuid', [f.row.principal_id]); }
    });

    check('an exhausted source cursor reconciles without configuring or calling a provider', async () => {
      const f = await fixture();
      await engine.executeRaw("UPDATE persistence_effects SET data=data||'{\"source_scan\":true,\"after_slug\":\"zzzz\"}'::jsonb WHERE id=$1", [f.effectId]);
      expect(await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: f.sourceId, request_id: f.row.request_id },
        { engine: engine.kind })).toMatchObject({ action: 'reconciled', state: 'committed', attempts: 5 });
    });

    check('selected DB disable blocks preview and approval with an enabled file but permits free reconciliation', async () => {
      const f = await fixture();
      const before = await effect(f.effectId);
      await engine.setConfig('embedding_disabled', 'true');
      try {
        expect(await retry(f, true)).toMatchObject({ action: 'blocked', reason: 'embedding_disabled' });
        expect(await retry(f)).toMatchObject({ action: 'blocked', reason: 'embedding_disabled' });
        expect(await effect(f.effectId)).toEqual(before);
        const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
        await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current',
          embedding: new Float32Array(1536).fill(0.25), model }], signature);
        expect(await retry(f)).toMatchObject({ action: 'reconciled', attempts: 5 });
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    check('DB disable after approval prevents the worker from invoking a provider', async () => {
      const f = await fixture();
      expect(await retry(f)).toMatchObject({ action: 'retry_queued' });
      await engine.setConfig('embedding_disabled', 'true');
      let calls = 0;
      try {
        await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model,
          embed: async () => { calls++; return [new Float32Array(1536).fill(0.25)]; } } });
        expect(calls).toBe(0);
        expect(await effect(f.effectId)).toMatchObject({ state: 'committed', outcome: { embedding: 'skipped', reason: 'embedding_disabled' } });
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    check('invalid DB embedding policy fails closed without changing the failed obligation', async () => {
      const f = await fixture();
      const before = await effect(f.effectId);
      await engine.setConfig('embedding_disabled', 'not-a-boolean');
      try {
        await expect(retry(f)).rejects.toMatchObject({ code: 'embedding_configuration' });
        expect(await effect(f.effectId)).toEqual(before);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    check('source-scan progress cannot renew the explicit retry allowance', async () => {
      const f = await fixture();
      for (let n = 1; n <= 5; n++) {
        const slug = `z-${n}`;
        await engine.putPage(slug, { type: 'note', title: 'Example', compiled_truth: 'Current' }, { sourceId: f.sourceId });
        const prepared = (await readProjectionSnapshot(engine, slug, f.sourceId, { allowUnsealed: true }))!;
        await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current' }], { seal: true });
      }
      await engine.executeRaw("UPDATE persistence_effects SET data=data||'{\"source_scan\":true}'::jsonb WHERE id=$1", [f.effectId]);
      expect(await retry(f)).toMatchObject({ action: 'retry_queued' });
      let calls = 0;
      for (let n = 0; n < 6; n++) await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1,
        embedding: { signature, model, embed: async () => { calls++; return [new Float32Array(1536).fill(0.25)]; } } });
      expect(calls).toBe(5);
      expect(await effect(f.effectId)).toMatchObject({ state: 'failed', error_code: 'embedding_attempts_exhausted', attempts: 11 });
      expect(await retry(f)).toMatchObject({ action: 'blocked', reason: 'embedding_retry_exhausted' });
    });

    check('actual direct CLI previews and queues only its exact request', async () => {
      const f = await fixture();
      const unrelated = await fixture();
      if (kind === 'pglite') await engine.disconnect();
      try {
        expect(await cli(f, ['--dry-run'])).toMatchObject({ action: 'would_retry', attempts: 5 });
        expect(await cli(f)).toMatchObject({ action: 'retry_queued', attempts: 5 });
        expect(await cli(f)).toMatchObject({ action: 'unchanged', attempts: 5 });
      } finally {
        if (kind === 'pglite') await reopen();
      }
      expect(await effect(unrelated.effectId)).toMatchObject({ state: 'failed', attempts: 5 });
    });

    check('actual mounted CLI reconciles selected provenance and approves only one policy-bound retry', async () => {
      const complete = await fixture();
      const pending = await fixture();
      const bounded = await fixture();
      const activeColumn = await fixture();
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', '1536');
      const prepared = (await readProjectionSnapshot(engine, 'page', complete.sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current',
        embedding: new Float32Array(1536).fill(0.25), model }], signature);
      const mountsPath = join(scratch, '.gbrain', 'mounts.json');
      writeFileSync(mountsPath, JSON.stringify({ version: 1, mounts: [{ id: 'selected', alias: 'selected-alias', path: scratch,
        engine: kind, database_url: config.database_url, database_path: config.database_path }] }));
      writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(scratch, 'unopened-host'),
        embedding_model: 'host:must-not-be-used', embedding_dimensions: 19, embedding_disabled: true }));
      const mounted = async (f: Awaited<ReturnType<typeof fixture>>, flags: string[] = [], expectedCode = 0) => {
        if (kind === 'pglite') await engine.disconnect();
        try { return await withEnv({ GBRAIN_MOUNTS_PATH: mountsPath }, () => cli(f, ['--brain', 'selected-alias', ...flags], expectedCode)); }
        finally { if (kind === 'pglite') await reopen(); }
      };
      try {
        await engine.setConfig('embedding_disabled', 'true');
        expect(await mounted(complete, ['--dry-run'])).toMatchObject({ action: 'would_reconcile' });
        expect(await mounted(complete)).toMatchObject({ action: 'reconciled', attempts: 5 });
        expect(await mounted(pending)).toMatchObject({ action: 'blocked', reason: 'embedding_disabled' });
        await engine.setConfig('embedding_disabled', 'false');
        await engine.executeRaw("UPDATE persistence_requests SET authority=jsonb_set(authority,'{scopes}','[\"read\"]'::jsonb) WHERE id=$1::uuid", [pending.row.id]);
        expect(await mounted(pending, [], 1)).toMatchObject({ error: 'permission_denied' });
        await engine.executeRaw('UPDATE persistence_requests SET authority=$2::text::jsonb WHERE id=$1::uuid', [pending.row.id, JSON.stringify(pending.row.authority)]);
        await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[\"read\"]'::jsonb) WHERE id=$1::uuid", [pending.row.principal_id]);
        expect(await mounted(pending, [], 1)).toMatchObject({ error: 'permission_denied' });
        await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[\"read\",\"write\"]'::jsonb) WHERE id=$1::uuid", [pending.row.principal_id]);
        expect(await mounted(pending, ['--dry-run'])).toMatchObject({ action: 'would_retry', attempts: 5,
          embedding_policy: { approval: 'selected_database_provenance', execution: 'owner_file_and_database' } });
        expect(await mounted(pending)).toMatchObject({ action: 'retry_queued', attempts: 5 });
        expect(await mounted(pending)).toMatchObject({ action: 'unchanged', attempts: 5 });
        let calls = 0;
        await runPersistenceEffects(engine, { ...config, embedding_disabled: true }, { hostId: localHostId(), limit: 1,
          embedding: { signature, model, embed: async () => { calls++; return []; } } });
        expect(calls).toBe(0);
        expect(await effect(pending.effectId)).toMatchObject({ state: 'committed', attempts: 6, outcome: { reason: 'embedding_disabled' } });
        await engine.setConfig('embedding_dimensions', '17');
        expect(await mounted(bounded, [], 1)).toMatchObject({ error: 'embedding_configuration' });
        await engine.setConfig('embedding_dimensions', '1536');
        await engine.executeRaw("DELETE FROM config WHERE key='embedding_model'");
        expect(await mounted(bounded, [], 1)).toMatchObject({ error: 'embedding_unconfigured' });
        await engine.setConfig('embedding_model', model);
        await engine.setConfig('embedding_columns', '{invalid');
        expect(await mounted(bounded, [], 1)).toMatchObject({ error: 'embedding_configuration' });
        await engine.executeRaw("DELETE FROM config WHERE key='embedding_columns'");
        expect(await mounted(bounded)).toMatchObject({ action: 'retry_queued', attempts: 5 });
        for (let n = 0; n < 5; n++) {
          await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [bounded.effectId]);
          await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model,
            embed: async () => { calls++; throw new Error('temporary network timeout'); } } });
        }
        expect(calls).toBe(5);
        expect(await effect(bounded.effectId)).toMatchObject({ state: 'failed', attempts: 10 });
        expect(await mounted(bounded)).toMatchObject({ action: 'blocked', reason: 'embedding_retry_exhausted' });
        await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_retry_test vector(1536)');
        await engine.setConfig('search_embedding_column', 'embedding_retry_test');
        await engine.setConfig('embedding_columns', JSON.stringify({ embedding_retry_test: { type: 'vector', dimensions: 1536, provider: model } }));
        await engine.setConfig('embedding_model', 'legacy:not-the-active-model');
        await engine.setConfig('embedding_dimensions', '19');
        const active = (await readProjectionSnapshot(engine, 'page', activeColumn.sourceId))!;
        await installPageEmbeddings(engine, active, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current',
          embedding: new Float32Array(1536).fill(0.25), model }], signature);
        expect(await mounted(activeColumn)).toMatchObject({ action: 'reconciled', attempts: 5 });
      } finally {
        writeFileSync(join(scratch, '.gbrain', 'config.json'), JSON.stringify(config));
        await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled','embedding_columns','search_embedding_column')");
        await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_retry_test');
        await engine.executeRaw('UPDATE persistence_requests SET authority=$2::text::jsonb WHERE id=$1::uuid', [pending.row.id, JSON.stringify(pending.row.authority)]);
        await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[\"read\",\"write\"]'::jsonb) WHERE id=$1::uuid", [pending.row.principal_id]);
      }
    });

    if (kind === 'pglite') check('actual resident CLI delegates retry while stdio and forged administration remain rejected', async () => {
      const f = await fixture();
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current',
        embedding: new Float32Array(1536).fill(0.25), model }], signature);
      if (kind === 'pglite') {
        const metadata = join(config.database_path!, '.gbrain-lock', 'lock');
        writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, 'utf8')), subcommand: 'serve' }));
      }
      const provider = await createPersistenceIpcProvider(engine, { ...config, embedding_disabled: true });
      const socket = persistenceSocketPathForConfig(config)!;
      let administered = 0;
      const binding = (await startPersistenceIpcServer(socket, { ...provider, administer: request => {
        administered++; return provider.administer!(request);
      } }))!;
      try {
        expect(await cli(f, ['--dry-run'])).toMatchObject({ action: 'would_reconcile', attempts: 5 });
        expect(await cli(f)).toMatchObject({ action: 'reconciled', attempts: 5 });
        expect(administered).toBe(2);
        const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
        const stdio = await readLocalWriter(engine, 'stdio');
        await expect(requestPersistenceAdministration(binding.socketPath, { version: 1, kind: 'administration', brain_id: brain.brain_id,
          registration: stdio, operation: 'writer_retry_effects', params: { source_id: f.sourceId, request_id: f.row.request_id } })).rejects.toMatchObject({ code: 'invalid_params' });
        const registration = await readLocalWriter(engine, 'cli');
        await expect(requestPersistenceAdministration(binding.socketPath, { version: 1, kind: 'administration', brain_id: brain.brain_id,
          registration, operation: 'writer_retry_effects', params: { source_id: f.sourceId, request_id: f.row.request_id, remote: false } })).rejects.toMatchObject({ code: 'invalid_params' });
      } finally {
        const closed = once(binding.server, 'close'); binding.close(); await closed;
        await disposePersistenceConsumer(engine);
      }
    });
  });
}
