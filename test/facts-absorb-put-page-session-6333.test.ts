/**
 * #6333 measurement gap: the page-write facts backstop enqueued `facts-absorb`
 * with no session, so a managed `put_page` re-extraction could never feed the
 * `would_dedup_same_page` shadow counter (the same-page predicate needs a
 * session; sync imports carry `sync:<slug>`). The page-write effect now carries
 * the stable session `put_page:<slug>`, threaded through the job to the facts
 * it writes.
 *
 * End to end: committed page write → facts-backstop effect dispatch → the
 * facts-absorb handler → extraction, on an unmanaged and a managed brain. Stub
 * transports only; zero paid calls.
 */
import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../src/core/persistence/effect-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

const DIMS = 1536;
const ENTITY = 'people/alice-example';
const PAGE = 'notes/example';
const SESSION = `put_page:${PAGE}`;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'Alice Example is the lead of the example company platform team, per this record. '.repeat(3)}`;
let engine: PGLiteEngine;

function vector(): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  return v;
}
function reworded(): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = Math.sqrt(0.9);
  v[1] = Math.sqrt(0.1);
  return v;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterEach(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function pageWriteJob(): Promise<{ id: number; data: Record<string, unknown> }> {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, PAGE);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: PAGE, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  const published = await publishMutation(engine, row, await preparePageMutation(engine, row, config));
  expect(published.outcome?.facts_backstop).toEqual({ queued: true });
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
  const effect = (await claimPersistenceEffect(engine, localHostId()))!;
  expect(effect.kind).toBe('facts-backstop');
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const [job] = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id,data FROM minion_jobs WHERE name='facts-absorb'");
  return job;
}

async function scenario(managed: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-6333-put-page-'));
  try {
    await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: 'test' }, async () => {
      await resetPgliteState(engine);
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
      await engine.setConfig('embedding_dimensions', String(DIMS));
      await registerLocalWriter(engine, 'cli');
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a person.', timeline: '', frontmatter: {} });
      await engine.insertFact({ fact: 'Alice Example leads the platform team at the example company', entity_slug: ENTITY, kind: 'fact',
        visibility: 'private', source: 'mcp:put_page', source_session: SESSION, embedding: Float32Array.from(vector()),
        embedding_model: 'openai:text-embedding-3-small' }, { source_id: 'default' });
      const job = await pageWriteJob();
      expect(job.data.sessionId).toBe(SESSION);
      if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: JSON.stringify({ facts: [{ fact: 'Alice Example is the lead of the example company platform team', kind: 'fact', entity: ENTITY, confidence: 1, notability: 'high' }] }),
        blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test',
      }));
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => reworded()) })) as never);
      const result = await makeFactsAbsorbHandler(engine)({ id: job.id, name: 'facts-absorb', data: job.data, signal: new AbortController().signal } as never) as Record<string, unknown>;
      expect(result.would_dedup_same_page).toBe(1);
      const sessions = await engine.executeRaw<{ source_session: string | null }>(
        "SELECT source_session FROM facts WHERE source_id='default' AND entity_slug=$1 AND expired_at IS NULL ORDER BY id", [ENTITY]);
      expect(sessions.map(r => r.source_session)).toEqual([SESSION, SESSION]);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}

describe('#6333: a put_page re-extraction feeds the same-page shadow counter', () => {
  test('the page-write job carries put_page:<slug> and the unmanaged backstop counts the rewording', () => scenario(false), 120_000);
  test('the managed preparer counts the rewording from the page-write job', () => scenario(true), 120_000);
});
