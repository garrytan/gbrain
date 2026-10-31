/**
 * GBRA-248 W1: the two-engine isolation suite. Two brains in one process on
 * two databases (PGLite x2 in test/two-engine-isolation.serial.test.ts,
 * Postgres x2 in test/e2e/two-engine-isolation.test.ts), each with its own
 * settings: a home directory, an AI key, an embedding model and a fake
 * OpenAI-compatible provider that records the key and model each request
 * arrived with.
 *
 * One case per dimension the embeddable core must keep per engine (plan
 * plans/GBRA-248-embeddable-core.md, wave W1). Every case runs for both
 * creation orders. A case listed in EXPECTED_FAILURES runs as test.failing,
 * so it must still fail today and an unexpected pass fails the suite: the
 * wave that fixes a dimension deletes its row in the same PR. The program is
 * done when EXPECTED_FAILURES is empty.
 *
 * openTestBrain is the seam later waves swap: today it opens a brain with the
 * public API an embedder has (createEngine, connect, initSchema, and the
 * process-wide configureGateway), and within() runs code with nothing
 * scoped. W2 replaces both with openEngine(settings) and the engine scope.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { configureGateway, embedQuery, resetGateway } from '../../src/core/ai/gateway.ts';
import { clearQueryEmbedCache } from '../../src/core/ai/query-embed-cache.ts';
import { recordChatUsage } from '../../src/core/ai/chat-usage.ts';
import { recordSearchTelemetry, awaitPendingTelemetryFlush, _resetTelemetryWriterForTest } from '../../src/core/search/telemetry.ts';
import { relationSemantics, setPackRelationSemantics } from '../../src/core/link-validity.ts';
import { resolveAdmissionPolicy, _resetAdmissionCacheForTest } from '../../src/core/minions/admission.ts';
import { bumpLastRetrievedAt, awaitPendingLastRetrievedWrites, _resetTrackRetrievalCacheForTests } from '../../src/core/last-retrieved.ts';
import { sourceGuardBlocksWrite } from '../../src/core/source-resolver.ts';
import { acquirePageLock } from '../../src/core/page-lock.ts';
import { gbrainPath } from '../../src/core/config.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

export type EngineKind = 'pglite' | 'postgres';
type Name = 'a' | 'b';

export interface TestBrainSettings {
  name: Name;
  home: string;
  databaseUrl?: string;
  ai: { key: string; embeddingModel: string; baseUrl: string };
}

export interface TestBrain {
  name: Name;
  engine: BrainEngine;
  settings: TestBrainSettings;
  within<T>(fn: () => Promise<T> | T): Promise<T>;
}

export async function openTestBrain(kind: EngineKind, settings: TestBrainSettings): Promise<TestBrain> {
  const engine = await createEngine({ engine: kind });
  await engine.connect(kind === 'pglite' ? { engine: 'pglite' } : { engine: 'postgres', database_url: settings.databaseUrl });
  await engine.initSchema();
  configureGateway({
    embedding_model: settings.ai.embeddingModel,
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: settings.ai.key, OPENAI_BASE_URL: settings.ai.baseUrl },
  });
  return { name: settings.name, engine, settings, within: async (fn) => fn() };
}

const DIMS = 1536;
const MODELS: Record<Name, string> = { a: 'text-embedding-3-small', b: 'text-embedding-3-large' };
const FILL: Record<Name, number> = { a: 0.25, b: 0.5 };

interface ProviderCall { brain: Name; key: string; model: string; inputs: string[] }

/** One fake OpenAI-compatible embeddings endpoint per brain; each records what reached it. */
function fakeProvider(brain: Name, calls: ProviderCall[]) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/embeddings')) return new Response('not found', { status: 404 });
      const body = await req.json() as { model: string; input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      calls.push({ brain, key: (req.headers.get('authorization') ?? '').replace(/^Bearer /, ''), model: body.model, inputs });
      return Response.json({
        object: 'list',
        model: body.model,
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(DIMS).fill(FILL[brain]) })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    },
  });
  return { server, url: 'http://127.0.0.1:' + server.port + '/v1' };
}

export interface Pair { first: TestBrain; second: TestBrain; calls: ProviderCall[] }

export interface IsolationCase {
  id: string;
  run(pair: Pair, kind: EngineKind): Promise<void>;
}

