#!/usr/bin/env bun
/**
 * W3 gate 4 latency (A66/A67): paired `search.reranker.gate` off vs on over
 * the whole recall-plus-query path, on the configured brain.
 *
 *   bun scripts/bench-rerank-gate-latency.ts --items <items.jsonl>
 *     [--warmup 5] [--repeats 1] [--concurrency 1] [--source <id>]
 *     [--database-url <url>] [--samples-out <file.ndjson>] [--json]
 *
 * Each line of the items file is one question:
 *   {"id": "q1", "kind": "temporal", "recall": {...}, "query": {"query": "...", "token_budget": 6300}}
 * `recall` (optional) and `query` are passed verbatim to those operations as
 * a trusted local caller. The arms differ only in an in-memory overlay of
 * `search.reranker.gate` (nothing is written to the brain's config); like any
 * search, each call records search telemetry. Controls, timing and the
 * verdict: src/eval/rerank-gate-latency.ts. Exit 0 when the latency clause
 * passes, 1 when it fails or an arm errored, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { loadConfig, loadConfigWithEngine, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { type LatencyItem, type LatencyReport, operationArmCaller, runPaired, summarizeLatency } from '../src/eval/rerank-gate-latency.ts';

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export function parseItems(text: string): LatencyItem[] {
  return text.split('\n').filter((l) => l.trim()).map((line, i) => {
    const row = JSON.parse(line) as Partial<LatencyItem>;
    if (typeof row.id !== 'string' || !row.query || typeof row.query !== 'object') {
      throw new Error(`items line ${i + 1}: needs a string "id" and a "query" params object`);
    }
    return row as LatencyItem;
  });
}

export function renderReport(r: LatencyReport): string {
  const v = (ok: boolean) => (ok ? 'pass' : 'FAIL');
  return [
    `pairs: ${r.pairs} (errors: ${r.errors})`,
    `off: mean ${r.arms.off.mean_ms} ms, p50 ${r.arms.off.p50_ms}, p95 ${r.arms.off.p95_ms}`,
    `on:  mean ${r.arms.on.mean_ms} ms, p50 ${r.arms.on.p50_ms}, p95 ${r.arms.on.p95_ms}`,
    `skipped: ${r.skipped_pairs} (${(r.skip_rate * 100).toFixed(1)}%)`,
    `mean saving per skipped query: ${r.mean_saving_per_skip_ms ?? 'n/a'} ms (>= 100: ${v(r.verdict.mean_saving_ok)})`,
    `mean saving on reranked queries: ${r.mean_saving_no_skip_ms ?? 'n/a'} ms`,
    `p95 increase: ${r.p95_increase_ms} ms (<= 0: ${v(r.verdict.p95_ok)})`,
    `reranker calls: ${r.reranker_calls.off} -> ${r.reranker_calls.on} (${(r.reranker_calls.reduction * 100).toFixed(1)}% fewer; >= 25%: ${v(r.verdict.reranker_call_reduction_ok)})`,
    `latency clause: ${v(r.verdict.latency_pass)}`,
  ].join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const itemsPath = flag(args, '--items');
  if (!itemsPath) { console.error('usage: bun scripts/bench-rerank-gate-latency.ts --items <items.jsonl> [--warmup 5] [--repeats 1] [--concurrency 1] [--source <id>] [--database-url <url>] [--samples-out <file>] [--json]'); return 2; }
  const numeric = (name: string, fallback: number) => {
    const n = Number(flag(args, name) ?? fallback);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} takes a non-negative integer`);
    return n;
  };
  const items = parseItems(readFileSync(itemsPath, 'utf8'));
  const url = flag(args, '--database-url');
  const fileConfig = loadConfig();
  let engineConfig: EngineConfig;
  if (url) engineConfig = { engine: 'postgres', database_url: url };
  else if (fileConfig) engineConfig = toEngineConfig(fileConfig);
  else { console.error('No GBrain config found. Pass --database-url, or set GBRAIN_HOME to the brain under test.'); return 1; }
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const merged = (await loadConfigWithEngine(engine, fileConfig ?? { engine: 'postgres' })) ?? fileConfig ?? { engine: 'postgres' as const };
    configureGateway(buildGatewayConfig(merged));
    const ctx = {
      engine,
      config: merged,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false,
      remote: false,
      sourceId: flag(args, '--source') ?? 'default',
    } as unknown as OperationContext;
    const samples = await runPaired(items, operationArmCaller(ctx), {
      warmup: numeric('--warmup', 5), repeats: Math.max(1, numeric('--repeats', 1)), concurrency: Math.max(1, numeric('--concurrency', 1)),
    });
    const samplesOut = flag(args, '--samples-out');
    if (samplesOut) writeFileSync(samplesOut, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const report = summarizeLatency(samples);
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
    return report.verdict.latency_pass ? 0 : 1;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

if (import.meta.main) process.exit(await main());
