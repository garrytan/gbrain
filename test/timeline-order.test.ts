/**
 * #7247: the pure timeline-order core. Page text in, repaired text plus counts out; no database.
 */
import { describe, expect, test } from 'bun:test';
import { orderTimeline, type TimelineOrderHold } from '../src/core/timeline-order.ts';
import { materializedMarker } from '../src/core/timeline-marker.ts';

const page = (timeline: string, compiled_truth = 'Alice Example is a synthetic person.') => ({ compiled_truth, timeline });
const changed = (result: ReturnType<typeof orderTimeline>) => {
  if (result.status !== 'changed') throw new Error(`expected changed, got ${JSON.stringify(result)}`);
  return result;
};
const lines = (text: string) => text.split('\n').filter(line => line.trim()).sort();

describe('orderTimeline: sorting', () => {
  test('sorts ascending bullets with their indented lines, stable for equal dates, every other byte kept', () => {
    const before = ['## Timeline', '', '- **2020-01-01** | import — Joined acme-example', '  Detail line one.', '  - nested note', '- **2024-03-01** | meeting — Quarterly review',
      '- **2021-01-01** | import — Moved', '- **2022-05-05** | import — First tie', '- **2022-05-05** | import — Second tie', '- **2023-01-01** | import — Appended'].join('\n');
    const result = changed(orderTimeline(page(before)));
    expect(result.timeline).toBe(['## Timeline', '', '- **2020-01-01** | import — Joined acme-example', '  Detail line one.', '  - nested note',
      '- **2021-01-01** | import — Moved', '- **2022-05-05** | import — First tie', '- **2022-05-05** | import — Second tie', '- **2023-01-01** | import — Appended',
      '- **2024-03-01** | meeting — Quarterly review'].join('\n'));
    expect(result.compiled_truth).toBe('Alice Example is a synthetic person.');
    expect(result).toMatchObject({ direction: 'ascending', duplicates: 0, sections_joined: 0 });
    expect(lines(result.timeline)).toEqual(lines(before));
    expect(orderTimeline(result).status).toBe('unchanged');
  });

  test('keeps a mostly descending page descending', () => {
    const result = changed(orderTimeline(page(['- **2024-03-01** | a — B', '- **2023-01-01** | a — A', '- **2022-01-01** | a — C', '- **2025-01-01** | a — D'].join('\n'))));
    expect(result.direction).toBe('descending');
    expect(result.timeline.split('\n').map(line => line.slice(4, 14))).toEqual(['2025-01-01', '2024-03-01', '2023-01-01', '2022-01-01']);
  });

  test('a page already in order, or with no Format-1 bullets, is unchanged', () => {
    expect(orderTimeline(page('## Timeline\n\n- **2020-01-01** | a — A\n- **2021-01-01** | a — B'))).toEqual({ status: 'unchanged', near_duplicates: 0 });
    expect(orderTimeline(page('## Timeline\n\n- 2024-01-01: Series A\n- 2020-01-01: Founded'))).toEqual({ status: 'unchanged', near_duplicates: 0 });
    expect(orderTimeline({ compiled_truth: 'Only prose.', timeline: '' })).toEqual({ status: 'unchanged', near_duplicates: 0 });
  });

  test('blank lines keep their slots and anchors split the runs that are sorted', () => {
    const before = ['## Timeline', '', '### 2024', '', '- **2024-01-01** | a — y', '', '- **2024-05-01** | a — x', '- **2024-03-01** | a — z', '- **2024-07-01** | a — u', '',
      'A paragraph people wrote.', '', '- **2023-05-01** | a — w', '- **2023-01-01** | a — v', '- **2023-09-01** | a — t', '- **2023-10-01** | a — s'].join('\n');
    const result = changed(orderTimeline(page(before)));
    expect(result.timeline).toBe(['## Timeline', '', '### 2024', '', '- **2024-01-01** | a — y', '', '- **2024-03-01** | a — z', '- **2024-05-01** | a — x', '- **2024-07-01** | a — u', '',
      'A paragraph people wrote.', '', '- **2023-01-01** | a — v', '- **2023-05-01** | a — w', '- **2023-09-01** | a — t', '- **2023-10-01** | a — s'].join('\n'));
  });

  test('a materialized marker moves with the bullet below it', () => {
    const marker = materializedMarker({ date: '2020-01-01', source: 'legacy', summary: 'Kickoff' });
    const result = changed(orderTimeline(page(['- **2024-05-01** | a — x', '- **2025-01-01** | a — z', marker, '- **2020-01-01** | legacy — Kickoff', '  detail'].join('\n'))));
    expect(result.timeline).toBe([marker, '- **2020-01-01** | legacy — Kickoff', '  detail', '- **2024-05-01** | a — x', '- **2025-01-01** | a — z'].join('\n'));
  });

  test('bullets quoted in a fenced code block are an anchor and never sorted', () => {
    const before = ['- **2020-01-01** | a — y', '- **2024-01-01** | a — x', '- **2019-01-01** | a — v', '', '```md', '- **2030-01-01** | example — z', '- **2010-01-01** | example — w', '```'].join('\n');
    expect(changed(orderTimeline(page(before))).timeline).toBe(['- **2019-01-01** | a — v', '- **2020-01-01** | a — y', '- **2024-01-01** | a — x', '', '```md',
      '- **2030-01-01** | example — z', '- **2010-01-01** | example — w', '```'].join('\n'));
  });

  test('sections other than the timeline are never touched', () => {
    const truth = 'Bio.\n\n## Notes\n\n- **2024-01-01** | a — not a timeline\n- **2020-01-01** | a — left alone';
    expect(orderTimeline({ compiled_truth: truth, timeline: '' }).status).toBe('unchanged');
    const result = changed(orderTimeline(page('## Timeline\n\n- **2020-01-01** | a — y\n- **2024-01-01** | a — x\n- **2019-01-01** | a — v\n\n## Facts\n\n- **2030-01-01** | a — kept', truth)));
    expect(result.compiled_truth).toBe(truth);
    expect(result.timeline).toBe('## Timeline\n\n- **2019-01-01** | a — v\n- **2020-01-01** | a — y\n- **2024-01-01** | a — x\n\n## Facts\n\n- **2030-01-01** | a — kept');
  });
});