async function eventually(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const both = (pair: Pair): TestBrain[] => [pair.first, pair.second];
const count = async (b: TestBrain, sql: string, params: unknown[] = []) =>
  Number((await b.engine.executeRaw<{ n: string | number }>(sql, params))[0]?.n ?? 0);

export const CASES: IsolationCase[] = [
  {
    id: 'pool: each engine reads and writes its own database',
    async run(pair) {
      for (const b of both(pair)) {
        await b.within(() => b.engine.putPage('isolation/pool-' + b.name, { type: 'concept', title: 'pool ' + b.name, compiled_truth: 'pool probe' }));
      }
      for (const b of both(pair)) {
        const other = b === pair.first ? pair.second : pair.first;
        expect(await b.within(() => b.engine.getPage('isolation/pool-' + b.name))).not.toBeNull();
        expect(await b.within(() => b.engine.getPage('isolation/pool-' + other.name))).toBeNull();
      }
    },
  },
  {
    id: 'provider key: an embedding call carries its own brain\'s key',
    async run(pair) {
      clearQueryEmbedCache();
      for (const b of both(pair)) await b.within(() => embedQuery('key probe ' + b.name));
      for (const b of both(pair)) {
        expect(pair.calls.find((c) => c.inputs.includes('key probe ' + b.name))?.key).toBe(b.settings.ai.key);
      }
    },
  },
  {
    id: 'model client cache: an embedding call uses its own brain\'s model and endpoint',
    async run(pair) {
      clearQueryEmbedCache();
      for (const b of both(pair)) await b.within(() => embedQuery('model probe ' + b.name));
      for (const b of both(pair)) {
        const call = pair.calls.find((c) => c.inputs.includes('model probe ' + b.name));
        expect({ brain: call?.brain, model: call?.model }).toEqual({ brain: b.name, model: MODELS[b.name] });
      }
    },
  },
  {
    id: 'query-embedding cache: one brain\'s cached vector never answers the other',
    async run(pair) {
      clearQueryEmbedCache();
      const text = 'shared query text';
      const vectors: Record<string, number> = {};
      for (const b of both(pair)) vectors[b.name] = (await b.within(() => embedQuery(text)))[0]!;
      for (const b of both(pair)) {
        const reached = pair.calls.filter((c) => c.brain === b.name && c.inputs.includes(text)).length;
        expect({ brain: b.name, vector: vectors[b.name], reachedOwnProvider: reached }).toEqual({ brain: b.name, vector: FILL[b.name], reachedOwnProvider: 1 });
      }
    },
  },
  {
    id: 'usage: chat usage lands in the calling brain\'s ledger',
    async run(pair) {
      for (const b of both(pair)) {
        await b.within(() => recordChatUsage({ model: 'openai:gpt-probe-' + b.name, usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      const own = (b: TestBrain) => count(b, 'SELECT count(*) AS n FROM chat_usage_log WHERE model = $1', ['openai:gpt-probe-' + b.name]);
      const anywhere = async () => {
        let n = 0;
        for (const b of both(pair)) n += await count(b, "SELECT count(*) AS n FROM chat_usage_log WHERE model LIKE 'openai:gpt-probe-%'");
        return n;
      };
      await eventually(async () => (await anywhere()) >= 2);
      for (const b of both(pair)) {
        const other = b === pair.first ? pair.second : pair.first;
        const foreign = await count(b, 'SELECT count(*) AS n FROM chat_usage_log WHERE model = $1', ['openai:gpt-probe-' + other.name]);
        expect({ brain: b.name, own: await own(b), foreign }).toEqual({ brain: b.name, own: 1, foreign: 0 });
      }
    },
  },
  {
    id: 'telemetry: search telemetry flushes into the searching brain',
    async run(pair) {
      _resetTelemetryWriterForTest();
      try {
        for (const b of both(pair)) {
          await b.within(() => recordSearchTelemetry(b.engine, { mode: 'isolation-' + b.name } as unknown as HybridSearchMeta, { results_count: 1 }));
        }
        await awaitPendingTelemetryFlush(5000, 'exit');
        for (const b of both(pair)) {
          const other = b === pair.first ? pair.second : pair.first;
          const own = await count(b, 'SELECT count(*) AS n FROM search_telemetry WHERE mode = $1', ['isolation-' + b.name]);
          const foreign = await count(b, 'SELECT count(*) AS n FROM search_telemetry WHERE mode = $1', ['isolation-' + other.name]);
          expect({ brain: b.name, own, foreign }).toEqual({ brain: b.name, own: 1, foreign: 0 });
        }
      } finally {
        _resetTelemetryWriterForTest();
      }
    },
  },
  {
    id: 'link semantics: a brain\'s schema-pack relation semantics stay its own',
    async run(pair) {
      const declared: Record<Name, 'state' | 'event'> = { a: 'state', b: 'event' };
      for (const b of both(pair)) await b.within(() => setPackRelationSemantics(new Map([['isolation_probe', declared[b.name]]])));
      try {
        for (const b of both(pair)) expect(await b.within(() => relationSemantics('isolation_probe'))).toBe(declared[b.name]);
      } finally {
        setPackRelationSemantics(new Map());
      }
    },
  },
  {
    id: 'admission policy: a job name resolves each brain\'s own quota',
    async run(pair) {
      _resetAdmissionCacheForTest();
      const quota: Record<Name, string> = { a: '5', b: '9' };
      for (const b of both(pair)) await b.engine.setConfig('minions.quota_max_waiting.isolation-probe', quota[b.name]);
      for (const b of both(pair)) {
        const policy = await b.within(() => resolveAdmissionPolicy(b.engine, 'isolation-probe'));
        expect({ brain: b.name, quota: policy.quotaMaxWaiting }).toEqual({ brain: b.name, quota: Number(quota[b.name]) });
      }
      _resetAdmissionCacheForTest();
    },
  },
  {
    id: 'retrieval tracking: each brain honors its own search.track_retrieval',
    async run(pair) {
      _resetTrackRetrievalCacheForTests();
      const tracking: Record<Name, string> = { a: 'off', b: 'on' };
      const ids: Record<string, number> = {};
      for (const b of both(pair)) {
        await b.engine.setConfig('search.track_retrieval', tracking[b.name]);
        const page = await b.engine.putPage('isolation/retrieval-' + b.name, { type: 'concept', title: 'retrieval', compiled_truth: 'retrieval probe' });
        ids[b.name] = page.id;
        await b.engine.executeRaw('DELETE FROM page_retrievals WHERE page_id = $1', [page.id]);
      }
      for (const b of both(pair)) {
        await b.within(() => bumpLastRetrievedAt(b.engine, [ids[b.name]!]));
        await awaitPendingLastRetrievedWrites(5000);
      }
      for (const b of both(pair)) {
        const rows = await count(b, 'SELECT count(*) AS n FROM page_retrievals WHERE page_id = $1', [ids[b.name]]);
        expect({ brain: b.name, tracked: rows }).toEqual({ brain: b.name, tracked: tracking[b.name] === 'on' ? 1 : 0 });
      }
      _resetTrackRetrievalCacheForTests();
    },
  },
  {
    id: 'source resolver: one brain\'s schema shape never decides another brain\'s source guard',
    async run(pair) {
      const legacy = pair.first;
      const current = pair.second;
      await current.engine.executeRaw("INSERT INTO sources (id, name, archived) VALUES ('isolation-archived', 'isolation-archived', true) ON CONFLICT (id) DO UPDATE SET archived = true");
      await legacy.engine.executeRaw('ALTER TABLE sources RENAME COLUMN archived TO archived_isolation_probe');
      try {
        await legacy.within(() => sourceGuardBlocksWrite(legacy.engine, 'seed_default'));
      } finally {
        await legacy.engine.executeRaw('ALTER TABLE sources RENAME COLUMN archived_isolation_probe TO archived');
      }
      expect(await current.within(() => sourceGuardBlocksWrite(current.engine, 'seed_default'))).toBe(false);
    },
  },
  {
    id: 'lock names: the same slug in two brains takes two locks',
    async run(pair) {
      const held = [];
      try {
        for (const b of both(pair)) held.push(await b.within(() => acquirePageLock('people/alice-example')));
        expect(held.map((h) => h !== null)).toEqual([true, true]);
      } finally {
        for (const h of held) h?.release();
      }
    },
  },
  {
    id: 'files: a brain\'s local files resolve under its own home',
    async run(pair) {
      for (const b of both(pair)) {
        const path = await b.within(() => gbrainPath('isolation-probe'));
        expect(path.startsWith(b.settings.home + sep)).toBe(true);
      }
    },
  },
  {
    id: 'jobs: a job submitted to one brain is invisible to the other',
    async run(pair) {
      const submitted: Record<string, number> = {};
      for (const b of both(pair)) {
        const job = await b.within(() => new MinionQueue(b.engine).add('isolation-probe-' + b.name, {}));
        submitted[b.name] = job.id;
      }
      for (const b of both(pair)) {
        const other = b === pair.first ? pair.second : pair.first;
        const seen = await count(b, 'SELECT count(*) AS n FROM minion_jobs WHERE name = $1', ['isolation-probe-' + other.name]);
        expect({ brain: b.name, sawOther: seen }).toEqual({ brain: b.name, sawOther: 0 });
      }
    },
  },
];

/**
 * Cases that still fail, each naming the wave that removes it. A wave that
 * makes a case pass deletes its row in the same PR (test.failing turns an
 * unexpected pass into a failure).
 */
export const EXPECTED_FAILURES: Record<string, { wave: string; kinds: EngineKind[] }> = {
  'pool: each engine reads and writes its own database': { wave: 'W2', kinds: ['postgres'] },
  'jobs: a job submitted to one brain is invisible to the other': { wave: 'W2', kinds: ['postgres'] },
  'provider key: an embedding call carries its own brain\'s key': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'model client cache: an embedding call uses its own brain\'s model and endpoint': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'query-embedding cache: one brain\'s cached vector never answers the other': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'usage: chat usage lands in the calling brain\'s ledger': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'telemetry: search telemetry flushes into the searching brain': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'link semantics: a brain\'s schema-pack relation semantics stay its own': { wave: 'W2', kinds: ['pglite', 'postgres'] },
  'admission policy: a job name resolves each brain\'s own quota': { wave: 'W6', kinds: ['pglite', 'postgres'] },
  'retrieval tracking: each brain honors its own search.track_retrieval': { wave: 'W6', kinds: ['pglite', 'postgres'] },
  'source resolver: one brain\'s schema shape never decides another brain\'s source guard': { wave: 'W6', kinds: ['pglite', 'postgres'] },
  'lock names: the same slug in two brains takes two locks': { wave: 'W5', kinds: ['pglite', 'postgres'] },
  'files: a brain\'s local files resolve under its own home': { wave: 'W6', kinds: ['pglite', 'postgres'] },
};

export function twoEngineIsolationSuite(kind: EngineKind, databaseUrls?: [string, string]): void {
  for (const order of [['a', 'b'], ['b', 'a']] as [Name, Name][]) {
    describe('two engines, ' + kind + ', created ' + order.join(' then '), () => {
      const calls: ProviderCall[] = [];
      const providers = (['a', 'b'] as Name[]).map((n) => fakeProvider(n, calls));
      const homes: string[] = [];
      let pair: Pair;

      beforeAll(async () => {
        const brains: TestBrain[] = [];
        for (const name of order) {
          const home = mkdtempSync(join(tmpdir(), 'gbrain-two-engine-' + name + '-'));
          homes.push(home);
          brains.push(await openTestBrain(kind, {
            name,
            home,
            databaseUrl: databaseUrls?.[name === 'a' ? 0 : 1],
            ai: { key: 'key-' + name, embeddingModel: 'openai:' + MODELS[name], baseUrl: providers[name === 'a' ? 0 : 1]!.url },
          }));
        }
        pair = { first: brains[0]!, second: brains[1]!, calls };
      }, 120_000);

      afterAll(async () => {
        resetGateway();
        clearQueryEmbedCache();
        for (const b of pair ? both(pair) : []) await b.engine.disconnect();
        for (const p of providers) p.server.stop(true);
        for (const h of homes) rmSync(h, { recursive: true, force: true });
      });

      test('both brains opened with their own settings', () => {
        expect(both(pair).map((b) => b.name)).toEqual(order);
      });

      for (const c of CASES) {
        const expected = EXPECTED_FAILURES[c.id];
        const run = expected?.kinds.includes(kind) ? test.failing : test;
        run(c.id + (expected?.kinds.includes(kind) ? ' (expected to fail until ' + expected.wave + ')' : ''), () => c.run(pair, kind), 30_000);
      }
    });
  }
}
