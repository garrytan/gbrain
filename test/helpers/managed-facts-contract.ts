import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimPersistenceEffect } from '../../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../../src/core/persistence/effect-facts.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { withEnv } from './with-env.ts';
import { createPersistenceIpcProvider } from '../../src/core/persistence/provider.ts';
import { requestPersistenceOperation, startPersistenceIpcServer, type PersistenceIpcRequest } from '../../src/core/persistence/ipc.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';

export const factContractCases = ['publication', 'confined', 'revoked', 'narrowed', 'private_target', 'private_hint', 'owner_unavailable', 'source_replaced', 'deferred', 'worker', 'worker_revoked', 'worker_narrowed', 'unparented', 'ipc'] as const;
type Case = typeof factContractCases[number];

export async function exerciseManagedFacts(engine: BrainEngine, scenario: Case): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-facts-'));
  const sourceId = `facts-${scenario.replaceAll('_', '-')}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('version', '162');
      await engine.setConfig('facts.default_visibility', 'private');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const firstSlug = 'people/alice-example', secondSlug = 'companies/acme-example';
      const oldBody = upsertFactRow('A registered entity.', { claim: 'An older retained fact.', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', source: 'fixture' }).body;
      await engine.putPage(firstSlug, { type: 'person', title: 'Alice-example', compiled_truth: oldBody.trim(),
        frontmatter: scenario === 'private_target' || scenario === 'private_hint' ? { visibility: 'private' } : {} }, { sourceId });
      await engine.putPage(secondSlug, { type: 'company', title: 'Acme-example', compiled_truth: 'A registered company.' }, { sourceId });
      const oldVector = new Float32Array(1536); oldVector[1] = 1;
      const old = await engine.insertFacts([{ fact: 'An older retained fact.', kind: 'fact', visibility: 'private', source: 'fixture',
        entity_slug: firstSlug, row_num: 1, source_markdown_slug: firstSlug, embedding: oldVector }], { source_id: sourceId });
      const [beforeVector] = await engine.executeRaw<{ vector: string }>('SELECT embedding::text AS vector FROM facts WHERE id=$1', [old.ids[0]]);
      const root = join(home, 'repo');
      for (const slug of [firstSlug, secondSlug]) {
        mkdirSync(join(root, slug.split('/')[0]), { recursive: true });
        writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown((await engine.getPage(slug, { sourceId }))!, []));
      }
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, root]);
      const registration = await registerLocalWriter(engine, 'cli');
      const binding = await claimWorktree(engine, sourceId, root);
      const clientId = `client-${sourceId}`;
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
        VALUES($1,'fixture-hash','example-client','read write',$2,$3::text[])`, [clientId, sourceId, scenario === 'confined' ? ['people/'] : null]);
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: true, sourceId, dryRun: false, logger: console,
        auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId,
          ...(scenario === 'confined' ? { boundSlugPrefixes: ['people/'] } : {}) } };
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      if (scenario === 'owner_unavailable') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
      let calls = 0;
      __setChatTransportForTests(async () => {
        calls++;
        if (scenario === 'revoked') await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [clientId]);
        if (scenario === 'narrowed') await engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes=ARRAY['people/'] WHERE client_id=$1", [clientId]);
        if (scenario === 'deferred') await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
        if (scenario === 'source_replaced') await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [sourceId]);
          await tx.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1)', [sourceId]);
          await tx.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1)', [sourceId]);
          await tx.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [sourceId]);
        });
        return { text: JSON.stringify({ facts: [
          { fact: 'Alice-example prefers weekly status reports.', kind: 'preference', entity: scenario === 'unparented' ? 'unknown-unregistered-person' : firstSlug, confidence: 0.9, notability: 'high' },
          { fact: 'Acme-example measures monthly growth.', kind: 'fact', entity: secondSlug, confidence: 0.8, notability: 'medium' },
        ] }), blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
      });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, ...Array(1535).fill(0)]) })) as never);
      const params = { turn_text: 'A substantive meeting about the registered entities and their operating preferences.', session_id: 'fixture-session', request_id: randomUUID(),
        ...(scenario === 'private_hint' ? { entity_hints: [firstSlug] } : {}) };
      if (scenario === 'ipc') {
        const provider = await createPersistenceIpcProvider(engine, { engine: engine.kind });
        const socketPath = join(home, 'facts.sock');
        const server = (await startPersistenceIpcServer(socketPath, provider))!;
        try {
          const request: PersistenceIpcRequest = { version: 1, kind: 'operation', brain_id: provider.brainId, operation: 'extract_facts', params,
            registration: { id: registration.id, credential: registration.credential, lane: 'cli' }, routing: { source: sourceId, cwd: root } };
          const result = await requestPersistenceOperation(socketPath, request);
          expect(result).toMatchObject({ inserted: 2 });
          expect(await requestPersistenceOperation(socketPath, request)).toEqual(result);
          expect(calls).toBe(1);
          expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' AND principal_kind='local_cli' AND principal_id=$2", [sourceId, registration.id])).toHaveLength(3);
        } finally { await new Promise<void>(resolve => { server.server.once('close', resolve); server.close(); }); }
        return;
      }
      if (scenario === 'worker' || scenario === 'worker_revoked' || scenario === 'worker_narrowed') {
        const content = `---\ntype: meeting\ntitle: Example meeting\n---\n\n${params.turn_text.repeat(4)}`;
        const put = await operationsByName.put_page.handler(ctx, { slug: 'meetings/example', content, request_id: randomUUID() }) as { request_id: string };
        await disposePersistenceConsumer(engine);
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
        const [recorded] = await engine.executeRaw<PersistenceEffect>("SELECT * FROM persistence_effects WHERE source_id=$1 AND kind='facts-backstop'", [sourceId]);
        expect(recorded).toBeDefined();
        expect(['queued', 'committed']).toContain(recorded.state);
        const effect = recorded.state === 'queued' ? (await claimPersistenceEffect(engine, localHostId()))! : recorded;
        expect(effect.kind).toBe('facts-backstop');
        expect(effect.source_id).toBe(sourceId);
        await dispatchFactsBackstopEffect(engine, effect, localHostId());
        await dispatchFactsBackstopEffect(engine, effect, localHostId());
        const jobs = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id,data FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1", [sourceId]);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].data.persistence_request_id).toBeDefined();
        const worker = new MinionWorker(engine, { queue: 'fixture' });
        await registerBuiltinHandlers(worker, engine, { quiet: true });
        const job: MinionJobContext = { id: Number(jobs[0].id), name: 'facts-absorb', data: jobs[0].data, attempts_made: 0,
          signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
          updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
        if (scenario === 'worker_revoked') await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [clientId]);
        if (scenario === 'worker_narrowed') await engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes=ARRAY['meetings/'] WHERE client_id=$1", [clientId]);
        const result = await worker.getHandler('facts-absorb')!(job);
        if (scenario === 'worker_revoked' || scenario === 'worker_narrowed') { expect(result).toMatchObject({ skipped: 'permission_denied' }); expect(calls).toBe(0); return; }
        expect(result).toMatchObject({ inserted: 2 });
        await worker.getHandler('facts-absorb')!(job);
        expect(calls).toBe(1);
        const authorities = await engine.executeRaw<{ principal_kind: string; principal_id: string; remote: string }>("SELECT principal_kind,principal_id,authority->>'remote' AS remote FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts'", [sourceId]);
        expect(authorities).toHaveLength(3);
        for (const authority of authorities) expect(authority).toEqual({ principal_kind: 'oauth_client', principal_id: clientId, remote: 'true' });
        expect(put.request_id).toBeTruthy();
        return;
      }
      if (['confined', 'revoked', 'narrowed', 'private_target', 'private_hint', 'owner_unavailable', 'source_replaced'].includes(scenario)) {
        await expect(operationsByName.extract_facts.handler(ctx, params)).rejects.toMatchObject({ code: scenario === 'private_target' || scenario === 'private_hint' ? 'page_not_found'
          : scenario === 'source_replaced' ? 'source_changed' : scenario === 'owner_unavailable' ? 'owner_unavailable' : 'permission_denied' });
        expect(calls).toBe(['confined', 'private_hint', 'owner_unavailable'].includes(scenario) ? 0 : 1);
        expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts'", [sourceId])).toHaveLength(0);
        expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId])).toHaveLength(1);
        return;
      }
      if (scenario === 'deferred') {
        await expect(operationsByName.extract_facts.handler(ctx, params)).rejects.toMatchObject({ code: 'write_pending', writeRequest: { state: 'queued' } });
        await disposePersistenceConsumer(engine);
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
        if (engine.kind === 'postgres') {
          const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
          const databaseUrl = new URL(process.env.DATABASE_URL!);
          databaseUrl.pathname = `/${database.name}`;
          const output = execFileSync(process.execPath, ['--no-env-file', join(import.meta.dir, '../fixtures/managed-facts-replay-child.ts'), JSON.stringify({ sourceId, auth: ctx.auth, params })],
            { env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: databaseUrl.toString() }, encoding: 'utf8', timeout: 30_000 });
          expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ result: { inserted: 2 }, providerCalls: 0 });
        }
      }
      const first = await operationsByName.extract_facts.handler(ctx, params) as { inserted: number; fact_ids: number[] };
      expect(first.inserted).toBe(2);
      expect(first.fact_ids).toHaveLength(2);
      await disposePersistenceConsumer(engine);
      if (scenario === 'publication') {
        await engine.setConfig('facts.default_visibility', 'world');
        await engine.executeRaw("UPDATE persistence_requests SET intent=NULL,compacted=true WHERE source_id=$1 AND operation='extract_facts'", [sourceId]);
      }
      expect(await operationsByName.extract_facts.handler(ctx, params)).toMatchObject({ inserted: 2, fact_ids: first.fact_ids });
      expect(await operationsByName.get_write_request.handler(ctx, { request_id: params.request_id })).toMatchObject({ state: 'committed', outcome: { inserted: 2 } });
      expect(calls).toBe(1);
      await expect(operationsByName.extract_facts.handler(ctx, { ...params, turn_text: 'Different input.' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(calls).toBe(1);
      const rows = await engine.executeRaw<{ id: number; visibility: string; source_session: string }>('SELECT id,visibility,source_session FROM facts WHERE source_id=$1 AND id=ANY($2::integer[])', [sourceId, first.fact_ids]);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ visibility: 'private', source_session: 'fixture-session' });
      const dates = await engine.executeRaw<{ time: string }>("SELECT to_char(valid_from AT TIME ZONE 'UTC','HH24:MI:SS') AS time FROM facts WHERE source_id=$1 AND id=ANY($2::integer[]) AND source_markdown_slug IS NOT NULL", [sourceId, first.fact_ids]);
      for (const date of dates) expect(date.time).toBe('00:00:00');
      expect(readFileSync(join(root, `${secondSlug}.md`), 'utf8')).toContain('Acme-example measures monthly growth.');
      expect(JSON.stringify(await operationsByName.get_page.handler(ctx, { slug: secondSlug }))).not.toContain('Acme-example measures monthly growth.');
      const [afterVector] = await engine.executeRaw<{ vector: string }>('SELECT embedding::text AS vector FROM facts WHERE id=$1', [old.ids[0]]);
      expect(afterVector.vector).toBe(beforeVector.vector);
      if (scenario === 'unparented') expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND entity_slug IS NULL', [sourceId])).toHaveLength(1);
    });
  } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); rmSync(home, { recursive: true, force: true }); }
}
