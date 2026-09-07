/**
 * Phase D — `gbrain eval longmemeval --judge` end-to-end on the mixed-case
 * fixture (3 questions: mc-1 single-session-user, mc-2 multi-session,
 * mc-3_abs abstention), with a canned reader (ThinkLLMClient) and a canned
 * judge (JudgeChatFn). Hermetic: in-memory PGLite, --keyword-only, no
 * network, no API key.
 *
 *   - live run: rows carry the judge fields + reader pins; the summary
 *     carries qa_accuracy; one injected judge_error scores INCORRECT in the
 *     headline and makes the run non-publishable (exit 1);
 *   - `--judge --resume-from` backfill: only the errored row is re-judged
 *     from its stored hypothesis (reader never called), the file is
 *     rewritten without duplicates, qa_accuracy is rebuilt from ALL rows,
 *     exit 0;
 *   - `--judge --retrieval-only` is a usage error; a retrieval-only file is
 *     refused by the backfill;
 *   - budget soft-stop stamps judge_skipped:"budget" (exit 1 unless
 *     --allow-incomplete-judgments);
 *   - mixed judge_config_hash refused unless --allow-mixed-run-config;
 *   - no usable judge provider → exit 1 naming OPENAI_API_KEY;
 *   - backfill to a different --output copies the prior rows forward;
 *   - a judge THROW on a live row (malformed provider result) stamps
 *     judge_error:provider_error and KEEPS the paid reader row (never an
 *     error row);
 *   - a resume of a judged file WITHOUT --judge still rebuilds qa_accuracy
 *     from the prior verdicts (anyRowJudged).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { READER_PROMPT_SHA } from '../src/eval/longmemeval/reader.ts';
import { JUDGE_PROMPT_VERSION } from '../src/eval/longmemeval/judge.ts';
import type { JudgeChatFn } from '../src/eval/shared/judge-runner.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mixedcase.jsonl');
const READER_MODEL = 'openai:gpt-5.2';
const BASE = ['--keyword-only', '--no-trajectory', '--top-k', '5', '--model', READER_MODEL];
const JUDGE = ['--judge', '--max-usd', '1', '--yes'];

const QUESTIONS: Record<string, string> = {
  'mc-1': 'kayak brand alice-example wants to buy for the river trip',
  'mc-2': 'how many sourdough loaves did alice-example bake for the widget-co bake sale',
  'mc-3_abs': 'which trail did the assistant recommend to charlie-example for the sunrise hike near the coast',
};
const ANSWERS: Record<string, string> = {
  'mc-1': 'The Driftwood kayak brand.',
  'mc-2': 'Twelve loaves.',
  'mc-3_abs': "The retrieved sessions do not contain a recommended trail; I don't know.",
};

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = await createBenchmarkBrain();
  tmp = mkdtempSync(join(tmpdir(), 'lme-judge-'));
});
afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => { resetGateway(); });

function readRows(path: string): any[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
function splitRows(path: string): { rows: any[]; summary: any } {
  const all = readRows(path);
  return { rows: all.filter(r => r.kind !== 'by_type_summary'), summary: all.find(r => r.kind === 'by_type_summary') };
}
function byId(rows: any[]): Record<string, any> {
  return Object.fromEntries(rows.map(r => [r.question_id, r]));
}
function qidOf(text: string): string {
  for (const [qid, q] of Object.entries(QUESTIONS)) if (text.includes(q)) return qid;
  throw new Error(`no fixture question in: ${text.slice(0, 120)}`);
}

/** Canned reader: answers by question; records the system + user text; optionally forbidden. */
function readerClient(opts: { forbid?: boolean } = {}) {
  const calls: Array<{ model: string; system: string; userText: string }> = [];
  const client: ThinkLLMClient = {
    async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      if (opts.forbid) throw new Error('reader must not be called on a judge-only backfill');
      const system = typeof params.system === 'string' ? params.system : '';
      const first = params.messages[0];
      const userText = typeof first.content === 'string' ? first.content : first.content.map(b => (b.type === 'text' ? b.text : '')).join('\n');
      calls.push({ model: params.model, system, userText });
      const qid = qidOf(userText);
      return {
        id: 'stub', type: 'message', role: 'assistant', model: params.model,
        content: [{ type: 'text', text: ANSWERS[qid], citations: null }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
        container: null,
      } as unknown as Anthropic.Message;
    },
  };
  return { client, calls };
}

