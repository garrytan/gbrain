/**
 * Entity-anchored query retrieval, gate 1 (docs/eval/decisions/entity-anchoring-query/).
 * The appended-corrections workload of the pinned-questions run 3, read
 * through the real `query` op with `search.entity_anchoring` on and off in the
 * same brain, by the same reader, at equal tokens (the top rows in rank order
 * up to 200 tokens) and at full evidence (16 rows). Expansion is off so the
 * only model call per read is the reader.
 *
 *   bun evals/entity-anchoring/query-gate.ts --plan --seeds 42,7,1234
 *   bun evals/entity-anchoring/query-gate.ts --offline --json --seeds 42 --entities 2
 *   bun evals/entity-anchoring/query-gate.ts --run --yes --max-usd 4 --seeds 42,7,1234 --embeddings voyage:voyage-4 --json
 */
import { writeFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { normalizeModelId } from '../../src/core/model-id.ts';
import { ENTITY_ANCHORING_KEY } from '../../src/core/search/entity-anchor.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { BATCHES, RATIOS, aggregate, appendedHash, applyEventsForTest, fit, generateAppendedWorkload, question, summarize,
  type AppendedWorkload, type ArmRun } from '../pinned-questions/appended-gate.ts';
import { SpendGuard, correctFor, offlineArms, paidArms, priced, readerAnswer, staleFor, type GateOpts } from '../pinned-questions/benefit-gate.ts';

export const ARMS = ['anchoring_on', 'anchoring_off', 'anchoring_on_full', 'anchoring_off_full'] as const;
export const BUDGET_TOKENS = 200;
const FULL_ROWS = 16;

export interface QueryGateOpts { workload: AppendedWorkload; readerModel: string; embed: boolean; reader: GateOpts['reader'] }

export async function runQueryGate(opts: QueryGateOpts): Promise<{ arms: ArmRun[]; triggered: number; states: number }> {
  const w = opts.workload;
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const arms = Object.fromEntries(ARMS.map(a => [a, { arm: a, reads: [], lifecycle_usd: 0, refresh_attempts: 0 } as ArmRun])) as Record<typeof ARMS[number], ArmRun>;
  const remembered = new Map<string, string>();
  let triggered = 0;
  try {
    const { runEmbedCore } = await import('../../src/commands/embed.ts');
    const rows = async (q: string, on: boolean) => {
      await engine.setConfig(ENTITY_ANCHORING_KEY, on ? 'true' : 'false');
      return await handleToolCall(engine, 'query', { query: q, limit: FULL_ROWS, expand: false, use_cache: false }) as SearchResult[];
    };
    for (let b = 0; b < BATCHES; b++) {
      await applyEventsForTest(engine, w.batches[b]!, remembered);
      if (opts.embed) {
        const r = await runEmbedCore(engine, { stale: true, sourceId: 'default', quiet: true });
        if (r.failures > 0) throw new Error(`embedding failed for ${r.failures} page(s)`);
      }
      for (const e of w.entities) {
        const gold = w.gold[e.slug]![b]!;
        const past = new Set(w.history[e.slug]!);
        const q = question(e.name);
        const read = async (arm: ArmRun, context: string) => {
          const r = await readerAnswer(opts.reader, opts.readerModel, q, context);
          arm.reads.push({ entity: e.slug, batch: b, gold, correct: correctFor(r.text, gold), stale: staleFor(r.text, gold, past), usd: priced(r.model, r.input_tokens, r.output_tokens) });
        };
        const on = await rows(q, true);
        const off = await rows(q, false);
        if (on.some(r => r.entity_anchored)) triggered++;
        const parts = (rs: SearchResult[]) => rs.map(r => `[${r.slug}] ${r.chunk_text}`);
        await read(arms.anchoring_on, fit(parts(on), BUDGET_TOKENS));
        await read(arms.anchoring_off, fit(parts(off), BUDGET_TOKENS));
        await read(arms.anchoring_on_full, parts(on).join('\n'));
        await read(arms.anchoring_off_full, parts(off).join('\n'));
      }
    }
  } finally {
    await engine.disconnect();
  }
  return { arms: Object.values(arms), triggered, states: w.entities.length * BATCHES };
}

type Summary = ReturnType<typeof summarize>;

