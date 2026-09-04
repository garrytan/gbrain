import { describe, expect, test } from 'bun:test';
import type { PageType, SearchResult } from '../../src/core/types.ts';
import {
  applyPreferredTypeCoverage,
  isPreferredTypeWinner,
  selectPreferredTypeWinners,
} from '../../src/core/search/preferred-type-coverage.ts';

/** Build a stable page-grain result for pure coverage tests. */
function result(
  slug: string,
  type: PageType,
  rank: number,
  sourceId = 'source-a',
): SearchResult {
  return {
    slug,
    source_id: sourceId,
    page_id: 1_000 + rank,
    title: slug,
    type,
    chunk_text: `${slug} document`,
    chunk_source: 'compiled_truth',
    chunk_id: 2_000 + rank,
    chunk_index: 0,
    score: 1 - rank / 1_000,
    stale: false,
  };
}

describe('preferred-type coverage', () => {
  test('selects one composite page winner per preferred type in typed rank order', () => {
    const meeting = result('shared/answer', 'meeting', 0, 'curated');
    const transcript = result('shared/answer', 'conversation', 1, 'raw');
    const transcriptDecoy = result('transcripts/decoy', 'conversation', 2, 'raw');

    const winners = selectPreferredTypeWinners(
      ['meeting', 'conversation'],
      [meeting, transcript, transcriptDecoy],
    );

    expect(winners).toEqual([
      { sourceId: 'curated', slug: 'shared/answer', type: 'meeting' },
      { sourceId: 'raw', slug: 'shared/answer', type: 'conversation' },
    ]);
  });

  test('puts the best winner first, bounds the second at 15, and preserves every other order', () => {
    const normal = Array.from({ length: 20 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'conversation', 101, 'raw');
    const transcriptDecoy = result('transcripts/decoy', 'conversation', 102, 'raw');
    const ranked = [
      normal[0]!,
      normal[1]!,
      meeting,
      ...normal.slice(2, 16),
      transcriptDecoy,
      ...normal.slice(16),
      transcript,
    ];
    const winners = selectPreferredTypeWinners(
      ['meeting', 'conversation'],
      [meeting, transcript, transcriptDecoy],
    );

    const covered = applyPreferredTypeCoverage(ranked, winners, ranked);

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBeLessThanOrEqual(15);
    expect(covered.findIndex((item) => item === transcriptDecoy) + 1).toBeGreaterThan(15);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('leaves an additional winner at its existing rank inside the first 15', () => {
    const normal = Array.from({ length: 16 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'conversation', 101, 'raw');
    const ranked = [normal[0]!, meeting, ...normal.slice(1, 6), transcript, ...normal.slice(6)];
    const transcriptRank = ranked.findIndex((item) => item === transcript) + 1;
    const winners = selectPreferredTypeWinners(
      ['meeting', 'conversation'],
      [meeting, transcript],
    );

    const covered = applyPreferredTypeCoverage(ranked, winners, ranked);

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBe(transcriptRank);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('re-admits the selected fused page when dedup removed it', () => {
    const normal = Array.from({ length: 20 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100, 'curated');
    const transcript = result('transcripts/best', 'conversation', 101, 'raw');
    const winners = selectPreferredTypeWinners(
      ['meeting', 'conversation'],
      [meeting, transcript],
    );

    const covered = applyPreferredTypeCoverage(
      [meeting, ...normal],
      winners,
      [meeting, ...normal, transcript],
    );

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBe(15);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('winner matching uses source_id plus slug for autocut preservation', () => {
    const winner = result('shared/answer', 'conversation', 0, 'raw-a');
    const sameSlugOtherSource = result('shared/answer', 'conversation', 1, 'raw-b');
    const winners = selectPreferredTypeWinners(['conversation'], [winner]);

    expect(isPreferredTypeWinner(winner, winners)).toBe(true);
    expect(isPreferredTypeWinner(sameSlugOtherSource, winners)).toBe(false);
  });

  test('keeps an exact identity row at rank 1 ahead of a preferred winner', () => {
    const alias = { ...result('notes/alias-owner', 'note', 0), alias_hit: true };
    const weekly = result('reports/weekly', 'conversation', 100);
    const ordinary = Array.from({ length: 4 }, (_, i) => result(`normal/${i}`, 'note', i + 1));
    const ranked = [alias, ...ordinary, weekly];
    const winners = selectPreferredTypeWinners(['conversation'], [weekly]);

    const covered = applyPreferredTypeCoverage(ranked, winners, ranked);

    expect(covered[0]).toBe(alias);
    expect(covered[1]).toBe(weekly);
    expect(covered.filter((item) => item.slug.startsWith('normal/'))).toEqual(ordinary);
  });

  test('does not displace a preferred winner that is itself the pinned identity', () => {
    const weeklyAlias = {
      ...result('reports/weekly-alias', 'conversation', 0),
      alias_hit: true,
    };
    const ordinary = result('normal/0', 'note', 1);
    const winners = selectPreferredTypeWinners(['conversation'], [weeklyAlias]);

    const covered = applyPreferredTypeCoverage([weeklyAlias, ordinary], winners);

    expect(covered).toEqual([weeklyAlias, ordinary]);
  });

  test('honors a tighter secondary rank so a final relational slot stays available', () => {
    const normal = Array.from({ length: 20 }, (_, i) => result(`normal/${i}`, 'note', i));
    const meeting = result('meetings/curated', 'meeting', 100);
    const transcript = result('transcripts/best', 'conversation', 101);
    const ranked = [...normal, meeting, transcript];
    const winners = selectPreferredTypeWinners(['meeting', 'conversation'], [meeting, transcript]);

    const covered = applyPreferredTypeCoverage(
      ranked,
      winners,
      ranked,
      { secondaryMaxRank: 14 },
    );

    expect(covered[0]).toBe(meeting);
    expect(covered.findIndex((item) => item === transcript) + 1).toBeLessThanOrEqual(14);
    expect(covered.filter((item) => item.type === 'note')).toEqual(normal);
  });

  test('never moves a secondary winner ahead of identity and earlier winners', () => {
    const alias = { ...result('notes/alias-owner', 'note', 0), alias_hit: true };
    const meeting = result('meetings/curated', 'meeting', 100);
    const transcript = result('transcripts/best', 'conversation', 101);
    const ordinary = result('normal/0', 'note', 1);
    const winners = selectPreferredTypeWinners(['meeting', 'conversation'], [meeting, transcript]);

    const covered = applyPreferredTypeCoverage(
      [alias, ordinary, meeting, transcript],
      winners,
      [meeting, transcript],
      { secondaryMaxRank: 2 },
    );

    expect(covered.slice(0, 3)).toEqual([alias, meeting, ordinary]);
    expect(covered[3]).toBe(transcript);
  });
});
