/**
 * #6764 convergence: doctor `unlinked_facts` walks a conversation page's
 * unlinked facts through the free relink, then the paid re-extraction, then
 * the manual route, and stops there. The paid attempt is remembered per
 * (source, page, content hash), so a page re-extracted on its current
 * content is never offered the paid argv again until its content changes;
 * a miss `RELINK_REASONS` does not memoize (`no_page`) is re-armed by a page
 * created later. Hermetic: PGLite plus a zero-price stubbed chat transport.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';
import { runConversationRelink } from '../src/core/facts/conversation-relink.ts';
import { unlinkedFactsStats, unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';

const MODEL = 'litellm:zero-price-chat';
const MEETING = 'meetings/2026-08-12-lease-review';
const TRANSCRIPT = [
  '**Owner Example** (2026-08-12 10:00 AM): She signed the lease renewal yesterday.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, she starts in September.',
].join('\n');
const config = { engine: 'pglite', embedding_disabled: true } as never;

let engine: PGLiteEngine;
let chatCalls = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM fact_relink_attempts');
  resetGateway();
  configureGateway({ chat_model: MODEL, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    base_urls: { litellm: 'http://localhost:4000' }, env: { LITELLM_BASE_URL: 'http://localhost:4000', OPENAI_API_KEY: 'test' } });
  chatCalls = 0;
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return { text: JSON.stringify({ facts: [{ fact: 'She signed the lease renewal', kind: 'event', entity: null, confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'litellm' };
  });
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('pricing.overrides', JSON.stringify({ [MODEL]: { input: 0, output: 0 } }));
  await engine.setConfig('embedding.disabled', 'true');
  await engine.putPage(MEETING, { type: 'meeting' as never, title: 'Lease review', compiled_truth: TRANSCRIPT, timeline: '', frontmatter: { date: '2026-08-12' } });
});

async function legacyRow(fact: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
    VALUES ('default', NULL, $1, 'cli:extract-conversation-facts', $2, 0, $3, now(), now())`, [fact, `from ${MEETING} segment 2026-08-12`, MEETING]);
}

async function doctor() {
  const verdict = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
  return { verdict, conversation: (verdict.details as { conversation: { fix: string; slugs: string[] } | null }).conversation };
}

async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((s: unknown) => { lines.push(String(s)); });
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
  try { await runExtractConversationFacts(engine, argv); } finally { log.mockRestore(); err.mockRestore(); exit.mockRestore(); }
  return lines.join('\n');
}

test('free, then paid, then by hand: once the page was re-extracted on its content, doctor offers no paid argv again', async () => {
  await legacyRow('She signed the lease renewal');
  expect((await doctor()).conversation).toMatchObject({ fix: 'relink', slugs: [MEETING] });
  expect(await runConversationRelink(engine, config, { sourceId: 'default' })).toMatchObject({ linked: 0, unresolved: 1 });

  const paid = await doctor();
  expect(paid.conversation).toMatchObject({ fix: 'reextract', slugs: [MEETING] });
  const out = await run(paid.verdict.fix!.argv!.slice(2).map(a => a === '<N>' ? '1' : a));
  expect(out).toContain('Spent ~$0.0000');
  expect(chatCalls).toBeGreaterThan(0);

  for (let step = 0; step < 3; step++) {
    const d = await doctor();
    if (d.conversation?.fix !== 'relink') break;
    await runConversationRelink(engine, config, { sourceId: 'default', slugs: d.conversation.slugs });
  }
  const done = await doctor();
  expect(done.conversation).toMatchObject({ fix: 'manual', slugs: [MEETING] });
  expect(done.verdict.fix).toBeUndefined();
  expect(done.verdict.message).toContain('remember it again with --entity');
  expect(JSON.stringify(done.verdict)).not.toContain('extract-conversation-facts --source-id');
  const calls = chatCalls;
  expect(await runConversationRelink(engine, config, { sourceId: 'default' })).toMatchObject({ pages: [] });
  expect((await doctor()).conversation).toMatchObject({ fix: 'manual' });
  expect(chatCalls).toBe(calls);
});

test('a no_page miss is re-armed for the free relink by creating the entity page', async () => {
  await legacyRow('Carol Example joined the board');
  expect(await runConversationRelink(engine, config, { sourceId: 'default' })).toMatchObject({ linked: 0, unresolved: 1 });
  expect(await engine.executeRaw<{ reason: string }>('SELECT reason FROM fact_relink_attempts')).toEqual([{ reason: 'no_page' }]);
  expect((await doctor()).conversation).toMatchObject({ fix: 'reextract' });

  await engine.putPage('people/carol-example', { type: 'person' as never, title: 'Carol Example', compiled_truth: '# Carol Example', timeline: '', frontmatter: {} });
  const rearmed = await doctor();
  expect(rearmed.conversation).toMatchObject({ fix: 'relink', slugs: [MEETING] });
  expect(await runConversationRelink(engine, config, { sourceId: 'default', slugs: rearmed.conversation!.slugs })).toMatchObject({ linked: 1, unresolved: 0 });
  expect((await doctor()).conversation).toBeNull();
  expect(chatCalls).toBe(0);
});

test('changing the transcript content re-arms the paid fallback', async () => {
  await legacyRow('She signed the lease renewal');
  await runConversationRelink(engine, config, { sourceId: 'default' });
  await run((await doctor()).verdict.fix!.argv!.slice(2).map(a => a === '<N>' ? '1' : a));
  await runConversationRelink(engine, config, { sourceId: 'default' });
  expect((await doctor()).conversation).toMatchObject({ fix: 'manual' });

  await engine.putPage(MEETING, { type: 'meeting' as never, title: 'Lease review', compiled_truth: `${TRANSCRIPT}\n**Owner Example** (2026-08-12 10:02 AM): The keys are ready.`, timeline: '', frontmatter: { date: '2026-08-12' } });
  const changed = await doctor();
  expect(changed.conversation).toMatchObject({ fix: 'reextract', slugs: [MEETING] });
  expect(changed.verdict.fix!.argv).toContain('--max-cost-usd');
});
