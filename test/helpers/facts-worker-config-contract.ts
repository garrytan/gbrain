import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway, isAvailable, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { prepareManagedFactsSession } from '../../src/core/persistence/facts-maintenance.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import { withEnv } from './with-env.ts';

const FACT = 'A worker-specific preference is to review plans weekly.';
const BODY = 'A synthetic meeting record describes a weekly planning preference. '.repeat(8);

export async function exerciseFactsWorkerConfig(engine: BrainEngine): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-worker-config-'));
  const sourceId = 'facts-worker-config';
  const selected: GBrainConfig = { engine: engine.kind, embedding_disabled: true,
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, openai_api_key: 'test',
    ...(engine.kind === 'postgres' ? { database_url: process.env.DATABASE_URL } : {}) };
  const embeddedTexts: string[] = [];
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_MODEL_DISCOVERY: '0' }, async () => {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(selected));
      configureGateway({ embedding_model: selected.embedding_model, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
      __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact: FACT, kind: 'preference', entity: 'people/example', confidence: 1, notability: 'high' }] }),
        blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        embeddedTexts.push(...values);
        return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]) };
      }) as never);
      await engine.setConfig('version', '162');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('people/example', { type: 'person', title: 'Example entity', compiled_truth: 'A searchable narrative remains on this registered entity.' }, { sourceId });
      await engine.executeRaw("INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES('worker-config-client','fixture-hash','example-client','read write',$1)", [sourceId]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const context: OperationContext = { engine, config: selected, remote: true, sourceId, dryRun: false, logger: console,
        auth: { token: 'fixture', clientId: 'worker-config-client', principal: { kind: 'oauth_client', id: 'worker-config-client' }, scopes: ['read', 'write'], sourceId } };
      await operationsByName.put_page.handler(context, { slug: 'meetings/config-example', content: `---\ntype: meeting\ntitle: Example meeting\n---\n\n${BODY}`, request_id: randomUUID() });
      await disposePersistenceConsumer(engine);
      await runPersistenceEffects(engine, selected, { hostId: localHostId(), limit: 8 });
      const [queued] = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id,data FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1", [sourceId]);
      expect(queued).toBeDefined();
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id=$1::uuid", [queued.data.persistence_request_id]);
      expect(persistenceConsumerStatus(engine).state).toBe('not_running');
      expect(isAvailable('embedding')).toBe(true);
      expect(embeddedTexts).toEqual([]);
      const worker = new MinionWorker(engine, { queue: 'fixture' });
      await registerBuiltinHandlers(worker, engine, { quiet: true });
      await disposePersistenceConsumer(engine);
      expect(persistenceConsumerStatus(engine).state).toBe('not_running');
      const job: MinionJobContext = { id: Number(queued.id), name: 'facts-absorb', data: { ...queued.data, config: { embedding_disabled: false } }, attempts_made: 0,
        signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
        updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
      expect(await worker.getHandler('facts-absorb')!(job)).toMatchObject({ inserted: 1 });
      expect(persistenceConsumerStatus(engine).state).toBe('open');
      const consumer = startPersistenceConsumer(engine, selected);
      let settled = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        await consumer.tick();
        const effects = await engine.executeRaw<{ attempts: number; state: string; error_code: string | null }>(`SELECT e.attempts,e.state,e.error_code FROM persistence_effects e
          JOIN persistence_requests r ON r.id=e.request_id WHERE e.source_id=$1 AND r.operation='extract_facts' AND e.kind='embedding'`, [sourceId]);
        if (effects.length && effects.every(effect => Number(effect.attempts) > 0 && effect.state !== 'running' && (effect.error_code !== null || effect.state === 'committed' || effect.state === 'failed'))) { settled = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await disposePersistenceConsumer(engine);
      expect(settled).toBe(true);
      expect(embeddedTexts.filter(text => text !== FACT)).toEqual([]);
      expect(embeddedTexts.filter(text => text === FACT)).toHaveLength(0);
      expect(consumer.config.embedding_disabled).toBe(true);
      expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id=$1 AND fact=$2", [sourceId, FACT])).toHaveLength(1);
      const requests = await engine.executeRaw<{ principal_kind: string; principal_id: string }>("SELECT principal_kind,principal_id FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts'", [sourceId]);
      for (const request of requests) expect(request).toEqual({ principal_kind: 'oauth_client', principal_id: 'worker-config-client' });
      const explicit: GBrainConfig = { engine: engine.kind, embedding_disabled: false };
      const session = await prepareManagedFactsSession({ engine, sourceId, source: 'mcp:extract_facts', sessionId: null,
        operationContext: { ...context, config: explicit }, config: selected }, { turnText: BODY });
      expect(session?.config).toBe(explicit);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
    rmSync(home, { recursive: true, force: true });
  }
}
