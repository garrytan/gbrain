import { readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { createStorage, type StorageConfig } from '../core/storage.ts';
import {
  BRAIN_ARCHIVE_BUCKET,
  buildBrainIngestionPlan,
  runBrainIngestion,
  type BrainIngestionOptions,
} from '../core/brain-ingestion.ts';

interface BrainIngestManifest {
  sources?: string[];
  bucket?: string;
  mode?: 'pilot' | 'staged';
  limit?: number;
  prefix?: string;
}

export async function runBrainIngest(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const manifest = loadManifest(flag(args, '--manifest'));
  const sources = listFlag(args, '--source');
  const bucket = flag(args, '--storage') ?? flag(args, '--bucket') ?? manifest.bucket ?? BRAIN_ARCHIVE_BUCKET;
  const mode = (flag(args, '--mode') ?? manifest.mode ?? 'pilot') as 'pilot' | 'staged';
  const limit = parseInt(flag(args, '--limit') ?? String(manifest.limit ?? 500), 10);
  const prefix = flag(args, '--prefix') ?? manifest.prefix;
  const dryRun = !args.includes('--write');
  const allowWrites = args.includes('--write') && process.env.GBRAIN_BRAIN_INGESTION_ALLOW_WRITES === '1';
  const json = args.includes('--json');

  const opts: BrainIngestionOptions = {
    bucket,
    mode,
    sources: sources.length ? sources : (manifest.sources ?? []),
    dryRun,
    allowWrites,
    limit,
    prefix,
  };

  if (!opts.sources.length) {
    console.error('Usage: gbrain brain-ingest --source afirebrand [--source MoneyPrinter0x] [--source "Taiki Madea"] [--dry-run|--write]');
    process.exit(1);
  }

  // Validate before creating a storage client so allowlist errors never need credentials.
  const plan = buildBrainIngestionPlan(opts);
  const storage = await createStorage(readStorageConfig(bucket));
  const result = await runBrainIngestion(engine, storage, { ...opts, sources: plan.sources.map(s => s.sourceKey) });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatBrainIngestionResult(result));
}

function loadManifest(path: string | undefined): BrainIngestManifest {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as BrainIngestManifest;
  return parsed;
}

function readStorageConfig(bucket: string): StorageConfig {
  const projectUrl = process.env.SUPABASE_URL ?? process.env.GBRAIN_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.GBRAIN_SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error('Brain ingestion storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or GBRAIN_* equivalents); values are never logged.');
  }
  return { backend: 'supabase', bucket, projectUrl, serviceRoleKey };
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

function listFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) values.push(args[++i]);
  }
  return values;
}

function formatBrainIngestionResult(result: Awaited<ReturnType<typeof runBrainIngestion>>): string {
  const lines = [
    'Brain Ingestion',
    '===============',
    `Mode: ${result.mode}`,
    `Bucket: ${result.bucket}`,
    `Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `Sources: ${result.sources.join(', ')}`,
    '',
    `Listed: ${result.counters.listed}`,
    `Parsed: ${result.counters.parsed}`,
    `Written: ${result.counters.written}`,
    `Failed: ${result.counters.failed}`,
    `Duplicates: ${result.counters.duplicates}`,
    '',
    'Quality gates:',
  ];
  for (const [name, gate] of Object.entries(result.qualityGates)) {
    lines.push(`- ${name}: ${gate.passed ? 'PASS' : 'FAIL'} (${gate.detail})`);
  }
  if (result.failures.length) {
    lines.push('', 'Failures:');
    for (const failure of result.failures.slice(0, 10)) {
      lines.push(`- ${failure.storagePath}: ${failure.error}`);
    }
  }
  return lines.join('\n');
}

function printUsage(): void {
  console.log(`Usage:
  gbrain brain-ingest --source afirebrand --dry-run
  gbrain brain-ingest --manifest /tmp/brain-pilot-manifest.json --json
  GBRAIN_BRAIN_INGESTION_ALLOW_WRITES=1 gbrain brain-ingest --manifest /tmp/brain-pilot-manifest.json --write

Defaults:
  --storage ${BRAIN_ARCHIVE_BUCKET}
  --mode pilot
  --limit 500

Write safety:
  Dry-run is the default. Persistent writes require both --write and GBRAIN_BRAIN_INGESTION_ALLOW_WRITES=1.`);
}
