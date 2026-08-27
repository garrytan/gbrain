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
