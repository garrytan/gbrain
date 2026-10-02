/**
 * `gbrain decide judge-agreement` end to end with a fixture decide transport
 * (no provider is called): one request per item on the background lane,
 * the kappa report, per question_type slices, Jev cost and latency, the
 * --out file with per-item rows, --dry-run (sends nothing) and the no-key
 * refusal. Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { runJudgeAgreement } from '../../src/commands/decide/judge-agreement.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-judge-agreement-cli-'));
const input = join(dir, 'lme-judged.jsonl');
let bodies: any[] = [];

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = console.log, error = console.error;
  let out = '', err = '';
  console.log = (...a: unknown[]) => { out += a.join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.join(' ') + '\n'; };
  try { return { code: await fn(), out, err }; } finally { console.log = log; console.error = error; }
}

beforeAll(() => {
  const rows = [
    { question_id: 'q1', question_type: 'temporal-reasoning', question: 'When?', answer: 'May', hypothesis: 'In May', judge_correct: true, judge_model: 'gpt-4o' },
    { question_id: 'q2', question_type: 'temporal-reasoning', question: 'When?', answer: 'June', hypothesis: 'In July', judge_correct: false, judge_model: 'gpt-4o' },
    { question_id: 'q3', question_type: 'multi-session', question: 'How many?', answer: '3', hypothesis: 'three', judge_correct: true, judge_model: 'gpt-4o' },
    { question_id: 'q4', question_type: 'multi-session', question: 'How many?', answer: '4', hypothesis: 'two', judge_correct: false, judge_model: 'gpt-4o' },
    { question_id: 'q5', question: 'x', answer: 'y', hypothesis: 'z', judge_error: 'timeout' },
  ];
  writeFileSync(input, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  // Jev agrees except on q4 (says yes where the LLM judge said no).
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const q = body.questions['judge:0'];
    const hyp = q.instructions.hypothesis as string;
    const p = hyp === 'In May' || hyp === 'three' || hyp === 'two' ? 0.9 : 0.1;
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { 'judge:0': { type: 'noul', noul: p } }, usage: { input_tokens: 200, output_tokens: 1 } }));
  });
});

afterAll(() => {
  __setDecideTransportForTests(null);
  resetGateway();
  rmSync(dir, { recursive: true, force: true });
});

describe('decide judge-agreement', () => {
  test('--suite longmemeval --json: kappa, confusion, slices, cost, latency; one request per item', async () => {
    bodies = [];
    const out = join(dir, 'report.json');
    const r = await capture(() => runJudgeAgreement(['--suite', 'longmemeval', '--input', input, '--json', '--out', out]));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(bodies.length).toBe(4);
    expect(report).toMatchObject({ suite: 'longmemeval', n: 4, raw_agreement: 0.75, models: ['jev-1.13.0'], skipped: { judge_error: 1 } });
    expect(report.confusion).toEqual({ both_yes: 2, reference_yes_jev_no: 0, reference_no_jev_yes: 1, both_no: 1 });
    expect(report.kappa).toBe(0.5);
    expect(report.kappa_ci95).toHaveLength(2);
    expect(report.reference).toEqual({ kind: 'llm_judge', label_source: { 'llm:gpt-4o': 4 } });
    expect(Object.keys(report.slices)).toEqual(['multi-session', 'temporal-reasoning']);
    expect(report.slices['temporal-reasoning'].raw_agreement).toBe(1);
    expect(report.input_tokens).toBe(800);
    expect(report.cost_usd).toBeGreaterThan(0);
    expect(typeof report.latency_ms.p50).toBe('number');
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.rows.map((x: { id: string; predicted: boolean }) => [x.id, x.predicted])).toEqual([['q1', true], ['q2', false], ['q3', true], ['q4', true]]);
  });

  test('--limit and --threshold', async () => {
    bodies = [];
    const r = await capture(() => runJudgeAgreement(['--suite', 'longmemeval', '--input', input, '--limit', '2', '--threshold', '0.95', '--json']));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(bodies.length).toBe(2);
    expect(report.threshold).toBe(0.95);
    expect(report.confusion).toEqual({ both_yes: 0, reference_yes_jev_no: 1, reference_no_jev_yes: 0, both_no: 1 });
  });

  test('--dry-run estimates tokens and cost and sends nothing', async () => {
    bodies = [];
    const r = await capture(() => runJudgeAgreement(['--suite', 'longmemeval', '--input', input, '--dry-run', '--json']));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(bodies.length).toBe(0);
    expect(report.dry_run).toBe(true);
    expect(report.items).toBe(4);
    expect(report.estimated_input_tokens).toBeGreaterThan(0);
  });

  test('usage errors and the no-key refusal', async () => {
    expect((await capture(() => runJudgeAgreement(['--suite', 'nope', '--input', input]))).code).toBe(1);
    configureGateway({ env: {} });
    const prev = { a: process.env.TYPESAFE_API_KEY, b: process.env.JEV_TYPESAFE_API_KEY };
    delete process.env.TYPESAFE_API_KEY; delete process.env.JEV_TYPESAFE_API_KEY;
    try {
      const r = await capture(() => runJudgeAgreement(['--suite', 'longmemeval', '--input', input]));
      expect(r.code).toBe(1);
      expect(r.err).toContain('no_key');
    } finally {
      if (prev.a !== undefined) process.env.TYPESAFE_API_KEY = prev.a;
      if (prev.b !== undefined) process.env.JEV_TYPESAFE_API_KEY = prev.b;
      configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
    }
  });
});
