import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

const gateway = await import('../src/core/ai/gateway.ts');
let chatCalls = 0;
mock.module('../src/core/ai/gateway.ts', () => ({
  ...gateway,
  isAvailable: (kind: string) => kind === 'chat',
  chat: async () => {
    chatCalls++;
    return { text: '{"commitments":[],"decisions_pending":[]}', stopReason: 'end' };
  },
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runLoopsExtract } = await import('../src/core/google/loops-extract.ts');
const { runExtractConversationFactsCore } = await import('../src/commands/extract-conversation-facts.ts');
const { runPhaseConversationFactsBackfill } = await import('../src/core/cycle/conversation-facts-backfill.ts');
const { runExtractFacts } = await import('../src/core/cycle/extract-facts.ts');
const { runPersistenceAdministration } = await import('../src/core/persistence/administration.ts');
const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-preflight-'));
const env = { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' };
let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.putPage('emails/example', { type: 'email', title: 'Synthetic exchange', compiled_truth: 'A generic follow-up exchange.', timeline: '', frontmatter: { thread_id: 'example', from: 'sender@example.invalid' } });
  await engine.setConfig('loops.extraction_enabled', 'true');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}), 120_000);

afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('unsupported Google loop writes refuse before chat while unmanaged extraction remains usable', async () => withEnv(env, async () => {
  chatCalls = 0;
  await expect(runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(chatCalls).toBe(0);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    expect((await runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' })).status).toBe('extracted');
    expect(chatCalls).toBe(1);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}));

test('unsupported bulk conversation extraction refuses before either preview or execution providers', async () => withEnv(env, async () => {
  let extractions = 0;
  for (const dryRun of [false, true]) {
    await expect(runExtractConversationFactsCore(engine, {
      sourceId: 'default', dryRun, overrideDisabled: true,
      extractor: async () => { extractions++; return []; },
    })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  }
  expect(extractions).toBe(0);
  await expect(runExtractFacts(engine, { sourceId: 'default' })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
}));

test('bulk phase refuses before provider work but disabled gates retain their skip semantics', async () => withEnv(env, async () => {
  chatCalls = 0;
  await expect(runPhaseConversationFactsBackfill(engine)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(chatCalls).toBe(0);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'false');
  await engine.setConfig('loops.extraction_enabled', 'false');
  expect((await runPhaseConversationFactsBackfill(engine)).status).toBe('skipped');
  expect((await runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' })).reason).toBe('extraction_disabled');
  expect(chatCalls).toBe(0);
}));

test('writer status and activation preview name unsupported bulk capabilities without changing them', async () => withEnv(env, async () => {
  const before = await engine.executeRaw('SELECT * FROM persistence_brain');
  const status = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
  const activation = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, dry_run: true });
  expect(status.onboarding.unsupported_maintenance).toEqual(['cycle.extract_facts', 'conversation_facts_backfill', 'loops_extract']);
  expect(activation.unsupported_maintenance).toEqual(status.onboarding.unsupported_maintenance);
  expect(await engine.executeRaw('SELECT * FROM persistence_brain')).toEqual(before);
}));
