#!/usr/bin/env node
// SkillOpt reflect-prompt quality eval runner (F8).
//
// Reads fixtures.jsonl, calls runReflect for each fixture, scores edits
// against expected_edits shape constraints, writes a JSON receipt.
//
// Usage:
//   node evals/skillopt-reflect/runner.mjs \
//     --optimizer-model anthropic:claude-opus-4-7 \
//     --output evals/skillopt-reflect/receipts/$(date +%Y%m%d).json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const optimizerModel = flag('--optimizer-model', 'anthropic:claude-opus-4-7');
const fixturesPath = flag('--fixtures', join(import.meta.dirname, 'fixtures.jsonl'));
const outputPath = flag('--output');

const fixtures = readFileSync(fixturesPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const { runReflect } = await import('../../src/core/skillopt/reflect.ts');

const perFixture = [];
let totalWins = 0;
let totalExpected = 0;

for (const fx of fixtures) {
  const scoredRollouts = fx.scored_rollouts.map((r) => ({
    trajectory: {
      task_id: r.task,
      task: r.task,
      final_text: r.final_text,
      tool_calls: (r.tool_calls ?? []).map((tc) => ({ name: tc.name, input: {}, failed: !!tc.failed })),
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      turns: 1,
      stop_reason: 'end',
      duration_ms: 100,
    },
    score: r.score,
  }));
  const successes = scoredRollouts.filter((r) => r.score >= 0.5);
  const failures = scoredRollouts.filter((r) => r.score < 0.5);

  const result = await runReflect({
    skillBodyText: fx.skill_body,
    successes,
    failures,
    rejected: [],
    optimizerModel,
  });

  const proposedEdits = [...result.failureEdits, ...result.successEdits];

  // Score: for each expected edit, does ANY proposed edit match its shape?
  let wins = 0;
  for (const ex of fx.expected_edits) {
    const matched = proposedEdits.some((pe) => editShapeMatches(pe, ex));
    if (matched) wins += 1;
  }

  totalWins += wins;
  totalExpected += fx.expected_edits.length;

  perFixture.push({
    id: fx.id,
    expected: fx.expected_edits.length,
    matched: wins,
    proposed_count: proposedEdits.length,
    hit_rate: fx.expected_edits.length > 0 ? wins / fx.expected_edits.length : 0,
    errors: result.errors,
  });
}

const aggregateHitRate = totalExpected > 0 ? totalWins / totalExpected : 0;
const verdict = aggregateHitRate >= 0.7 ? 'pass' : 'fail';

const receipt = {
  schema_version: 1,
  timestamp: new Date().toISOString(),
  optimizer_model: optimizerModel,
  fixtures_count: fixtures.length,
  expected_total: totalExpected,
  matched_total: totalWins,
  aggregate_hit_rate: aggregateHitRate,
  verdict,
  threshold: 0.7,
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

function editShapeMatches(proposed, expected) {
  if (proposed.op !== expected.op) return false;
  if (expected.anchor_contains && proposed.anchor) {
    return proposed.anchor.toLowerCase().includes(expected.anchor_contains.toLowerCase());
  }
  if (expected.target_contains && proposed.target) {
    return proposed.target.toLowerCase().includes(expected.target_contains.toLowerCase());
  }
  return true;
}