/** Canned judge: verdict text (or a thrown Error) per question id; records every ChatOpts. */
function judgeClient(
  script: Record<string, string | Error>,
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 200, output_tokens: 2 },
) {
  const calls: Array<ChatOpts & { qid: string }> = [];
  const fn: JudgeChatFn = async (opts) => {
    const content = opts.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const qid = qidOf(content);
    calls.push({ ...opts, qid });
    const v = script[qid];
    if (v === undefined) throw new Error(`no scripted verdict for ${qid}`);
    if (v instanceof Error) throw v;
    const res: ChatResult = {
      text: v, blocks: [{ type: 'text', text: v }], stopReason: 'end',
      usage: { ...usage, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? '', providerId: 'openai', responseModel: 'gpt-4o-2024-08-06',
    };
    return res;
  };
  return { fn, calls };
}

/** Run with process.exit captured; returns the exit code (null = clean) and captured stderr. */
async function runCapturing(args: string[], runOpts: Parameters<typeof runEvalLongMemEval>[1]): Promise<{ code: number | null; stderr: string }> {
  let code: number | null = null;
  let stderr = '';
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  // @ts-ignore runtime override for the test
  process.exit = ((c: number) => { code = c; throw new Error('__exit__'); }) as any;
  // @ts-ignore runtime override for the test
  process.stderr.write = ((chunk: any) => { stderr += String(chunk); return true; }) as any;
  try {
    await runEvalLongMemEval(args, runOpts);
  } catch (e) {
    if (!String(e).includes('__exit__')) throw e;
  } finally {
    // @ts-ignore runtime restore
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
  return { code, stderr };
}

describe('--judge live run + --judge --resume-from backfill', () => {
  const out = () => join(tmp, 'live-then-backfill.jsonl');

  test('live: rows carry judge fields + reader pins; one injected judge_error → headline incorrect, exit 1', async () => {
    const reader = readerClient();
    const judge = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'No', 'mc-3_abs': new Error('injected provider outage') });
    const { code, stderr } = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out()], { engine, client: reader.client, judgeClient: judge.fn });
    expect(code).toBe(1);
    expect(stderr).toContain('FAIL --judge: judgments incomplete');
    expect(stderr).toContain('NOT publishable');
    expect(stderr).toContain('[longmemeval] judge: openai:gpt-4o, 3 live + 0 backfill');

    const { rows, summary } = splitRows(out());
    expect(rows).toHaveLength(3);
    const r = byId(rows);
    // Verdicts and the error class — the error is NOT an `incorrect`.
    expect(r['mc-1'].judge_correct).toBe(true);
    expect(r['mc-2'].judge_correct).toBe(false);
    expect(r['mc-3_abs'].judge_correct).toBeUndefined();
    expect(r['mc-3_abs'].judge_error).toBe('provider_error');
    expect(r['mc-3_abs'].judge_error_detail).toContain('injected provider outage');
    expect(r['mc-3_abs'].judge_attempts).toBe(1); // provider_error is not retried
    for (const row of rows) {
      expect(row.judge_model).toBe('openai:gpt-4o');
      expect(row.judge_prompt_version).toBe(JUDGE_PROMPT_VERSION);
      expect(row.judge_config_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof row.judge_raw).toBe('string');
      expect(row.judge_raw.length).toBeLessThanOrEqual(200);
      // Reader pins (D30) on every answered row.
      expect(row.reader_model).toBe(READER_MODEL);
      expect(row.reader_model_snapshot).toBeNull(); // stub echoed the requested id
      expect(row.reader_prompt_sha).toBe(READER_PROMPT_SHA);
      expect(row.reader_max_tokens).toBe(512);
      expect(row.retrieval_only).toBeUndefined();
      expect(row.error).toBeUndefined();
    }
    expect(new Set(rows.map(x => x.judge_config_hash)).size).toBe(1);
    expect(r['mc-1'].judge_model_snapshot).toBe('gpt-4o-2024-08-06');
    expect(r['mc-1'].judge_cost_usd).toBeGreaterThan(0);
    expect(r['mc-3_abs'].judge_cost_usd).toBe(0); // threw before any usage
    expect(r['mc-3_abs'].judge_prompt_kind).toBe('abstention');
    expect(r['mc-2'].judge_prompt_kind).toBe('standard');

    // The judge saw the official call shape and the per-type prompt.
    expect(judge.calls).toHaveLength(3);
    for (const c of judge.calls) {
      expect(c.temperature).toBe(0);
      expect(c.maxTokens).toBe(16); // provider minimum (official prompt asks 10; one-token verdict unaffected)
      expect(c.model).toBe('openai:gpt-4o');
      expect(c.messages).toHaveLength(1);
    }
    const promptOf = (qid: string) => String(judge.calls.find(c => c.qid === qid)!.messages[0].content);
    expect(promptOf('mc-3_abs')).toContain('unanswerable');
    expect(promptOf('mc-3_abs')).toContain('Explanation: The assistant never recommended');
    expect(promptOf('mc-2')).toContain('If the response only contains a subset of the information required by the answer, answer no.');
    expect(promptOf('mc-2')).toContain('Correct Answer: twelve loaves, six of them rye');
    expect(promptOf('mc-2')).toContain('Model Response: Twelve loaves.');
    expect(promptOf('mc-1')).toContain('<judge_input>');

    // The reader saw the abstention instruction.
    expect(reader.calls).toHaveLength(3);
    expect(reader.calls[0].system).toContain("I don't know");
    expect(reader.calls[0].system).toContain('UNTRUSTED');
    expect(reader.calls[0].userText).toContain('Retrieved sessions:');

    // --judge implied --by-type: the summary exists and carries qa_accuracy.
    expect(summary).toBeDefined();
    const qa = summary.qa_accuracy;
    expect(qa.total_questions).toBe(3);
    expect(qa.judged).toBe(2);
    expect(qa.correct).toBe(1);
    expect(qa.judge_errors).toBe(1);
    expect(qa.skipped_budget).toBe(0);
    expect(qa.reader_errors).toBe(0);
    expect(qa.accuracy_headline).toBeCloseTo(1 / 3, 12); // the error scores INCORRECT
    expect(qa.accuracy).toBe(qa.accuracy_headline);
    expect(qa.accuracy_excluding_errors).toBeCloseTo(1 / 2, 12);
    expect(qa.accuracy_470).toBeCloseTo(1 / 2, 12); // mc-1 correct, mc-2 wrong; _abs excluded
    expect(qa.non_abstention_total).toBe(2);
    expect(qa.abstention).toEqual({ total: 1, judged: 0, correct: 0, judge_errors: 1, accuracy_headline: 0 });
    expect(Object.keys(qa.by_type)).toEqual(['multi-session', 'single-session-assistant', 'single-session-user']);
    expect(qa.by_type['single-session-user']).toMatchObject({ total: 1, judged: 1, correct: 1, accuracy_headline: 1 });
    expect(qa.judge_error_classes).toEqual({ provider_error: 1 });
    expect(qa.complete).toBe(false);
    expect(qa.judge_model).toBe('openai:gpt-4o');
    expect(qa.judge_prompt_version).toBe(JUDGE_PROMPT_VERSION);
    expect(qa.judge_config_hash).toBe(rows[0].judge_config_hash);
    expect(qa.est_cost_usd).toBeGreaterThan(0);
    expect(qa.actual_cost_usd).toBeGreaterThan(0);
    expect(qa.run_cost_usd).toBeCloseTo(qa.actual_cost_usd, 12);
    expect(qa.ci95_bootstrap.label).toBe('question-sampling only');
    expect(qa.ci95_bootstrap.n).toBe(3);
    expect(qa.methodology_note).toContain('data-boundary');
    expect(qa.methodology_note).toContain('no SOTA claim');
    expect(summary._meta.metric_glossary.qa_accuracy).toContain('judge');
    // Recall metrics are untouched by the judge lane.
    expect(summary.aggregate.total).toBe(2);
    expect(summary.excluded_abstention).toBe(1);
  }, 120_000);

  test('backfill: only the errored row is re-judged (no reader call), file rewritten without duplicates, exit 0', async () => {
    const reader = readerClient({ forbid: true });
    const judge = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const { code, stderr } = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--output', out(), '--resume-from', out()],
      { engine, client: reader.client, judgeClient: judge.fn },
    );
    expect(code).toBeNull();
    expect(stderr).toContain('judge backfill: 1 row(s) to judge from their stored hypothesis; 2 verdict(s) stand');
    expect(stderr).not.toContain('FAIL');
    expect(reader.calls).toHaveLength(0);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].qid).toBe('mc-3_abs');

    const { rows, summary } = splitRows(out());
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(x => x.question_id)).size).toBe(3);
    const r = byId(rows);
    expect(r['mc-3_abs'].judge_correct).toBe(true);
    expect(r['mc-3_abs'].judge_error).toBeUndefined();
    expect(r['mc-3_abs'].judge_error_detail).toBeUndefined();
    expect(r['mc-3_abs'].judge_attempts).toBe(1);
    expect(r['mc-3_abs'].hypothesis).toBe(ANSWERS['mc-3_abs']); // judged from the STORED hypothesis
    expect(r['mc-2'].judge_correct).toBe(false); // settled verdict stands (not re-judged)
    expect(r['mc-1'].judge_correct).toBe(true);

    const qa = summary.qa_accuracy;
    expect(qa.total_questions).toBe(3);
    expect(qa.judged).toBe(3);
    expect(qa.correct).toBe(2);
    expect(qa.judge_errors).toBe(0);
    expect(qa.skipped_budget).toBe(0);
    expect(qa.complete).toBe(true);
    expect(qa.accuracy_headline).toBeCloseTo(2 / 3, 12);
    expect(qa.accuracy_excluding_errors).toBeCloseTo(2 / 3, 12);
    expect(qa.abstention).toEqual({ total: 1, judged: 1, correct: 1, judge_errors: 0, accuracy_headline: 1 });
    expect(qa.mixed_judge_config).toBe(false);
    // Cumulative spend across both runs exceeds this run's.
    expect(qa.actual_cost_usd).toBeGreaterThan(qa.run_cost_usd);
    // Recall summary is still cumulative over the prior rows.
    expect(summary.aggregate.total).toBe(2);
    expect(summary.run_config.cache_skipped).toBe('keyword_only');
  }, 120_000);

  test('backfill to a DIFFERENT --output copies the prior rows forward (nothing to judge → no calls)', async () => {
    const out2 = join(tmp, 'copy-forward.jsonl');
    const reader = readerClient({ forbid: true });
    const judge = judgeClient({});
    const { code, stderr } = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--output', out2, '--resume-from', out()],
      { engine, client: reader.client, judgeClient: judge.fn },
    );
    expect(code).toBeNull();
    expect(stderr).toContain('nothing to do (all questions already answered and judged)');
    expect(judge.calls).toHaveLength(0);
    // The no-op branch copies the prior rows into the new output and rebuilds qa_accuracy from them.
    const copied = splitRows(out2);
    expect(copied.rows.map(r => r.question_id).sort()).toEqual(['mc-1', 'mc-2', 'mc-3_abs']);
    expect(byId(copied.rows)['mc-3_abs'].judge_correct).toBe(true);
    expect(copied.summary.qa_accuracy).toMatchObject({ judged: 3, correct: 2, complete: true });
    expect(readRows(out2)[readRows(out2).length - 1].kind).toBe('by_type_summary');
    expect(stderr).toContain('qa_accuracy: headline 66.7% (2/3');
  }, 60_000);
});

