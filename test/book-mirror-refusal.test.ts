/**
 * A book-mirror chapter whose child job completed with `stop_reason:
 * 'refusal'` (a provider refusal or output-filter stop) is a failed chapter,
 * named as a provider refusal. Before this, the refusal text was written into
 * the page as a completed chapter and the run could exit 0.
 */
import { describe, expect, it } from 'bun:test';
import { chapterAnalysisFromJob } from '../src/commands/book-mirror.ts';

describe('book-mirror chapter results', () => {
  it('a refused child is a failed chapter named as a provider refusal', () => {
    const out = chapterAnalysisFromJob(
      { status: 'completed', result: { result: "I can't help with reproducing that text.", stop_reason: 'refusal' } },
      41,
      3,
    );
    expect(out).toEqual({
      index: 3,
      result: '',
      failed: true,
      error: 'provider refusal or output filter stop (job 41 stop_reason=refusal)',
    });
  });

  it('a child that ended normally is a completed chapter', () => {
    expect(chapterAnalysisFromJob({ status: 'completed', result: { result: 'analysis', stop_reason: 'end_turn' } }, 7, 1))
      .toEqual({ index: 1, result: 'analysis', failed: false });
  });

  it('a child that did not complete is a failed chapter with its status', () => {
    expect(chapterAnalysisFromJob({ status: 'dead', result: null }, 9, 2))
      .toEqual({ index: 2, result: '', failed: true, error: 'job 9 status=dead' });
  });
});
