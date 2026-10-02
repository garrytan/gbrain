/**
 * Managed `writeSingleFact` attribution (fix wave 5, TODOS "Managed
 * writeSingleFact keeps unresolved entity attribution"), on PGLite and, with a
 * safe DATABASE_URL, Postgres (test/e2e/managed-write-single-attribution-postgres.test.ts).
 *
 * Protects: on a managed brain, the same commitment remembered for two people
 * who have no pages lands as two facts, each keeping the resolver's fallback
 * slug database-only (no row number, no page, no file); the same claim for the
 * same absent person still deduplicates. The facts backstop (extract_facts)
 * never opts in: its absent-entity rows stay unattributed, deduplicate within
 * a batch, and replay without provider calls.
 * Fails when: the managed fact intent drops the fallback slug for
 * writeSingleFact (the second person's fact dedups against the first), or the
 * opt-in leaks into the backstop.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Will send the signed contract by Friday.';

for (const backend of testBackends()) {
  describe(`managed writeSingleFact attribution (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-single-attribution-'));
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    }, 120_000);
    afterEach(async () => {
      __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    });
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

    /** A fresh source with a claimed worktree, then managed mode on. */
    async function managedSource(run: (sourceId: string, root: string) => Promise<void>): Promise<void> {
      const sourceId = `attr-${randomUUID().slice(0, 8)}`;
      const root = mkdtempSync(join(dir, 'root-'));
      await withEnv({ GBRAIN_HOME: join(dir, `home-${sourceId}`) }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(sourceId, root);
      });
    }
    const rows = (sourceId: string) => engine.executeRaw<{ id: number; entity_slug: string | null; row_num: number | null; source_markdown_slug: string | null }>(
      'SELECT id::int AS id, entity_slug, row_num, source_markdown_slug FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]);

    test('the same commitment for two people with no pages lands as two facts, each keeping its fallback slug', async () => {
      await managedSource(async (sourceId, root) => {
        const remember = (entity: string) => writeSingleFact(engine, sourceId, { fact: CLAIM, provenance: 'fixture', entity, kind: 'commitment' });
        const alice = await remember('Alice Absent');
        const bob = await remember('Bob Absent');
        expect([alice.status, bob.status]).toEqual(['inserted', 'inserted']);
        expect(bob.id).not.toBe(alice.id);
        expect([alice.entity_slug, bob.entity_slug]).toEqual(['alice-absent', 'bob-absent']);
        const again = await remember('Alice Absent');
        expect(again).toMatchObject({ status: 'duplicate', id: alice.id, entity_slug: 'alice-absent' });
        expect(await rows(sourceId)).toEqual([
          { id: alice.id, entity_slug: 'alice-absent', row_num: null, source_markdown_slug: null },
          { id: bob.id, entity_slug: 'bob-absent', row_num: null, source_markdown_slug: null },
        ]);
        const requests = await engine.executeRaw<{ slug: string; flag: string | null }>(`SELECT slug, intent->>'attribute_fallback' AS flag FROM persistence_requests
          WHERE source_id=$1 AND operation='extract_facts' AND state='committed' AND intent->>'kind'='managed_facts_entity' ORDER BY sequence`, [sourceId]);
        expect(requests).toEqual([0, 1, 2].map(() => ({ slug: 'memory/unattributed', flag: 'true' })));
        expect(await engine.getPage('memory/unattributed', { sourceId })).toBeNull();
        expect(readdirSync(root).filter(name => !name.startsWith('.gbrain'))).toEqual([]);
      });
    }, 120_000);

    test('the facts backstop never opts in: absent entities stay unattributed, dedup within the batch, and replay without provider calls', async () => {
      await managedSource(async sourceId => {
        let calls = 0;
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
        __setChatTransportForTests(async () => { calls++; return { text: JSON.stringify({ facts: [
          { fact: CLAIM, kind: 'commitment', entity: 'Alice Absent', confidence: 0.9, notability: 'high' },
          { fact: CLAIM, kind: 'commitment', entity: 'Bob Absent', confidence: 0.9, notability: 'high' },
        ] }), blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }; });
        const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, remote: false, sourceId, dryRun: false, logger: console };
        const params = { turn_text: 'Alice Absent and Bob Absent both said they will send the signed contract by Friday.', request_id: randomUUID() };
        const first = await operationsByName.extract_facts.handler(ctx as never, params) as { inserted: number; duplicate: number; fact_ids: number[] };
        expect(first).toMatchObject({ inserted: 1, duplicate: 1 });
        expect(new Set(first.fact_ids).size).toBe(1);
        expect((await rows(sourceId)).map(row => row.entity_slug)).toEqual([null]);
        const flags = await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent ? 'attribute_fallback'", [sourceId]);
        expect(flags).toEqual([]);
        const replay = await operationsByName.extract_facts.handler(ctx as never, params);
        expect(replay).toEqual(first);
        expect(calls).toBe(1);
      });
    }, 120_000);
  });
}
