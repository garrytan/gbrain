#!/usr/bin/env node
/**
 * Re-score an existing run-*.jsonl (or baseline-runs/*.jsonl) with the lenient
 * dispatcher-area scoring rule, without re-running any LLM calls.
 *
 * Usage:  node rescore.mjs <run-file.jsonl>
 *
 * Reads the receipt header to identify which variants were used, loads them
 * from ./variants/<name>.md, parses their (dispatcher for: ...) clauses, then
 * applies scoreFixtureLenient to every row. Prints a STRICT vs LENIENT
 * accuracy table without mutating the file.
 *
 * This is T1a from the v0.32.3.0 boil-the-ocean push.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseDispatcherLists(variantContent) {
  const out = new Map();
  const re = /→\s*`([a-z][a-z0-9-]*)`\s*\(dispatcher for:\s*([^)]+)\)/g;
  let m;
  while ((m = re.exec(variantContent)) !== null) {
    const dispatcher = m[1];
    const subSkills = m[2].split(',').map(s => s.trim()).filter(s => /^[a-z][a-z0-9-]*$/.test(s));
    out.set(dispatcher, new Set([dispatcher, ...subSkills]));
  }
  return out;
}

function lenientScore(predicted, expected, dispatcherLists) {
  if (predicted === expected) return 1;
  for (const set of dispatcherLists.values()) {
    if (set.has(predicted) && set.has(expected)) return 1;
  }
  return 0;
}

function meanAndCI(values) {
  if (values.length === 0) return { mean: 0, ci: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, ci: 0 };
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  const stdErr = Math.sqrt(variance / values.length);
  const tCrit = values.length === 3 ? 4.303 : values.length === 2 ? 12.706 : 1.96;
  return { mean, ci: tCrit * stdErr };
}

function fmt(vals) {
  if (vals.length === 0) return '—';
  const { mean, ci } = meanAndCI(vals);
  return `${(mean * 100).toFixed(1)}% ± ${(ci * 100).toFixed(1)}%`;
}

const runFile = process.argv[2];
if (!runFile) {
  console.error('Usage: node rescore.mjs <run-file.jsonl>');
  process.exit(2);
}

const absRun = resolve(process.cwd(), runFile);
if (!existsSync(absRun)) {
  console.error(`File not found: ${absRun}`);
  process.exit(2);
}

const lines = readFileSync(absRun, 'utf8').split('\n').filter(l => l.trim().length > 0);
const rows = lines.map(l => JSON.parse(l));

const receipt = rows.find(r => r.kind === 'receipt');
const runRows = rows.filter(r => r.kind === 'run');

console.error(`Re-scoring ${runRows.length} rows from ${absRun}`);
console.error(`Receipt: model=${receipt?.model ?? '?'} fixtures_hash=${receipt?.fixtures_hash ?? '?'} ts=${receipt?.ts ?? '?'}`);

// Identify variants and load them
const variantsUsed = [...new Set(runRows.map(r => r.variant))];
const variantsDir = join(__dirname, 'variants');
const dispatcherLists = {};
for (const v of variantsUsed) {
  const path = join(variantsDir, `${v}.md`);
  if (!existsSync(path)) {
    console.error(`Warning: variant file missing for "${v}" at ${path} — lenient score will collapse to strict for this variant.`);
    dispatcherLists[v] = new Map();
    continue;
  }
  dispatcherLists[v] = parseDispatcherLists(readFileSync(path, 'utf8'));
}

const SEEDS = [1, 2, 3];

const strictSummary = {};
const lenientSummary = {};
for (const v of variantsUsed) {
  strictSummary[v] = { training: [], held_out: [] };
  lenientSummary[v] = { training: [], held_out: [] };
  for (const corpus of ['training', 'held_out']) {
    for (const seed of SEEDS) {
      const subset = runRows.filter(r => r.variant === v && r.corpus === corpus && r.seed === seed);
      if (subset.length === 0) continue;
      strictSummary[v][corpus].push(subset.reduce((a, r) => a + r.correct, 0) / subset.length);
      const lenientHits = subset.reduce((a, r) => a + lenientScore(r.predicted, r.expected, dispatcherLists[v]), 0);
      lenientSummary[v][corpus].push(lenientHits / subset.length);
    }
  }
}

console.log(`\n=== Re-scored from ${runFile} ===\n`);
console.log('                              | STRICT scoring                                  | LENIENT (same-area)');
console.log('Variant                       | Held-out               | Training              | Held-out             | Training');
console.log('------------------------------|------------------------|------------------------|----------------------|----------------------');
for (const v of variantsUsed) {
  console.log(
    `${v.padEnd(30)}| ${fmt(strictSummary[v].held_out).padEnd(22)} | ${fmt(strictSummary[v].training).padEnd(22)} | ${fmt(lenientSummary[v].held_out).padEnd(20)} | ${fmt(lenientSummary[v].training)}`,
  );
}
console.log('\nLENIENT counts a prediction correct if it shares a dispatcher area with expected.');
console.log('For variants without "(dispatcher for: ...)" clauses, LENIENT == STRICT.');
