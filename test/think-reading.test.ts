/**
 * think reads in a date frame.
 *
 * Protects: (1) the reader sees the current/reference date and each page's
 * content date, never a fallback row timestamp; (2) relative dates in a page
 * render in the brain's timezone; (3) invalid reference dates are refused.
 * Regression it catches: a reader answering "last month" questions with no
 * idea what today is.
 * Existing coverage: think-pipeline/think-pages-block tests never assert dates.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { renderPagesBlock } from '../src/core/think/gather.ts';
import { buildThinkSystemPrompt, buildThinkUserMessage } from '../src/core/think/prompt.ts';
import { pageContentDate, parseReferenceDate, ReferenceDateError } from '../src/core/think/temporal-context.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const imported = await importFromContent(engine, 'meetings/acme-example-pricing',
    '---\ntitle: Acme pricing review\ntype: meeting\ndate: 2026-09-15\n---\n\nWe agreed the enterprise plan costs 125 credits per month. Yesterday the team shipped the new invoice flow.',
    { noEmbed: true, sourceId: 'default' });
  expect(imported.status).toBe('imported');
});

afterAll(async () => {
  await engine.disconnect();
});

function stub(text: string, capture: { system?: string; user?: string; maxTokens?: number }, stopReason = 'end_turn'): ThinkLLMClient {
  return {
    create: async (params) => {
      capture.system = typeof params.system === 'string' ? params.system : JSON.stringify(params.system);
      const content = params.messages[0]?.content;
      capture.user = typeof content === 'string' ? content : JSON.stringify(content);
      capture.maxTokens = params.max_tokens;
      return {
        id: 'msg_reading', type: 'message', role: 'assistant', model: 'stub',
        stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text }],
      } as never;
    },
  };
}

describe('pageContentDate', () => {
  test('content-date sources render; fallback and created sources do not', () => {
    expect(pageContentDate({ effective_date: '2026-09-15T00:00:00.000Z', effective_date_source: 'date' }, 'UTC')).toBe('2026-09-15');
    expect(pageContentDate({ effective_date: '2026-09-15T00:00:00.000Z', effective_date_source: 'fallback' }, 'UTC')).toBeNull();
    expect(pageContentDate({ effective_date: '2026-09-15T00:00:00.000Z', effective_date_source: 'created' }, 'UTC')).toBeNull();
    expect(pageContentDate({ effective_date: null, effective_date_source: 'date' }, 'UTC')).toBeNull();
  });

  test('a timestamped date renders in the brain timezone; a day-only date renders as written', () => {
    expect(pageContentDate({ effective_date: new Date('2023-05-20T02:21:00Z'), effective_date_source: 'date' }, 'America/Los_Angeles')).toBe('2023-05-19');
    expect(pageContentDate({ effective_date: new Date('2023-05-20T00:00:00Z'), effective_date_source: 'date' }, 'America/Los_Angeles')).toBe('2023-05-20');
  });
});

describe('parseReferenceDate', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  test('accepts a past or current calendar day', () => {
    expect(parseReferenceDate('2023-05-30', 'UTC', now)).toBe('2023-05-30');
    expect(parseReferenceDate('2026-10-05', 'UTC', now)).toBe('2026-10-05');
  });
  test('refuses malformed, impossible and future dates', () => {
    expect(() => parseReferenceDate('2023/05/30', 'UTC', now)).toThrow(ReferenceDateError);
    expect(() => parseReferenceDate('2023-02-30', 'UTC', now)).toThrow(ReferenceDateError);
    expect(() => parseReferenceDate('2027-01-01', 'UTC', now)).toThrow(ReferenceDateError);
  });
});

describe('prompt shape', () => {
  test('page blocks carry content dates only', () => {
    const pages = [
      { slug: 'meetings/a', chunk_text: 'x', effective_date: '2026-09-15T00:00:00.000Z', effective_date_source: 'date' },
      { slug: 'notes/b', chunk_text: 'y', effective_date: '2026-09-20T10:00:00.000Z', effective_date_source: 'fallback' },
    ] as unknown as SearchResult[];
    const block = renderPagesBlock(pages, 100, '', { verbatim: true, timeZone: 'UTC' });
    expect(block).toContain('<page slug="meetings/a" rank="1" date="2026-09-15">');
    expect(block).toContain('<page slug="notes/b" rank="2">');
  });

  test('the current date sits just before the question in both message shapes; the system text stays date-free', () => {
    const plain = buildThinkUserMessage({ question: 'q?', pagesBlock: 'p', takesBlock: 't', currentDate: '2026-10-04 (UTC)' });
    expect(plain).toContain('Current date: 2026-10-04 (UTC)\nQuestion: q?');
    const calibrated = buildThinkUserMessage({
      question: 'q?', pagesBlock: 'p', takesBlock: 't', currentDate: '2026-10-04 (UTC)',
      calibration: { holder: 'garry', patternStatements: [], activeBiasTags: [] },
    });
    expect(calibrated).toContain('Current date: 2026-10-04 (UTC)\nQuestion: q?');
    const system = buildThinkSystemPrompt({ currentDate: true });
    expect(system).toContain('date="YYYY-MM-DD"');
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('runThink reading', () => {
  test('reference date and page date reach the reader', async () => {
    const cap: { system?: string; user?: string; maxTokens?: number } = {};
    const result = await runThink(engine, {
      question: 'What does the enterprise plan cost at acme-example?',
      client: stub(JSON.stringify({ answer: '125 credits per month [meetings/acme-example-pricing]', citations: [], gaps: [] }), cap),
      withTrajectory: false, remote: false, referenceDate: '2026-10-01',
    });
    expect(cap.user).toContain('Current date: 2026-10-01 (UTC)');
    expect(cap.user).toContain('date="2026-09-15"');
    expect(result.temporal).toEqual({ reference_date: '2026-10-01', time_zone: 'UTC' });
  });

  test('a future reference date is refused before any model call', async () => {
    let called = false;
    const client: ThinkLLMClient = { create: async () => { called = true; throw new Error('unreachable'); } };
    await expect(runThink(engine, { question: 'q', client, remote: false, referenceDate: '2999-01-01' })).rejects.toThrow(ReferenceDateError);
    expect(called).toBe(false);
  });
});
