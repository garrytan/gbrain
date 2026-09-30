/**
 * #5425: an assistant's proposal must not become the user's decision.
 *
 * The grounding gate checks, mechanically, the one part of a decision or
 * commitment it can: when a claim says a speaker decided, agreed, committed
 * or will do something, the numbers and dates it carries must come from that
 * speaker's own turns, or from the turn they explicitly accepted. A decision
 * whose specifics only another speaker stated is quarantined as
 * `decision_misattributed`. Claims without numbers or dates are left to the
 * synthesis prompt.
 */
import { describe, expect, test } from 'bun:test';
import { groundSource, verifyBody } from '../src/core/cycle/synthesize-verify.ts';

const transcript = [
  'User: Let us look into moving the launch.',
  'Assistant: I recommend moving the launch to 2026-10-15 and adding a pricing page first.',
  'User: No, keep the date as is. Only the pricing page.',
  'Assistant: Should we cap the beta at $30K of credits?',
  'User: Sounds good, do that.',
  'User: I will send the investor update by March 3.',
].join('\n');
const src = [groundSource('/t/launch.txt', transcript)];

describe('decision attribution (#5425)', () => {
  test('a user decision whose date only the assistant proposed is quarantined', () => {
    const r = verifyBody('The user decided to move the launch to 2026-10-15.', src);
    expect(r.quarantined.map(q => q.reason)).toEqual(['decision_misattributed']);
    expect(r.body).toBe('');
  });

  test('crediting the proposal to the assistant is kept', () => {
    const body = 'The assistant proposed moving the launch to 2026-10-15; the user declined.';
    expect(verifyBody(body, src).quarantined).toEqual([]);
  });

  test('a proposal the user explicitly accepted may be stated as the user\'s decision', () => {
    expect(verifyBody('The user agreed to cap the beta at $30K of credits.', src).quarantined).toEqual([]);
  });

  test('a commitment whose date the user stated is kept', () => {
    expect(verifyBody('The user will send the investor update by March 3rd.', src).quarantined).toEqual([]);
  });

  test('a decision recorded with its refusal, or a proposal, is kept', () => {
    expect(verifyBody('The user decided not to move the launch to 2026-10-15.', src).quarantined).toEqual([]);
    expect(verifyBody('When a launch on 2026-10-15 was suggested, the user said they will keep the date.', src).quarantined).toEqual([]);
  });

  test('a number no speaker stated (a file-name date) is not attributed to anyone', () => {
    const dated = [groundSource('/t/2026-09-20-session.txt', transcript)];
    expect(verifyBody('In a 2026 session the user committed to weekly customer calls.', dated).quarantined).toEqual([]);
  });

  test('a plain statement without a decision verb is not a decision claim', () => {
    expect(verifyBody('A launch date of 2026-10-15 was discussed.', src).quarantined).toEqual([]);
  });

  test('a transcript without speaker turns is not checked for attribution', () => {
    const flat = [groundSource('/t/notes.txt', 'Notes: move the launch to 2026-10-15 maybe.')];
    expect(verifyBody('The user decided to move the launch to 2026-10-15.', flat).quarantined).toEqual([]);
  });
});