describe('usage errors + refusals', () => {
  test('--judge with --retrieval-only is a usage error (exit 1, no output)', async () => {
    const out = join(tmp, 'usage-error.jsonl');
    const { code, stderr } = await runCapturing([FIXTURE, ...BASE, '--retrieval-only', ...JUDGE, '--output', out], { engine });
    expect(code).toBe(1);
    expect(stderr).toContain('--judge cannot be combined with --retrieval-only');
    expect(existsSync(out)).toBe(false);
  });

  test('a --retrieval-only file is marked retrieval_only:true and a --judge backfill refuses it', async () => {
    const out = join(tmp, 'retrieval-only.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--retrieval-only', '--limit', '1', '--output', out], { engine });
    const { rows } = splitRows(out);
    expect(rows[0].retrieval_only).toBe(true);
    expect(rows[0].reader_model).toBeUndefined();
    const judge = judgeClient({});
    const { code, stderr } = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--limit', '1', '--output', out, '--resume-from', out], { engine, judgeClient: judge.fn });
    expect(code).toBe(1);
    expect(stderr).toContain('produced with --retrieval-only');
    expect(judge.calls).toHaveLength(0);
  }, 60_000);

  test('no usable judge provider and no injected client → exit 1 naming OPENAI_API_KEY', async () => {
    configureGateway({ env: {} });
    const out = join(tmp, 'no-provider.jsonl');
    const { code, stderr } = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out], { engine, client: readerClient().client });
    expect(code).toBe(1);
    expect(stderr).toContain('OPENAI_API_KEY');
    expect(stderr).toContain('--judge-model');
    expect(existsSync(out)).toBe(false);
  });

  test('unpriced judge model with a cap → exit 2; estimate over the cap without --yes → exit 2', async () => {
    const judge = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const out = join(tmp, 'unpriced.jsonl');
    const unpriced = await runCapturing(
      [FIXTURE, ...BASE, '--judge', '--judge-model', 'openai:not-a-priced-model-xyz', '--output', out],
      { engine, client: readerClient().client, judgeClient: judge.fn },
    );
    expect(unpriced.code).toBe(2);
    expect(unpriced.stderr).toContain('no CANONICAL_PRICING entry');
    const over = await runCapturing(
      [FIXTURE, ...BASE, '--judge', '--max-usd', '0.0000001', '--output', out],
      { engine, client: readerClient().client, judgeClient: judge.fn },
    );
    expect(over.code).toBe(2);
    expect(over.stderr).toContain('exceeds --max-usd');
    expect(over.stderr).toContain('--yes');
    expect(judge.calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe('budget soft-stop', () => {
  test('the cap stops the lane after the first paid call; remaining rows are judge_skipped:"budget" (exit 1, or 0 with --allow-incomplete-judgments)', async () => {
    // Per-call actual cost with usage {1000, 2} on gpt-4o ≈ $0.0025 > the $0.001 cap,
    // while the projected cost of the FIRST call (~225 prompt tokens) fits under it.
    const mk = () => judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' }, { input_tokens: 1000, output_tokens: 2 });
    const out = join(tmp, 'budget.jsonl');
    const j1 = mk();
    const first = await runCapturing([FIXTURE, ...BASE, '--judge', '--max-usd', '0.001', '--yes', '--output', out], { engine, client: readerClient().client, judgeClient: j1.fn });
    expect(first.code).toBe(1);
    expect(first.stderr).toContain('skipped_budget 2');
    expect(j1.calls).toHaveLength(1);
    const { rows, summary } = splitRows(out);
    const judged = rows.filter(r => typeof r.judge_correct === 'boolean');
    const skipped = rows.filter(r => r.judge_skipped === 'budget');
    expect(judged).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    for (const s of skipped) {
      expect(s.judge_correct).toBeUndefined();
      expect(s.judge_error).toBeUndefined();
      expect(s.judge_cost_usd).toBeNull();
      expect(s.judge_config_hash).toBe(judged[0].judge_config_hash);
    }
    expect(summary.qa_accuracy.skipped_budget).toBe(2);
    expect(summary.qa_accuracy.judged).toBe(1);
    expect(summary.qa_accuracy.accuracy_headline).toBeCloseTo(1 / 3, 12); // skips score INCORRECT
    expect(summary.qa_accuracy.complete).toBe(false);

    const out2 = join(tmp, 'budget-allowed.jsonl');
    const j2 = mk();
    const allowed = await runCapturing(
      [FIXTURE, ...BASE, '--judge', '--max-usd', '0.001', '--yes', '--allow-incomplete-judgments', '--output', out2],
      { engine, client: readerClient().client, judgeClient: j2.fn },
    );
    expect(allowed.code).toBeNull();
    expect(allowed.stderr).toContain('WARN --judge: judgments incomplete');

    // A backfill under a real cap judges the skipped rows (they lack a settled verdict).
    const j3 = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const back = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out, '--resume-from', out], { engine, client: readerClient({ forbid: true }).client, judgeClient: j3.fn });
    expect(back.code).toBeNull();
    expect(j3.calls).toHaveLength(2);
    expect(splitRows(out).summary.qa_accuracy).toMatchObject({ judged: 3, correct: 3, skipped_budget: 0, complete: true });
  }, 180_000);
});

describe('judge_config_hash gate on resume (D33)', () => {
  test('a file judged under another judge model is refused; --allow-mixed-run-config proceeds and flags mixed_judge_config', async () => {
    const out = join(tmp, 'mixed.jsonl');
    const j1 = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const first = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out], { engine, client: readerClient().client, judgeClient: j1.fn });
    expect(first.code).toBeNull();
    const h1 = splitRows(out).rows[0].judge_config_hash;

    const j2 = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const refused = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--judge-model', 'openai:gpt-4o-mini', '--output', out, '--resume-from', out],
      { engine, client: readerClient({ forbid: true }).client, judgeClient: j2.fn },
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('3 judged row(s)');
    expect(refused.stderr).toContain('different judge_config_hash');
    expect(j2.calls).toHaveLength(0);
    expect(splitRows(out).rows[0].judge_config_hash).toBe(h1); // untouched

    const allowed = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--judge-model', 'openai:gpt-4o-mini', '--output', out, '--resume-from', out, '--allow-mixed-run-config'],
      { engine, client: readerClient({ forbid: true }).client, judgeClient: j2.fn },
    );
    expect(allowed.code).toBeNull();
    expect(allowed.stderr).toContain('Continuing (--allow-mixed-run-config)');
    expect(j2.calls).toHaveLength(0); // verdicts stand; nothing to re-judge
    const qa = splitRows(out).summary.qa_accuracy;
    // Every row still carries h1 → the file is homogeneous: NOT mixed, and the
    // published hash is the one the rows were judged under, not this run's.
    expect(qa.mixed_judge_config).toBe(false);
    expect(qa.judge_config_hash).toBe(h1);
    expect(qa.judge_model).toBe('openai:gpt-4o-mini');
    expect(qa.judged).toBe(3);

    // Strip one verdict so the gpt-4o-mini lane judges exactly that row:
    // 2 rows under h1 + 1 under the new hash → genuinely mixed.
    const stripped = splitRows(out).rows.map(r => (r.question_id === 'mc-3_abs' ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('judge_'))) : r));
    writeFileSync(out, stripped.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const j3 = judgeClient({ 'mc-3_abs': 'Yes' });
    const mixed = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--judge-model', 'openai:gpt-4o-mini', '--output', out, '--resume-from', out, '--allow-mixed-run-config'],
      { engine, client: readerClient({ forbid: true }).client, judgeClient: j3.fn },
    );
    expect(mixed.code).toBeNull();
    expect(j3.calls.map(c => c.qid)).toEqual(['mc-3_abs']);
    const after = splitRows(out);
    expect(new Set(after.rows.map(r => r.judge_config_hash)).size).toBe(2);
    expect(after.summary.qa_accuracy.mixed_judge_config).toBe(true);
    expect(after.summary.qa_accuracy.judged).toBe(3);
    expect(after.summary.qa_accuracy.complete).toBe(true);
  }, 120_000);
});

