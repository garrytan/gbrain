#!/usr/bin/env node
/**
 * mars-multilingual-eval.mjs — Mars cross-language behavior.
 *
 * Gates the multilingual claim restored in v0.37.0.0. Each fixture is in a
 * non-English language; the judge checks that Mars responds in the same
 * language AND stays in character.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARS } from '../../code/lib/personas/mars.mjs';
import { runFixtureSet, loadFixturesJsonl, parseEvalCliArgs } from './judge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseEvalCliArgs(process.argv.slice(2));
const outDir = resolve(__dirname, args.baseline ? 'baseline-runs' : 'baseline-runs/dev');

const fixtures = loadFixturesJsonl(resolve(__dirname, 'fixtures/mars-multilingual.jsonl'));
console.error(`[mars-multilingual-eval] running ${fixtures.length} fixtures (limit=${args.limit || 'none'})`);

const run = await runFixtureSet({
  fixtures,
  personaPrompt: MARS.prompt,
  personaModel: args.model,
  outDir,
  limit: args.limit,
  label: 'mars-multilingual',
});

console.log(JSON.stringify(run.summary, null, 2));
process.exit(run.summary.overall_verdict === 'pass' ? 0 : 1);
