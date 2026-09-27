import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { submitRememberMutation, submitForgetMutation, prepareMemoryMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequest, getWriteRequestById, receiptFor } from '../src/core/persistence/journal.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { waitFor } from './helpers/wait-for.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const engines: BrainEngine[] = [];
const sourceId = 'managed-memory-concurrency-test';
const context = (engine: BrainEngine, remote = false): OperationContext => ({ engine, remote, sourceId,
  config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const pageInput = (body: string) => ({ type: 'person', title: 'Example', compiled_truth: body, timeline: 'Existing timeline', frontmatter: {} });
async function setupPage(engine: BrainEngine, slug: string, body = 'Existing biography') {
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.putPage(slug, pageInput(body), { sourceId });
    await tx.addTag(slug, 'existing-tag', { sourceId });
    return (await tx.readPageSnapshot(slug, { sourceId }))!;
  }));
}
beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const pg = new PostgresEngine(); await pg.connect({ database_url: process.env.DATABASE_URL, poolSize: 4 }); await pg.initSchema(); engines.push(pg);
  }
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
  }
  resetGateway();
});

describe('journaled memory publication, both engines', () => {
  test('remember provider preparation cooperatively aborts without terminal failure and retries the same receipt', async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      const slug = 'people/deadline-example';
      const snapshot = await setupPage(engine, slug);
      const authority = await submissionAuthority(context(engine), 'remember', sourceId, snapshot.sourceIncarnation, slug);
      const intent = { fact: 'Synthetic provider deadline fact', provenance: 'deadline fixture', entity_slug: slug,
        visibility: 'world', fence: true, valid_from: new Date().toISOString(), valid_until: null };
      const row = await admitWrite(engine, { principal: authority.principal, operation: 'remember', sourceId,
        sourceIncarnation: snapshot.sourceIncarnation, slug, pageId: snapshot.page.id, callerIntent: intent, intent, authority, requestId: randomUUID() });
      let aborted = false;
      const release = Promise.withResolvers<void>();
      const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => {
        await release.promise;
        return Response.json({ embeddings: [[1, ...Array(1535).fill(0)]], usage: { tokens: 0 } });
      } });
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests(async options => {
        try { return await (await fetch(provider.url, { signal: options.abortSignal })).json() as never; }
        catch (error) { aborted = options.abortSignal!.aborted; throw error; }
      });
      const consumer = new PersistenceConsumer(engine, context(engine).config, prepareMemoryMutation, { pollMs: 60000, preparationMs: 50 });
      try {
        consumer.start();
        await waitFor(() => aborted && consumer.status().active_preparations === 0);
        expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
        expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, intent.fact])).toHaveLength(0);
      } finally { release.resolve(); provider.stop(true); await consumer.stop(); __setEmbedTransportForTests(null); configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} }); }
      const retry = new PersistenceConsumer(engine, context(engine).config, prepareMemoryMutation, { pollMs: 50 });
      try {
        retry.start();
        await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed');
        expect(await engine.executeRaw('SELECT fact,source FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, intent.fact]))
          .toEqual([{ fact: intent.fact, source: intent.provenance }]);
      } finally { await retry.stop(); }
    }
  }, 15000);
  test('slow healthy loopback preparation keeps an aged receipt nonterminal and replays without a provider call', async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      const slug = 'people/slow-provider-example';
      await setupPage(engine, slug);
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => {
        calls++;
        await release.promise;
        return Response.json({ embeddings: [[1, ...Array(1535).fill(0)]], usage: { tokens: 0 } });
      } });
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests(async options => await (await fetch(provider.url, { signal: options.abortSignal })).json() as never);
      const params = { fact: 'Synthetic slow healthy fact', provenance: 'slow loopback fixture', entity: slug, request_id: randomUUID() };
      const completion = submitRememberMutation(context(engine), params, 10000);
      try {
        await waitFor(async () => calls > 0 && (await engine.executeRaw<{ state: string }>(
          'SELECT state FROM persistence_requests WHERE request_id=$1', [params.request_id]))[0]?.state === 'running');
        await engine.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '3 minutes' WHERE request_id=$1", [params.request_id]);
        const [pending] = await engine.executeRaw<import('../src/core/persistence/model.ts').WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1', [params.request_id]);
        expect(pending.state).toBe('running');
        expect(receiptFor(pending).diagnostic).toMatchObject({ reason: 'cause_unknown', next_action: 'inspect_owner' });
        expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, params.fact])).toHaveLength(0);
        release.resolve();
        const result = await completion;
        expect(result.state).toBe('committed');
        await disposePersistenceConsumer(engine);
        const callsBeforeReplay = calls;
        expect(await submitRememberMutation(context(engine), params)).toEqual(result);
        expect(calls).toBe(callsBeforeReplay);
        expect(await engine.executeRaw('SELECT fact,source FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, params.fact]))
          .toEqual([{ fact: params.fact, source: params.provenance }]);
      } finally {
        release.resolve(); await completion.catch(() => {}); await disposePersistenceConsumer(engine);
        provider.stop(true); __setEmbedTransportForTests(null); configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      }
    }
  }, 20000);
  test('same-ID remember replays frozen fields after entity and fact removal', async () => {
    for (const engine of engines) {
      const slug = 'people/replay-example';
      await setupPage(engine, slug);
      const params = { fact: 'Prefers morning meetings', provenance: 'test conversation', entity: slug, ttl: '30d', request_id: randomUUID() };
      const first = await operationsByName.remember!.handler(context(engine), params) as Record<string, unknown>;
      expect(first).toMatchObject({ status: 'inserted', entity_slug: slug, protocol_version: 1, state: 'committed', degraded_dedup: true });
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.executeRaw('DELETE FROM facts WHERE id=$1', [Number(first.id)]);
        await tx.deletePage(slug, { sourceId });
      }));
      const replay = await operationsByName.remember!.handler(context(engine), params);
      expect(replay).toEqual(first);
      await expect(operationsByName.remember!.handler(context(engine), { ...params, ttl: 'P30D' })).rejects.toMatchObject({ code: 'invalid_params', writeError: 'idempotency_conflict', protocolVersion: 1 });
    }
  });

  test('concurrent requests preserve every append, tags, timeline and hidden fence rows', async () => {
    for (const engine of engines) {
      const slug = 'people/concurrent-example';
      const hidden = upsertFactRow('Biography', { claim: 'Private sentinel', kind: 'fact', visibility: 'private', confidence: 1, notability: 'medium' }).body
        + '\n<!--- gbrain:takes:begin -->\nOpaque private take\n<!--- gbrain:takes:end -->\n';
      const before = await setupPage(engine, slug, hidden);
      const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => submitRememberMutation(context(engine, index % 2 === 0), {
        fact: `Independent remembered preference ${index}`, provenance: 'test conversation', entity: slug, request_id: randomUUID(),
      }, 30_000)));
      expect(new Set(responses.map(r => r.id)).size).toBe(6);
      const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const facts = parseFactsFence(after.page.compiled_truth).facts;
      expect(facts).toHaveLength(7);
      expect(new Set(facts.map(f => f.rowNum)).size).toBe(7);
      expect(after.page.compiled_truth).toContain('Private sentinel');
      expect(after.page.compiled_truth).toContain('Opaque private take');
      expect(after.page.timeline).toBe('Existing timeline');
      expect(after.tags).toEqual(['existing-tag']);
      expect(after.revision).not.toBe(before.revision);
      const chunks = await engine.getChunks(slug, { sourceId });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map(c => c.chunk_text).join('\n')).not.toContain('Private sentinel');
      expect(chunks.map(c => c.chunk_text).join('\n')).not.toContain('Opaque private take');
    }
  }, 120_000);

  test('concurrent identical request IDs allocate exactly one fact and one receipt', async () => {
    for (const engine of engines) {
      const p = { fact: 'A subjectless stable memory', provenance: 'test conversation', request_id: randomUUID() };
      const responses = await Promise.all(Array.from({ length: 6 }, () => submitRememberMutation(context(engine), p, 30_000)));
      expect(new Set(responses.map(r => r.id)).size).toBe(1);
      expect(responses.every(r => r.state === 'committed')).toBe(true);
      const rows = await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, p.fact]);
      expect(rows).toHaveLength(1);
    }
  });

  test('semantic supersession updates fence and index atomically without private-candidate leaks', async () => {
    let providerCalls = 0;
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-managed-memory' } });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => {
      providerCalls += opts.values.length;
      return { embeddings: opts.values.map(() => [1, ...new Array(1535).fill(0)]) };
    }) as never);
    try {
      for (const engine of engines) {
        const slug = 'people/supersede-example';
        await setupPage(engine, slug);
        const privateMemory = await submitRememberMutation(context(engine), { fact: 'Confidential unrelated claim',
          provenance: 'test', entity: slug, visibility: 'private' }, 30_000);
        const first = await submitRememberMutation(context(engine, true), { fact: 'Works at acme-example',
          provenance: 'test', entity: slug }, 30_000);
        expect(first.status).toBe('inserted');
        expect(first.degraded_dedup).toBeUndefined();
        expect(await engine.executeRaw('SELECT id FROM facts WHERE id=$1 AND embedding IS NOT NULL', [Number(first.id)])).toHaveLength(1);
        const params = { fact: 'Left acme-example', provenance: 'test', entity: slug, request_id: randomUUID() };
        const next = await submitRememberMutation(context(engine, true), params, 30_000);
        expect(next.status).toBe('superseded');
        const callsBeforeReplay = providerCalls;
        expect(await submitRememberMutation(context(engine, true), params)).toEqual(next);
        expect(providerCalls).toBe(callsBeforeReplay);
        const rows = await engine.executeRaw<{ id: number; expired_at: Date | null; superseded_by: number | null }>(
          'SELECT id,expired_at,superseded_by FROM facts WHERE id=ANY($1::int[]) ORDER BY id',
          [[Number(privateMemory.id), Number(first.id), Number(next.id)]]);
        expect(rows[0].expired_at).toBeNull();
        expect(rows[1].expired_at).not.toBeNull();
        expect(Number(rows[1].superseded_by)).toBe(Number(next.id));
        expect(rows[2].expired_at).toBeNull();
        const page = (await engine.readPageSnapshot(slug, { sourceId }))!;
        const fence = parseFactsFence(page.page.compiled_truth).facts;
        expect(fence.find(f => f.claim === 'Works at acme-example')?.active).toBe(false);
        expect(fence.find(f => f.claim === 'Works at acme-example')?.supersededBy).toBe(fence.find(f => f.claim === 'Left acme-example')?.rowNum);
      }
    } finally {
      __setEmbedTransportForTests(null);
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }
  });

  test('forget commits offline, withdraws before sealing reads and replays after fact removal', async () => {
    for (const engine of engines) {
      const slug = 'people/withdraw-example';
      await setupPage(engine, slug);
      const remembered = await submitRememberMutation(context(engine), { fact: 'Withdraw this unique memory', provenance: 'test', entity: slug }, 30_000);
      const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const worktreeId = randomUUID(); const offlineHost = randomUUID();
      await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktreeId, offlineHost]);
      await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id)
        VALUES($1,$2::uuid,$3::uuid)`, [sourceId, before.sourceIncarnation, worktreeId]);
      const requestId = randomUUID();
      const params = { id: remembered.id, reason: 'User correction', request_id: requestId };
      const forgotten = await submitForgetMutation(context(engine), 'forget', params);
      expect(forgotten).toMatchObject({ id: remembered.id, expired: true, reason: 'User correction', protocol_version: 1, state: 'committed' });
      expect(JSON.stringify(forgotten)).not.toContain(slug);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      expect(snapshot.revision).not.toBe(before.revision);
      expect(parseFactsFence(snapshot.page.compiled_truth).facts.find(f => f.claim === 'Withdraw this unique memory')?.forgotten).toBe(true);
      expect(await engine.getChunks(slug, { sourceId })).toEqual([]);
      const local = await registerLocalWriter(engine, 'cli');
      const request = (await getWriteRequest(engine, { kind: 'local_cli', id: local.id }, requestId))!;
      expect(request.worktree_id).toBeNull();
      expect(await engine.executeRaw('SELECT kind FROM persistence_effects WHERE request_id=$1::uuid', [request.id])).not.toHaveLength(0);
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw('DELETE FROM facts WHERE id=$1', [Number(remembered.id)])));
      expect(await submitForgetMutation(context(engine), 'forget', params)).toEqual(forgotten);
      // The fixture's offline owner is synthetic. Durable effects otherwise
      // deliberately retain their worktree identity until reconciliation.
      await engine.executeRaw('DELETE FROM persistence_effects WHERE worktree_id=$1::uuid', [worktreeId]);
      await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [sourceId]);
      await engine.executeRaw('DELETE FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
    }
  });

  test('withdrawal invalidates a prepared remember before publication', async () => {
    for (const engine of engines) {
      // Dispose the resident consumer so this test controls the publication boundary.
      await disposePersistenceConsumer(engine);
      const slug = 'people/preparation-example';
      await setupPage(engine, slug);
      const old = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.insertFact({ fact: 'Claim withdrawn during preparation', source: 'test', entity_slug: slug, visibility: 'world' }, { source_id: sourceId })));
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const authority = await submissionAuthority(context(engine), 'remember', sourceId, snapshot.sourceIncarnation, slug);
      const p = { fact: 'Claim withdrawn during preparation', provenance: 'test', entity_slug: slug, visibility: 'world', fence: true,
        valid_from: new Date().toISOString(), valid_until: null };
      await admitWrite(engine, { principal: authority.principal, operation: 'remember', sourceId, sourceIncarnation: snapshot.sourceIncarnation,
        slug, pageId: snapshot.page.id, callerIntent: p, intent: p, authority, requestId: randomUUID() });
      const row = (await claimNextWrite(engine, randomUUID()))!;
      const prepared = await prepareMemoryMutation(engine, row, context(engine).config);
      await submitForgetMutation(context(engine), 'forget', { id: String(old.id), request_id: randomUUID() });
      const result = await publishMutation(engine, row, prepared);
      expect(result.state).not.toBe('committed');
      const live = await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [sourceId, p.fact]);
      expect(live).toHaveLength(0);
    }
  });
});
