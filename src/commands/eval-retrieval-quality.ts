/**
 * `gbrain eval retrieval-quality <fixture.jsonl> [--json] [--source <id>]`
 * (T6 — NamedThingBench). Runs the gold query set against the brain's hybrid
 * retrieval and gates on the families that ARE the retrieval-maxpool incident.
 *
 * Run with reranker + expansion at their configured defaults but the gate
 * measures core retrieval (title/alias/pool) — the families don't depend on
 * the rescue layers. Exit 0 PASS / 1 FAIL (hard-family breach) / 2 USAGE.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readFileSync } from 'fs';
import { hybridSearch } from '../core/search/hybrid.ts';
import {
  parseQuestionsJsonl,
  runRetrievalQuality,
  evaluateGate,
  type SearchFn,
} from '../eval/retrieval-quality/harness.ts';

export async function runEvalRetrievalQuality(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  const fixture = args.find(a => !a.startsWith('--') && a !== sourceId);

  if (!fixture) {
    console.error('Usage: gbrain eval retrieval-quality <fixture.jsonl> [--json] [--source <id>]');
    process.exit(2);
  }

  let questions;
  try {
    questions = parseQuestionsJsonl(readFileSync(fixture, 'utf8'));
  } catch (e) {
    console.error(`Cannot read fixture: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  // Core-retrieval measurement: reranker/expansion at config defaults; the
  // families key off title/alias/pool which are upstream of the rescue layers.
  const searchFn: SearchFn = async (q) => {
    const results = await hybridSearch(engine, q, {
      limit: 10,
      ...(sourceId ? { sourceId } : {}),
    });
    return results.map(r => r.slug);
  };

  const report = await runRetrievalQuality(questions, searchFn);
  const gate = evaluateGate(report);

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, report, gate }, null, 2));
  } else {
    console.log(`NamedThingBench — ${report.total} queries across ${report.families.length} families\n`);
    for (const f of report.families) {
      console.log(`  ${f.family.padEnd(22)} n=${f.n}  Hit@1=${(f.hit_at_1 * 100).toFixed(0)}%  Hit@3=${(f.hit_at_3 * 100).toFixed(0)}%  MRR=${f.mrr.toFixed(3)}`);
    }
    console.log('');
    if (gate.breaches.length) {
      console.log('GATE: FAIL');
      for (const b of gate.breaches) {
        console.log(`  ✗ ${b.family} ${b.metric}=${(b.got * 100).toFixed(0)}% < floor ${(b.floor * 100).toFixed(0)}%`);
      }
    } else {
      console.log('GATE: PASS');
    }
    for (const w of gate.warnings) {
      console.log(`  ⚠ (warn) ${w.family} ${w.metric}=${(w.got * 100).toFixed(0)}% < ${(w.floor * 100).toFixed(0)}%`);
    }
  }

  process.exit(gate.pass ? 0 : 1);
}
