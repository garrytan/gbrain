/**
 * gbrain backfill — first-class bulk operations (v0.30.1 Fix 3).
 *
 * Generalizes the keyset+checkpoint pattern from backfill-effective-date.ts
 * so future backfills (embedding_voyage in v0.30.2, etc.) reuse one tested
 * runner instead of cloning the SQL. T3 fixes the SET LOCAL evaporation
 * bug by routing writes through withReservedConnection. P2/X4 corrects
 * the emotional_weight predicate via a new recomputed_at column.
 *
 * Usage:
 *   gbrain backfill <kind> [--batch-size N] [--concurrency N] [--resume]
 *                          [--dry-run] [--keep-index] [--max-errors N]
 *   gbrain backfill list
 *
 * X5: --concurrency clamps to GBRAIN_DIRECT_POOL_SIZE - 1 with a warning,
 * always reserving 1 connection for HNSW + heartbeat + doctor probes.
 */

import { resolveDirectPoolSize } from '../core/connection-manager.ts';
import { listBackfills, getBackfill } from '../core/backfill-registry.ts';
import { runBackfill, clearBackfillCheckpoint } from '../core/backfill-base.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';

interface BackfillArgs {
  kind?: string;
  list?: boolean;
  batchSize?: number;
  concurrency?: number;
  resume?: boolean;
  dryRun?: boolean;
  keepIndex?: boolean;
  maxErrors?: number;
  fresh?: boolean;
  help?: boolean;
}

function parseArgs(args: string[]): BackfillArgs {
  const has = (flag: string) => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const num = (flag: string): number | undefined => {
    const v = val(flag);
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  // First non-flag positional becomes the kind / list.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      // Skip the value when the flag takes one.
      if (['--batch-size', '--concurrency', '--max-errors'].includes(a)) i++;
      continue;
    }
    positional.push(a);
  }
  const kind = positional[0];
  return {
    kind: kind === 'list' ? undefined : kind,
    list: kind === 'list' || has('--list'),
    batchSize: num('--batch-size'),
    concurrency: num('--concurrency'),
    resume: has('--resume'),
    dryRun: has('--dry-run'),
    keepIndex: has('--keep-index'),
    maxErrors: num('--max-errors'),
    fresh: has('--fresh'),
    help: has('--help') || has('-h'),
  };
}

function printHelp(): void {
  console.log(`gbrain backfill — first-class bulk operations.

Usage:
  gbrain backfill <kind> [flags]      Run a registered backfill.
  gbrain backfill list                 Show registered backfills + checkpoints.

Backfills (v0.30.1):
  effective_date     Compute effective_date for pages imported pre-v0.29.1.
  emotional_weight   Recompute emotional_weight for pages with stale stamp.
  embedding_voyage   Declared-only in v0.30.1 (multi-column embedding lands
                     in v0.30.2 alongside the schema migration).

Flags:
  --batch-size N     Initial batch size before adaptive halving (default 1000).
  --concurrency N    Parallel batches; clamped to GBRAIN_DIRECT_POOL_SIZE - 1
                     (default 3 - 1 = 2). Always reserves 1 conn for HNSW +
                     heartbeat + doctor probes.
  --resume           Pick up from last checkpoint (auto-detected; default on).
  --fresh            Restart from id=0, ignoring checkpoint.
  --dry-run          Report what WOULD happen; no writes.
  --keep-index       Skip HNSW drop-rebuild for embedding backfills.
  --max-errors N     Bail after N total errors (default 200).
`);
}

function clampConcurrency(requested: number | undefined): { effective: number; warning?: string } {
  const poolSize = resolveDirectPoolSize();
  // Always reserve 1 conn for HNSW + heartbeat + doctor.
  const ceiling = Math.max(1, poolSize - 1);
  if (requested === undefined) {
    return { effective: Math.min(ceiling, 3) };
  }
  if (requested > ceiling) {
    return {
      effective: ceiling,
      warning: `[backfill] --concurrency ${requested} clamped to ${ceiling} (pool size ${poolSize}, reserved 1 for HNSW/heartbeat). Bump GBRAIN_DIRECT_POOL_SIZE if you need more concurrency.`,
    };
  }
  return { effective: requested };
}

export async function runBackfillCommand(args: string[]): Promise<void> {
  const cli = parseArgs(args);
  if (cli.help) { printHelp(); return; }

  if (cli.list) {
    const entries = listBackfills();
    console.log(`Registered backfills (v0.30.1):\n`);
    for (const e of entries) {
      const status = e.v030_1_status === 'implemented' ? '✓' : '⊘';
      console.log(`  ${status} ${e.spec.name.padEnd(20)} ${e.description}`);
    }
    console.log('');
    return;
  }

  if (!cli.kind) {
    console.error('Usage: gbrain backfill <kind> [flags]   |   gbrain backfill list');
    process.exit(2);
  }

  const reg = getBackfill(cli.kind);
  if (!reg) {
    console.error(`No backfill registered with name "${cli.kind}". Run \`gbrain backfill list\`.`);
    process.exit(2);
  }
  if (reg.v030_1_status === 'declared-only') {
    console.error(`Backfill "${cli.kind}" is declared-only in v0.30.1 — the schema migration ships in v0.30.2.`);
    process.exit(2);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(2);
  }

  // X5 admission control — clamp concurrency to direct-pool capacity.
  const { effective: concurrency, warning } = clampConcurrency(cli.concurrency);
  if (warning) console.warn(warning);

  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));

  if (cli.fresh) {
    await clearBackfillCheckpoint(engine, reg.spec.name);
    console.log(`Cleared checkpoint for backfill.${reg.spec.name}`);
  }

  console.log(`Running backfill: ${reg.spec.name}${cli.dryRun ? ' (dry-run)' : ''}`);
  console.log(`  batch_size=${cli.batchSize ?? 1000}  concurrency=${concurrency}  max_errors=${cli.maxErrors ?? 200}`);

  let lastReport = Date.now();
  const result = await runBackfill(engine, reg.spec, {
    maxRows: undefined,
    batchSize: cli.batchSize,
    fresh: cli.fresh === true,
    dryRun: cli.dryRun === true,
    maxErrors: cli.maxErrors,
    onBatch: (info) => {
      const now = Date.now();
      if (now - lastReport > 2000) {
        console.log(`  batch ${info.batch}: cumulative=${info.cumulative} lastId=${info.lastId} errors=${info.errorsSeen} effectiveBatchSize=${info.effectiveBatchSize}`);
        lastReport = now;
      }
    },
  });

  console.log('');
  console.log(`Backfill ${reg.spec.name} complete.`);
  console.log(`  examined: ${result.examined}`);
  console.log(`  updated:  ${result.updated}`);
  console.log(`  errors:   ${result.errors}`);
  console.log(`  lastId:   ${result.lastId}`);
  console.log(`  duration: ${result.durationSec.toFixed(2)}s`);
  if (result.cappedByMaxRows) console.log(`  ⚠️  Capped by --max-rows; more remain.`);
  if (result.cappedByErrors) console.log(`  ⚠️  Capped by --max-errors at ${result.errors}.`);

  await engine.disconnect();
  if (result.cappedByErrors) process.exit(1);
}

export const _internal = { clampConcurrency, parseArgs };
