import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import { formatResult as formatOperationResult } from '../core/operations.ts';
import {
  collectMarkdownFiles,
  runImportService,
} from '../core/services/import-service.ts';
import { buildSyncManifest, isSyncable, pathToSlug } from '../core/sync.ts';
import type { SyncManifest } from '../core/sync.ts';

export interface SyncResult {
  status: 'up_to_date' | 'synced' | 'first_sync' | 'dry_run';
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  chunksCreated: number;
  pagesAffected: string[];
}

export interface SyncOpts {
  repoPath?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
}

interface SyncFailure {
  path: string;
  message: string;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

async function recordSyncRepoPaths(engine: BrainEngine, repoPath: string): Promise<void> {
  await engine.setConfig('sync.repo_path', repoPath);
  await engine.setConfig('markdown.repo_path', repoPath);
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // Resolve repo path
  const repoPath = opts.repoPath || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    throw new Error('No repo path specified. Use --repo or run mbrain init with --repo first.');
  }

  // Validate git repo
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}. MBrain sync requires a git-initialized repo.`);
  }

  // Git pull (unless --no-pull)
  if (!opts.noPull && !opts.dryRun) {
    try {
      git(repoPath, 'pull', '--ff-only');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('non-fast-forward') || msg.includes('diverged')) {
        console.error(`Warning: git pull failed (remote diverged). Syncing from local state.`);
      } else {
        console.error(`Warning: git pull failed: ${msg.slice(0, 100)}`);
      }
    }
  }

  // Get current HEAD
  let headCommit: string;
  try {
    headCommit = git(repoPath, 'rev-parse', 'HEAD');
  } catch {
    throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
  }

  // Read sync state
  const lastCommit = opts.full ? null : await engine.getConfig('sync.last_commit');

  // Ancestry validation: if lastCommit exists, verify it's still in history
  if (lastCommit) {
    try {
      git(repoPath, 'cat-file', '-t', lastCommit);
    } catch {
      console.error(`Sync anchor commit ${lastCommit.slice(0, 8)} missing (force push?). Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }

    // Verify ancestry
    try {
      git(repoPath, 'merge-base', '--is-ancestor', lastCommit, headCommit);
    } catch {
      console.error(`Sync anchor ${lastCommit.slice(0, 8)} is not an ancestor of HEAD. Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, repoPath, headCommit, opts);
  }

  // No changes
  if (lastCommit === headCommit) {
    if (!opts.dryRun) {
      await recordSyncRepoPaths(engine, repoPath);
    }
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      pagesAffected: [],
    };
  }

  // Diff using git diff (net result, not per-commit)
  const diffOutput = git(repoPath, 'diff', '--name-status', '-M', `${lastCommit}..${headCommit}`);
  const manifest = buildSyncManifest(diffOutput);

  const renamedSyncableToUnsyncable = manifest.renamed.filter(r => isSyncable(r.from) && !isSyncable(r.to));
  const renamedUnsyncableToSyncable = manifest.renamed.filter(r => !isSyncable(r.from) && isSyncable(r.to));
  const renamedSyncableToSyncable = manifest.renamed.filter(r => isSyncable(r.from) && isSyncable(r.to));
  const staleUnsyncableModified: string[] = [];
  for (const path of manifest.modified.filter(p => !isSyncable(p))) {
    const slug = pathToSlug(path);
    try {
      const existing = await engine.getPage(slug);
      if (existing) staleUnsyncableModified.push(path);
    } catch {
      // Ignore stale cleanup probes; syncable changes should still proceed.
    }
  }

  // Filter to syncable files and stale pages that must be removed.
  const filtered: SyncManifest = {
    added: [
      ...manifest.added.filter(p => isSyncable(p)),
      ...renamedUnsyncableToSyncable.map(r => r.to),
    ],
    modified: manifest.modified.filter(p => isSyncable(p)),
    deleted: [
      ...manifest.deleted.filter(p => isSyncable(p)),
      ...renamedSyncableToUnsyncable.map(r => r.from),
      ...staleUnsyncableModified,
    ],
    renamed: renamedSyncableToSyncable,
  };

  const totalChanges = filtered.added.length + filtered.modified.length +
    filtered.deleted.length + filtered.renamed.length;

  // Dry run
  if (opts.dryRun) {
    console.log(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
    if (filtered.added.length) console.log(`  Added: ${filtered.added.join(', ')}`);
    if (filtered.modified.length) console.log(`  Modified: ${filtered.modified.join(', ')}`);
    if (filtered.deleted.length) console.log(`  Deleted: ${filtered.deleted.join(', ')}`);
    if (filtered.renamed.length) console.log(`  Renamed: ${filtered.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}`);
    if (totalChanges === 0) console.log(`  No syncable changes.`);
    return {
      status: 'dry_run',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      chunksCreated: 0,
      pagesAffected: [],
    };
  }

  if (totalChanges === 0) {
    // Update sync state even with no syncable changes (git advanced)
    await engine.setConfig('sync.last_commit', headCommit);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await recordSyncRepoPaths(engine, repoPath);
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      pagesAffected: [],
    };
  }

  if (totalChanges > 100) {
    console.log(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  const pagesAffected: string[] = [];
  let chunksCreated = 0;
  const start = Date.now();
  const failures: SyncFailure[] = [];

  const addPageAffected = (slug: string) => {
    if (!pagesAffected.includes(slug)) {
      pagesAffected.push(slug);
    }
  };

  const recordFailure = (path: string, message: string) => {
    failures.push({ path, message });
    console.error(`  Warning: skipped ${path}: ${message}`);
  };

  const recordImportResult = (
    path: string,
    result: Awaited<ReturnType<typeof importFile>>,
  ) => {
    if (result.status === 'imported') {
      chunksCreated += result.chunks;
      addPageAffected(result.slug);
      return;
    }

    if (result.error) {
      recordFailure(path, result.error);
    }
  };

  await engine.transaction(async (tx) => {
    // Process deletes first (prevents slug conflicts)
    for (const path of filtered.deleted) {
      const slug = pathToSlug(path);
      await tx.deletePage(slug);
      addPageAffected(slug);
    }

    // Process renames (updateSlug preserves page_id, chunks, embeddings)
    for (const { from, to } of filtered.renamed) {
      const oldSlug = pathToSlug(from);
      const newSlug = pathToSlug(to);
      try {
        await tx.updateSlug(oldSlug, newSlug);
      } catch {
        // Slug doesn't exist or collision, treat as add.
      }
      // Reimport at new path (picks up content changes)
      const filePath = join(repoPath, to);
      if (existsSync(filePath)) {
        try {
          const result = await importFile(tx, filePath, to);
          recordImportResult(to, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          recordFailure(to, msg);
        }
      }
      addPageAffected(newSlug);
    }

    // Process adds and modifies
    for (const path of [...filtered.added, ...filtered.modified]) {
      const filePath = join(repoPath, path);
      if (!existsSync(filePath)) continue;
      try {
        const result = await importFile(tx, filePath, path);
        recordImportResult(path, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        recordFailure(path, msg);
      }
    }

    if (failures.length > 0) {
      throw new Error(formatSyncFailures(failures));
    }

    const elapsed = Date.now() - start;

    // Update sync state AFTER all changes succeed.
    await tx.setConfig('sync.last_commit', headCommit);
    await tx.setConfig('sync.last_run', new Date().toISOString());
    await recordSyncRepoPaths(tx, repoPath);

    // Log ingest only after checkpoint update is safe.
    await tx.logIngest({
      source_type: 'git_sync',
      source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
      pages_updated: pagesAffected,
      summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${chunksCreated} chunks, ${elapsed}ms`,
    });
  });

  if (chunksCreated > 0) {
    console.log(`Text imported. Run 'mbrain embed --stale' to backfill missing embeddings.`);
  }

  return {
    status: 'synced',
    fromCommit: lastCommit,
    toCommit: headCommit,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length,
    renamed: filtered.renamed.length,
    chunksCreated,
    pagesAffected,
  };
}

