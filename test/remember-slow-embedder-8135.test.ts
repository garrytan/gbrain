/**
 * #8135: a slow but working embedder lost every remember. Its preparation embeds the fact under the consumer's 30 s
 * foreground budget while the embed call itself may take up to 60 s, so an embed slower than the budget let the budget's
 * abort win: `prepareFactEmbedding`'s no-vector fallback (`degraded: true`, re-embedded later) only ran when the embed
 * failed with the signal still live, the attempt was charged, and the second one finished the request
 * `failed`/`preparation_stalled` with nothing saved. The embed is now bounded inside the budget and its own timeout
 * takes the fallback, so the fact is saved without a vector on the first attempt.
 *
 * Real consumer, real remember preparer and publication, real gateway with a slow embed transport; the foreground
 * budget is scaled down (the consumer's `preparationMs`), the shape is the production one.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { awaitWrite, disposePersistenceConsumer, preparePersistedMutation } from '../src/core/persistence/service.ts';
import '../src/core/persistence/memory-mutations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-remember-slow-embed-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 8135, schedules: 0, operations: 0, sourceIds: ['source-a'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
const BUDGET_MS = 1_500;
let engine: PGLiteEngine;
let embedCalls = 0;

/** An embedder slower than the budget that honours cancellation (the reporter's saturated local provider). */
function slowEmbedder(ms: number) {
  __setEmbedTransportForTests((async (opts: { values: string[]; abortSignal?: AbortSignal }) => {
    embedCalls++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      opts.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); reject(opts.abortSignal!.reason); }, { once: true });
    });
    return { embeddings: opts.values.map(() => new Array(LEGACY_EMBEDDING_CONFIG.embedding_dimensions).fill(0.01)) };
  }) as never);
}

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
  resetWriteSwitches();
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'sk-test' } });
}), 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

function rememberRow(fact: string) {
  return admitWrite(engine, admission(config, sourceA(), 'memory/unattributed', '', 0, {
    operation: 'remember', worktreeId: null, topologyGeneration: null, callerIntent: { fact },
    intent: { fact, entity_slug: null, fence: false, valid_from: new Date().toISOString(), valid_until: null, visibility: 'world', session_id: null },
  }));
}
let sources: Awaited<ReturnType<typeof fixtures>>;
const sourceA = () => sources[0]!;

test('#8135 a remember whose embed outlasts the preparation budget is saved without a vector, not lost as preparation_stalled', async () => withEnv(env, async () => {
  sources = await fixtures(engine, config);
  slowEmbedder(BUDGET_MS * 4);
  const fact = 'Alice Example keeps the acme-example ledger in a fireproof safe.';
  const row = await rememberRow(fact);
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, preparePersistedMutation,
    { hostId: config.hostId, pollMs: 20, preparationMs: BUDGET_MS, preparationBudgets: { maxAttempts: 2 }, onError: () => {} });
  try {
    consumer.start();
    const waited = await awaitWrite(engine, row, { engine: 'pglite' }, { waitMs: BUDGET_MS * 6 });
    expect({ state: waited.row.state, error_code: waited.row.error_code }).toEqual({ state: 'committed', error_code: null });
    expect(waited.row.preparation_attempts ?? 0).toBe(0);
    const facts = await engine.executeRaw<{ fact: string; has_vector: boolean }>(
      'SELECT fact, embedding IS NOT NULL AS has_vector FROM facts WHERE source_id=$1 AND expired_at IS NULL', [row.source_id]);
    expect(facts).toEqual([{ fact, has_vector: false }]);
    expect(embedCalls).toBeGreaterThan(0);
  } finally { await disposePersistenceConsumer(engine); await consumer.stop(); }
}), 30_000);
