/**
 * A feedback event that is lost is never lost silently. The write-behind queue drops the oldest answers on overflow and
 * drops a batch whose write fails; the caller already holds the answer id by then. This pins that each loss writes one
 * sanitized stderr line (code, op and count; never page text or ids), is counted for the client that lost it and named
 * on that client's next answer (`FEEDBACK_EVENTS_LOST:<n>`, then reset), that a recording that throws says so
 * (`FEEDBACK_RECORD_FAILED`) instead of returning nothing, and that rate_answer on a lost id says it was lost.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { rateAnswer } from '../src/core/feedback/rate.ts';
import { _resetFeedbackRecordingForTests, drainFeedbackQueue, feedbackMetaFields, QUEUE_CAP, recordAnswer } from '../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';

const SECRET_TEXT = 'a-page-slug-that-must-not-be-logged';
let writes: 'block' | 'fail' | 'ok' = 'ok';
let release!: () => void;
let gate: Promise<void>;

function engine(): BrainEngine {
  return {
    getConfig: async (key: string) => (key === 'feedback.enabled' || key === 'feedback.learn' ? 'true' : null),
    insertRetrievalEvents: async () => {
      if (writes === 'block') await gate;
      if (writes === 'fail') throw Object.assign(new Error(`write failed for ${SECRET_TEXT}`), { code: 'engine_unavailable' });
    },
    readRetrievalEvent: async () => null,
  } as unknown as BrainEngine;
}

const ctxOf = (eng: BrainEngine, clientId: string): OperationContext => ({
  engine: eng, config: {}, remote: true, transport: 'http', sourceId: 'default', logger: console,
  auth: { token: `t-${clientId}`, clientId, scopes: ['read', 'write'], sourceId: 'default' },
}) as unknown as OperationContext;

const answer = (ctx: OperationContext) => recordAnswer(ctx, { op: 'search', pages: [{ source_id: 'default', slug: SECRET_TEXT }] });

let lines: string[] = [];
let spy: ReturnType<typeof spyOn>;

beforeEach(() => {
  _resetFeedbackSettingsCacheForTests();
  _resetFeedbackRecordingForTests();
  writes = 'ok';
  gate = new Promise<void>(resolve => { release = resolve; });
  lines = [];
  spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});

afterEach(() => {
  release();
  spy.mockRestore();
});

describe('lost feedback events', () => {
  test('a failed write names itself on stderr by code and count only, and the same client\'s next answer says how many were lost, once', async () => {
    const eng = engine();
    writes = 'fail';
    const first = await answer(ctxOf(eng, 'client-a'));
    const other = await answer(ctxOf(eng, 'client-b'));
    expect((await drainFeedbackQueue(10_000)).unfinished).toBe(0);
    writes = 'ok';
    expect(lines.some(l => /answers lost: code=engine_unavailable events=\d+/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(SECRET_TEXT);
    expect(lines.join('\n')).not.toContain(first!.answer_id!);
    const next = await answer(ctxOf(eng, 'client-a'));
    expect(next!.feedback.warnings).toEqual(['FEEDBACK_EVENTS_LOST:1']);
    expect((await answer(ctxOf(eng, 'client-a')))!.feedback.warnings).toBeUndefined();
    expect(other!.feedback.warnings).toBeUndefined();
    expect(feedbackMetaFields(next)).toMatchObject({ answer_id: next!.answer_id, feedback: { warnings: ['FEEDBACK_EVENTS_LOST:1'] } });
  });

  test('queue overflow names itself on stderr and counts the dropped answers for their client', async () => {
    const eng = engine();
    writes = 'block';
    const reported: string[] = [];
    // Each answer takes (and so resets) the loss count so far: the counts it reports, summed, are every drop.
    for (let i = 0; i < QUEUE_CAP + 5; i++) reported.push(...((await answer(ctxOf(eng, 'client-a')))!.feedback.warnings ?? []));
    expect(lines.some(l => /answers lost: code=queue_overflow events=\d+/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(SECRET_TEXT);
    writes = 'ok';
    release();
    expect((await drainFeedbackQueue(20_000)).unfinished).toBe(0);
    reported.push(...((await answer(ctxOf(eng, 'client-a')))!.feedback.warnings ?? []));
    const lost = reported.map(w => Number(/^FEEDBACK_EVENTS_LOST:(\d+)$/.exec(w)![1]));
    expect(lost.reduce((a, b) => a + b, 0)).toBe(4);
  });

  test('a recording that throws returns a not-recorded meta with FEEDBACK_RECORD_FAILED, and says so on stderr', async () => {
    const pages = { [Symbol.iterator]() { throw new Error(`broken ${SECRET_TEXT}`); } } as unknown as Array<{ slug: string }>;
    const meta = await recordAnswer(ctxOf(engine(), 'client-a'), { op: 'search', pages });
    expect(meta).toEqual({ feedback: { rateable: false, reason: 'record_failed', warnings: ['FEEDBACK_RECORD_FAILED'] } });
    expect(lines.some(l => l.includes('code=record_failed'))).toBe(true);
    expect(lines.join('\n')).not.toContain(SECRET_TEXT);
    expect(feedbackMetaFields(meta)).toEqual({ feedback: meta!.feedback });
  });

  test('rating an answer this server lost says it was lost, not that it is pending or unknown', async () => {
    const eng = engine();
    writes = 'fail';
    const meta = await answer(ctxOf(eng, 'client-a'));
    expect((await drainFeedbackQueue(10_000)).unfinished).toBe(0);
    const rated = await rateAnswer(ctxOf(eng, 'client-a'), { answer_id: meta!.answer_id!, rating: 5 }).then(() => null, (e: { code?: string; reason?: string }) => ({ code: e.code, reason: e.reason }));
    expect(rated).toEqual({ code: 'answer_unavailable', reason: 'event_lost' });
  });
});
