/**
 * #5362: a facts-absorb job whose facts write is refused by the write path
 * (here: the fence file sits in a claimed canonical worktree before
 * activation, so the legacy filesystem guard refuses) records the real code in
 * ingest_log (`write_refused: writer_coordinator_required …`, not "provider
 * request failed") and dead-letters on the first attempt instead of
 * re-running inference before the same refusal. The claimed root is checked
 * before extraction, so the refusal costs no model call.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { writeFactsAbsorbFailure, writeRefusalCode } from '../src/core/facts/absorb-log.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-absorb-refusal-'));
let chatCalls = 0;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return { text: JSON.stringify({ facts: [{ fact: 'Prefers weekly status reports.', kind: 'preference', entity: 'people/alice-example', confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
  await disposePersistenceConsumer(engine); await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const absorbRows = (slug: string) => engine.executeRaw<{ summary: string }>(
  "SELECT summary FROM ingest_log WHERE source_type='facts:absorb' AND source_ref=$1 ORDER BY id", [slug]);

test('a claimed-worktree refusal is logged with its code and dead-letters without retry', async () => {
  const root = join(dir, 'brain'); mkdirSync(join(root, 'people'), { recursive: true });
  const body = 'Alice Example runs the weekly review and prefers written status updates over meetings. '.repeat(12);
  writeFileSync(join(root, 'people/alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example.\n');
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes/weekly-review.md'), `---\ntitle: Weekly review\ntype: note\n---\n${body}\n`);
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['claimed-example', root]);
    await engine.setConfig('sync.write_through', 'true');
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example.' }, { sourceId: 'claimed-example' });
    await engine.putPage('notes/weekly-review', { type: 'note', title: 'Weekly review', compiled_truth: body }, { sourceId: 'claimed-example' });
    await claimWorktree(engine, 'claimed-example', root);
    const handler = makeFactsAbsorbHandler(engine);
    const error = await handler({ id: 4242, name: 'facts-absorb', data: { slug: 'notes/weekly-review', sourceId: 'claimed-example', source: 'sync:import' } } as never)
      .catch((e: Error) => e) as Error;
    // The bound-root precheck refuses before any inference is paid for.
    expect(chatCalls).toBe(0);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('facts_absorb_write_refused (writer_coordinator_required)');
    expect(error.message).toContain('foresights jobs retry 4242');
    expect(error.message).toContain('docs/guides/write-refusals.md#facts_absorb_write_refused');
    const rows = await absorbRows('notes/weekly-review');
    expect(rows.at(-1)?.summary).toStartWith('write_refused: writer_coordinator_required (OperationError)');
    expect(rows.map(r => r.summary).join('\n')).not.toContain('provider request failed');
  });
}, 60_000);

test('only provider-class failures say "provider request failed"; write refusals carry their own code', async () => {
  await writeFactsAbsorbFailure(engine, 'notes/refused', new OperationError('permission_denied', 'The grant does not cover this source.'));
  await writeFactsAbsorbFailure(engine, 'notes/parse', new Error('Unexpected token in JSON at position 3'));
  expect((await absorbRows('notes/refused'))[0].summary).toBe('write_refused: permission_denied (OperationError): The grant does not cover this source.');
  expect((await absorbRows('notes/parse'))[0].summary).not.toContain('provider request failed');
  expect(writeRefusalCode(new Error('plain'))).toBeNull();
});
