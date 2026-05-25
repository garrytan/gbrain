#!/usr/bin/env node
/**
 * venus-eval.mjs — Venus persona LLM-judge runner.
 *
 * Runs `venus.jsonl` fixtures through the persona prompt + 3-model judge.
 *
 * Usage: see mars-eval.mjs.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENUS } from '../../code/lib/personas/venus.mjs';
import { runFixtureSet, loadFixturesJsonl, parseEvalCliArgs } from './judge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseEvalCliArgs(process.argv.slice(2));
const outDir = resolve(__dirname, args.baseline ? 'baseline-runs' : 'baseline-runs/dev');

const fixtures = loadFixturesJsonl(resolve(__dirname, 'fixtures/venus.jsonl'));
console.error(`[venus-eval] running ${fixtures.length} fixtures (limit=${args.limit || 'none'})`);

const run = await runFixtureSet({
  fixtures,
  personaPrompt: VENUS.prompt,
  personaModel: args.model,
  outDir,
  limit: args.limit,
  label: 'venus',
});

console.log(JSON.stringify(run.summary, null, 2));
process.exit(run.summary.overall_verdict === 'pass' ? 0 : 1);
