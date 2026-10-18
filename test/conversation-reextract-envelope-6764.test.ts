/**
 * #6764 envelope fixture for the paid conversation fix: after the free
 * conversation relink has tried a page's unlinked facts and could not resolve
 * one, doctor `unlinked_facts` offers the paid re-extraction. Its
 * `preview_argv` names the target page and writes nothing (no model call);
 * its real `argv`, with the approved amount `N` filled in, runs through the
 * CLI against a zero-price stubbed provider and the verify check clears.
 * Hermetic: PGLite plus gateway test transports; no network or keys.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';
import { runConversationRelink } from '../src/core/facts/conversation-relink.ts';
import { unlinkedFactsStats, unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';

const MODEL = 'litellm:zero-price-chat';
const MEETING = 'meetings/2026-08-12-lease-review';
const TRANSCRIPT = [
  '**Owner Example** (2026-08-12 10:00 AM): Alice Example signed the lease renewal yesterday.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, she starts in September.',
].join('\n');
const config = { engine: 'pglite', embedding_disabled: true } as never;

let engine: PGLiteEngine;
let chatCalls = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  resetGateway();
  configureGateway({ chat_model: MODEL, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    base_urls: { litellm: 'http://localhost:4000' }, env: { LITELLM_BASE_URL: 'http://localhost:4000', OPENAI_API_KEY: 'test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return { text: JSON.stringify({ facts: [{ fact: 'Alice Example signed the lease renewal', kind: 'event', entity: 'people/alice-example', confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'litellm' };
  });
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('pricing.overrides', JSON.stringify({ [MODEL]: { input: 0, output: 0 } }));
  await engine.setConfig('embedding.disabled', 'true');
  await engine.putPage(MEETING, { type: 'meeting' as never, title: 'Lease review', compiled_truth: TRANSCRIPT, timeline: '', frontmatter: { date: '2026-08-12' } });
  await engine.putPage('people/alice-example', { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: {} });
  // An older extractor stored this fact with no entity; no entity page is named in it, so the free relink cannot resolve it.
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
    VALUES ('default', NULL, 'She signed the lease renewal', 'cli:extract-conversation-facts', $1, 0, $2, now(), now())`, [`from ${MEETING} segment 2026-08-12`, MEETING]);
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

const facts = () => engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; expired_at: string | null }>(
  'SELECT id, fact, entity_slug, expired_at FROM facts ORDER BY id');

async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((s: unknown) => { lines.push(String(s)); });
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
  try { await runExtractConversationFacts(engine, argv); } finally { log.mockRestore(); err.mockRestore(); exit.mockRestore(); }
  return lines.join('\n');
}

test('free pass, then the paid fix: preview names its target and writes nothing; the filled argv runs at zero price and verify clears', async () => {
  expect(await runConversationRelink(engine, config, { sourceId: 'default' })).toMatchObject({ linked: 0, unresolved: 1 });
  const before = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
  const fix = before.fix!;
  expect(before.details).toMatchObject({ conversation: { fix: 'reextract', slugs: [MEETING] } });
  expect(fix).toMatchObject({ consent: ['paid', 'egress'], ask_user: true, inputs: [{ name: 'N' }] });
  expect(renderAction(fix as never, cliRenderContext()).next).toBe('ask_user');

  const untouched = await facts();
  const preview = await run(fix.preview_argv!.slice(2));
  expect(preview).toContain('(dry run)');
  expect(preview).toContain(`Targets: ${MEETING}`);
  expect(chatCalls).toBe(0);
  expect(await facts()).toEqual(untouched);

  const out = await run(fix.argv!.slice(2).map(a => a === '<N>' ? '1' : a));
  expect(out).toContain('Spent ~$0.0000');
  expect(chatCalls).toBeGreaterThan(0);
  const live = (await facts()).filter(f => f.expired_at === null && !f.fact.startsWith('EXTRACTION_'));
  expect(live.map(f => [f.fact, f.entity_slug])).toEqual([['Alice Example signed the lease renewal', 'people/alice-example']]);

  const after = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
  expect(after.fix).toBeUndefined();
  expect((after.details as { conversation: unknown }).conversation).toBeNull();
});