/** Preregistered gate 1: in every seed the key-on arm has higher accuracy or lower freshness lag, and lower accuracy in no seed. */
export function decideGate(perSeed: Array<{ seed: number; summary: Summary[] }>) {
  const seeds = perSeed.map(({ seed, summary }) => {
    const at = (arm: string) => summary.find(s => s.reads_per_write === 1 && s.arm === arm)!;
    const on = at('anchoring_on'), off = at('anchoring_off');
    const higher = on.accuracy > off.accuracy, fresher = on.freshness.mean_lag_batches < off.freshness.mean_lag_batches;
    return { seed, on_accuracy: on.accuracy, off_accuracy: off.accuracy, on_lag: on.freshness.mean_lag_batches, off_lag: off.freshness.mean_lag_batches,
      on_stale: on.stale_wrong_rate, off_stale: off.stale_wrong_rate, wins: higher || fresher, accuracy_lower: on.accuracy < off.accuracy };
  });
  return { seeds, pass: seeds.every(s => s.wins && !s.accuracy_lower) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  const seeds = (flag('--seeds') ?? '42').split(',').map(Number);
  const readerModel = flag('--reader-model') ?? 'anthropic:claude-sonnet-5-5';
  const embeddingModel = flag('--embeddings');
  const entities = Number(flag('--entities') ?? 6);
  const workloads = seeds.map(seed => generateAppendedWorkload(seed, entities));
  const states = entities * BATCHES;
  // Two budgeted reads (~650 in / 50 out) and two full-evidence reads (~2k in / 50 out) per state, run 3's sizes x1.25.
  const estimate = seeds.length * states * (2 * priced(readerModel, 650, 50) + 2 * priced(readerModel, 2_000, 50));
  if (args.includes('--plan') || (!args.includes('--offline') && !args.includes('--run'))) {
    console.log(JSON.stringify({ mode: 'plan', seeds, workload_hashes: workloads.map(appendedHash), states_per_seed: states, reader_model: readerModel, embedding_model: embeddingModel ?? null, est_usd: estimate }, null, 2));
    process.exit(0);
  }
  const paid = args.includes('--run');
  const cap = Number(flag('--max-usd'));
  if (paid && (!args.includes('--yes') || !Number.isFinite(cap) || cap < estimate)) {
    console.error(`Refusing a paid run: pass --yes and --max-usd >= the estimate ($${estimate.toFixed(2)}).`);
    process.exit(3);
  }
  if (embeddingModel && !paid) { console.error('--embeddings needs --run (offline mode makes no network calls).'); process.exit(2); }
  const guard = new SpendGuard(paid ? cap : Infinity);
  if (paid) {
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    configureGateway({ chat_model: normalizeModelId(readerModel), ...(embeddingModel ? { embedding_model: embeddingModel, embedding_dimensions: 1024 } : {}), env: { ...process.env } as Record<string, string> });
  }
  const reader = paid ? paidArms(readerModel, guard).reader : offlineArms(readerModel, readerModel).reader;
  const perSeed: Array<{ seed: number; workload_hash: string; triggered: number; states: number; summary: Summary[]; reads: unknown[] }> = [];
  for (const workload of workloads) {
    const out = await runQueryGate({ workload, readerModel, embed: !!embeddingModel, reader });
    perSeed.push({ seed: workload.seed, workload_hash: appendedHash(workload), triggered: out.triggered, states: out.states,
      summary: RATIOS.flatMap(ratio => out.arms.map(r => summarize(r, workload, ratio, null))), reads: out.arms.map(r => ({ arm: r.arm, reads: r.reads })) });
    const partial = flag('--partial');
    if (partial) writeFileSync(partial, JSON.stringify({ metered_spend_usd: guard.spent, per_seed: perSeed }, null, 2));
    if (!json) console.error(`[query-gate] seed ${workload.seed} done; metered spend $${guard.spent.toFixed(4)}`);
  }
  const out = { mode: paid ? 'run' : 'offline', plumbing_only: !paid, seeds, entities, batches: BATCHES, reader_model: readerModel, embedding_model: embeddingModel ?? null,
    budget_tokens: BUDGET_TOKENS, full_rows: FULL_ROWS, metered_spend_usd: Number.isFinite(guard.spent) ? guard.spent : null,
    gate: decideGate(perSeed), aggregate: aggregate(perSeed.map(s => s.summary)), per_seed: perSeed };
  console.log(json ? JSON.stringify(out, null, 2) : JSON.stringify(out));
}
