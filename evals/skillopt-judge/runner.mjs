#!/usr/bin/env node
// SkillOpt judge LLM accuracy eval runner (F9).
//
// Reads fixtures.jsonl, calls scoreTrajectory with llm judge mode, computes
// per-fixture absolute error vs gold, writes a JSON receipt.
//
// Pass criterion: MAE <= 0.15.
//
// Usage:
//   node evals/skillopt-judge/runner.mjs \
//     --judge-model anthropic:claude-sonnet-4-6 \
//     --output evals/skillopt-judge/receipts/$(date +%Y%m%d).json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const judgeModel = flag('--judge-model', 'anthropic:claude-sonnet-4-6');
const fixturesPath = flag('--fixtures', join(import.meta.dirname, 'fixtures.jsonl'));
const outputPath = flag('--output');

const fixtures = readFileSync(fixturesPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const { scoreTrajectory } = await import('../../src/core/skillopt/score.ts');

const perFixture = [];
let totalAbsError = 0;
let parseFailures = 0;

for (const fx of fixtures) {
  const trajectory = {
    task_id: fx.id,
    task: 'judge-eval',
    final_text: fx.final_text,
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    turns: 1,
    stop_reason: 'end',
    duration_ms: 0,
  };
  const result = await scoreTrajectory(trajectory, { kind: 'llm', rubric: fx.rubric }, { judgeModel });
  const absErr = Math.abs(result.score - fx.gold_score);
  totalAbsError += absErr;
  if (result.judge_error) parseFailures += 1;
  perFixture.push({
    id: fx.id,
    gold: fx.gold_score,
    actual: result.score,
    abs_error: absErr,
    judge_error: result.judge_error ?? null,
    rationale: result.rationale ?? null,
  });
}

const mae = fixtures.length > 0 ? totalAbsError / fixtures.length : 0;
const verdict = mae <= 0.15 ? 'pass' : 'fail';

const receipt = {
  schema_version: 1,
  timestamp: new Date().toISOString(),
  judge_model: judgeModel,
  fixtures_count: fixtures.length,
  parse_failures: parseFailures,
  mae,
  verdict,
  threshold: 0.15,
  per_fixture: perFixture,
};

const out = JSON.stringify(receipt, null, 2);
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, out);
  process.stderr.write(`Wrote receipt to ${outputPath}\n`);
} else {
  process.stdout.write(out + '\n');
}

process.exit(verdict === 'pass' ? 0 : 1);
