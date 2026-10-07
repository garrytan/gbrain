/**
 * #6069: LLM replies that quote a code block verbatim carry ``` inside a JSON
 * string. The fence regex in parseLlmJson is non-greedy, so before the fix it
 * ended the extract at that inner ``` and the reply came back null, which the
 * significance judge recorded as an unparseable (and uncached) verdict.
 *
 * Every assertion goes through parseLlmJson or a real caller, both of which
 * exist before the fix, so a run with the source reverted fails on the
 * assertions rather than on a missing import. The "control" cases pass on
 * both sides: the recovery runs only after the fenced extract fails, and it
 * never reaches back before a real fence.
 */
import { describe, expect, test } from 'bun:test';
import { parseLlmJson } from '../src/core/llm-json.ts';
import { judgeSignificance, type JudgeClient } from '../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const TICKS = '```';
const fence = (body: string, tag = 'json') => `${TICKS}${tag}\n${body}\n${TICKS}`;
const quotedRun = `paste ${TICKS}sh\ngbrain sync --source wiki\n${TICKS} into the terminal`;
const inlineRun = `run ${TICKS}gbrain doctor --json${TICKS} before filing`;
const clippedQuote = `the snippet opened with ${TICKS}python and was cut`;
const judged = (quote: string) => ({
  score: 0.71,
  content_type: 'technical',
  segments: [{ quote, note: 'operator workflow' }],
  entities: ['widget-co'],
  reasons: ['durable how-to', 'names a command'],
});
const asText = (v: unknown, indent = 2) => JSON.stringify(v, null, indent);

describe('parseLlmJson recovers replies whose strings quote ``` (#6069)', () => {
  test('a fenced object whose quote holds a whole code block', () => {
    expect(parseLlmJson<unknown>(fence(asText(judged(quotedRun))))).toEqual(judged(quotedRun));
  });

  test('a fenced object whose quote holds one stray ```', () => {
    expect(parseLlmJson<unknown>(fence(asText(judged(clippedQuote))))).toEqual(judged(clippedQuote));
  });

  test('a bare fence (no json tag) behaves the same', () => {
    expect(parseLlmJson<unknown>(fence(asText(judged(quotedRun)), ''))).toEqual(judged(quotedRun));
  });

  test('an unfenced object whose quote holds ```', () => {
    expect(parseLlmJson<unknown>(asText(judged(quotedRun)))).toEqual(judged(quotedRun));
  });

  test('an unfenced one-line object after a lead-in sentence', () => {
    const reply = `Verdict follows. ${asText(judged(quotedRun), 0)}`;
    expect(parseLlmJson<unknown>(reply)).toEqual(judged(quotedRun));
  });

  test('prose with its own braces before and after a fenced answer', () => {
    const reply = `Scoring {draft 2}:\n${fence(asText(judged(quotedRun)))}\nThat is all {end}.`;
    expect(parseLlmJson<unknown>(reply)).toEqual(judged(quotedRun));
  });

  test('a reasoning block that drafts an object before the fenced answer', () => {
    const reply = `<think>first try: {"score": 0.2}</think>\n${fence(asText(judged(quotedRun)))}`;
    expect(parseLlmJson<unknown>(reply)).toEqual(judged(quotedRun));
  });

  test('an array reply (conversation-parser fallback) whose turns quote ```', () => {
    const turns = [
      { role: 'user', text: `why does ${TICKS}make${TICKS} fail?` },
      { role: 'assistant', text: `run ${TICKS}sh\nmake -j1\n${TICKS} and read the first error` },
    ];
    expect(parseLlmJson<unknown>(fence(asText(turns)), { array: true })).toEqual(turns);
  });

  test('a fenced answer with a ``` quote followed by a note holding another object', () => {
    const reply = `${fence(asText(judged(quotedRun)))}\nNote: the schema was {"version": 2}.`;
    expect(parseLlmJson<unknown>(reply)).toEqual(judged(quotedRun));
  });
});

describe('controls: what parsed or failed before still does (#6069)', () => {
  test('a clean fenced object parses from its extract', () => {
    expect(parseLlmJson<unknown>(fence('{"score": 0.4}'))).toEqual({ score: 0.4 });
  });

  test('a clean fenced object wins over a later object in prose', () => {
    expect(parseLlmJson<unknown>(`${fence('{"score": 0.4}')}\nCompare {"score": 0.9}.`)).toEqual({ score: 0.4 });
  });

  test('a fenced answer cut off inside a quote stays null', () => {
    expect(parseLlmJson<unknown>(`${TICKS}json\n{"score": 0.71, "segments": [{"quote": "paste ${TICKS}sh`)).toBeNull();
  });

  test('a reasoning draft never stands in for a cut-off fenced answer', () => {
    const reply = `<think>first try: {"score": 0.2}</think>\n${TICKS}json\n{"score": 0.71, "segments": [{"quote": "paste ${TICKS}sh`;
    expect(parseLlmJson<unknown>(reply)).toBeNull();
  });

  test('a prose object before a fence that holds no JSON is not picked up', () => {
    expect(parseLlmJson<unknown>(`Earlier {"score": 0.3} was wrong.\n${fence('no verdict today', '')}`)).toBeNull();
  });

  test('a ``` quoted mid-string never yields a nested fragment as the answer', () => {
    // The leading prose brace hides the enclosing object; guessing from the
    // inner ``` would return the second segment instead of the reply.
    const reply = `Note {x}: {"segments": [{"quote": "${TICKS}sh${TICKS} first"}, {"quote": "second"}]}`;
    expect(parseLlmJson<unknown>(reply)).toBeNull();
  });

  test('array mode still refuses an object-only reply that quotes ```', () => {
    expect(parseLlmJson<unknown>(fence(asText(judged(quotedRun))), { array: true })).toBeNull();
  });
});

describe('judgeSignificance keeps a verdict whose quote holds a code block (#6069)', () => {
  test('the fenced verdict is scored and reliable', async () => {
    const client: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: fence(asText(judged(inlineRun))) }],
        stop_reason: 'end_turn',
      }) as never,
    };
    const transcript: DiscoveredTranscript = {
      filePath: '/fixtures/chat-widget-co.txt',
      contentHash: 'c0ffee'.repeat(8),
      content: `assistant: ${inlineRun}\n`.repeat(30),
      basename: 'chat-widget-co',
      inferredDate: null,
    };
    const verdict = await judgeSignificance(client, transcript, 'anthropic:claude-haiku-4-5-20251001');
    expect(verdict.unreliable).toBeUndefined();
    expect(verdict.score).toBe(0.71);
    expect(verdict.segments).toEqual([{ quote: inlineRun, note: 'operator workflow' }]);
  });
});
