/**
 * PR #5086 (@tarush1989), wave 14 P3.17: `think` derives a temporal window from exactly one explicit date in the
 * question when the caller passed no `since`/`until`, and says where the window came from.
 *
 * Protects: caller bounds stay authoritative; a question with one unambiguous ISO day, ISO month or "Month YYYY"
 * token is bounded to it and the result carries `window_source: 'question'` plus a `WINDOW_FROM_QUESTION` warning;
 * two distinct dates, a bare year, a relative phrase or an invalid token derive nothing (fail closed); caller bounds
 * report `window_source: 'caller'`; no window reports no field.
 * Seams: `resolveThinkWindow` (the resolver `runThink` calls), `runThink({ stubResponse })` on a PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runThink } from '../src/core/think/index.ts';
import { parseQuestionWindow, parseTemporalWindow, resolveThinkWindow } from '../src/core/think/temporal-window.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const win = (since: string, until?: string) => parseTemporalWindow(since, until)!;

describe('parseQuestionWindow: one explicit date, or nothing', () => {
  test('an ISO day, an ISO month and a month name with a year each bound the question to that span', () => {
    expect(parseQuestionWindow('what changed on 2026-09-15 exactly')).toEqual({ since: '2026-09-15', until: '2026-09-15' });
    expect(parseQuestionWindow('summarize 2026-09 for me')).toEqual({ since: '2026-09', until: '2026-09' });
    expect(parseQuestionWindow('meetings in September 2026')).toEqual({ since: '2026-09', until: '2026-09' });
    expect(parseQuestionWindow('SEPTEMBER 2026 recap (mid-september 2026)')).toEqual({ since: '2026-09', until: '2026-09' });
    expect(parseQuestionWindow('September 2026 (2026-09) plans')).toEqual({ since: '2026-09', until: '2026-09' });
  });

  test('fails closed: no token, a bare year, two distinct dates, an invalid or partial token, a relative phrase', () => {
    for (const q of ['what are my open commitments', 'what did GPT-4 in 2024 change', 'what happened in 2026', 'notes about v2026',
      'between September 2026 and October 2026', 'compare 2026-09-15 and 2026-09-22', 'September 2026 vs 2026-10',
      'the 2026-13 quarter', 'around 2026-9 sometime', 'Septober 2026 offsite', 'the 2026-02-30 meeting',
      'meetings next week', 'what happened in the last 7 days', '']) {
      expect(parseQuestionWindow(q)).toBeNull();
    }
  });
});

describe('resolveThinkWindow: caller bounds first', () => {
  test('any caller bound wins; both absent → the question; nothing → null', () => {
    expect(resolveThinkWindow('September 2026', '2020-01-01', '2020-12-31')).toEqual({ window: win('2020-01-01', '2020-12-31'), source: 'caller', since: '2020-01-01', until: '2020-12-31' });
    expect(resolveThinkWindow('September 2026', '2020-01-01', undefined)).toEqual({ window: win('2020-01-01'), source: 'caller', since: '2020-01-01', until: undefined });
    expect(resolveThinkWindow('September 2026', undefined, undefined)).toEqual({ window: win('2026-09', '2026-09'), source: 'question', since: '2026-09', until: '2026-09' });
    expect(resolveThinkWindow('open commitments', undefined, undefined)).toBeNull();
  });
});

describe('runThink reports the window and its origin', () => {
  let engine: PGLiteEngine;
  const stub = { answer: 'stubbed', citations: [], gaps: [] };
  beforeAll(async () => {
    __setEmbedTransportForTests(() => { throw new Error('keyword-only test'); });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const [slug, date] of [['brain/ops/2026-09-10', '2026-09-10'], ['brain/ops/2026-06-01', '2026-06-01']]) {
      const imported = await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: meeting\ndate: "${date}T09:00:00Z"\n---\n\noperations review notes\n`,
        { noEmbed: true, sourceId: 'default' });
      expect(imported.status).toBe('imported');
    }
  }, 60_000);
  afterAll(async () => { __setEmbedTransportForTests(null); await engine.disconnect(); });

  test('a question naming September 2026 is bounded to it and says so', async () => {
    const r = await runThink(engine, { question: 'operations review in September 2026', stubResponse: stub });
    expect(r.window_source).toBe('question');
    expect(r.warnings).toContain('WINDOW_FROM_QUESTION');
    expect((r.feedback_evidence ?? []).map((e) => e.slug)).toEqual(['brain/ops/2026-09-10']);
  });

  test('caller bounds are reported as the caller\'s and win over the question', async () => {
    const r = await runThink(engine, { question: 'operations review in September 2026', since: '2026-06-01', until: '2026-06-30', stubResponse: stub });
    expect(r.window_source).toBe('caller');
    expect(r.warnings).not.toContain('WINDOW_FROM_QUESTION');
    expect((r.feedback_evidence ?? []).map((e) => e.slug)).toEqual(['brain/ops/2026-06-01']);
  });

  test('no date anywhere: no window, no field, every page', async () => {
    const r = await runThink(engine, { question: 'operations review', stubResponse: stub });
    expect(r.window_source).toBeUndefined();
    expect((r.feedback_evidence ?? []).map((e) => e.slug).sort()).toEqual(['brain/ops/2026-06-01', 'brain/ops/2026-09-10']);
  });
});
