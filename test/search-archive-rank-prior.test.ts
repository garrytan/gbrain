/**
 * GST-2768 PR 3 (decision C): conversation-archive pages rank a little below written pages. An archive row (the
 * archive's day layout conversations/<harness>/<YYYY-MM-DD>/..., or a row of the conversations source) takes
 * ARCHIVE_PRIOR when a non-archive row scores close below it in the same list, and one list keeps at most
 * ARCHIVE_HITS_PER_DAY archive rows per day; a question about a conversation or a date is unchanged, and
 * search.rank_priors false turns both off. Pure.
 */
import { describe, expect, test } from 'bun:test';
import { applyRankPriors, ARCHIVE_HITS_PER_DAY, ARCHIVE_PRIOR, rankPriors } from '../src/core/search/rank-priors.ts';
import { prioritize } from '../src/core/search/hybrid/rank.ts';
import type { SearchResult } from '../src/core/types.ts';

const r = (slug: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  slug, type: 'note', title: slug.split('/').pop()!, page_id: 1, chunk_id: 1, chunk_index: 0, chunk_text: slug,
  chunk_source: 'compiled_truth', score: 0.5, stale: false, source_id: 'default', ...extra,
});
const archive = (day: string, n: number, score: number) =>
  r('conversations/codex/' + day + '/dm-' + String(n).padStart(8, '0'), { type: 'conversation', source_id: 'conversations', score });

describe('archive rank prior', () => {
  test('a written page outranks an archive hit that scores close above it', () => {
    const chat = archive('2026-11-02', 1, 0.6);
    const note = r('projects/acme-example-launch', { score: 0.55 });
    const out = applyRankPriors([chat, note], 'acme example launch plan');
    expect(out.map(x => x.slug)).toEqual(['projects/acme-example-launch', chat.slug]);
    expect(out[1]).toMatchObject({ rank_prior: ARCHIVE_PRIOR });
    expect(out[1]!.score).toBeCloseTo(0.6 * ARCHIVE_PRIOR);
  });

  test('a row of the conversations source counts as archive; an archive hit far above every written page keeps its score', () => {
    expect(rankPriors([r('notes/x', { source_id: 'conversations', score: 0.6 }), r('notes/y', { score: 0.55 })], 'launch plan')).toEqual([ARCHIVE_PRIOR, 1]);
    expect(rankPriors([archive('2026-11-02', 1, 0.9), r('notes/y', { score: 0.3 })], 'launch plan')).toEqual([1, 1]);
  });

  test('a list with only archive rows is unchanged', () => {
    const rows = [archive('2026-11-02', 1, 0.6), archive('2026-11-03', 2, 0.5)];
    expect(applyRankPriors(rows, 'launch plan')).toBe(rows);
  });

  test('a date question or a "what did we discuss" question is unchanged', () => {
    const rows = [archive('2026-11-02', 1, 0.6), r('projects/acme-example-launch', { score: 0.55 })];
    for (const q of ['what did we discuss about the launch', 'when did alice-example mention the launch', 'launch notes from 2026-11-02', 'what did we talk about yesterday', 'the chat about the launch']) {
      expect(applyRankPriors(rows, q).map(x => x.slug)).toEqual([rows[0]!.slug, rows[1]!.slug]);
      expect(rankPriors(rows, q)).toEqual([1, 1]);
    }
  });

  test('one list keeps at most two archive hits per day', () => {
    expect(ARCHIVE_HITS_PER_DAY).toBe(2);
    const rows = [
      archive('2026-11-02', 1, 0.9), archive('2026-11-02', 2, 0.85), archive('2026-11-02', 3, 0.8),
      r('conversations/days/2026-11-02', { type: 'conversation', source_id: 'conversations', score: 0.75 }),
      archive('2026-11-03', 4, 0.7), r('projects/acme-example-launch', { score: 0.2 }),
    ];
    const out = applyRankPriors(rows, 'acme example launch plan');
    const perDay = (day: string) => out.filter(x => x.slug.includes(day)).length;
    expect(perDay('2026-11-02')).toBe(2);
    expect(perDay('2026-11-03')).toBe(1);
    expect(out.some(x => x.slug === 'projects/acme-example-launch')).toBe(true);
    expect(applyRankPriors(rows, 'what did we discuss about the launch')).toHaveLength(rows.length);
  });

  test('search.rank_priors false turns the prior and the day cap off', () => {
    const rows = [archive('2026-11-02', 1, 0.6), archive('2026-11-02', 2, 0.59), archive('2026-11-02', 3, 0.58), r('projects/acme-example-launch', { score: 0.55 })];
    const off = prioritize({ resolvedMode: { rank_priors: false }, query: 'acme example launch plan' } as never, rows);
    expect(off).toBe(rows);
    const on = prioritize({ resolvedMode: { rank_priors: true }, query: 'acme example launch plan' } as never, rows);
    expect(on[0]!.slug).toBe('projects/acme-example-launch');
    expect(on).toHaveLength(3);
  });
});
