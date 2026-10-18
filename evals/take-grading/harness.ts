#!/usr/bin/env bun
/**
 * Take-grading eval runner (W6, wave 4b).
 *
 * CHECK mode ($0, no key):
 *   bun evals/take-grading/harness.ts --check
 * Verifies fixtures.jsonl matches cases.ts and runs the instrument checks
 * (set counts, placeholder names, the dates each set promises, the production
 * evidence block). Exit 1 on any violation.
 *
 * SCORE mode ($0):
 *   bun evals/take-grading/harness.ts --score a.jsonl b.jsonl ... [--json summary.json] [--md summary.md]
 *
 * LIVE mode (spends tokens):
 *   bun evals/take-grading/harness.ts --model <provider:model> --split dev|counted --out <rows.jsonl>
 *     --max-usd <n> [--concurrency 4] [--only id1,id2] [--preregistration <commit>]
 * Each fixture goes through the production path of grade_takes: the evidence
 * block from `formatEvidenceBlock` and the verdict from `defaultJudge` (the
 * production prompt, one gateway `chat` call with the production options
 * and the production parser), with the model named the way the phase names
 * it. The harness only wraps the chat call to read the provider's usage. A
 * parse failure stands (production retries it on the next cycle); a provider
 * error is retried up to twice after a pause. The counted split refuses to
 * run without `--preregistration <commit>`, the commit that froze
 * PREREGISTRATION.md. The run stops once `--max-usd` is spent.
 *
 * Exit codes: 0 done, 1 check violation, 2 usage or no provider key, 3 budget stop.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FIXTURES_PATH, fixturesJsonl, type Fixture } from './generate-fixtures.ts';
import type { ResultRow } from './score.ts';

const here = import.meta.dir;
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };

export function loadFixtures(): Fixture[] {
  return readFileSync(FIXTURES_PATH, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

if (args.includes('--check')) {
  const { checkFixtures } = await import('./check.ts');
  const violations = readFileSync(FIXTURES_PATH, 'utf8') === fixturesJsonl() ? [] : ['fixtures.jsonl does not match cases.ts (regenerate with bun evals/take-grading/generate-fixtures.ts)'];
  const fixtures = loadFixtures();
  violations.push(...checkFixtures(fixtures));
  const bySet: Record<string, number> = {};
  for (const f of fixtures) bySet[`${f.split}/${f.set}`] = (bySet[`${f.split}/${f.set}`] ?? 0) + 1;
  for (const v of violations) console.error(`VIOLATION ${v}`);
  console.log(`check: ${fixtures.length} fixture(s) (${Object.entries(bySet).map(([s, n]) => `${s} ${n}`).join(', ')}), ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}

if (args.includes('--score')) {
  const skip = new Set([flag('--json'), flag('--md')]);
  const files = args.slice(args.indexOf('--score') + 1).filter(a => !a.startsWith('--') && !skip.has(a));
  const { summarize } = await import('./score.ts');
  const { buildReport, renderMarkdown } = await import('./report.ts');
  const rows: ResultRow[] = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const report = buildReport(summarize(rows), files.map(f => f.slice(f.lastIndexOf('/') + 1)));
  const md = renderMarkdown(report);
  if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(report, null, 2) + '\n');
  if (flag('--md')) writeFileSync(flag('--md')!, md);
  console.log(md);
  process.exit(0);
}

const model = flag('--model');
const split = flag('--split');
const outPath = flag('--out');
const maxUsd = Number(flag('--max-usd'));
const concurrency = Number(flag('--concurrency') ?? 4);
const preregistration = flag('--preregistration');
if (!model || !outPath || (split !== 'dev' && split !== 'counted') || !(maxUsd > 0) || !(concurrency >= 1)) {
  console.error('usage: bun evals/take-grading/harness.ts --check | --score <rows.jsonl ...> [--json f] [--md f] | --model <provider:model> --split dev|counted --out <rows.jsonl> --max-usd <n> [--concurrency 4] [--only ids] [--preregistration <commit>]');
  process.exit(2);
}
if (split === 'counted' && !preregistration) {
  console.error('take-grading: the counted split runs only after PREREGISTRATION.md is frozen; pass --preregistration <commit>.');
  process.exit(2);
}

const { configureEvalGateway } = await import('../../src/eval/shared/gateway-bootstrap.ts');
const gateway = await import('../../src/core/ai/gateway.ts');
const { chatCallUsd } = await import('../../src/core/budget/daily-ledger.ts');
const { defaultJudge, GRADE_TAKE_PROMPT, GRADE_TAKES_PROMPT_VERSION, GRADE_TAKES_AUTO_RESOLVE_THRESHOLD } = await import('../../src/core/cycle/grade-takes.ts');
const { evidenceBlock, productionTake } = await import('./check.ts');
const { grade } = await import('./score.ts');

configureEvalGateway({ chatModel: model });
if (!gateway.isAvailable('chat', model)) {
  console.error(`take-grading: no chat provider configured for ${model}; set its key. Refusing to run keyless.`);
  process.exit(2);
}

const only = flag('--only')?.split(',');
const selected = loadFixtures().filter(f => f.split === split && (!only || only.includes(f.id)));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const meta = {
  model, split, started_at: new Date().toISOString(),
  gbrain_commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: here }).stdout.toString().trim(),
  preregistration, bun: Bun.version, prompt_version: GRADE_TAKES_PROMPT_VERSION, prompt_sha256: sha(GRADE_TAKE_PROMPT),
  threshold: GRADE_TAKES_AUTO_RESOLVE_THRESHOLD, fixtures_sha256: sha(readFileSync(FIXTURES_PATH)),
  harness_sha256: sha(['harness.ts', 'check.ts', 'score.ts', 'cases.ts'].map(f => readFileSync(join(here, f), 'utf8')).join('\u0000')),
  max_usd: maxUsd, concurrency, fixtures: selected.length,
};
writeFileSync(`${outPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
writeFileSync(outPath, '');
console.error(`take-grading: ${selected.length} fixture(s) of the ${split} split on ${model}, cap $${maxUsd}`);

let spent = 0;
let stopped = false;

async function judgeOne(f: Fixture): Promise<void> {
  const take = productionTake(f);
  const evidence = evidenceBlock(f);
  let attempts = 0;
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  let verdict: Awaited<ReturnType<typeof defaultJudge>> | null = null;
  let failure: ResultRow['failure'] = null;
  let answerText: string | null = null;
  const t0 = performance.now();
  for (;;) {
    attempts++;
    const chatFn = (async (opts: Parameters<typeof gateway.chat>[0]) => {
      const result = await gateway.chat(opts);
      answerText = result.text;
      usage = { input_tokens: (usage?.input_tokens ?? 0) + result.usage.input_tokens, output_tokens: (usage?.output_tokens ?? 0) + result.usage.output_tokens };
      return result;
    }) as typeof gateway.chat;
    try {
      verdict = await defaultJudge({ take, evidence, modelHint: model! }, chatFn);
      failure = null;
      break;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message.includes('judge output parse failed')) { failure = 'parse'; break; }
      failure = 'unavailable';
      if (attempts >= 3) break;
      console.error(`${f.id}: provider error (${message.slice(0, 120)}), attempt ${attempts}; retrying after a pause`);
      await new Promise(r => setTimeout(r, attempts * 20_000));
    }
  }
  const latency = Math.round(performance.now() - t0);
  const u = usage as { input_tokens: number; output_tokens: number } | null;
  const usd = u ? chatCallUsd(model!, { inputTokens: u.input_tokens, outputTokens: u.output_tokens }).usd : 0;
  spent += usd;
  const g = grade(f, verdict?.verdict ?? null, verdict?.confidence ?? null, GRADE_TAKES_AUTO_RESOLVE_THRESHOLD);
  const row: ResultRow = {
    model: model!, split: f.split, id: f.id, set: f.set, cls: f.cls, rule: f.rule, gold: f.gold, world_truth: f.world_truth,
    verdict: verdict?.verdict ?? null, confidence: verdict?.confidence ?? null, failure, applied: g.applied, wrong: g.wrong,
    input_tokens: u?.input_tokens ?? null, output_tokens: u?.output_tokens ?? null, usd, latency_ms: latency,
    reasoning: verdict?.reasoning ?? null, attempts, answer_text: failure === 'parse' ? answerText : null,
  };
  appendFileSync(outPath!, JSON.stringify(row) + '\n');
  console.error(`${f.id}: ${row.verdict ?? `no answer (${failure})`}@${row.confidence?.toFixed(2) ?? '-'} ${g.applied ? (g.wrong ? 'APPLIED-WRONG' : 'applied') : 'held'} $${usd.toFixed(4)} ${latency}ms`);
}

const queue = [...selected];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    if (spent >= maxUsd) { stopped = true; return; }
    await judgeOne(f);
  }
}));

writeFileSync(`${outPath}.meta.json`, JSON.stringify({ ...meta, finished_at: new Date().toISOString(), spent_usd: spent, budget_stop: stopped }, null, 2) + '\n');
console.error(`spend: $${spent.toFixed(4)} on ${model} (${split})${stopped ? '; stopped at the budget cap' : ''}`);
process.exit(stopped ? 3 : 0);
