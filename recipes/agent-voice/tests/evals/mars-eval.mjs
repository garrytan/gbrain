#!/usr/bin/env node
/**
 * mars-eval.mjs — Mars persona LLM-judge runner.
 *
 * Runs `mars-solo.jsonl` + `mars-demo.jsonl` fixtures through the persona
 * prompt + 3-model judge. Writes receipts to baseline-runs/.
 *
 * Usage:
 *   node mars-eval.mjs                       # all fixtures
 *   node mars-eval.mjs --limit 3             # first 3 of each
 *   node mars-eval.mjs --model claude-sonnet-4-6
 *   node mars-eval.mjs --baseline            # writes to baseline-runs/
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARS } from '../../code/lib/personas/mars.mjs';
import { runFixtureSet, loadFixturesJsonl, parseEvalCliArgs } from './judge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = parseEvalCliArgs(process.argv.slice(2));
const outDir = resolve(__dirname, args.baseline ? 'baseline-runs' : 'baseline-runs/dev');

const soloFixtures = loadFixturesJsonl(resolve(__dirname, 'fixtures/mars-solo.jsonl'));
const demoFixtures = loadFixturesJsonl(resolve(__dirname, 'fixtures/mars-demo.jsonl'));

console.error(`[mars-eval] running ${soloFixtures.length} solo + ${demoFixtures.length} demo fixtures (limit=${args.limit || 'none'})`);

const soloRun = await runFixtureSet({
  fixtures: soloFixtures,
  personaPrompt: MARS.prompt,
  personaModel: args.model,
  outDir,
  limit: args.limit,
  label: 'mars-solo',
});

const demoRun = await runFixtureSet({
  fixtures: demoFixtures,
  personaPrompt: MARS.prompt,
  personaModel: args.model,
  outDir,
  limit: args.limit,
  label: 'mars-demo',
});

const overall = {
  solo: soloRun.summary,
  demo: demoRun.summary,
  overall_pass: soloRun.summary.overall_verdict === 'pass' && demoRun.summary.overall_verdict === 'pass',
};
console.log(JSON.stringify(overall, null, 2));
process.exit(overall.overall_pass ? 0 : 1);
