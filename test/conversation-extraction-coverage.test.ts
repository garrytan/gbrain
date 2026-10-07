/**
 * Input coverage through the real conversation core and strict extractor.
 * Only chat/embedding transports are scripted; parser, selection, persistence,
 * outcomes and replay are production code. No real model or brain is used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { runExtractConversationFactsCore, TERMINAL_AUDIT_SOURCE } from '../src/commands/extract-conversation-facts.ts';
import { MAX_TURN_TEXT_CHARS } from '../src/core/facts/extract.ts';

const TAIL = 'FINAL_RESULT_SENTINEL: 153 tests passed, zero failures.';
const text = (n: number) => 'ordinary context sentence. '.repeat(n);
const line = (speaker: string, i: number, body: string) =>
  `**${speaker}** (2026-05-05 12:${String(i).padStart(2, '0')} PM): ${body}`;
const bodyOf = (messages: string[]) => messages.map((body, i) =>
  line(i % 2 || i === messages.length - 1 ? 'Assistant' : 'User', i, body)).join('\n');

describe('conversation extraction input coverage', () => {
  let engine: PGLiteEngine;
  let inputs: string[] = [];
  let failureAt = 0;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setChatTransportForTests(async opts => {
      const input = String(opts.messages[0]?.content ?? '');
      inputs.push(input);
      if (failureAt && inputs.length === failureAt) throw new Error('synthetic window failure');
      return {
        text: JSON.stringify({ facts: input.includes(TAIL) ? [{
          fact: TAIL, kind: 'event', confidence: 1, notability: 'high', attributed_to: 'assistant',
        }] : [] }),
        blocks: [], stopReason: 'end', model: opts.model!, providerId: 'stub',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
    })) as never);
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM facts');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw('DELETE FROM op_checkpoints');
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    inputs = [];
    failureAt = 0;
  });
  async function put(messages: string[], title = 'Synthetic coverage fixture') {
    await engine.putPage('conversations/coverage', {
      type: 'conversation', title, compiled_truth: bodyOf(messages), timeline: '',
      frontmatter: { date: '2026-05-05' },
    }, { sourceId: 'default' });
    expect(await engine.getPage('conversations/coverage', { sourceId: 'default' })).not.toBeNull();
  }
  const run = (more = {}) => runExtractConversationFactsCore(engine, {
    sourceId: 'default', slug: 'conversations/coverage', sleepMs: 0, ...more,
  });
  const rows = () => engine.executeRaw<{ fact: string; attributed_to: string; valid_from: string }>(
    'SELECT fact, attributed_to, valid_from FROM facts WHERE source = $1',
    ['cli:extract-conversation-facts'],
  );
  async function expectTail() {
    expect(inputs.some(input => input.includes(TAIL))).toBe(true);
    const facts = await rows();
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe(TAIL);
    expect(facts[0].attributed_to).toBe('assistant');
    expect(new Date(facts[0].valid_from).toISOString().slice(0, 10)).toBe('2026-05-05');
    for (const input of inputs) expect(input.length).toBeLessThanOrEqual(MAX_TURN_TEXT_CHARS);
  }
  test('short conversation remains one call and retains final result', async () => {
    await put(['Test started.', TAIL]);
    expect((await run()).pages_processed).toBe(1);
    expect(inputs).toHaveLength(1);
    await expectTail();
  });
  test('final result after a dense segment reaches the strict provider and facts', async () => {
    await put([text(270), TAIL]);
    expect((await run()).pages_processed).toBe(1);
    await expectTail();
  });
  test('a single oversized turn retains its own ending and the following reply', async () => {
    await put([text(600) + 'LONG_TURN_END', TAIL]);
    expect((await run()).pages_processed).toBe(1);
    expect(inputs.join('\n')).toContain('LONG_TURN_END');
    expect(inputs.filter(input => input.includes('User (2026-05-05T12:00:00'))).toHaveLength(3);
    await expectTail();
  });
  test('31-message size boundary never discards the final reply', async () => {
    await put(Array.from({ length: 31 }, (_, i) => i === 30 ? TAIL : 'Ordinary brief message.'));
    expect((await run()).pages_processed).toBe(1);
    await expectTail();
  });
  test('preview counts all windows; a limited run cannot certify an unseen tail', async () => {
    await put([text(600), TAIL]);
    const preview = await run({ dryRun: true });
    expect(preview.segments_processed).toBeGreaterThan(1);
    expect(inputs).toHaveLength(0);
    await run({ segmentLimit: 1 });
    expect(inputs.join('\n')).not.toContain(TAIL);
    const terminals = await engine.executeRaw('SELECT id FROM facts WHERE source = $1', [TERMINAL_AUDIT_SOURCE]);
    expect(terminals).toHaveLength(0);
    inputs = [];
    await run();
    await expectTail();
    inputs = [];
    expect((await run()).pages_skipped_completed).toBe(1);
    expect(inputs).toHaveLength(0);
  });
  test('later window failure leaves page unfinished and retry reaches the tail', async () => {
    await put([text(600), TAIL]);
    failureAt = 2;
    await expect(run()).rejects.toThrow('synthetic window failure');
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source = $1', [TERMINAL_AUDIT_SOURCE])).toHaveLength(0);
    failureAt = 0;
    inputs = [];
    await run();
    await expectTail();
  });
  test('a completed legacy page is corrected only with explicit scoped force', async () => {
    await put([text(270), TAIL]);
    // Seed through the native caller seam as an earlier successful zero-fact run.
    await run({ extractor: async () => [] });
    inputs = [];
    expect((await run()).pages_skipped_completed).toBe(1);
    expect(inputs).toHaveLength(0);
    await run({ force: true });
    await expectTail();
    inputs = [];
    expect((await run()).pages_skipped_completed).toBe(1);
    expect(inputs).toHaveLength(0);
  });
  test('every code point of a long turn reaches the caller without duplication', async () => {
    const original = '😀'.repeat(6_000) + ' END_OF_UNICODE_TURN';
    await put([original, TAIL]);
    const turns: string[] = [];
    await run({ extractor: async ({ turnText }: { turnText: string }) => { turns.push(turnText); return []; } });
    const pieces = turns.flatMap(turn => [...turn.matchAll(/^User \(2026-05-05T12:00:00Z\): (.*)$/gm)].map(m => m[1]));
    expect(pieces.join('')).toBe(original);
    for (const turn of turns) {
      expect(turn.length).toBeLessThanOrEqual(6_500);
      expect(turn).toContain('Conversation between User and Assistant');
      expect(turn).toContain('from 2026-05-05T12:00:00Z to 2026-05-05T12:01:00Z');
      expect(turn).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(turns.join('\n')).toContain(TAIL);
  });
  test('oversized metadata fails before model work or prior-fact cleanup', async () => {
    await put(['Test started.', TAIL], 'x'.repeat(6_500));
    await engine.insertFacts([{ fact: 'prior accepted fact', kind: 'fact', source: 'cli:extract-conversation-facts',
      source_markdown_slug: 'conversations/coverage', row_num: 0 }], { source_id: 'default' });
    await expect(run()).rejects.toThrow('header exceeds the input budget');
    expect(inputs).toHaveLength(0);
    expect((await rows()).map(f => f.fact)).toEqual(['prior accepted fact']);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source = $1', [TERMINAL_AUDIT_SOURCE])).toHaveLength(0);
  });
});
