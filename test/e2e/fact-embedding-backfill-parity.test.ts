import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { embedStaleFacts } from '../../src/core/embed-facts.ts';
import { runEmbed } from '../../src/commands/embed.ts';
import { saveConfig, loadConfig } from '../../src/core/config.ts';
import { AUDIT_ROW_SOURCES } from '../../src/core/facts/audit-sources.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
const sourceId = 'fact-backfill-example';
const neighbor = 'fact-backfill-neighbor';
const approved = { sourceId, yes: true, maxCostUsd: 1 };

for (const kind of ['pglite', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !databaseUrl)(`${kind} explicit fact embedding backfill`, () => {
    let engine: BrainEngine;
    let calls: string[][];
    const originalConfig = loadConfig() ?? { engine: 'pglite' as const };
    let databasePath: string;

    beforeAll(async () => {
      engine = kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(databaseUrl!);
      databasePath = mkdtempSync(join(tmpdir(), 'fact-backfill-parity-'));
      await engine.connect(kind === 'pglite' ? { database_path: join(databasePath, 'db') } : { database_url: databaseUrl! });
      await engine.initSchema();
      for (const id of [sourceId, neighbor]) {
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING', [id]);
      }
    });

    beforeEach(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-key' } });
      saveConfig({ ...originalConfig, embedding_disabled: false });
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
      await engine.setConfig('embedding_dimensions', '1536');
      await engine.setConfig('embedding_disabled', 'false');
      await engine.executeRaw('DELETE FROM facts WHERE source_id=ANY($1::text[])', [[sourceId, neighbor]]);
      await engine.executeRaw('DELETE FROM fact_withdrawals WHERE source_id=$1', [sourceId]);
      calls = [];
      __setEmbedTransportForTests(async ({ values }) => {
        calls.push([...values]);
        return { values, usage: { tokens: values.length }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
      });
    });

    afterEach(async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      saveConfig({ ...originalConfig, embedding_disabled: false });
      __setEmbedTransportForTests(null);
      resetGateway();
    });

    afterAll(async () => {
      await engine.executeRaw('DELETE FROM sources WHERE id=ANY($1::text[])', [[sourceId, neighbor]]);
      await engine.disconnect();
      rmSync(databasePath, { recursive: true, force: true });
      saveConfig(originalConfig ?? {});
    });

    async function seed(fact: string, extra: Partial<NewFact> = {}, source = sourceId) {
      const inserted = await engine.insertFact({
        fact, kind: 'fact', confidence: 1, source: 'notes', visibility: 'world', notability: 'medium', ...extra,
      }, { source_id: source });
      if (extra.expired_at) await engine.expireFact(inserted.id, { at: extra.expired_at });
    }

    async function state() {
      return Array.from(await engine.executeRaw(
        'SELECT id::text, fact, embedding::text, visibility, expired_at::text FROM facts WHERE source_id=ANY($1::text[]) ORDER BY id', [[sourceId, neighbor]]));
    }

    test('preview is read-only and scoped; null active facts only, with zero provider calls', async () => {
      await seed('pending');
      await seed('private pending', { visibility: 'private' });
      await seed('expired', { expired_at: new Date('2020-01-01') });
      await seed('already embedded', { embedding: new Float32Array(1536).fill(0.5) });
      await seed('audit', { source: AUDIT_ROW_SOURCES[0] });
      await seed('neighbor pending', {}, neighbor);
      const before = await state();
      const result = await embedStaleFacts(engine, { sourceId });
      expect(result).toMatchObject({ dryRun: true, total_stale: 2, would_embed: 2, embedded: 0, stopped: 'preview' });
      expect(calls).toEqual([]);
      expect(await state()).toEqual(before);
      await embedStaleFacts(engine, { ...approved, dryRun: true });
      expect(calls).toEqual([]);
      expect(await state()).toEqual(before);
    });

    test('bounded runs bank progress, restart from remaining nulls, and are idempotent', async () => {
      for (const claim of ['one', 'two', 'three', 'four', 'five']) await seed(claim);
      const first = await embedStaleFacts(engine, { ...approved, maxFacts: 3, batchSize: 2 });
      expect(first).toMatchObject({ embedded: 3, remaining: 2, stopped: 'limit', failures: 0 });
      expect(calls).toEqual([['one', 'two'], ['three']]);
      await engine.disconnect();
      engine = kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
      await engine.connect(kind === 'pglite' ? { database_path: join(databasePath, 'db') } : { database_url: databaseUrl! });
      const second = await embedStaleFacts(engine, approved);
      expect(second).toMatchObject({ embedded: 2, remaining: 0, stopped: 'complete' });
      const before = await state();
      const third = await embedStaleFacts(engine, approved);
      expect(third).toMatchObject({ embedded: 0, attempted: 0, failures: 0 });
      expect(await state()).toEqual(before);
      expect(calls.flat()).toEqual(['one', 'two', 'three', 'four', 'five']);
    });

    test('stops after a failed batch and resumes without re-embedding completed facts', async () => {
      for (const claim of ['one', 'two', 'three']) await seed(claim);
      __setEmbedTransportForTests(async ({ values }) => {
        calls.push([...values]);
        if (calls.length === 2) throw new Error('synthetic provider failure');
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
      });
      const first = await embedStaleFacts(engine, { ...approved, batchSize: 1 });
      expect(first).toMatchObject({ embedded: 1, remaining: 2, stopped: 'failed', failures: 1 });
      expect(first.cost_estimated).toBe(true);
      const second = await embedStaleFacts(engine, { ...approved, batchSize: 1 });
      expect(second).toMatchObject({ embedded: 2, remaining: 0, failures: 0 });
      expect(calls.flat()).toEqual(['one', 'two', 'two', 'three']);
    });

    test('cost cap rejects before any provider request', async () => {
      await seed('a nonempty claim with a positive cost');
      const before = await state();
      const result = await embedStaleFacts(engine, { ...approved, maxCostUsd: 0 });
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect(calls).toEqual([]);
      expect(await state()).toEqual(before);
    });

    test('unexpected billed usage cannot silently exceed the cap on the final batch', async () => {
      await seed('one');
      __setEmbedTransportForTests(async ({ values }) => {
        calls.push([...values]);
        return { values, usage: { tokens: 1_000_000 }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
      });
      const result = await embedStaleFacts(engine, { ...approved, maxCostUsd: 0.0001, batchSize: 1 });
      expect(result.stopped).toBe('failed');
      expect(result.failures).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
      expect(result.cost_usd).toBeGreaterThan(0.0001);
    });

    test('a zero budget cannot admit a paid request for an empty legacy fact', async () => {
      await seed('');
      const result = await embedStaleFacts(engine, { ...approved, maxCostUsd: 0 });
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect(calls).toEqual([]);
    });

    test('missing valid provider usage retains a conservative reported charge', async () => {
      await seed('one');
      __setEmbedTransportForTests(async ({ values }) => ({
        values, usage: { tokens: Number.NaN }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)),
      }));
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 1, failures: 0, cost_estimated: true });
      expect(result.cost_usd).toBeGreaterThan(0);
    });

    test('disabled embeddings refuse before provider spend', async () => {
      await seed('pending');
      saveConfig({ ...originalConfig, embedding_disabled: true });
      await expect(embedStaleFacts(engine, approved, loadConfig())).rejects.toThrow('no-embedding');
      const preview = await embedStaleFacts(engine, { sourceId, dryRun: true });
      expect(preview.would_embed).toBe(1);
      expect(calls).toEqual([]);
    });

    test('direct fact repair honors the selected off-switch instead of the enabled host', async () => {
      await seed('selected pending');
      const before = await state();
      await expect(runEmbed(engine, ['--stale', '--facts', '--source', sourceId, '--yes', '--max-cost-usd', '1'],
        { engine: kind, embedding_disabled: true })).rejects.toThrow('no-embedding');
      expect(calls).toEqual([]);
      expect(await state()).toEqual(before);
    });

    test('engine off-switch overrides an enabled selected configuration', async () => {
      await seed('selected pending');
      await engine.setConfig('embedding_disabled', 'true');
      await expect(embedStaleFacts(engine, approved, { engine: kind, embedding_disabled: false })).rejects.toThrow('no-embedding');
      expect(calls).toEqual([]);
    });

    test('an engine off-switch changed during provider work prevents installation', async () => {
      await seed('selected pending');
      const before = await state();
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.setConfig('embedding_disabled', 'true');
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
      });
      const result = await embedStaleFacts(engine, approved, { engine: kind, embedding_disabled: false });
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect(result.failure_samples[0]).toContain('no-embedding');
      expect(await state()).toEqual(before);
    });

    test('provider failure samples redact connection credentials and bearer tokens', async () => {
      await seed('pending');
      const password = 'synthetic-fixture-password';
      const token = 'fixture-' + 'AbCdEf0123456789GhIjKlMn'.repeat(2);
      const connection = ['postgresql', '://fixture-user:', password, '@db.example.invalid/test'].join('');
      __setEmbedTransportForTests(async () => {
        throw new Error(`provider rejected ${connection} https://fixture-user:${password}@api.example.invalid/embed Authorization: Bearer ${token}`);
      });
      const result = await embedStaleFacts(engine, approved);
      const output = JSON.stringify(result.failure_samples);
      expect(result.failures).toBe(1);
      expect(output).not.toContain(password);
      expect(output).not.toContain(token);
      expect(output).not.toContain(connection);
      expect(output).toContain('REDACTED');
    });

    test('managed repair updates only physical vectors and preserves canonical rows and guards', async () => {
      await seed('private pending', { visibility: 'private' });
      await seed('neighbor pending', {}, neighbor);
      const canonical = async () => Array.from(await engine.executeRaw(`SELECT to_jsonb(f)-ARRAY['embedding','embedded_at'] AS row
        FROM facts f WHERE source_id=ANY($1::text[]) ORDER BY id`, [[sourceId, neighbor]]));
      const before = await canonical();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const preview = await embedStaleFacts(engine, { sourceId, dryRun: true });
      expect(preview.would_embed).toBe(1);
      expect(calls).toEqual([]);
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 1, remaining: 0, failures: 0 });
      expect(await canonical()).toEqual(before);
      expect(calls).toEqual([['private pending']]);
      const rows = await state();
      expect(rows[0].embedding).not.toBeNull();
      expect(rows[1].embedding).toBeNull();
      await expect(engine.executeRaw("UPDATE facts SET fact='unauthorized edit' WHERE source_id=$1", [sourceId])).rejects.toThrow('writer_coordinator_required');
      const rerun = await embedStaleFacts(engine, approved);
      expect(rerun).toMatchObject({ embedded: 0, failures: 0 });
      expect(calls).toHaveLength(1);
    });

    test('managed repair refuses installing a vector after the model changes', async () => {
      await seed('pending');
      const before = await state();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)] };
      });
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect(result.failure_samples[0]).toContain('Embedding model changed');
      expect(await state()).toEqual(before);
    });

    test('abort after provider response installs nothing', async () => {
      await seed('pending');
      const before = await state();
      const controller = new AbortController();
      __setEmbedTransportForTests(async ({ values }) => {
        controller.abort();
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)] };
      });
      const result = await embedStaleFacts(engine, { ...approved, signal: controller.signal });
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'aborted' });
      expect(await state()).toEqual(before);
    });

    test('an incomplete provider result writes no partial batch', async () => {
      await seed('one');
      await seed('two');
      const before = await state();
      __setEmbedTransportForTests(async ({ values }) => ({
        values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)],
      }));
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 0, failures: 2, stopped: 'failed' });
      expect(await state()).toEqual(before);
    });

    test('source incarnation changes prevent installing vectors into a new identity', async () => {
      await seed('pending');
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [sourceId]);
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)] };
      });
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect(result.failure_samples[0]).toContain('Source identity changed');
      expect((await state())[0].embedding).toBeNull();
    });

    test('BIGSERIAL fact IDs retain exact identity and JSON-safe results', async () => {
      await engine.executeRaw(`INSERT INTO facts(id,source_id,fact,source,visibility)
        VALUES(9007199254740993,$1,'large id claim','notes','world')`, [sourceId]);
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 1, remaining: 0, failures: 0 });
      expect(() => JSON.stringify(result)).not.toThrow();
      expect((await state())[0].id).toBe('9007199254740993');
    });

    test('concurrent text and visibility edits never receive a stale vector', async () => {
      await seed('pending');
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.executeRaw("UPDATE facts SET fact='changed', visibility='private' WHERE source_id=$1", [sourceId]);
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)] };
      });
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
      expect((await state())[0]).toMatchObject({ fact: 'changed', visibility: 'private', embedding: null });
    });

    test('withdrawals recorded during embedding remain unembedded', async () => {
      await seed('withdrawn claim', { visibility: 'private' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setEmbedTransportForTests(async ({ values }) => {
        await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
          VALUES($1,'private',gbrain_fact_fingerprint('withdrawn claim'))`, [sourceId]);
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.25)] };
      });
      const result = await embedStaleFacts(engine, approved);
      expect(result).toMatchObject({ embedded: 0, failures: 1, remaining: 0 });
      expect((await state())[0]).toMatchObject({ visibility: 'private', embedding: null });
    });

    test('missing scope, missing spend consent, and conflicting modes are rejected', async () => {
      await expect(embedStaleFacts(engine, { sourceId: '' })).rejects.toThrow('explicit --source');
      await expect(embedStaleFacts(engine, { sourceId, yes: true })).rejects.toThrow('--max-cost-usd');
      await expect(runEmbed(engine, ['--facts'])).rejects.toThrow('embed --stale --facts');
      await expect(runEmbed(engine, ['--facts', '--stale', '--background', '--source', sourceId])).rejects.toThrow('embed --stale --facts');
      await expect(runEmbed(engine, ['--facts', '--stale', '--source'])).rejects.toThrow('requires a value');
      expect(calls).toEqual([]);
    });

    test('the public command defaults to a scoped read-only fact preview', async () => {
      await seed('pending');
      const before = await state();
      const result = await runEmbed(engine, ['--stale', '--facts', '--source', sourceId]);
      expect(result).toMatchObject({ source_id: sourceId, dryRun: true, total_stale: 1, would_embed: 1, embedded: 0 });
      expect(calls).toEqual([]);
      expect(await state()).toEqual(before);
    });
  });
}
