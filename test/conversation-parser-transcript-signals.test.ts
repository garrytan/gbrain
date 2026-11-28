import { describe, expect, test } from 'bun:test';
import { isTranscriptClaiming } from '../src/core/conversation-parser/transcript-signals.ts';
import type { Page } from '../src/core/types.ts';

function pageWith(frontmatter: Record<string, unknown>): Page {
  return { frontmatter } as unknown as Page;
}

const SUMMARY = [
  '## Highlights',
  '- Shipped the new onboarding flow',
  '- Reviewed the quarterly metrics doc',
  '## Decisions',
  '- Move the launch to next week',
  '- Alice owns the follow-up doc',
].join('\n');

describe('isTranscriptClaiming (#4193)', () => {
  test('summary-only headings + bullets: false', () => {
    expect(isTranscriptClaiming(undefined, SUMMARY)).toBe(false);
  });

  test('empty body: false', () => {
    expect(isTranscriptClaiming(undefined, '')).toBe(false);
  });

  test('raw_transcript frontmatter claims a transcript even when unresolvable', () => {
    expect(isTranscriptClaiming(pageWith({ raw_transcript: 'transcripts/x.txt' }), SUMMARY)).toBe(true);
  });

  test('blank raw_transcript is not a claim', () => {
    expect(isTranscriptClaiming(pageWith({ raw_transcript: '  ' }), SUMMARY)).toBe(false);
  });

  test('## Transcript section heading: true', () => {
    expect(isTranscriptClaiming(undefined, '## Summary\n- notes\n\n## Transcript\nweird turn shape')).toBe(true);
    expect(isTranscriptClaiming(undefined, '### Raw Transcript\nstuff')).toBe(true);
  });

  test('timestamp-dense lines: true (telegram/irc style anchors)', () => {
    const body = ['[10:12] alice: hi', '[10:13] bob: hello', '[10:15] alice: bye'].join('\n');
    expect(isTranscriptClaiming(undefined, body)).toBe(true);
  });

  test('a single time mention in an agenda does not trip the density signal', () => {
    const body = [
      '## Agenda',
      '- standup at 3:00',
      '- retro planning',
      '- metrics review',
      '- launch checklist',
      '- follow-ups',
      '- docs pass',
      '- close out',
    ].join('\n');
    expect(isTranscriptClaiming(undefined, body)).toBe(false);
  });

  test('prose label lines (builtins test_negative shape) are not a signal', () => {
    expect(
      isTranscriptClaiming(undefined, 'Owner: this is a prose label, not a transcript line\nNext: more prose'),
    ).toBe(false);
  });
});

describe('calendar fields are not timestamped turns (#9885)', () => {
  const ENGLISH = [
    '# Weekly sync',
    '- Date: 2031-03-04',
    '- Start: 08:15 AM PST',
    '- Starts at: 2031-03-04 08:15',
    '- End: 08:45 AM',
    '- **Time:** 08:15 – 08:45 (UTC+8)',
    '- Created at: 2031-03-01T09:01:04Z',
    '## Notes',
    '- Reviewed the launch checklist',
  ].join('\n');
  const CHINESE = [
    '# 周会纪要',
    '- 时间：2031-03-04 08:15–08:45 Asia/Tokyo',
    '- 开始时间：2031年3月4日 上午8:15',
    '- 结束时间：08:45',
    '- 创建时间：2031-03-01 09:01:04',
    '## 结论',
    '- 下周发布',
  ].join('\n');

  test('calendar-only English summary: false', () => {
    expect(isTranscriptClaiming(undefined, ENGLISH)).toBe(false);
  });

  test('calendar-only Chinese summary: false', () => {
    expect(isTranscriptClaiming(undefined, CHINESE)).toBe(false);
  });

  test('explicit transcript heading and sidecar still win over calendar fields', () => {
    expect(isTranscriptClaiming(undefined, `${ENGLISH}\n## Transcript\nodd shape`)).toBe(true);
    expect(isTranscriptClaiming(pageWith({ raw_transcript: 'transcripts/x.vtt' }), CHINESE)).toBe(true);
  });

  test('real turns mixed with calendar fields still count', () => {
    const body = [CHINESE, '[10:00] alice-example: 开始', '[10:01] bob-example: 同意', '[10:02] alice-example: 收到'].join('\n');
    expect(isTranscriptClaiming(undefined, body)).toBe(true);
  });

  test('unknown timestamped dialogue and labelled lines carrying speech still count', () => {
    expect(isTranscriptClaiming(undefined, ['10:00 Q :: one', '10:01 A :: two', '10:02 Q :: three'].join('\n'))).toBe(true);
    expect(isTranscriptClaiming(undefined, Array(3).fill('- Start: 08:15 we kicked off the review').join('\n'))).toBe(true);
    expect(isTranscriptClaiming(undefined, Array(3).fill('[08:15] Date: 2031-03-04').join('\n'))).toBe(true);
  });
});
