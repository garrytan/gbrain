#!/usr/bin/env bun
/**
 * Content-repair judgment eval runner (#6377, plan section 4).
 *
 * CHECK mode ($0, no key):
 *   bun evals/content-repair-judgment/harness.ts --check
 * Verifies fixtures.jsonl matches cases.ts, builds every pair's judgment
 * input and prints what the model would see per set: how many lines the
 * head carries and which pairs put identity evidence past line 60 (so only
 * `mentions` shows it). Exit 1 on drift or a fixture whose late evidence is
 * not in `mentions`.
 *
 * SCORE mode ($0):
 *   bun evals/content-repair-judgment/harness.ts --score a.jsonl b.jsonl ... [--json summary.json] [--md summary.md]
 * Pools the rows, ranks the models (qualifying first, by true-duplicate
 * accuracy, ties to the cheaper) and prints the Markdown tables.
 *
 * LIVE mode (spends tokens):
 *   bun evals/content-repair-judgment/harness.ts --model <provider:model> --run <n> --out <results.jsonl> [--only id1,id2]
 * Each pair goes through the production call (`askJudgment` in
 * src/core/content-repair/llm.ts: the production prompt, one gateway `chat`
 * with thinking off where the route allows, the production output ceiling,
 * no fallback model, the production parser). The harness adds nothing to
 * the call; it records the verdict, its grade, the tokens the provider
 * reported, the USD gbrain's own price table gives them, wall time and the
 * answer text. `llm_unavailable` is retried up to twice after a pause, as
 * the next maintenance run would; every other outcome stands. No ledger and
 * no memo: every pair is asked in every run.
 *
 * Exit codes: 0 done, 1 check violation, 2 usage or no provider key.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FIXTURES_PATH, fixturesJsonl, type Fixture } from './generate-fixtures.ts';
import type { ResultRow } from './score.ts';

const here = import.meta.dir;
export const CALL_TIMEOUT_MS = 90_000;

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };

export function loadFixtures(): Fixture[] {
  return readFileSync(FIXTURES_PATH, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

if (args.includes('--check')) {
  const { judgmentInput, HEAD_LINES } = await import('./input.ts');
  const { checkFixtures } = await import('./check.ts');
  const text = readFileSync(FIXTURES_PATH, 'utf8');
  const violations = text === fixturesJsonl() ? [] : ['fixtures.jsonl does not match cases.ts (regenerate with bun evals/content-repair-judgment/generate-fixtures.ts)'];
  const fixtures = loadFixtures();
  violations.push(...checkFixtures(fixtures));
  const bySet: Record<string, number> = {};
  for (const f of fixtures) {
    bySet[f.set] = (bySet[f.set] ?? 0) + 1;
    const input = judgmentInput(f);
    const late = input.held.mentions.length + (input.named?.mentions.length ?? 0);
    if (late) console.log(`LATE ${f.id}: ${late} line(s) past line ${HEAD_LINES} mention the other page (head ${input.held.head_lines.length} / ${input.named?.head_lines.length ?? 0} lines)`);
  }
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

const modelArg = flag('--model');
const run = Number(flag('--run') ?? 1);
const outPath = flag('--out');
if (!modelArg || !outPath || !Number.isInteger(run)) {
  console.error(`usage: bun ${join('evals/content-repair-judgment', 'harness.ts')} --check | --score <results.jsonl ...> [--json out.json] [--md out.md] | --model <provider:model> --run <n> --out <results.jsonl> [--only ids]`);
  process.exit(2);
}
const model: string = modelArg;

const { configureEvalGateway } = await import('../../src/eval/shared/gateway-bootstrap.ts');
const { isAvailable } = await import('../../src/core/ai/gateway.ts');
const { chatCallUsd } = await import('../../src/core/budget/daily-ledger.ts');
const { buildJudgmentPrompt, JUDGMENT_PROMPT_VERSION } = await import('../../src/core/content-repair/judgment.ts');
const { askJudgment, judgmentTokenBudget } = await import('../../src/core/content-repair/llm.ts');
const { judgmentInput } = await import('./input.ts');
const { grade } = await import('./score.ts');

configureEvalGateway({ chatModel: model });
if (!isAvailable('chat', model)) {
  console.error(`content-repair-judgment: no chat provider configured for ${model}; set its key. Refusing to run keyless.`);
  process.exit(2);
}

const fixtures = loadFixtures();
const only = flag('--only')?.split(',');
const selected = only ? fixtures.filter(f => only.includes(f.id)) : fixtures;
const first = judgmentInput(selected[0]!);
const systemText = buildJudgmentPrompt(first)[0]!.content;
const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: here }).stdout.toString().trim();
const meta = { model, run, started_at: new Date().toISOString(), gbrain_commit: commit, bun: Bun.version, prompt_version: JUDGMENT_PROMPT_VERSION,
  system_prompt_sha256: createHash('sha256').update(typeof systemText === 'string' ? systemText : '').digest('hex'),
  fixtures_sha256: createHash('sha256').update(readFileSync(FIXTURES_PATH)).digest('hex'),
  harness_sha256: createHash('sha256').update(['harness.ts', 'input.ts', 'score.ts', 'check.ts'].map(f => readFileSync(join(here, f), 'utf8')).join('\u0000')).digest('hex'),
  max_output_tokens: judgmentTokenBudget(first, model).maxOutputTokens, call_timeout_ms: CALL_TIMEOUT_MS, thinking: 'off' };
writeFileSync(`${outPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
writeFileSync(outPath, '');
console.error(`content-repair-judgment: ${selected.length} pair(s) on ${model} (run ${run}); output ceiling ${meta.max_output_tokens} tokens`);

let spent = 0;
for (const f of selected) {
  const input = judgmentInput(f);
  let attempts = 0;
  let answer;
  let latency = 0;
  for (;;) {
    attempts++;
    const t0 = performance.now();
    answer = await askJudgment(input, { model, timeoutMs: CALL_TIMEOUT_MS });
    latency = Math.round(performance.now() - t0);
    if (answer.ok || answer.reason !== 'llm_unavailable' || attempts >= 3) break;
    console.error(`${f.id}: provider unavailable (${answer.error ?? 'error'}, attempt ${attempts}); retrying after a pause`);
    await new Promise(r => setTimeout(r, attempts * 20_000));
  }
  const usage = answer.result?.usage ?? null;
  const usd = usage ? chatCallUsd(model, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }).usd : 0;
  spent += usd;
  const verdict: ResultRow['verdict'] = answer.ok ? (answer.verdict.action === 'merge_into' ? { action: 'merge_into', canonical: answer.verdict.canonical } : { action: answer.verdict.action }) : null;
  const row: ResultRow & { why: string | null } = { model, run, id: f.id, set: f.set, cls: f.cls, tags: f.tags, verdict, failure: answer.ok ? null : answer.reason, grade: grade(f, verdict),
    input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null, usd, latency_ms: latency, stop: answer.result?.stopReason ?? null, text: answer.text ?? null, attempts,
    why: answer.ok ? answer.verdict.why ?? null : null };
  appendFileSync(outPath, JSON.stringify(row) + '\n');
  console.error(`${f.id}: ${verdict ? verdict.action + (verdict.action === 'merge_into' ? ` ${verdict.canonical}` : '') : row.failure} ${row.grade.toUpperCase()} $${usd.toFixed(4)} ${latency}ms`);
}
writeFileSync(`${outPath}.meta.json`, JSON.stringify({ ...meta, finished_at: new Date().toISOString(), spent_usd: spent }, null, 2) + '\n');
console.error(`spend: $${spent.toFixed(4)} on ${model} (run ${run})`);
process.exit(0);
