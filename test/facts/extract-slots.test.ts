/**
 * GBRA-574: the conversation extractor's main call sends the historical prompt and response schema, with no slot.
 *
 * Protects: asking the main extraction call for a per-fact slot made it save fewer facts (about 15% fewer wishes,
 * preferences and ideas on two public dev worlds), so the call's system prompt stays byte-identical to the historical one
 * for every variant (pinned by hash), its schema has no slot field, and a slot the model returns anyway is never stored.
 * Regression: a conversation extraction call that carries slot text or a slot field.
 * Slots come from the separate tagging call (slot-tagging.test.ts); the stub answers it with no slot.
 * Seams: gateway chat transport stub (no provider call), PGLite with no git repository.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { buildExtractorSystem } from '../../src/core/facts/extract.ts';
import { SLOT_TAG_SYSTEM } from '../../src/core/facts/slot-tagging.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** buildExtractorSystem before GBRA-574 B2, by (admitsLow, variant). */
const HISTORICAL: Array<[boolean, { dateGrounding?: boolean; attribution?: boolean }, string]> = [
  [true, {}, 'a4b468b86e867f3703a4c834583f5ac9a99f47ff4f0c50484fdd6b22706465c7'],
  [true, { dateGrounding: true }, 'd49e4a26fe594b8a4445172c736b1c7407af9fb55c20c7f7f9dce05e068bcd64'],
  [true, { attribution: true }, '525370d677f35fa2bd331c6ceff0be0fcd28b02e6478c9e869380699e139d8d2'],
  [true, { dateGrounding: true, attribution: true }, 'd500e15bf4e0b089cceb014018bbb157e281de76eb1e4c769024c4e9e4630edd'],
  [false, {}, '5df290c0002bfc73371897c339e1a34e33caf844e3fb6d24b35c05d47e862ddf'],
  [false, { dateGrounding: true }, '77d490254802af74d683c3876cc087534c6a578f4f5275db3bd6698909929fb3'],
  [false, { attribution: true }, '364637bf592f858bad211525a4dcb9c2fd15e3ea8cba2af90acb109e1cd7875a'],
  [false, { dateGrounding: true, attribution: true }, '3b15e8a337a2557ed4b81255cf27a386069490d6209567c753942d310064eb25'],
];
const HISTORICAL_HASHES = new Set(HISTORICAL.map(([, , hash]) => hash));

const PAGE = 'conversations/2026-03-10/chat-example';
const BODY = [
  '**user** (2026-03-10 9:00 AM): Alice Example joined Acme Example as head of design last week.',
  '**assistant** (2026-03-10 9:01 AM): Good news for her.',
  '**user** (2026-03-10 9:02 AM): I want a quieter desk lamp for the study.',
].join('\n');

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('facts.default_visibility', 'world');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.putPage('people/alice-example', { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: {} });
  await engine.putPage(PAGE, { type: 'conversation' as never, title: 'Conversation 2026-03-10', compiled_truth: BODY, timeline: '', frontmatter: { date: '2026-03-10' } });
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

describe('conversation extraction main call', () => {
  test('every prompt variant is byte-identical to the historical one', () => {
    for (const [admitsLow, variant, hash] of HISTORICAL) expect(sha(buildExtractorSystem(admitsLow, variant))).toBe(hash);
  });

  test('sends the historical prompt and a schema with no slot, and stores no slot the model returns anyway', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      if (opts.system === SLOT_TAG_SYSTEM) return { text: '{"slots":[]}', blocks: [{ type: 'text', text: '{"slots":[]}' }], stopReason: 'end', model: 'test:stub',
        providerId: 'test', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
      seen.push(opts);
      const text = JSON.stringify({ facts: [
        { fact: 'Alice Example joined Acme Example as head of design.', kind: 'fact', entity: 'people/alice-example', confidence: 1,
          notability: 'high', slot: ['role', 'head of design'] },
        { fact: 'User wants a quieter desk lamp for the study.', kind: 'preference', entity: null, confidence: 1, notability: 'high' },
      ] });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
    });
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [PAGE], sleepMs: 0, overrideDisabled: true });
    } finally { spy.mockRestore(); }
    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) {
      expect(HISTORICAL_HASHES.has(sha(opts.system as string))).toBe(true);
      expect(opts.system as string).not.toContain('slot');
      expect(JSON.stringify(opts.responseSchema ?? null)).not.toContain('slot');
    }
    const rows = await engine.executeRaw<{ fact: string; dimension: string | null }>(
      'SELECT fact, dimension FROM facts WHERE source_markdown_slug = $1 ORDER BY id', [PAGE]);
    expect(rows.map(row => row.fact)).toEqual([
      'Alice Example joined Acme Example as head of design.', 'User wants a quieter desk lamp for the study.', 'EXTRACTION_COMPLETE']);
    for (const row of rows) expect(row.dimension).toBeNull();
  });
});