function formatSyncFailures(failures: SyncFailure[]): string {
  const shown = failures
    .slice(0, 5)
    .map(f => `${f.path}: ${f.message}`)
    .join('; ');
  const suffix = failures.length > 5 ? `; ${failures.length - 5} more` : '';
  return `Sync failed for ${failures.length} file(s): ${shown}${suffix}. Checkpoint not advanced; fix the files and rerun sync.`;
}

async function performFullSync(
  engine: BrainEngine,
  repoPath: string,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  if (opts.dryRun) {
    const files = collectMarkdownFiles(repoPath);
    const pagesAffected = files.map(file => pathToSlug(relative(repoPath, file).replace(/\\/g, '/')));
    console.log(`Sync dry run: full import of ${repoPath} at ${headCommit.slice(0, 8)}`);
    if (pagesAffected.length) console.log(`  Added: ${pagesAffected.join(', ')}`);
    else console.log(`  No syncable files.`);
    return {
      status: 'dry_run',
      fromCommit: null,
      toCommit: headCommit,
      added: pagesAffected.length,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      pagesAffected,
    };
  }

  console.log(`Running full import of ${repoPath}...`);
  const summary = await runImportService(engine, {
    rootDir: repoPath,
    noEmbed: opts.noEmbed,
    fresh: Boolean(opts.full),
    workers: 1,
  });

  if (summary.errors > 0) {
    throw new Error(
      `Full sync failed for ${summary.errors} file(s). ` +
      'Checkpoint not advanced; fix the files and rerun sync.',
    );
  }

  await engine.logIngest({
    source_type: 'git_sync',
    source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
    pages_updated: summary.importedSlugs,
    summary: `Full sync: ${summary.imported} pages imported, ${summary.skipped} skipped, ${summary.chunksCreated} chunks`,
  });

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: summary.imported,
    modified: 0,
    deleted: 0,
    renamed: 0,
    chunksCreated: summary.chunksCreated,
    pagesAffected: summary.importedSlugs,
  };
}

export async function runSync(engine: BrainEngine, args: string[]) {
  const repoPath = args.find((a, i) => args[i - 1] === '--repo') || undefined;
  const watch = args.includes('--watch');
  const intervalStr = args.find((a, i) => args[i - 1] === '--interval');
  const interval = intervalStr ? parseInt(intervalStr, 10) : 60;
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const noPull = args.includes('--no-pull');
  const noEmbed = args.includes('--no-embed');

  const opts: SyncOpts = { repoPath, dryRun, full, noPull, noEmbed };

  if (!watch) {
    const result = await performSync(engine, opts);
    process.stdout.write(formatOperationResult('sync_brain', result));
    return;
  }

  // Watch mode
  let consecutiveErrors = 0;
  console.log(`Watching for changes every ${interval}s... (Ctrl+C to stop)`);

  while (true) {
    try {
      const result = await performSync(engine, { ...opts, full: false });
      consecutiveErrors = 0;
      if (result.status === 'synced') {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] Synced: +${result.added} ~${result.modified} -${result.deleted} R${result.renamed}`);
      }
    } catch (e: unknown) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${new Date().toISOString().slice(11, 19)}] Sync error (${consecutiveErrors}/5): ${msg}`);
      if (consecutiveErrors >= 5) {
        console.error(`5 consecutive sync failures. Stopping watch.`);
        process.exit(1);
      }
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}
