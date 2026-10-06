/**
 * LoCoMo → LongMemEval conversion (src/eval/longmemeval/locomo.ts) on a tiny
 * synthetic conversation.
 *
 * Protects: one question per non-adversarial QA; evidence dialog ids map to
 * the stable per-conversation session ids; the haystack, its dates and the
 * question date come from the conversation's sessions; speaker names and
 * photo captions survive into the turns; an empty or sealed conversation list
 * is refused unless the custodian asks; QAs without usable evidence are
 * skipped and counted.
 */
import { describe, expect, test } from 'bun:test';
import { convertLocomo, locomoDate, type LocomoSample } from '../src/eval/longmemeval/locomo.ts';
import { haystackToPages, normalizeSessions } from '../src/eval/longmemeval/adapter.ts';

const sample: LocomoSample = {
  sample_id: 'conv-90',
  conversation: {
    speaker_a: 'Alice', speaker_b: 'Bob',
    session_1_date_time: '1:10 pm on 27 March, 2023',
    session_1: [
      { speaker: 'Alice', dia_id: 'D1:1', text: 'I adopted a puppy.' },
      { speaker: 'Bob', dia_id: 'D1:2', text: 'Look at this!', blip_caption: 'a photo of a red bike' },
    ],
    session_2_date_time: '9:02 am on 2 April, 2023',
    session_2: [{ speaker: 'Bob', dia_id: 'D2:1', text: 'I started a new job.' }],
  },
  qa: [
    { question: 'What did Alice adopt?', answer: 'a puppy', evidence: ['D1:1'], category: 4 },
    { question: 'Which bird does Alice like?', evidence: ['D1:1'], category: 5 },
    { question: 'What happened in March and April?', answer: 2023, evidence: ['D2:1', 'D1:2', 'D1:1'], category: 1 },
    { question: 'Unsupported?', answer: 'x', evidence: ['D9:1'], category: 2 },
  ],
};

describe('convertLocomo', () => {
  test('one question per non-adversarial QA, gold sessions from evidence ids', () => {
    const { questions, skipped } = convertLocomo([sample], ['conv-90']);
    expect(questions.map(q => q.question_id)).toEqual(['conv-90_q0', 'conv-90_q2']);
    expect(skipped['conv-90']).toEqual({ adversarial: 1, no_evidence: 1 });
    const [q0, q2] = questions;
    expect(q0.question_type).toBe('single-hop');
    expect(q0.answer_session_ids).toEqual(['conv-90_s1']);
    expect(q2.question_type).toBe('multi-hop');
    expect(q2.answer).toBe('2023');
    expect(q2.answer_session_ids).toEqual(['conv-90_s1', 'conv-90_s2']);
    expect(q0.haystack_session_ids).toEqual(['conv-90_s1', 'conv-90_s2']);
    expect(q0.haystack_dates).toEqual(['2023/03/27 (Mon) 13:10', '2023/04/02 (Sun) 09:02']);
    expect(q0.question_date).toBe('2023/04/02 (Sun) 09:02');
    expect(q0.haystack_sessions[0]).toEqual([
      { role: 'Alice', content: 'I adopted a puppy.' },
      { role: 'Bob', content: 'Look at this! [shares a photo of a red bike]' },
    ]);
  });

  test('the harness adapter reads the converted shape', () => {
    const [q] = convertLocomo([sample], ['conv-90']).questions;
    expect(normalizeSessions(q as never).map(s => s.session_id)).toEqual(['conv-90_s1', 'conv-90_s2']);
    expect(haystackToPages(q as never)[0].content).toContain('**Alice:** I adopted a puppy.');
  });

  test('an empty, unknown or sealed conversation list is refused', () => {
    expect(() => convertLocomo([sample], [])).toThrow('explicit conversation list');
    expect(() => convertLocomo([sample], ['conv-91'])).toThrow('not in the input');
    expect(() => convertLocomo([{ ...sample, sample_id: 'conv-26' }], ['conv-26'])).toThrow('sealed LoCoMo split');
    expect(convertLocomo([{ ...sample, sample_id: 'conv-26' }], ['conv-26'], { custodian: true }).questions).toHaveLength(2);
  });

  test('locomoDate reads the LoCoMo date format and rejects others', () => {
    expect(locomoDate('12:05 am on 1 January, 2024')).toBe('2024/01/01 (Mon) 00:05');
    expect(locomoDate('12:30 pm on 15 June, 2023')).toBe('2023/06/15 (Thu) 12:30');
    expect(() => locomoDate('yesterday')).toThrow('unrecognized');
  });
});
