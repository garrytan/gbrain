import type { BrainEngine } from '../core/engine.ts';
import { getEmbeddingProvider } from '../core/embedding.ts';
import { formatOpHelp, parseOpArgs } from '../core/operations.ts';
import type { Operation } from '../core/operations.ts';
import {
  runEmbedBackfillJob,
  submitEmbedBackfillJob,
  type EmbedBackfillJobRuntime,
} from '../core/services/embed-backfill-job-service.ts';
import {
  embedOnePageWithProvider,
  runEmbeddingBackfill,
} from '../core/services/embedding-backfill-service.ts';
import { createSqlMaintenanceRuntimeAdapter } from '../core/services/maintenance-runtime-db-adapter.ts';

const EMBED_COMMAND: Operation = {
  name: 'embed',
  description: 'Generate or refresh embeddings for one page, all pages, or only stale chunks.',
  params: {
    slug: { type: 'string', description: 'Page slug to embed' },
    all: { type: 'boolean', description: 'Embed every page' },
    stale: { type: 'boolean', description: 'Only embed missing or stale chunks' },
    enqueue: { type: 'boolean', description: 'Submit a durable embed_backfill maintenance job instead of embedding inline' },
    run_job: { type: 'string', description: 'Claim and run a specific embed_backfill maintenance job id' },
  },
  handler: async () => undefined,
  cliHints: { name: 'embed', positional: ['slug'] },
};

export interface RunEmbedDeps {
  runtime?: EmbedBackfillJobRuntime;
  provider?: ReturnType<typeof getEmbeddingProvider>;
}

export async function runEmbed(engine: BrainEngine, args: string[], deps: RunEmbedDeps = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(formatOpHelp(EMBED_COMMAND));
    return;
  }

  const params = parseOpArgs(EMBED_COMMAND, args);
  const slug = params.slug as string | undefined;
  const staleOnly = params.stale === true;
  const rebuildAll = params.all === true;
  const enqueue = params.enqueue === true;
  const runJob = params.run_job as string | undefined;
  const runtime = () => deps.runtime ?? createSqlMaintenanceRuntimeAdapter(engine) as unknown as EmbedBackfillJobRuntime;

  if (runJob && (enqueue || slug || rebuildAll || staleOnly)) {
    console.error('Usage: mbrain embed --run-job <id>');
    process.exit(1);
    return;
  }

  if (enqueue) {
    if (slug) {
      console.error('Usage: mbrain embed [--all|--stale] --enqueue');
      process.exit(1);
      return;
    }
    const mode = rebuildAll ? 'all' : 'stale';
    const result = await submitEmbedBackfillJob(runtime(), { mode });
    console.log(`${result.status} embed_backfill ${result.job.id}`);
    return;
  }

  const provider = deps.provider ?? getEmbeddingProvider();

  if (runJob) {
    const result = await runEmbedBackfillJob({
      engine,
      runtime: runtime(),
      job_id: runJob,
      provider,
    });
    console.log(`completed embed_backfill ${runJob}: ${result.result.chunks_embedded} chunks embedded`);
    return;
  }

  if (!provider.capability.available) {
    console.error(provider.capability.reason || 'No embedding provider available.');
    process.exit(1);
  }

  if (slug) {
    await embedPage(engine, slug, provider, staleOnly);
    return;
  }

  if (rebuildAll || staleOnly) {
    await embedAll(engine, provider, staleOnly);
    return;
  }

  console.error('Usage: mbrain embed [<slug>|--all|--stale] [--enqueue|--run-job <id>]');
  process.exit(1);
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  provider: ReturnType<typeof getEmbeddingProvider>,
  staleOnly: boolean,
) {
  const page = await engine.getPage(slug);
  if (!page) {
    console.error(`Page not found: ${slug}`);
    process.exit(1);
  }

  const result = await embedOnePageWithProvider(engine, page, provider, staleOnly, {
    error: message => console.error(message),
  });
  if (result.skipped_derived_refresh) return;
  if (result.embedded_chunks === 0) {
    console.log(`${slug}: all ${result.total_chunks} chunks already embedded`);
    return;
  }

  console.log(`${slug}: embedded ${result.embedded_chunks} chunks with ${provider.capability.model ?? provider.capability.implementation}`);
}

async function embedAll(
  engine: BrainEngine,
  provider: ReturnType<typeof getEmbeddingProvider>,
  staleOnly: boolean,
) {
  const summary = await runEmbeddingBackfill(engine, {
    staleOnly,
    provider,
    logger: {
      log: message => console.log(message),
      error: message => console.error(message),
      write: message => process.stdout.write(message),
    },
  });

  console.log(
    `\nEmbedded ${summary.chunks_embedded} chunks across ${summary.pages_touched} pages ` +
    `(${summary.pages_scanned} pages scanned, ${summary.chunks_queued} chunks queued, ${summary.window_count} windows, ` +
    `${summary.skipped_derived_refresh_pages} skipped derived refresh, ` +
    `${summary.provider_failures} provider failures, ${summary.write_failures} write failures)`,
  );
}
