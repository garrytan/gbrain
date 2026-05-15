import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig } from '../core/config.ts';
import { migrateEmbeddingDimensions, planEmbeddingDimMigration } from '../core/embedding-dim-migration.ts';

interface Args {
  targetDims: number;
  embeddingModel?: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(args: string[]): Args {
  const dimsIdx = args.indexOf('--embedding-dimensions');
  const toIdx = args.indexOf('--to');
  const rawDims = dimsIdx >= 0 ? args[dimsIdx + 1] : toIdx >= 0 ? args[toIdx + 1] : undefined;
  const modelIdx = args.indexOf('--embedding-model');
  const embeddingModel = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const targetDims = rawDims ? Number(rawDims) : NaN;

  if (!Number.isInteger(targetDims) || targetDims <= 0) {
    console.error('Usage: gbrain migrate-embedding-dim --embedding-dimensions <N> [--embedding-model provider:model] [--yes] [--dry-run] [--json]');
    process.exit(1);
  }

  return {
    targetDims,
    embeddingModel,
    yes: args.includes('--yes'),
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
  };
}

function updateFileConfig(opts: { targetDims: number; embeddingModel?: string }) {
  const config = loadConfig();
  if (!config) return;
  saveConfig({
    ...config,
    embedding_dimensions: opts.targetDims,
    ...(opts.embeddingModel ? { embedding_model: opts.embeddingModel } : {}),
  });
}

export async function runMigrateEmbeddingDim(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const plan = await planEmbeddingDimMigration(engine, opts.targetDims);

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'dry_run', ...plan, embedding_model: opts.embeddingModel ?? null }));
    } else {
      console.log(`Would migrate content_chunks.embedding: vector(${plan.currentDims}) -> vector(${plan.targetDims})`);
      console.log('Would clear all existing embeddings and query cache rows.');
      console.log(plan.recreateHnsw
        ? 'Would recreate idx_chunks_embedding.'
        : 'Would skip idx_chunks_embedding because target dims exceed HNSW cap.');
    }
    return;
  }

  if (!opts.yes) {
    console.error(
      `Refusing to migrate embedding dimensions without --yes.\n` +
      `This changes content_chunks.embedding vector(${plan.currentDims}) -> vector(${plan.targetDims}), ` +
      `clears every existing embedding, clears query cache rows, and requires re-embedding.\n` +
      `Re-run with --yes when ready, or use --dry-run to inspect the plan.`,
    );
    process.exit(1);
  }

  const result = await migrateEmbeddingDimensions(engine, opts.targetDims);
  if (opts.embeddingModel) {
    await engine.setConfig('embedding_model', opts.embeddingModel);
  }
  updateFileConfig({ targetDims: opts.targetDims, embeddingModel: opts.embeddingModel });

  if (opts.json) {
    console.log(JSON.stringify({
      ...result,
      embedding_model: opts.embeddingModel ?? null,
      next: 'gbrain embed --stale',
    }));
  } else {
    if (result.status === 'noop') {
      console.log(`Embedding column already vector(${opts.targetDims}).`);
    } else {
      console.log(`Migrated embedding column: vector(${result.currentDims}) -> vector(${result.targetDims})`);
      console.log('Cleared existing embeddings. Next: gbrain embed --stale');
    }
    if (opts.embeddingModel) console.log(`Set embedding_model = ${opts.embeddingModel}`);
    console.log(`Set embedding_dimensions = ${opts.targetDims}`);
  }
}
