/**
 * #7500: conversation_facts_backfill reports the pages a managed run left
 * accepted and still publishing.
 *
 * Protects: when a managed batch is still pending after the job's write wait,
 * the phase summary and `details.pages_pending` say so, instead of a bare
 * "0 facts inserted" while the accepted batch commits its facts afterwards.
 * Fails when: the phase aggregate drops the per-source `pages_pending`.
 * Why new: managed-facts-writers covers a batch that commits within the wait only.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testWaitMs } from './helpers/wait-for.ts';

const SLUG = 'conversations/synthetic-chat';
const CONVERSATION = `---\ntitle: Synthetic chat\ntype: conversation\n---\n${[
  '**Alice Example** (2024-03-15 9:00 AM): I just signed the offer letter for Acme Corp.',
  '**Bob Demo** (2024-03-15 9:01 AM): Congrats! What is the title?',
  '**Alice Example** (2024-03-15 9:02 AM): Staff engineer on the platform team.',
].join('\n')}\n`;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ facts: [{ fact: 'Alice Example joined Acme Corp.', kind: 'event', entity: null, confidence: 1, notability: 'high' }] }),
    blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
});
afterEach(() => { installFaultHook(undefined); });
afterAll(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });

const extractorFacts = async (engine: BrainEngine) => (await engine.executeRaw<{ fact: string }>(
  "SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' ORDER BY row_num", [SLUG])).map(r => r.fact);

test('#7500: a managed batch still pending after the wait is reported as pending, then commits its facts', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: CONVERSATION } });
    await disposePersistenceConsumer(engine);

    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
    const restore = __setMaintenanceWriteWaitForTests(testWaitMs(300));
    let phase: Awaited<ReturnType<typeof runPhaseConversationFactsBackfill>>;
    try {
      phase = await runPhaseConversationFactsBackfill(engine);
    } finally { release(); restore(); }
    expect(phase.details).toMatchObject({ facts_inserted: 0, pages_pending: 1 });
    expect(phase.summary).toContain('1 page(s) accepted and still publishing; their facts commit after this run and are not counted here');

    const open = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state NOT IN ('committed','failed','cancelled')");
    for (const row of open) expect((await waitForWrite(engine, row, { engine: engine.kind }, testWaitMs(20_000))).state).toBe('committed');
    expect(await extractorFacts(engine)).toEqual(['Alice Example joined Acme Corp.', 'EXTRACTION_COMPLETE']);
  });
}, 120_000);
