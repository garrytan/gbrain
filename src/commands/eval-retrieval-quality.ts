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
  const abRelational = args.includes('--ab-relational');
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  const fixture = args.find(a => !a.startsWith('--') && a !== sourceId);

  if (!fixture) {
    console.error('Usage: gbrain eval retrieval-quality <fixture.jsonl> [--json] [--source <id>] [--ab-relational]');
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

  // v0.43 — A/B the relational recall arm (off vs on) over the same questions
  // in a fixed mode (expansion off, skipCache-equivalent via bare hybridSearch)
  // so the delta is purely the arm. Headline: graph-relationship recall@10 lift.
  if (abRelational) {
    const mk = (relationalRetrieval: boolean): SearchFn => async (q) => {
      const results = await hybridSearch(engine, q, {
        limit: 10, relationalRetrieval, expansion: false,
        ...(sourceId ? { sourceId } : {}),
      });
      return results.map(r => r.slug);
    };
    const t0 = Date.now();
    const off = await runRetrievalQuality(questions, mk(false));
    const tMid = Date.now();
    const on = await runRetrievalQuality(questions, mk(true));
    const tEnd = Date.now();
    const fam = (r: typeof off, f: string) => r.families.find(x => x.family === f);
    const rel = { off: fam(off, 'graph-relationship'), on: fam(on, 'graph-relationship') };
    const payload = {
      schema_version: 1 as const,
      ab: 'relational',
      graph_relationship: {
        n: rel.on?.n ?? 0,
        recall_at_10: { off: rel.off?.recall_at_10 ?? 0, on: rel.on?.recall_at_10 ?? 0,
          delta: (rel.on?.recall_at_10 ?? 0) - (rel.off?.recall_at_10 ?? 0) },
        hit_at_3: { off: rel.off?.hit_at_3 ?? 0, on: rel.on?.hit_at_3 ?? 0 },
      },
      latency_ms: { off_total: tMid - t0, on_total: tEnd - tMid },
      families: { off: off.families, on: on.families },
    };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Relational A/B — graph-relationship n=${payload.graph_relationship.n}`);
      const g = payload.graph_relationship;
      console.log(`  recall@10:  off=${(g.recall_at_10.off * 100).toFixed(0)}%  on=${(g.recall_at_10.on * 100).toFixed(0)}%  Δ=+${(g.recall_at_10.delta * 100).toFixed(0)}pp`);
      console.log(`  Hit@3:      off=${(g.hit_at_3.off * 100).toFixed(0)}%  on=${(g.hit_at_3.on * 100).toFixed(0)}%`);
      console.log(`  latency:    off=${payload.latency_ms.off_total}ms  on=${payload.latency_ms.on_total}ms (arm adds ${payload.latency_ms.on_total - payload.latency_ms.off_total}ms over ${payload.graph_relationship.n} queries)`);
    }
    process.exit(0);
  }

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
