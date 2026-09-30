/**
 * Fix wave 3 cross-lane check: Lane B's coordinated Google loop extraction on
 * Lane A's database-only connector source.
 *
 * Authoring gate. (1) Protects loop extraction on the default connector
 * layout: a Google source with a local path and no canonical owner syncs
 * database-only (`connector_database`), so extracting its commitments must
 * publish database-only too, not refuse for want of an owner. (2) Fails when
 * the shared facts session demands a canonical owner for a connector source,
 * as it did before this integration (`owner_unavailable` before extraction).
 * (3) test/managed-facts-writers.test.ts runs loop extraction on a bound
 * filesystem source only. (4) The chat model is the gateway's process-global
 * transport seam, so this file is serial.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
beforeAll(fixture.setup, 120_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await fixture.teardown(); });

test('loop extraction on a database-only connector source lands its commitment fact through the coordinator', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ commitments: [{ text: 'Send the deck by Friday', direction: 'owed_by_me',
    counterparty_name: 'people/alice-example', counterparty_email: '', due_iso: '2026-10-02', quote: 'I will send the deck by Friday.' }], decisions_pending: [] }),
  blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    await engine.setConfig('loops.extraction_enabled', 'true');
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: f.id, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = (slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
    await put('people/alice-example', '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n');
    await put('emails/example', '---\ntitle: Synthetic exchange\ntype: email\nthread_id: example\nfrom: sender@example.invalid\n---\nI will send the deck by Friday.\n');
    const result = await runLoopsExtract(engine, { slug: 'emails/example', sourceId: f.id });
    expect(result).toMatchObject({ status: 'extracted', commitments: 1 });
    const rows = await engine.executeRaw<{ fact: string }>(
      "SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.entity_slug='people/alice-example' AND f.expired_at IS NULL", [f.id]);
    expect(rows.map(r => r.fact)).toEqual(['Send the deck by Friday']);
    expect(await engine.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1', [f.id])).toHaveLength(0);
    await disposePersistenceConsumer(engine);
  }
}), 180_000);
