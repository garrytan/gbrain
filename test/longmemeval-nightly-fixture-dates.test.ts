/**
 * #7308 / #7501: the nightly quality probe's fixture asks relative-date
 * questions ("last year", "this year", "last month") about a haystack dated
 * 2025. Without a `question_date` the reader has no `Current Date:` line and
 * resolves them against the real clock, so the probe failed every night on
 * the calendar, not the brain. Every row with a relative-date question must
 * carry a question_date on or after its last haystack session, and the
 * reader must render it.
 */
import { expect, test } from 'bun:test';
import { NIGHTLY_PROBE_FIXTURES } from '../src/core/cycle/nightly-probe-fixtures.ts';
import { loadDataset } from '../src/eval/longmemeval/run-config.ts';
import { generateAnswer } from '../src/eval/longmemeval/reader.ts';
import { datasetDay } from '../src/eval/longmemeval/retrieval-arms.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';

const RELATIVE_DATE = /\b(last|this|next|past)\s+(year|month|week|quarter)\b|\b(yesterday|today|tomorrow|ago|recently|currently|now)\b/i;

test('#7308: every nightly fixture row with a relative-date question carries a question_date the reader renders', async () => {
  const { questions } = loadDataset(NIGHTLY_PROBE_FIXTURES.longMemEval, 'unused');
  const relative = questions.filter(q => RELATIVE_DATE.test(q.question));
  expect(relative.map(q => q.question_id)).toEqual(expect.arrayContaining(['nightly-1', 'nightly-2', 'nightly-7']));
  for (const q of relative) {
    const day = datasetDay(q.question_date);
    expect({ id: q.question_id, day }).toEqual({ id: q.question_id, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    for (const haystackDay of (q.haystack_dates ?? []).map(d => datasetDay(d)!)) expect(day! >= haystackDay).toBe(true);
    let sent = '';
    const client = { create: async (request: { messages: Array<{ content: string }> }) => {
      sent = request.messages[0]!.content;
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } };
    } } as unknown as ThinkLLMClient;
    await generateAnswer(client, q, [], [], new Map(), 'stub');
    expect(sent).toContain(`Current Date: ${q.question_date}\n`);
  }
});