describe('--judge publishability gate reads qa.complete (unjudged rows count)', () => {
  test('a prior row with an empty hypothesis and no error is "done" for the reader but unjudgeable → complete:false, exit 1 naming unjudged; --allow-incomplete-judgments → WARN, exit 0', async () => {
    const out = join(tmp, 'unjudged.jsonl');
    const write = () => writeFileSync(out, readRows(FIXTURE).map(q => JSON.stringify({
      question_id: q.question_id, question: q.question, question_type: q.question_type,
      hypothesis: q.question_id === 'mc-3_abs' ? '' : ANSWERS[q.question_id],
    })).join('\n') + '\n', 'utf8');
    write();
    const j1 = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes' });
    const failed = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--output', out, '--resume-from', out],
      { engine, client: readerClient({ forbid: true }).client, judgeClient: j1.fn },
    );
    expect(failed.code).toBe(1);
    expect(j1.calls.map(c => c.qid).sort()).toEqual(['mc-1', 'mc-2']);
    expect(failed.stderr).toContain('FAIL --judge: judgments incomplete (judge_errors 0, skipped_budget 0, unjudged 1)');
    const qa = splitRows(out).summary.qa_accuracy;
    expect(qa.complete).toBe(false);
    expect(qa.unjudged).toBe(1);
    expect(qa.judged).toBe(2);
    expect(qa.judge_errors).toBe(0);

    write();
    const j2 = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes' });
    const warned = await runCapturing(
      [FIXTURE, ...BASE, ...JUDGE, '--allow-incomplete-judgments', '--output', out, '--resume-from', out],
      { engine, client: readerClient({ forbid: true }).client, judgeClient: j2.fn },
    );
    expect(warned.code).toBeNull();
    expect(warned.stderr).toContain('WARN --judge: judgments incomplete (judge_errors 0, skipped_budget 0, unjudged 1)');
    expect(splitRows(out).summary.qa_accuracy.complete).toBe(false);
  }, 120_000);
});