describe('orderTimeline: duplicates', () => {
  test('drops later exact copies (trailing whitespace ignored) and keeps the first', () => {
    const result = changed(orderTimeline(page(['## Timeline', '', '- **2020-01-01** | import — A', '- **2021-01-01** | x — B', '', '- **2020-01-01** | import — A  ',
      '- **2022-01-01** | x — C'].join('\n'))));
    expect(result.timeline).toBe(['## Timeline', '', '- **2020-01-01** | import — A', '- **2021-01-01** | x — B', '- **2022-01-01** | x — C'].join('\n'));
    expect(result).toMatchObject({ duplicates: 1, moved: 0, near_duplicates: 0 });
  });

  test('a copy with different indented lines, or a near duplicate, is kept and only counted', () => {
    const before = ['- **2020-01-01** | import — Joined acme-example.', '  first detail', '- **2020-01-01** | import — Joined acme-example.', '  other detail',
      '- **2020-01-01** | meeting — joined Acme-Example'].join('\n');
    expect(orderTimeline(page(before))).toEqual({ status: 'unchanged', near_duplicates: 2 });
  });
});

describe('orderTimeline: joining sections', () => {
  test('two ## Timeline sections below the sentinel join into the first', () => {
    const result = changed(orderTimeline(page('## Timeline\n\n- **2020-01-01** | a — A\n- **2022-01-01** | b — B\n\n## Timeline\n\n- **2021-01-01** | c — C\n- **2020-01-01** | a — A')));
    expect(result.timeline).toBe('## Timeline\n\n- **2020-01-01** | a — A\n- **2021-01-01** | c — C\n- **2022-01-01** | b — B');
    expect(result).toMatchObject({ sections_joined: 1, duplicates: 1 });
  });

  test('bullets right below the sentinel and a later ## Timeline heading join, keeping the headingless first section', () => {
    const result = changed(orderTimeline(page('- **2023-01-01** | a — A\n\n## Timeline\n\n- **2021-01-01** | b — B\n\n## Facts\n\nKept.')));
    expect(result.timeline).toBe('- **2021-01-01** | b — B\n- **2023-01-01** | a — A\n\n## Facts\n\nKept.');
  });

  test('a ## Timeline section above the sentinel takes the bullets below it when it is the last section of the body', () => {
    const result = changed(orderTimeline({ compiled_truth: 'Bio.\n\n## Timeline\n\n- **2020-01-01** | a — A', timeline: '## Timeline\n\n- **2019-01-01** | b — B' }));
    expect(result.compiled_truth.trim()).toBe('Bio.');
    expect(result.timeline).toBe('## Timeline\n\n- **2019-01-01** | b — B\n- **2020-01-01** | a — A');
    expect(orderTimeline(result).status).toBe('unchanged');
  });

  test('a join that would move other sections, or prose, is kept for a person', () => {
    expect(orderTimeline({ compiled_truth: 'Bio.\n\n## Timeline\n\n- **2020-01-01** | a — A\n\n## Notes\n\nProse.', timeline: '## Timeline\n\n- **2019-01-01** | b — B' }))
      .toEqual({ status: 'needs_human', reason: 'not_conserved', near_duplicates: 0 });
    expect(orderTimeline(page('## Timeline\n\n- **2020-01-01** | a — A\n\n## Timeline\n\nA note.\n\n- **2019-01-01** | b — B')))
      .toMatchObject({ status: 'needs_human', reason: 'join_not_lossless' });
    expect(orderTimeline(page('## Timeline\n\n- **2020-01-01** | a — A\n\n### Later\n\n- **2021-01-01** | a — C\n\n## History\n\n- **2019-01-01** | b — B')))
      .toMatchObject({ status: 'needs_human', reason: 'join_not_lossless' });
  });
});

describe('orderTimeline: lines it cannot place keep the page', () => {
  const cases: Array<[TimelineOrderHold, string]> = [
    ['lazy_continuation', '- **2024-01-01** | a — x\nwrapped text\n- **2020-01-01** | a — y'],
    ['ambiguous_indent', '- **2024-01-01** | a — x\n wrapped text\n- **2020-01-01** | a — y'],
    ['detached_continuation', '- **2024-01-01** | a — x\n\n  second paragraph\n- **2020-01-01** | a — y'],
    ['mixed_bullet_format', '- **2024-01-01** | a — x\n- 2022-01-01: other format\n- **2020-01-01** | a — y'],
    ['unclosed_fence', '- **2024-01-01** | a — x\n- **2020-01-01** | a — y\n\n```\nnever closed'],
    ['unclosed_comment', '- **2024-01-01** | a — x\n- **2020-01-01** | a — y\n\n<!-- never\nclosed'],
  ];
  for (const [reason, timeline] of cases) {
    test(reason, () => { expect(orderTimeline(page(timeline))).toEqual({ status: 'needs_human', reason, near_duplicates: 0 }); });
  }
});
