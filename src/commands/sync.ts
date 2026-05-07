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
import {
  loadSubbrainRegistry,
  type SubbrainConfig,
} from '../core/subbrains.ts';

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
  targets?: SyncTargetSummary[];
}

export interface SyncTargetSummary {
  id: string;
  status: SyncResult['status'];
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
  subbrain?: string;
  allSubbrains?: boolean;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
}

interface SyncFailure {
  path: string;
  message: string;
}

interface SyncTarget {
  id: string | null;
  repoPath: string;
  slugPrefix?: string;
  legacy: boolean;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

async function recordSyncRepoPaths(engine: BrainEngine, target: SyncTarget): Promise<void> {
  if (!target.legacy) return;
  await engine.setConfig('sync.repo_path', target.repoPath);
  await engine.setConfig('markdown.repo_path', target.repoPath);
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  validateSyncTargetOptions(opts);
  if (opts.allSubbrains) {
    return performAllSubbrainSync(engine, opts);
  }

  const target = await resolveSyncTarget(engine, opts);
  return performSyncTarget(engine, opts, target);
}

async function performSyncTarget(engine: BrainEngine, opts: SyncOpts, target: SyncTarget): Promise<SyncResult> {
  // Resolve repo path
  const repoPath = target.repoPath;
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
  const lastCommit = opts.full ? null : await engine.getConfig(lastCommitKey(target));

  // Ancestry validation: if lastCommit exists, verify it's still in history
  if (lastCommit) {
    try {
      git(repoPath, 'cat-file', '-t', lastCommit);
    } catch {
      console.error(`Sync anchor commit ${lastCommit.slice(0, 8)} missing (force push?). Running full reimport.`);
      return performFullSync(engine, target, headCommit, opts);
    }

    // Verify ancestry
    try {
      git(repoPath, 'merge-base', '--is-ancestor', lastCommit, headCommit);
    } catch {
      console.error(`Sync anchor ${lastCommit.slice(0, 8)} is not an ancestor of HEAD. Running full reimport.`);
      return performFullSync(engine, target, headCommit, opts);
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, target, headCommit, opts);
  }

  // No changes
  if (lastCommit === headCommit) {
    if (!opts.dryRun) {
      await recordSyncRepoPaths(engine, target);
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
    const slug = pathToSlug(path, target.slugPrefix);
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
    const dryRunPagesAffected = changedPagesForDryRun(filtered, target.slugPrefix);
    console.log(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
    if (filtered.added.length) console.log(`  Added: ${filtered.added.map(path => pathToSlug(path, target.slugPrefix)).join(', ')}`);
    if (filtered.modified.length) console.log(`  Modified: ${filtered.modified.map(path => pathToSlug(path, target.slugPrefix)).join(', ')}`);
    if (filtered.deleted.length) console.log(`  Deleted: ${filtered.deleted.map(path => pathToSlug(path, target.slugPrefix)).join(', ')}`);
    if (filtered.renamed.length) console.log(`  Renamed: ${filtered.renamed.map(r => `${pathToSlug(r.from, target.slugPrefix)} -> ${pathToSlug(r.to, target.slugPrefix)}`).join(', ')}`);
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
      pagesAffected: dryRunPagesAffected,
    };
  }

  if (totalChanges === 0) {
    // Update sync state even with no syncable changes (git advanced)
    await engine.setConfig(lastCommitKey(target), headCommit);
    await engine.setConfig(lastRunKey(target), new Date().toISOString());
    await recordSyncRepoPaths(engine, target);
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
      const slug = pathToSlug(path, target.slugPrefix);
      await tx.deletePage(slug);
      addPageAffected(slug);
    }

    // Process renames (updateSlug preserves page_id, chunks, embeddings)
    for (const { from, to } of filtered.renamed) {
      const oldSlug = pathToSlug(from, target.slugPrefix);
      const newSlug = pathToSlug(to, target.slugPrefix);
      try {
        await tx.updateSlug(oldSlug, newSlug);
      } catch {
        // Slug doesn't exist or collision, treat as add.
      }
      // Reimport at new path (picks up content changes)
      const filePath = join(repoPath, to);
      if (existsSync(filePath)) {
        try {
          const result = await importFile(tx, filePath, to, { slugPrefix: target.slugPrefix });
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
        const result = await importFile(tx, filePath, path, { slugPrefix: target.slugPrefix });
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
    await tx.setConfig(lastCommitKey(target), headCommit);
    await tx.setConfig(lastRunKey(target), new Date().toISOString());
    await recordSyncRepoPaths(tx, target);

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
  target: SyncTarget,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  const repoPath = target.repoPath;
  if (opts.dryRun) {
    const files = collectMarkdownFiles(repoPath);
    const pagesAffected = files.map(file => pathToSlug(
      relative(repoPath, file).replace(/\\/g, '/'),
      target.slugPrefix,
    ));
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
    slugPrefix: target.slugPrefix,
    updateSyncMetadata: target.legacy,
  });

  if (summary.errors > 0) {
    throw new Error(
      `Full sync failed for ${summary.errors} file(s). ` +
      'Checkpoint not advanced; fix the files and rerun sync.',
    );
  }

  let staleDeletedSlugs: string[] = [];
  const currentSlugs = target.legacy ? new Set<string>() : collectCurrentRepoSlugs(repoPath, target.slugPrefix);
  await engine.transaction(async (tx) => {
    staleDeletedSlugs = target.legacy ? [] : await deleteStaleSubbrainPages(tx, target, currentSlugs);
    const pagesUpdated = uniqueStrings([...summary.importedSlugs, ...staleDeletedSlugs]);
    await tx.logIngest({
      source_type: 'git_sync',
      source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
      pages_updated: pagesUpdated,
      summary: `Full sync: ${summary.imported} pages imported, ${summary.skipped} skipped, ${staleDeletedSlugs.length} deleted, ${summary.chunksCreated} chunks`,
    });

    if (!target.legacy) {
      await tx.setConfig(lastCommitKey(target), headCommit);
      await tx.setConfig(lastRunKey(target), new Date().toISOString());
    }
  });

  const pagesAffected = uniqueStrings([...summary.importedSlugs, ...staleDeletedSlugs]);

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: summary.imported,
    modified: 0,
    deleted: staleDeletedSlugs.length,
    renamed: 0,
    chunksCreated: summary.chunksCreated,
    pagesAffected,
  };
}

function changedPagesForDryRun(manifest: SyncManifest, slugPrefix?: string): string[] {
  return uniqueStrings([
    ...manifest.added.map(path => pathToSlug(path, slugPrefix)),
    ...manifest.modified.map(path => pathToSlug(path, slugPrefix)),
    ...manifest.deleted.map(path => pathToSlug(path, slugPrefix)),
    ...manifest.renamed.flatMap(rename => [
      pathToSlug(rename.from, slugPrefix),
      pathToSlug(rename.to, slugPrefix),
    ]),
  ]);
}

function collectCurrentRepoSlugs(repoPath: string, slugPrefix?: string): Set<string> {
  return new Set(
    collectMarkdownFiles(repoPath).map(file => pathToSlug(
      relative(repoPath, file).replace(/\\/g, '/'),
      slugPrefix,
    )),
  );
}

async function deleteStaleSubbrainPages(
  engine: BrainEngine,
  target: SyncTarget,
  currentSlugs: Set<string>,
): Promise<string[]> {
  if (!target.slugPrefix) return [];

  const staleSlugs: string[] = [];
  const prefix = `${target.slugPrefix}/`;
  const limit = 500;
  let offset = 0;
  while (true) {
    const batch = await engine.listPages({ limit, offset });
    if (batch.length === 0) break;
    for (const page of batch) {
      if (!page.slug.startsWith(prefix)) continue;
      if (currentSlugs.has(page.slug)) continue;
      staleSlugs.push(page.slug);
    }
    if (batch.length < limit) break;
    offset += limit;
  }

  for (const slug of staleSlugs) {
    await engine.deletePage(slug);
  }
  return staleSlugs;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function validateSyncTargetOptions(opts: SyncOpts): void {
  if (opts.repoPath && (opts.subbrain || opts.allSubbrains)) {
    throw new Error('Cannot combine --repo with --subbrain or --all-subbrains');
  }
  if (opts.subbrain && opts.allSubbrains) {
    throw new Error('Cannot combine --subbrain with --all-subbrains');
  }
}

async function resolveSyncTarget(engine: BrainEngine, opts: SyncOpts): Promise<SyncTarget> {
  if (opts.subbrain) {
    const registry = await loadSubbrainRegistry(engine);
    const subbrain = registry.subbrains[opts.subbrain];
    if (!subbrain) {
      throw new Error(`Unknown sub-brain: ${opts.subbrain}`);
    }
    return subbrainSyncTarget(subbrain);
  }

  const repoPath = opts.repoPath || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    throw new Error('No repo path specified. Use --repo or run mbrain init with --repo first.');
  }
  return { id: null, repoPath, legacy: true };
}

async function performAllSubbrainSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  const registry = await loadSubbrainRegistry(engine);
  const subbrains = Object.values(registry.subbrains).sort((a, b) => a.id.localeCompare(b.id));
  if (subbrains.length === 0) {
    throw new Error('No sub-brains registered. Run: mbrain subbrain add <id> <path>.');
  }

  const results: Array<{ id: string; result: SyncResult }> = [];
  const failures: Array<{ id: string; message: string }> = [];
  for (const subbrain of subbrains) {
    try {
      results.push({ id: subbrain.id, result: await performSyncTarget(engine, opts, subbrainSyncTarget(subbrain)) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: subbrain.id, message });
      console.error(`Sub-brain sync failed for ${subbrain.id}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Sub-brain sync failed for ${failures.map(f => f.id).join(', ')}; checkpoint was not advanced for failed sub-brain(s).`);
  }

  return aggregateSyncResults(results, opts);
}

function subbrainSyncTarget(subbrain: SubbrainConfig): SyncTarget {
  return {
    id: subbrain.id,
    repoPath: subbrain.path,
    slugPrefix: subbrain.prefix,
    legacy: false,
  };
}

function lastCommitKey(target: SyncTarget): string {
  return target.legacy ? 'sync.last_commit' : `sync.subbrains.${target.id}.last_commit`;
}

function lastRunKey(target: SyncTarget): string {
  return target.legacy ? 'sync.last_run' : `sync.subbrains.${target.id}.last_run`;
}

function aggregateSyncResults(results: Array<{ id: string; result: SyncResult }>, opts: SyncOpts): SyncResult {
  const targetSummaries = results.map(({ id, result }) => ({
    id,
    status: result.status,
    fromCommit: result.fromCommit,
    toCommit: result.toCommit,
    added: result.added,
    modified: result.modified,
    deleted: result.deleted,
    renamed: result.renamed,
    chunksCreated: result.chunksCreated,
    pagesAffected: result.pagesAffected,
  }));
  const childResults = results.map(({ result }) => result);
  return {
    status: opts.dryRun
      ? 'dry_run'
      : targetSummaries.every(target => target.status === 'up_to_date')
        ? 'up_to_date'
        : 'synced',
    fromCommit: null,
    toCommit: childResults.map(r => r.toCommit.slice(0, 8)).join(','),
    added: childResults.reduce((sum, r) => sum + r.added, 0),
    modified: childResults.reduce((sum, r) => sum + r.modified, 0),
    deleted: childResults.reduce((sum, r) => sum + r.deleted, 0),
    renamed: childResults.reduce((sum, r) => sum + r.renamed, 0),
    chunksCreated: childResults.reduce((sum, r) => sum + r.chunksCreated, 0),
    pagesAffected: childResults.flatMap(r => r.pagesAffected),
    targets: targetSummaries,
  };
}

export async function runSync(engine: BrainEngine, args: string[]) {
  const repoPath = args.find((a, i) => args[i - 1] === '--repo') || undefined;
  const subbrain = args.find((a, i) => args[i - 1] === '--subbrain') || undefined;
  const allSubbrains = args.includes('--all-subbrains');
  const watch = args.includes('--watch');
  const intervalStr = args.find((a, i) => args[i - 1] === '--interval');
  const interval = intervalStr ? parseInt(intervalStr, 10) : 60;
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const noPull = args.includes('--no-pull');
  const noEmbed = args.includes('--no-embed');

  const opts: SyncOpts = { repoPath, subbrain, allSubbrains, dryRun, full, noPull, noEmbed };

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
