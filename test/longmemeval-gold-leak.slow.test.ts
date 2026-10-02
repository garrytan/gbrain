/**
 * LongMemEval gold-label leak guard. Every gold session id in the public
 * dataset starts with `answer_` and no distractor does, so a raw id anywhere
 * the system or the reader can see it is a free label. The harness must hand
 * the brain and the reader opaque per-question ids only, and still score on
 * the raw ids through its private slug→raw map.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { generateAnswer } from '../src/eval/longmemeval/reader.ts';
import { buildSlugToRawMap } from '../src/eval/longmemeval/metrics.ts';
import { makeStubClient } from './helpers/longmemeval-stub.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SearchResult } from '../src/core/types.ts';

const LEAK = /answer[_-]/i;
const GOLD = 'answer_1a2b3c4d_1';

const QUESTION: LongMemEvalQuestion = {
  question_id: 'leak-1',
  question_type: 'single-session-user',
  question: 'what did alice-example want to buy for the river trip',
  answer: 'a kayak',
  haystack_session_ids: ['sharegpt_Xyz_0', GOLD, '9f8e7d6c_2'],
  haystack_dates: ['2024/01/01 (Mon) 10:00', '2024/01/02 (Tue) 10:00', '2024/01/03 (Wed) 10:00'],
  haystack_sessions: [
    [{ role: 'user', content: 'Placeholder about widget-co invoices.' }, { role: 'assistant', content: 'Placeholder reply about invoices.' }],
    [{ role: 'user', content: 'alice-example wants to buy a kayak for the river trip.' }, { role: 'assistant', content: 'A kayak is a fine choice for a river trip.' }],
    [{ role: 'user', content: 'Placeholder about fund-a reserves.' }, { role: 'assistant', content: 'Placeholder reply about reserves.' }],
  ],
  answer_session_ids: [GOLD],
};

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = await createBenchmarkBrain();
  tmp = mkdtempSync(join(tmpdir(), 'lme-gold-leak-'));
});
afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe('LongMemEval gold-label leak', () => {
  test('adapter pages carry no raw session id in slug or content', () => {
    for (const page of haystackToPages(QUESTION)) {
      expect(page.slug).not.toMatch(LEAK);
      expect(page.content).not.toMatch(LEAK);
      expect(page.slug).toMatch(/^chat\/s-[0-9a-f]{10}$/);
    }
  });

  test('reader request carries no raw session id', async () => {
    const pages = haystackToPages(QUESTION);
    const results = pages.map((p, i) => ({ slug: p.slug, chunk_text: p.content, chunk_id: i + 1, score: 1 - i / 10 }) as SearchResult);
    const { client, calls } = makeStubClient('a kayak');
    await generateAnswer(client, QUESTION, results, pages, buildSlugToRawMap(QUESTION), 'anthropic:claude-sonnet-4-6');
    expect(calls.length).toBe(1);
    expect(calls[0].userText).toContain('<chat_session id="s-');
    expect(calls[0].system + calls[0].userText).not.toMatch(LEAK);
  });

  test('harness run: brain rows and reader prompt are opaque, scoring still joins on raw gold ids', async () => {
    const fixture = join(tmp, 'leak.jsonl');
    writeFileSync(fixture, JSON.stringify(QUESTION) + '\n', 'utf8');
    const out = join(tmp, 'leak-out.jsonl');
    const { client, calls } = makeStubClient('a kayak');
    await runEvalLongMemEval([fixture, '--keyword-only', '--no-trajectory', '--top-k', '3', '--output', out], { client, engine });

    expect(calls.length).toBe(1);
    expect(calls[0].userText).toContain('kayak');
    expect(calls[0].system + calls[0].userText).not.toMatch(LEAK);

    const pages = await engine.executeRaw<{ slug: string; title: string; compiled_truth: string; frontmatter: unknown }>(
      `SELECT slug, title, compiled_truth, frontmatter FROM pages`,
    );
    expect(pages.length).toBe(3);
    for (const p of pages) expect(JSON.stringify(p)).not.toMatch(LEAK);
    const chunks = await engine.executeRaw<{ chunk_text: string }>(`SELECT chunk_text FROM content_chunks`);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.chunk_text).not.toMatch(LEAK);

    const row = JSON.parse(readFileSync(out, 'utf8').split('\n').filter(Boolean)[0]);
    expect(row.recall_all_hit).toBe(true);
    expect(row.retrieved[0].session_id).toBe(GOLD);
  }, 120_000);
});
