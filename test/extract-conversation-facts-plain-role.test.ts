/**
 * Conversation-facts extraction over plain role-prefixed transcripts
 * (`user: ...` / `assistant: ...`, the form agents and harnesses write) and
 * the bold form (`**User:** ...`), plus partial-success accounting: a run
 * where some pages fail lists them and exits 0; only a run where every
 * attempted page failed exits nonzero. Injected extractor; no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { extractExitCode, extractRunStatus, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';

const PLAIN = [
  'user: I moved to Lisbon last month for the new job.',
  'assistant: Congratulations! How is the new job going?',
  'user: Great, I lead the platform team now.',
  'Most days I start at eight.',
  'assistant: That sounds like a big step.',
].join('\n');
const BOLD = PLAIN.replace(/^(user|assistant):/gm, (_, role: string) => `**${role[0]!.toUpperCase()}${role.slice(1)}:**`);
const fact = (text: string): ExtractedFact => ({ fact: text, kind: 'fact', entity_slug: null, source: 'test', source_session: null, confidence: 1, notability: 'medium' });

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
});

const seed = (slug: string, body: string) => engine.putPage(slug, { type: 'conversation', title: slug, compiled_truth: body, timeline: '', frontmatter: { date: '2026-03-01' } });

describe('plain role-prefixed transcripts', () => {
  test('parse with both roles and multi-line bodies; the bold form still parses', () => {
    const plain = parseConversation(PLAIN, { page: { slug: 'chat/plain', frontmatter: { date: '2026-03-01' }, compiled_truth: PLAIN } as never });
    expect(plain.matched_pattern_id).toBe('plain-role-no-time');
    expect(plain.messages.map(m => m.speaker)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(plain.messages[2]!.text).toContain('Most days I start at eight.');
    const bold = parseConversation(BOLD, { page: { slug: 'chat/bold', frontmatter: { date: '2026-03-01' }, compiled_truth: BOLD } as never });
    expect(bold.messages).toHaveLength(4);
  });

  test('an article with one illustrative pair deep inside is not a transcript', () => {
    // Past the five-line preamble guard the pair gets no continuation immunity, so plain density (2 of 62 lines) is under the 5% floor.
    const article = [...Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about how chat assistants work in practice.`), 'user: hello', 'assistant: hi'].join('\n');
    const r = parseConversation(article, { page: { slug: 'notes/article', frontmatter: {}, compiled_truth: article } as never });
    expect(r.matched_pattern_id).not.toBe('plain-role-no-time');
  });

  test('extract-conversation-facts extracts from plain and bold transcripts alike', async () => {
    await seed('sessions/plain', PLAIN);
    await seed('sessions/bold', BOLD);
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', types: ['conversation'], sleepMs: 0, extractor: async () => [fact('The user lives in Lisbon')] });
    expect(result.pages_skipped_unparsed).toBe(0);
    expect(result.pages_processed).toBe(2);
    expect(result.facts_inserted).toBeGreaterThanOrEqual(2);
  });
});

describe('partial success', () => {
  test('a run with some failed pages lists them and exits 0; a run where every page failed exits 1', async () => {
    await seed('sessions/ok', PLAIN);
    await seed('sessions/broken', BOLD.replace('Lisbon', 'Porto'));
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', types: ['conversation'], sleepMs: 0,
      extractor: async (input) => { if (input.turnText.includes('Porto')) throw new Error('synthetic provider outage'); return [fact('The user lives in Lisbon')]; },
    });
    expect(result).toMatchObject({ pages_processed: 1, pages_failed: 1 });
    expect(result.failed_pages).toEqual([{ slug: 'sessions/broken', error: expect.stringContaining('synthetic provider outage') }]);
    expect(extractRunStatus(result)).toBe('partial');
    expect(extractExitCode(result, 0)).toBe(0);
    expect(extractExitCode({ pages_processed: 0, pages_failed: 2 }, 0)).toBe(1);
    expect(extractExitCode({ pages_processed: 3, pages_failed: 0 }, 1)).toBe(1);
    expect(extractRunStatus({ pages_processed: 3, pages_failed: 0 })).toBe('ok');
  });
});
