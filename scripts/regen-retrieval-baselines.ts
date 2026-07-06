/**
 * Regenerates the EV-1c per-config live retrieval baselines for the P2 gold set.
 *
 * Run from the repo root:
 *
 *   bun scripts/regen-retrieval-baselines.ts
 *
 * For each config variant this script seeds the P2 gold corpus
 * (test/fixtures/retrieval-eval/p2-gold-corpus.ts) into a fresh temporary
 * SQLite engine, runs the full live retrieval eval over
 * test/fixtures/retrieval-eval/p2-gold.jsonl, and writes a baseline artifact to
 * test/fixtures/retrieval-eval/baselines/:
 *
 *   - sqlite-governed-probe-on.json   (retrieval.governed_probe_hybrid = true)
 *   - sqlite-governed-probe-off.json  (retrieval.governed_probe_hybrid = false)
 *
 * Embeddings are pinned to `none`, so both runs are deterministic (the hybrid
 * probe degrades to keyword-only without an embedding provider) and the
 * artifacts are stable across machines. Latency fields are zeroed before
 * writing so regeneration produces stable diffs; comparisons must not rely on
 * timing. Diff two baselines with the existing compare path:
 *
 *   mbrain eval retrieval --compare \
 *     test/fixtures/retrieval-eval/baselines/sqlite-governed-probe-on.json \
 *     test/fixtures/retrieval-eval/baselines/sqlite-governed-probe-off.json --json
 *
 * Commit the regenerated files whenever the fixture, the corpus, or ranking
 * behavior intentionally changes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveConfig } from '../src/core/config.ts';
import {
  evaluateLiveRetrievalFixture,
  type RetrievalEvalReport,
} from '../src/core/evaluation/retrieval-eval.ts';
import { createProductionRetrieveContextDependencies } from '../src/core/services/production-retrieval-dependencies-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  loadP2GoldFixture,
  seedP2GoldCorpus,
} from '../test/fixtures/retrieval-eval/p2-gold-corpus.ts';

const BASELINE_DIR = new URL('../test/fixtures/retrieval-eval/baselines/', import.meta.url).pathname;

const VARIANTS = [
  { name: 'sqlite-governed-probe-on', governedProbeHybrid: true },
  { name: 'sqlite-governed-probe-off', governedProbeHybrid: false },
] as const;

async function runVariant(governedProbeHybrid: boolean): Promise<RetrievalEvalReport> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-baseline-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await seedP2GoldCorpus(engine);
    const config = resolveConfig({
      engine: 'sqlite',
      database_path: join(dir, 'brain.db'),
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
      retrieval: { governed_probe_hybrid: governedProbeHybrid },
    });
    return await evaluateLiveRetrievalFixture(engine, loadP2GoldFixture('p2-gold'), {
      retrieve_context_dependencies: createProductionRetrieveContextDependencies(engine, config),
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function baselineArtifact(report: RetrievalEvalReport, governedProbeHybrid: boolean) {
  const routeMatchRate = report.case_count === 0
    ? 0
    : report.cases.filter((entry) => entry.route_match === true).length / report.case_count;
  const passed = report.cases.filter((entry) => entry.status === 'passed').length;
  return {
    artifact_kind: 'ev1c_live_retrieval_baseline',
    gate: 'EV-1c',
    generated_by: 'scripts/regen-retrieval-baselines.ts',
    engine: 'sqlite',
    embedding_provider: 'none',
    config: {
      'retrieval.governed_probe_hybrid': governedProbeHybrid,
    },
    fixture_id: report.fixture_id,
    fixture_path: 'test/fixtures/retrieval-eval/p2-gold.jsonl',
    metrics: {
      total: report.case_count,
      passed,
      failed: report.case_count - passed,
      pass_rate: report.case_count === 0 ? 0 : passed / report.case_count,
      top1_match_rate: report.top1_match_rate,
      recall_at_10: report.recall_at_10,
      precision_at_k: report.precision_at_k,
      mrr: report.mrr,
      route_match_rate: routeMatchRate,
      latency_ms_avg: 0,
      per_route: Object.fromEntries(Object.entries(report.per_route).map(([route, summary]) => [route, {
        case_count: summary.case_count,
        top1_match_rate: summary.top1_match_rate,
        recall_at_10: summary.recall_at_10,
        precision_at_k: summary.precision_at_k,
        mrr: summary.mrr,
        latency_ms_avg: 0,
        retrieved_token_count_total: summary.retrieved_token_count_total,
      }])),
    },
    cases: report.cases.map((entry) => ({
      id: entry.id,
      route: entry.route,
      expected_selected_intent: entry.expected_selected_intent,
      selected_intent: entry.selected_intent,
      route_match: entry.route_match,
      status: entry.status,
      top1_slug: entry.top1_slug,
      top1_match: entry.top1_match,
      recall_at_10: entry.recall_at_10,
      precision_at_k: entry.precision_at_k,
      mrr: entry.mrr,
      missing_gold_slugs: entry.missing_gold_slugs,
    })),
    failures: report.failures,
  };
}

mkdirSync(BASELINE_DIR, { recursive: true });
for (const variant of VARIANTS) {
  const report = await runVariant(variant.governedProbeHybrid);
  const artifact = baselineArtifact(report, variant.governedProbeHybrid);
  const target = join(BASELINE_DIR, `${variant.name}.json`);
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${target} (recall_at_10=${artifact.metrics.recall_at_10}, mrr=${artifact.metrics.mrr}, route_match_rate=${artifact.metrics.route_match_rate})`);
}
