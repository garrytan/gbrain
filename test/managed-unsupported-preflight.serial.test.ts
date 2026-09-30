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
const { withSubmissionAuthority } = await import('../src/core/minions/submission-authority.ts');
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

// #5280: these writers publish through the coordinator on a managed brain
// (test/managed-facts-writers.test.ts). What stays pinned here is the order:
// a caller the coordinator cannot accept refuses before any provider work.
const remoteJob = <T>(fn: () => Promise<T>) => withSubmissionAuthority({ version: 1, kind: 'remote_generic' } as never, fn);

test('managed Google loop extraction refuses an unaccepted writer before chat while unmanaged extraction remains usable', async () => withEnv(env, async () => {
  chatCalls = 0;
  await expect(remoteJob(() => runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' }))).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(chatCalls).toBe(0);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    expect((await runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' })).status).toBe('extracted');
    expect(chatCalls).toBe(1);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}));

test('managed bulk conversation extraction and fence reconciliation refuse an unaccepted writer before either preview or execution providers', async () => withEnv(env, async () => {
  let extractions = 0;
  for (const dryRun of [false, true]) {
    await expect(remoteJob(() => runExtractConversationFactsCore(engine, {
      sourceId: 'default', dryRun, overrideDisabled: true,
      extractor: async () => { extractions++; return []; },
    }))).rejects.toMatchObject({ code: 'permission_denied' });
  }
  expect(extractions).toBe(0);
  await expect(remoteJob(() => runExtractFacts(engine, { sourceId: 'default' }))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
}));

test('bulk phase records an unaccepted writer per source before provider work but disabled gates retain their skip semantics', async () => withEnv(env, async () => {
  chatCalls = 0;
  const phase = await remoteJob(() => runPhaseConversationFactsBackfill(engine));
  expect(phase.status).toBe('warn');
  expect((phase.details.per_source as Record<string, { error?: string }>).default.error).toMatch(/local writer/);
  expect(chatCalls).toBe(0);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'false');
  await engine.setConfig('loops.extraction_enabled', 'false');
  expect((await runPhaseConversationFactsBackfill(engine)).status).toBe('skipped');
  expect((await runLoopsExtract(engine, { slug: 'emails/example', sourceId: 'default' })).reason).toBe('extraction_disabled');
  expect(chatCalls).toBe(0);
}));

test('writer status and activation preview report no unsupported bulk capabilities without changing them', async () => withEnv(env, async () => {
  const before = await engine.executeRaw('SELECT * FROM persistence_brain');
  const status = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
  const activation = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, dry_run: true });
  expect(status.onboarding.unsupported_maintenance).toEqual([]);
  expect(activation.unsupported_maintenance).toEqual(status.onboarding.unsupported_maintenance);
  expect(await engine.executeRaw('SELECT * FROM persistence_brain')).toEqual(before);
}));