describe('inline judge throw keeps the paid reader row', () => {
  test('a judge client that resolves with a malformed (undefined) result → judge_error provider_error on the row; hypothesis kept; no error row; exit 1', async () => {
    const out = join(tmp, 'judge-throw.jsonl');
    const reader = readerClient();
    let calls = 0;
    // judgeRow never throws for a transport failure (a thrown client error is a
    // classified judge_error), so the throw is provoked by a malformed result:
    // runJudge dereferences `res.usage` and TypeErrors out of judgeRow.
    const badJudge: JudgeChatFn = async () => { calls++; return undefined as unknown as ChatResult; };
    const { code, stderr } = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out], { engine, client: reader.client, judgeClient: badJudge });
    expect(code).toBe(1);
    expect(calls).toBe(3);
    expect(reader.calls).toHaveLength(3);
    expect(stderr).toContain('FAIL --judge: judgments incomplete (judge_errors 3, skipped_budget 0, unjudged 0)');
    expect(stderr).not.toContain('every question errored');
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.error).toBeUndefined(); // NOT an error row
      expect(row.hypothesis).toBe(ANSWERS[row.question_id]); // the paid reader row survives
      expect(row.reader_model).toBe(READER_MODEL);
      expect(row.judge_error).toBe('provider_error');
      expect(row.judge_error_detail).toContain('undefined');
      expect(row.judge_correct).toBeUndefined();
      expect(row.judge_model).toBe('openai:gpt-4o');
      expect(row.judge_prompt_version).toBe(JUDGE_PROMPT_VERSION);
      expect(row.judge_config_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(summary.run_config.errors).toBe(0);
    expect(summary.qa_accuracy).toMatchObject({ judge_errors: 3, reader_errors: 0, judged: 0, complete: false });
    expect(summary.qa_accuracy.judge_error_classes).toEqual({ provider_error: 3 });

    // The rows are judgeable on a backfill: every one lacks a settled verdict.
    const j = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'Yes', 'mc-3_abs': 'Yes' });
    const back = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out, '--resume-from', out], { engine, client: readerClient({ forbid: true }).client, judgeClient: j.fn });
    expect(back.code).toBeNull();
    expect(j.calls).toHaveLength(3);
    expect(splitRows(out).summary.qa_accuracy).toMatchObject({ judged: 3, correct: 3, judge_errors: 0, complete: true });
  }, 120_000);
});

