import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, freezeEvidence, inputUpperBound, pairedSummary, readRecords, readerRequest, recordedCall, reportSummaries, saveJson, selectCohorts, usageCost, READER } from '../scripts/eval-answer-packet.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { generateAnswer } from '../src/eval/longmemeval/reader.ts';
import { renderFullSessions } from '../src/eval/longmemeval/evidence-packet.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import type { SearchResult } from '../src/core/types.ts';

const dirs: string[] = [];
function journal() { const d = mkdtempSync(join(tmpdir(), 'answer-packet-')); dirs.push(d); return join(d, 'calls.ndjson'); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const question = { question_id: 'q', question_type: 'single-session-user', question: 'Which flower?', answer: 'hidden', answer_session_ids: ['s1'],
  question_date: '2023/05/20', haystack_dates: ['2023/01/01', '2023/02/01'], haystack_sessions: [
    { session_id: 's1', turns: [{ role: 'user' as const, content: 'An orchid.' }] },
    { session_id: 's2', turns: [{ role: 'assistant' as const, content: 'An oak.' }] },
  ] };
function fake(path: string, opts: { unknown?: boolean; fail?: boolean; before?: () => void } = {}) {
  return async (request: ChatOpts): Promise<ChatResult> => invokeAI({ model: request.model!, kind: 'chat', operation: 'test', maxOutputTokens: request.maxTokens }, async () => {
    expect(readRecords(path).at(-1)?.event).toBe('admit'); opts.before?.();
    if (opts.fail) throw new Error('timeout');
    return { text: 'yes', blocks: [], model: request.model!, providerId: 'anthropic', responseModel: 'snapshot', stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 20, cache_creation_tokens: 30 } };
  }, () => opts.unknown ? null : { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 });
}

