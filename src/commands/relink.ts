import { existsSync, lstatSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFromFile } from '../core/import-file.ts';
import { isSyncable } from '../core/sync.ts';

function collectSyncableFiles(rootDir: string): { fullPath: string; relPath: string }[] {
  const files: { fullPath: string; relPath: string }[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(dir, entry);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');
      if (isSyncable(relPath)) {
        files.push({ fullPath, relPath });
      }
    }
  }

  walk(rootDir);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

export async function runRelink(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`gbrain relink — rebuild DB link graph from markdown links

USAGE
  gbrain relink [--dir <brain-dir>] [--dry-run]

OPTIONS
  --dir <path>     Brain directory to scan (default: current directory)
  --dry-run        Report how many files would be relinked without writing

Relink re-imports every syncable markdown file under <dir> with embeddings
skipped, which triggers link reconciliation in import-file. Use after bulk
markdown edits, schema migrations, or when the DB link graph has drifted
from the markdown source of truth.`);
    return;
  }

  const dirIdx = args.indexOf('--dir');
  const rootDir = dirIdx >= 0 ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');

  if (!existsSync(rootDir)) {
    console.error(`Directory not found: ${rootDir}`);
    process.exit(1);
  }

  const files = collectSyncableFiles(rootDir);
  if (files.length === 0) {
    console.log('No syncable markdown files found.');
    return;
  }

  if (dryRun) {
    console.log(`Would relink ${files.length} syncable markdown file(s) from ${rootDir}.`);
    return;
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const result = await importFromFile(engine, file.fullPath, file.relPath, { noEmbed: true });
    if (result.status === 'imported') imported++;
    else if (result.status === 'skipped') skipped++;
    else errors++;
  }

  console.log(`Relinked ${files.length} file(s) from ${rootDir}.`);
  console.log(`  imported_or_updated: ${imported}`);
  console.log(`  unchanged_or_reconciled: ${skipped}`);
  console.log(`  errors: ${errors}`);
}
