import type { BrainEngine } from '../core/engine.ts';
import {
  collectMarkdownFiles,
  defaultImportWorkers,
  runImportService,
  type ImportRunSummary,
} from '../core/services/import-service.ts';

export async function runImport(engine: BrainEngine, args: string[]) {
  const workersIdx = args.indexOf('--workers');
  const workersArg = workersIdx !== -1 ? args[workersIdx + 1] : null;
  const workerCount = workersArg ? parseInt(workersArg, 10) : defaultImportWorkers();
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  const dir = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dir) {
    console.error('Usage: mbrain import <dir> [--no-embed] [--workers N] [--fresh] [--json]');
    process.exit(1);
  }

  const summary = await runImportService(engine, {
    rootDir: dir,
    noEmbed: args.includes('--no-embed'),
    fresh: args.includes('--fresh'),
    workers: workerCount,
  });
  printImportSummary(summary, args.includes('--json'));
}

function printImportSummary(summary: ImportRunSummary, jsonOutput: boolean) {
  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      duration_s: summary.durationSeconds,
      imported: summary.imported,
      skipped: summary.skipped,
      errors: summary.errors,
      chunks: summary.chunksCreated,
      total_files: summary.totalFiles,
    }));
    return;
  }

  console.log(`\nImport complete (${summary.durationSeconds.toFixed(1)}s):`);
  console.log(`  ${summary.imported} pages imported`);
  console.log(`  ${summary.skipped} pages skipped (${summary.unchanged} unchanged, ${summary.errors} errors)`);
  console.log(`  ${summary.chunksCreated} chunks created`);
}

export { collectMarkdownFiles };