describe('frozen presentation experiment', () => {
  test('baseline is byte-identical to the unmodified reader, including dates and full pages', async () => {
    const sources = freezeEvidence(question, { question_id: 'q', retrieved_session_ids: ['s2', 's1'] });
    const request = readerRequest(question, renderFullSessions(sources));
    let captured: any;
    const pages = haystackToPages(question).map((p, i) => ({ ...p, date: question.haystack_dates[i] }));
    await generateAnswer({ create: async (params: any) => { captured = params; return { content: [{ type: 'text', text: 'x' }] } as any; } }, question,
      [pages[1], pages[0], pages[1]].map(p => ({ slug: p.slug, chunk_text: 'not the full text' }) as SearchResult), pages,
      new Map(pages.map((p, i) => [p.slug, [question.haystack_sessions[i].session_id]])), READER);
    expect(request.system).toBe(captured.system);
    expect(request.messages).toEqual(captured.messages);
    expect(request.maxTokens).toBe(captured.max_tokens);
    expect(request.model).toBe(captured.model);
    expect(request.temperature).toBeUndefined();
    expect(Object.keys(sources[0]).sort()).toEqual(['body', 'date', 'session_id', 'source_id', 'turns']);
    expect(JSON.stringify(sources)).not.toContain('hidden');
  });

  test('missing, duplicate, and ambiguous source IDs fail closed', () => {
    expect(() => freezeEvidence(question, { question_id: 'q', retrieved_session_ids: ['absent'] })).toThrow('Missing');
    expect(() => freezeEvidence(question, { question_id: 'q', retrieved_session_ids: ['s1', 's1'] })).toThrow('Invalid');
    expect(() => freezeEvidence({ ...question, haystack_sessions: [question.haystack_sessions[0], question.haystack_sessions[0]] }, { question_id: 'q', retrieved_session_ids: ['s1'] })).toThrow('ambiguous');
  });

  test('selects disjoint all-category cohorts without correctness labels and groups related variants', () => {
    const qs: LongMemEvalQuestion[] = [];
    const splits = { dev40: [] as string[], decision430: [] as string[] };
    for (let category = 0; category < 6; category++) for (let n = 0; n < 16; n++) {
      const id = `c${category}-${n}`;
      qs.push({ ...question, question_id: id, question_type: `type-${category}`, question: `question ${id}`, haystack_session_ids: [`history-${id}`] });
      (n < 4 ? splits.dev40 : splits.decision430).push(id);
    }
    for (let n = 0; n < 30; n++) qs.push({ ...question, question_id: `abs-${n}_abs`, question: `abstention ${n}`, haystack_session_ids: [`history-abs-${n}`] });
    qs.push({ ...qs[0], question_id: `${qs[0].question_id}_abs` });
    const c = selectCohorts(qs, splits);
    expect(c.dev).toHaveLength(18); expect(c.holdout).toHaveLength(60);
    expect(new Set([...c.dev, ...c.holdout].map(id => c.groups[id])).size).toBe(78);
    expect(c).toEqual(selectCohorts(qs.map(q => ({ ...q, answer: 'changed gold' })), splits));
  });

  test('records admission before dispatch, prices cached tokens, and reuses exact completed responses', async () => {
    const path = journal(); const request = readerRequest(question, 'evidence');
    const first = await recordedCall(path, 'dev/q/v1/reader', request, 20, fake(path));
    expect(first.responseModel).toBe('snapshot');
    const events = readRecords(path);
    expect(events.map(r => r.event)).toEqual(['admit', 'settle', 'response']);
    expect(events[1].cost_usd).toBeCloseTo((100 * 3 + 10 * 15 + 20 * .3 + 30 * 3.75) / 1e6, 10);
    expect(await recordedCall(path, 'dev/q/v1/reader', request, 20, async () => { throw new Error('must not dispatch'); })).toEqual(first);
    await expect(recordedCall(path, 'dev/q/v1/reader', { ...request, system: 'changed' }, 20, fake(path))).rejects.toThrow('Changed');
  });

  test('restores spend on restart and refuses exhausted and unknown-price attempts before dispatch', async () => {
    const path = journal(); const request = readerRequest(question, 'evidence');
    await recordedCall(path, 'first', request, 20, fake(path));
    await expect(recordedCall(path, 'second', request, .0001, fake(path))).rejects.toThrow();
    expect(readRecords(path).filter(r => r.event === 'admit')).toHaveLength(1);
    await expect(recordedCall(journal(), 'unknown', { ...request, model: 'unknown:model' }, 20, fake(path))).rejects.toThrow('pricing');
    await expect(recordedCall(journal(), 'zero', request, 0, fake(path))).rejects.toThrow('cap');
    expect(() => usageCost('unpriced', { inputTokens: 1, outputTokens: 1 })).toThrow('pricing');
  });

  test('retains unknown reservations and never automatically repeats an interrupted paid request', async () => {
    for (const opts of [{ unknown: true }, { fail: true }]) {
      const path = journal(); const request = readerRequest(question, 'evidence');
      await expect(recordedCall(path, 'first', request, 20, fake(path, opts))).rejects.toThrow();
      expect(readRecords(path).find(r => r.event === 'settle')?.usage).toBeNull();
      await expect(recordedCall(path, 'second', request, 20, fake(path))).rejects.toThrow('Unknown paid usage');
    }
  });

  test('rejects partial journals, conflicting artifacts and unsupported request shapes', () => {
    const path = journal(); writeFileSync(path, '{"event":');
    expect(() => readRecords(path)).toThrow('Interrupted');
    const other = journal(); saveJson(other, { frozen: true });
    expect(() => saveJson(other, { overwritten: true })).toThrow();
    expect(() => appendRecord(join(other, 'not-a-directory'), {})).toThrow();
    expect(() => inputUpperBound({ ...readerRequest(question, 'evidence'), tools: [{}] as any })).toThrow('text-only');
    expect(inputUpperBound(readerRequest(question, '你好'))).toBeGreaterThan(1024);
  });

  test('keeps every regression and distinguishes incomplete pairs from wrong answers', () => {
    const rows = [[false, true], [true, false], [true, true], [false, false], [undefined, true]].map(([b, c], i) => ({ question_id: String(i), baseline_correct: b, candidate_correct: c }));
    const s = pairedSummary(rows);
    expect(s).toMatchObject({ n: 5, complete: 4, incomplete: 1, baseline_correct: 2, candidate_correct: 2, both_right: 1, both_wrong: 1, wins: ['0'], losses: ['1'], net: 0 });
    expect(s.delta_ci95.label).toBe('question-sampling only');
  });

  test('retains successful provider text before rejecting a settlement policy violation', async () => {
    const path = journal(); const request = readerRequest(question, 'evidence');
    const transport = (opts: ChatOpts) => invokeAI({ model: READER, kind: 'chat', operation: 'test', maxOutputTokens: opts.maxTokens },
      async (): Promise<ChatResult> => ({ text: 'retain this answer', blocks: [], model: READER, providerId: 'anthropic', stopReason: 'end',
        usage: { input_tokens: inputUpperBound(request) + 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } }),
      () => ({ inputTokens: inputUpperBound(request) + 1, outputTokens: 1 }));
    await expect(recordedCall(path, 'overbound', request, 20, transport)).rejects.toThrow('token bound');
    expect(readRecords(path).map(r => r.event)).toEqual(['admit', 'settle', 'response', 'error']);
    expect(readRecords(path).find(r => r.event === 'response')?.response.text).toBe('retain this answer');
    await expect(recordedCall(path, 'overbound', request, 20, transport)).rejects.toThrow('Failed paid call');
    const prefix = readRecords(path).filter(r => r.event !== 'error');
    writeFileSync(path, prefix.map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(prefix.at(-1)?.accepted).toBe(false);
    await expect(recordedCall(path, 'overbound', request, 20, transport)).rejects.toThrow('Unaccepted paid response');
  });

  test('reports interrupted cases in every subgroup even before the first complete pair', () => {
    const manifest = { cohorts: { holdout: ['q1', 'q2'], categories: ['a', 'b'] }, case_metadata: {
      q1: { category: 'a', abstention: false, retrieval_complete: true }, q2: { category: 'b', abstention: true, retrieval_complete: false },
    } };
    const starts = [{ event: 'phase_start', phase: 'holdout', variant: 'v1' }];
    const empty = reportSummaries(manifest, [], starts)['holdout-v1'];
    expect(empty).toMatchObject({ n: 2, complete: 0, incomplete: 2 });
    expect(empty.by_category.b).toMatchObject({ n: 1, incomplete: 1 });
    const rows = [{ phase: 'holdout', variant: 'v1', question_id: 'q1', ...manifest.case_metadata.q1, baseline_correct: true, candidate_correct: true }];
    const partial = reportSummaries(manifest, rows, starts)['holdout-v1'];
    expect(partial.by_abstention.true).toMatchObject({ n: 1, incomplete: 1 });
    expect(partial.by_retrieval_complete.false).toMatchObject({ n: 1, incomplete: 1 });
  });
});