describe('resume of a judged file WITHOUT --judge', () => {
  test('qa_accuracy is rebuilt from the prior verdicts (anyRowJudged) on a no-op resume AND a partial resume; no judge call; no publishability gate', async () => {
    const out = join(tmp, 'judged-then-plain.jsonl');
    const j = judgeClient({ 'mc-1': 'Yes', 'mc-2': 'No', 'mc-3_abs': 'Yes' });
    const first = await runCapturing([FIXTURE, ...BASE, ...JUDGE, '--output', out], { engine, client: readerClient().client, judgeClient: j.fn });
    expect(first.code).toBeNull();
    expect(j.calls).toHaveLength(3);

    // No-op resume, no --judge: the summary still carries qa_accuracy from the rows.
    const noop = await runCapturing([FIXTURE, ...BASE, '--by-type', '--output', out, '--resume-from', out], { engine, client: readerClient({ forbid: true }).client });
    expect(noop.code).toBeNull();
    expect(noop.stderr).toContain('nothing to do');
    expect(noop.stderr).toContain('qa_accuracy: headline 66.7% (2/3');
    expect(noop.stderr).not.toContain('FAIL');
    const qa1 = splitRows(out).summary.qa_accuracy;
    expect(qa1).toMatchObject({ total_questions: 3, judged: 3, correct: 2, judge_errors: 0, complete: true });
    expect(qa1.judge_config_hash).toBe(splitRows(out).rows[0].judge_config_hash);

    // Partial resume, no --judge: mc-3_abs is re-answered (reader called, not
    // judged) and qa_accuracy is rebuilt over judged + unjudged rows.
    const kept = splitRows(out).rows.filter(r => r.question_id !== 'mc-3_abs');
    writeFileSync(out, kept.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const reader = readerClient();
    const partial = await runCapturing([FIXTURE, ...BASE, '--by-type', '--output', out, '--resume-from', out], { engine, client: reader.client });
    expect(partial.code).toBeNull();
    expect(reader.calls).toHaveLength(1);
    const { rows, summary } = splitRows(out);
    expect(rows.map(r => r.question_id).sort()).toEqual(['mc-1', 'mc-2', 'mc-3_abs']);
    expect(byId(rows)['mc-3_abs'].judge_correct).toBeUndefined();
    expect(byId(rows)['mc-1'].judge_correct).toBe(true);
    expect(summary.qa_accuracy).toMatchObject({ total_questions: 3, judged: 2, correct: 1, unjudged: 1, complete: false });
    // Without --judge an incomplete judgment set is reported, not gated.
    expect(partial.stderr).not.toContain('FAIL --judge');
  }, 180_000);
});
