/**
 * GBRA-283 B3a (N1): the engine-taking entry points a host calls enter the engine's scope themselves when the engine
 * was opened from settings (hybridSearch, the import paths), and the minion worker runs each job in its engine's
 * scope. A host that never wraps them in withEngineScope still gets that engine's providers, and never the process
 * gateway or engine_scope_required. Every provider is a transport stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { __setEmbedTransportForTests, configureGateway, embedQuery, resetGateway } from '../src/core/ai/gateway.ts';
import { openEngine, withEngineScope, type EngineSettings } from '../src/core/engine-open.ts';
import { embeddedEngineInScope } from '../src/core/engine-scope.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { waitFor } from './helpers/wait-for.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const EMBEDDING = { model: 'openai:text-embedding-3-small', dimensions: 1536 };
const key = (label: string) => `sk-${label}-${randomBytes(12).toString('hex')}`;
const settingsFor = (apiKey: string): EngineSettings => ({
  embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, embedding: EMBEDDING, ai: { providers: { openai: { apiKey } } },
});
const PROCESS_KEY = key('process');
const sent: string[] = [];
function installEmbedStub(): void {
  __setEmbedTransportForTests((async ({ model, values }: any) => {
    const headers = await model.config.headers();
    sent.push(headers.authorization ?? headers.Authorization ?? '');
    return { embeddings: values.map(() => Array.from({ length: EMBEDDING.dimensions }, (_, i) => (i % 7) + 1)), usage: { tokens: 1 } };
  }) as any);
  configureGateway({ embedding_model: EMBEDDING.model, embedding_dimensions: EMBEDDING.dimensions, env: { OPENAI_API_KEY: PROCESS_KEY } });
}

afterEach(() => {
  sent.length = 0;
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('entry points a host calls without a scope', () => {
  test('import and search on an embedded engine embed with that engine\'s key', async () => {
    installEmbedStub();
    const keyA = key('a');
    const a = await openEngine(settingsFor(keyA));
    const b = await openEngine(settingsFor(key('b')));
    try {
      await a.initSchema();
      await importFromContent(a, 'notes/alpha-example', '# Alpha\n\nA note about acme-example and its quarterly plan for brain-a.');
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set([`Bearer ${keyA}`]));
      sent.length = 0;
      await hybridSearch(a, 'quarterly plan');
      await hybridSearchCached(a, 'acme-example plan');
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set([`Bearer ${keyA}`]));
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 120_000);

  test('a deferred post-commit embedding from an import embeds with its engine\'s key, whatever scope drains it', async () => {
    installEmbedStub();
    const keyA = key('a');
    const a = await openEngine(settingsFor(keyA));
    const b = await openEngine(settingsFor(key('b')));
    try {
      await a.initSchema();
      const deferred: Array<() => Promise<{ status: string }>> = [];
      await importFromContent(a, 'notes/alpha-example', '# Alpha\n\nA note about acme-example for brain-a.', { onPostCommitEmbedding: complete => { deferred.push(complete); } });
      await importFromContent(a, 'notes/beta-example', '# Beta\n\nAnother note about acme-example for brain-a.', { onPostCommitEmbedding: complete => { deferred.push(complete); } });
      expect(deferred.length).toBe(2);
      sent.length = 0;
      expect((await deferred[0]()).status).toBe('embedded');
      expect((await withEngineScope(b, () => deferred[1]())).status).toBe('embedded');
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set([`Bearer ${keyA}`]));
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 120_000);

  test('inside an embedded engine\'s scope, search on a local engine leaves that scope and uses the process gateway', async () => {
    installEmbedStub();
    const keyA = key('a');
    const a = await openEngine(settingsFor(keyA));
    const local = await createEngine({ engine: 'pglite' });
    try {
      await local.connect({ engine: 'pglite' } as never);
      await local.initSchema();
      await withEngineScope(a, async () => {
        await hybridSearch(local, 'acme-example note');
        await hybridSearchCached(local, 'acme-example plan');
      });
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set([`Bearer ${PROCESS_KEY}`]));
    } finally {
      await Promise.all([a.disconnect(), local.disconnect()]);
    }
  }, 120_000);

  test('the minion worker runs each job in its engine\'s scope, whatever scope started it', async () => {
    installEmbedStub();
    const keyA = key('a');
    const a = await openEngine(settingsFor(keyA));
    const b = await openEngine(settingsFor(key('b')));
    try {
      await a.initSchema();
      const queue = new MinionQueue(a);
      const job = await queue.add('scope-probe', {});
      const worker = new MinionWorker(a, { concurrency: 1, pollInterval: 20, healthCheckInterval: 0, stalledInterval: 60_000 });
      worker.register('scope-probe', async () => {
        await embedQuery('from a job');
        return { inScope: embeddedEngineInScope() === a };
      });
      const running = worker.start();
      try {
        await waitFor(async () => ['completed', 'failed', 'dead'].includes((await queue.getJob(job.id))?.status ?? ''), { timeoutMs: 30_000, label: 'probe settled' });
      } finally {
        worker.stop();
        await running;
      }
      const done = await queue.getJob(job.id);
      expect([done?.status, done?.error_text ?? null]).toEqual(['completed', null]);
      expect(done?.result).toEqual({ inScope: true });
      expect(sent).toEqual([`Bearer ${keyA}`]);
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 120_000);
});
