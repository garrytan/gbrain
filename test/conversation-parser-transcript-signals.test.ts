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

describe('calendar fields in meeting records', () => {
  const metadata = [
    '- 时间：2031-03-04 08:15–08:45 Asia/Tokyo',
    '- 创建时间：2031-03-01 09:01:04 Asia/Tokyo',
    '- Time: 2031-03-04 08:15 UTC',
    '- Created at: 2031-03-01 09:01:04 UTC',
  ];
  test('calendar fields alone never establish turn density', () => {
    expect(isTranscriptClaiming(undefined, metadata.join('\n'))).toBe(false);
  });
  test('retain unsupported timed speech and labeled lines containing speech', () => {
    for (const lines of [
      ['10:00 Q :: one', '10:01 A :: two', '10:02 Q :: three'],
      Array(3).fill('- Time: 2031-03-04 08:15 UTC — a speaker says something'),
      Array(3).fill('[08:15] Alex: 2031-03-04 08:15 UTC'),
    ]) expect(isTranscriptClaiming(undefined, lines.join('\n'))).toBe(true);
  });
  test('explicit transcript promises and genuine turns mixed with metadata remain visible', () => {
    expect(isTranscriptClaiming(undefined, ['## Transcript', ...metadata].join('\n'))).toBe(true);
    expect(isTranscriptClaiming(pageWith({ raw_transcript: 'requested.vtt' }), metadata.join('\n'))).toBe(true);
    expect(isTranscriptClaiming(undefined, [...metadata, '[10:00] 李: 开始', '[10:01] 陈: 同意', '[10:02] 李: 收到'].join('\n'))).toBe(true);
  });
});
