import { existsSync } from 'fs';
import path from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { runBacklinks } from './backlinks.ts';
import { runExtract } from './extract.ts';
import { runImport } from './import.ts';
import { compileBookmarks } from '../bookmarks/compiler.ts';
import {
  extractSelfThreadsToFile,
  fetchXUrlListToFile,
  resolveBookmarkWorkspace,
} from '../bookmarks/pipeline.ts';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function collectFreeUrls(args: string[]): string[] {
  const valueFlags = new Set([
    '--workspace',
    '--input',
    '--source',
    '--threads',
    '--output-dir',
    '--storage-state',
    '--dataset-id',
    '--title',
    '--description',
  ]);

  const skipIndexes = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) skipIndexes.add(i + 1);
  }

  return args.filter(
    (arg, index) => !skipIndexes.has(index) && /^https?:\/\//.test(arg),
  );
}

function humanizeDatasetId(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function printIngestBookmarksHelp() {
  console.log(`Usage: gbrain ingest:bookmarks [options] [x-urls...]

Fetch bookmarked X posts with Playwright, compile them into subject-first GBrain
markdown, then import/extract them into the brain.

Options:
  --workspace <dir>       Workspace root for raw/, compiled/, playwright/ (default: .bookmarks)
  --input <file>          Text file of X status URLs
  --source <file>         Existing fetched JSON payload (skip fetch if present)
  --threads <file>        Existing self-thread JSON payload
  --output-dir <dir>      Compiled markdown output directory
  --storage-state <file>  Playwright storage state (defaults to workspace auth path or env)
  --dataset-id <id>       Stable dataset id (default: derived from input filename)
  --title <title>         Collection page title
  --description <text>    Collection page description
  --compile-only          Stop after writing compiled markdown + backlinks
  --no-import             Alias for --compile-only
  --no-fetch              Skip Playwright fetch, require --source
  --no-threads            Skip same-author thread extraction
  --no-embed             Pass through to gbrain import
  --json                  Emit JSON summary

Examples:
  gbrain ingest:bookmarks --input inputs/karpathy-kb-cluster.txt
  gbrain ingest:bookmarks --source raw/x/cluster.json --threads raw/x/threads.json --compile-only
`);
}

export async function runIngestBookmarks(engine: BrainEngine | null, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printIngestBookmarksHelp();
    return;
  }

  const workspace = resolveBookmarkWorkspace(
    valueAfter(args, '--workspace') ?? path.resolve('.bookmarks'),
  );
  const inputPath = valueAfter(args, '--input');
  const providedSourcePath = valueAfter(args, '--source');
  const providedThreadsPath = valueAfter(args, '--threads');
  const cliUrls = collectFreeUrls(args);
  const noFetch = args.includes('--no-fetch');
  const noThreads = args.includes('--no-threads');
  const noEmbed = args.includes('--no-embed');
  const jsonMode = args.includes('--json');
  const compileOnly = args.includes('--compile-only') || args.includes('--no-import');

  const datasetId =
    valueAfter(args, '--dataset-id') ??
    (inputPath
      ? path.basename(inputPath, path.extname(inputPath))
      : providedSourcePath
        ? path.basename(providedSourcePath, path.extname(providedSourcePath))
        : 'x-bookmarks');
  const datasetTitle = valueAfter(args, '--title') ?? humanizeDatasetId(datasetId);
  const datasetDescription =
    valueAfter(args, '--description') ??
    `Bookmarked X posts compiled for ${datasetTitle}.`;

  const sourcePath =
    providedSourcePath ?? path.join(workspace.rawDir, `${datasetId}.json`);
  const threadsPath =
    providedThreadsPath ??
    path.join(workspace.rawDir, `${datasetId}-self-threads.json`);
  const outputDir =
    valueAfter(args, '--output-dir') ??
    path.join(workspace.compiledDir, datasetId);
  const storageStatePath =
    valueAfter(args, '--storage-state') ??
    process.env.PLAYWRIGHT_STORAGE_STATE ??
    workspace.storageStatePath;

  const shouldFetch = !noFetch && (cliUrls.length > 0 || Boolean(inputPath) || !existsSync(sourcePath));
  const shouldExtractThreads = !noThreads && (!existsSync(threadsPath) || shouldFetch);

  if (shouldFetch && !storageStatePath) {
    throw new Error('PLAYWRIGHT_STORAGE_STATE or --storage-state is required to fetch X bookmarks.');
  }
  if (shouldFetch && cliUrls.length === 0 && !inputPath) {
    throw new Error('Fetching bookmarks requires --input <file> or one or more X status URLs.');
  }
  if (!shouldFetch && !existsSync(sourcePath)) {
    throw new Error(`Source payload not found: ${sourcePath}`);
  }
  if (shouldExtractThreads && !storageStatePath) {
    throw new Error('PLAYWRIGHT_STORAGE_STATE or --storage-state is required to extract same-author threads.');
  }

  if (shouldFetch) {
    console.log(`Fetching X bookmarks into ${sourcePath}...`);
    await fetchXUrlListToFile({
      inputPath,
      urls: cliUrls,
      outputPath: sourcePath,
      storageStatePath,
      onProgress: (url, index, total) => {
        console.log(`[${index + 1}/${total}] ${url}`);
      },
    });
  }

  if (shouldExtractThreads) {
    console.log(`Extracting same-author threads into ${threadsPath}...`);
    await extractSelfThreadsToFile({
      sourcePath,
      outputPath: threadsPath,
      storageStatePath,
    });
  } else if (!existsSync(threadsPath)) {
    throw new Error(`Thread payload not found: ${threadsPath}`);
  }

  const compileResult = await compileBookmarks({
    dataset: {
      id: datasetId,
      title: datasetTitle,
      description: datasetDescription,
      sourceType: 'x',
      sourcePath,
      threadPath: threadsPath,
    },
    outputDir,
  });

  await runBacklinks(['fix', '--dir', outputDir]);

  let importRan = false;
  if (!compileOnly) {
    if (!engine) {
      throw new Error('No brain configured. Run gbrain init, or use --compile-only.');
    }
    const importArgs = [outputDir];
    if (noEmbed) importArgs.push('--no-embed');
    await runImport(engine, importArgs);
    await runExtract(engine, ['all', '--dir', outputDir]);
    importRan = true;
  }

  const summary = {
    status: 'ok',
    dataset_id: datasetId,
    source_path: path.resolve(sourcePath),
    threads_path: path.resolve(threadsPath),
    output_dir: compileResult.outputDir,
    bookmarks: compileResult.bookmarks,
    page_count: compileResult.pageCount,
    people: compileResult.people,
    concepts: compileResult.concepts,
    collections: compileResult.collections,
    imported: importRan,
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Bookmarks compiled to ${compileResult.outputDir}`);
  console.log(
    `  ${compileResult.bookmarks} bookmarks -> ${compileResult.pageCount} pages (${compileResult.people} people, ${compileResult.concepts} concepts, ${compileResult.collections} collections)`,
  );
  if (importRan) {
    console.log('  Imported into brain and extracted links/timeline.');
  } else {
    console.log('  Compile-only mode: markdown written, backlinks fixed, import skipped.');
  }
}
