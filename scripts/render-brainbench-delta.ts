/**
 * Render a BrainBench result JSON (the --out artifact) as a compact GitHub
 * step-summary / PR-body markdown block. Reads the file path from argv —
 * never stdout-parses the bench (decision 9: the --out file is the canonical
 * CI artifact).
 *
 * Usage: bun scripts/render-brainbench-delta.ts /tmp/brainbench-result.json
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: bun scripts/render-brainbench-delta.ts <result.json>\n');
  process.exit(2);
}

interface Cell {
  harness: string;
  seam: string;
  suite: string;
  gold_failed: number;
  gold_total: number;
  metrics: Record<string, number>;
}
interface Result {
  receipt: { fixtures_hash: string; llm: boolean; include_holdout: boolean };
  cells: Cell[];
  seed_failures: Array<{ fixture_id: string; error: string }>;
  compare?: {
    verdict: string;
    mode: string;
    breaches: Array<{ cell: string; metric: string; baseline: number; current: number; detail: string }>;
    notes: string[];
  };
}

const result = JSON.parse(readFileSync(path, 'utf-8')) as Result;

const lines: string[] = [];
const verdict = result.compare?.verdict?.toUpperCase() ?? 'NO GATE (initial landing)';
lines.push(`## BrainBench: ${verdict}`);
lines.push('');
lines.push(`fixtures \`${result.receipt.fixtures_hash.slice(0, 12)}\` · ${result.compare?.mode ?? 'ungated'}`);
lines.push('');
lines.push('| harness | seam | suite | failed/gold | headline |');
lines.push('|---|---|---|---|---|');
const HEADLINE: Record<string, string> = {
  'know-to-ask': 'know_to_ask_failure_rate',
  push: 'push_recall',
  'write-back': 'write_back_fidelity',
  continuity: 'continuity_rate',
};
for (const c of result.cells) {
  const h = HEADLINE[c.suite];
  const v = h && c.metrics[h] !== undefined ? `${h}=${c.metrics[h]}` : '—';
  lines.push(`| ${c.harness} | ${c.seam} | ${c.suite} | ${c.gold_failed}/${c.gold_total} | ${v} |`);
}
for (const n of result.compare?.notes ?? []) lines.push(`- ${n}`);
if (result.compare?.breaches.length) {
  lines.push('');
  lines.push('**Breaches:**');
  for (const b of result.compare.breaches) {
    lines.push(`- \`${b.cell}\` ${b.metric}: ${b.baseline} → ${b.current} (${b.detail})`);
  }
}
if (result.seed_failures.length) {
  lines.push('');
  lines.push(`**Seed failures (${result.seed_failures.length})** — run invalid.`);
}
lines.push('');
process.stdout.write(lines.join('\n') + '\n');
