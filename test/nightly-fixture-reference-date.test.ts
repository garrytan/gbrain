import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NIGHTLY_PROBE_FIXTURES } from '../src/core/cycle/nightly-probe-fixtures.ts';
import { generateAnswer, resolveReaderConfig } from '../src/eval/longmemeval/reader.ts';
import type { SearchResult } from '../src/core/types.ts';

const rows = readFileSync(NIGHTLY_PROBE_FIXTURES.longMemEval, 'utf8').trim().split('\n').map(line => JSON.parse(line));
afterEach(() => setSystemTime());

test('the nightly corpus pins a reference date after its evidence and keeps all ten question identities', () => {
  expect(rows.map(row => row.question_id)).toEqual(Array.from({ length: 10 }, (_, i) => `nightly-${i + 1}`));
  for (const row of rows) {
    expect(row.question_date).toBe('2025-08-31');
    for (const date of row.haystack_dates) expect(Date.parse(date)).toBeLessThanOrEqual(Date.parse(row.question_date));
  }
  // The explicit July and annual windows match the frozen evidence,
  // rather than a moving host clock that eventually contradicts the gold.
  expect(rows[1].haystack_dates.every((date: string) => date.startsWith('2025-07-'))).toBe(true);
  expect(rows[6].haystack_dates.every((date: string) => date.startsWith('2025-'))).toBe(true);
});

test.each(['2026-10-21T12:00:00Z', '2037-01-01T12:00:00Z'])('the actual reader receives the fixture date under host clock %s', async clock => {
  setSystemTime(new Date(clock));
  for (const row of rows) {
    let request: any;
    const client = { create: async (value: any) => {
      request = value;
      return { model: value.model, content: [{ type: 'text', text: 'test-only answer' }], stop_reason: 'end_turn' };
    } };
    const pages = row.haystack_sessions.map((session: Array<{ role: string; content: string }>, i: number) => ({
      slug: row.haystack_session_ids[i], date: row.haystack_dates[i],
      content: session.map(turn => `[${turn.role}] ${turn.content}`).join('\n'),
    }));
    const hits = pages.map((page: { slug: string; content: string }) => ({ slug: page.slug, chunk_text: page.content, score: 1, title: page.slug } as SearchResult));
    await generateAnswer(client as never, row, hits, pages, new Map(), 'test-only:model', '', resolveReaderConfig({ mode: 'direct' }));
    expect(request.messages[0].content).toContain('Current Date: 2025-08-31');
    expect(request.messages[0].content).toContain(row.question);
    expect(request.messages[0].content).toContain(pages[0].content.split('\n')[0].slice(7));
  }
});

test('the assistant-memory case asks for a recorded label without replacing its evidence or answer', () => {
  const row = rows[4];
  expect(row.question_type).toBe('single-session-assistant');
  expect(row.question).toContain('city label');
  expect(row.answer).toBe('placeholder-city');
  expect(row.haystack_sessions[0][1].role).toBe('assistant');
  expect(row.haystack_sessions[0][1].content).toContain(row.answer);
});
