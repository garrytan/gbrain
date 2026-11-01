import { describe, expect, test } from 'bun:test';
import { createPatternDetector, parseConversation } from '../../src/core/conversation-parser/parse.ts';

const BODY = [
  '**Assistant** (2026-08-06 9:00 AM): I will inspect the proposal.',
  '**Key specs:** the first requirement is stable output.',
  '**Constraints:** existing callers keep their current format.',
  '**Options:** retrying another grammar may recover the transcript.',
  '**Recommendation:** preserve the original message boundaries.',
  '**User** (2026-08-06 9:05 AM): Should we try the smaller change?',
  '**Assistant** (2026-08-06 9:06 AM): Score the other grammar against the whole page.',
].join('\n');

describe('structure-gate grammar rescue', () => {
  test('parses the full transcript after rejecting a label-dense broad pattern', () => {
    const result = parseConversation(BODY, { fallbackDate: '2026-08-06' });

    expect({
      phase: result.phase,
      pattern: result.matched_pattern_id,
      speakers: result.messages.map((message) => message.speaker),
    }).toEqual({
      phase: 'regex_match',
      pattern: 'imessage-slack',
      speakers: ['Assistant', 'User', 'Assistant'],
    });
  });

  test('keeps the streamed detector aligned with the parser', () => {
    const detector = createPatternDetector();
    detector.push(BODY);
    expect(detector.finish()).toBe('imessage-slack');
  });
});
