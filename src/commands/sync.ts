import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import {
  buildSyncManifest,
  isSyncable,
  pathToSlug,
  recordSyncFailures,
  unacknowledgedSyncFailures,
  acknowledgeSyncFailures,
} from '../core/sync.ts';
import type { SyncManifest } from '../core/sync.ts';

export interface SyncResult {
  status: 'up_to_date' | 'synced' | 'first_sync' | 'dry_run' | 'blocked_by_failures';
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  chunksCreated: number;
  pagesAffected: string[];
  failedFiles?: number; // count of parse failures (Bug 9)
}

export interface SyncOpts {
  repoPath?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
  noExtract?: boolean;
  /** Bug 9 — acknowledge + skip past current failure set (CLI --skip-failed). */
  skipFailed?: boolean;
  /** Bug 9 — re-attempt unacknowledged failures explicitly (CLI --retry-failed). */
  retryFailed?: boolean;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // Resolve repo path
  const repoPath = opts.repoPath || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    throw new Error('No repo path specified. Use --repo or run gbrain init with --repo first.');
  }

  // Validate git repo
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}. GBrain sync requires a git-initialized repo.`);
  }

  // Git pull (unless --no-pull)
  if (!opts.noPull) {
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

  // Filter to syncable files
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => isSyncable(p)),
    modified: manifest.modified.filter(p => isSyncable(p)),
    deleted: manifest.deleted.filter(p => isSyncable(p)),
    renamed: manifest.renamed.filter(r => isSyncable(r.to)),
  };

  // Delete pages that became un-syncable (modified but filtered out)
  const unsyncableModified = manifest.modified.filter(p => !isSyncable(p));
  for (const path of unsyncableModified) {
    const slug = pathToSlug(path);
    try {
      const existing = await engine.getPage(slug);
      if (existing) {
        await engine.deletePage(slug);
        console.log(`  Deleted un-syncable page: ${slug}`);
      }
    } catch { /* ignore */ }
  }

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
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      pagesAffected: [],
    };
  }

  const noEmbed = opts.noEmbed || totalChanges > 100;
  if (totalChanges > 100) {
    console.log(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  const pagesAffected: string[] = [];
  let chunksCreated = 0;
  const start = Date.now();

  // Process deletes first (prevents slug conflicts)
  for (const path of filtered.deleted) {
    const slug = pathToSlug(path);
    await engine.deletePage(slug);
    pagesAffected.push(slug);
  }

  // Process renames (updateSlug preserves page_id, chunks, embeddings)
  for (const { from, to } of filtered.renamed) {
    const oldSlug = pathToSlug(from);
    const newSlug = pathToSlug(to);
    try {
      await engine.updateSlug(oldSlug, newSlug);
    } catch {
      // Slug doesn't exist or collision, treat as add
    }
    // Reimport at new path (picks up content changes)
    const filePath = join(repoPath, to);
    if (existsSync(filePath)) {
      const result = await importFile(engine, filePath, to, { noEmbed });
      if (result.status === 'imported') chunksCreated += result.chunks;
    }
    pagesAffected.push(newSlug);
  }

  // Process adds and modifies.
  //
  // NOTE: do NOT wrap this loop in engine.transaction(). importFromContent
  // already opens its own inner transaction per file, and PGLite transactions
  // are not reentrant — they acquire the same _runExclusiveTransaction mutex,
  // so a nested call from inside a user callback queues forever on the mutex
  // the outer transaction is still holding. Result: incremental sync hangs in
  // ep_poll whenever the diff crosses the old > 10 threshold that used to
  // trigger the outer wrap. Per-file atomicity is also the right granularity:
  // one file's failure should not roll back the others' successful imports.
  const failedFiles: Array<{ path: string; error: string; line?: number }> = [];
  for (const path of [...filtered.added, ...filtered.modified]) {
    const filePath = join(repoPath, path);
    if (!existsSync(filePath)) continue;
    try {
      const result = await importFile(engine, filePath, path, { noEmbed });
      if (result.status === 'imported') {
        chunksCreated += result.chunks;
        pagesAffected.push(result.slug);
      } else if (result.status === 'skipped' && (result as any).error) {
        // importFile returned a non-throw skip with a reason
        failedFiles.push({ path, error: String((result as any).error) });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  Warning: skipped ${path}: ${msg}`);
      failedFiles.push({ path, error: msg });
    }
  }

  const elapsed = Date.now() - start;

  // Bug 9 — gate the sync bookmark on success. If any per-file parse
  // failed, record it to ~/.gbrain/sync-failures.jsonl and DO NOT advance
  // sync.last_commit. The next sync re-walks the same diff and re-attempts
  // the failed files. Escape hatches: --skip-failed acknowledges the
  // current set, --retry-failed re-parses before running the normal sync.
  if (failedFiles.length > 0) {
    recordSyncFailures(failedFiles, headCommit);
    if (!opts.skipFailed) {
      console.error(
        `\nSync blocked: ${failedFiles.length} file(s) failed to parse. ` +
        `Fix the YAML frontmatter in the files above and re-run, or use ` +
        `'gbrain sync --skip-failed' to acknowledge and move on.`,
      );
      // Update last_run + repo_path (progress on infra) but NOT last_commit.
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: lastCommit,
        toCommit: headCommit,
        added: filtered.added.length,
        modified: filtered.modified.length,
        deleted: filtered.deleted.length,
        renamed: filtered.renamed.length,
        chunksCreated,
        pagesAffected,
        failedFiles: failedFiles.length,
      };
    }
    // --skip-failed: acknowledge the now-recorded set and proceed.
    const acked = acknowledgeSyncFailures();
    if (acked > 0) {
      console.error(`  Acknowledged ${acked} failure(s) and advancing past them.`);
    }
  }

  // Update sync state AFTER all changes succeed
  await engine.setConfig('sync.last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await engine.setConfig('sync.repo_path', repoPath);

  // Log ingest
  await engine.logIngest({
    source_type: 'git_sync',
    source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
    pages_updated: pagesAffected,
    summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${chunksCreated} chunks, ${elapsed}ms`,
  });

  // Auto-extract links + timeline (always, extraction is cheap CPU)
  if (!opts.noExtract && pagesAffected.length > 0) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs } = await import('./extract.ts');
      const linksCreated = await extractLinksForSlugs(engine, repoPath, pagesAffected);
      const timelineCreated = await extractTimelineForSlugs(engine, repoPath, pagesAffected);
      if (linksCreated > 0 || timelineCreated > 0) {
        console.log(`  Extracted: ${linksCreated} links, ${timelineCreated} timeline entries`);
      }
    } catch { /* extraction is best-effort */ }
  }

  // Auto-embed (skip for large syncs — embedding calls OpenAI)
  if (!noEmbed && pagesAffected.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--slugs', ...pagesAffected]);
    } catch { /* embedding is best-effort */ }
  } else if (noEmbed || totalChanges > 100) {
    console.log(`Text imported. Run 'gbrain embed --stale' to generate embeddings.`);
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

async function performFullSync(
  engine: BrainEngine,
  repoPath: string,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  console.log(`Running full import of ${repoPath}...`);
  const { runImport } = await import('./import.ts');
  const importArgs = [repoPath];
  if (opts.noEmbed) importArgs.push('--no-embed');
  const result = await runImport(engine, importArgs, { commit: headCommit });

  // Bug 9 — gate the full-sync bookmark on success. runImport already
  // writes its own sync.last_commit conditionally (import.ts), but
  // performFullSync is called on first-sync + force-full paths where
  // the sync module owns the last_commit write. Respect the same gate.
  if (result.failures.length > 0) {
    recordSyncFailures(result.failures, headCommit);
    if (!opts.skipFailed) {
      console.error(
        `\nFull sync blocked: ${result.failures.length} file(s) failed. ` +
        `Fix the YAML in those files and re-run, or use '--skip-failed'.`,
      );
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: null,
        toCommit: headCommit,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        chunksCreated: result.chunksCreated,
        pagesAffected: [],
        failedFiles: result.failures.length,
      };
    }
    const acked = acknowledgeSyncFailures();
    if (acked > 0) console.error(`  Acknowledged ${acked} failure(s) and advancing past them.`);
  }

  // Persist sync state so next sync is incremental (C1 fix: was missing)
  await engine.setConfig('sync.last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await engine.setConfig('sync.repo_path', repoPath);

  // Full sync doesn't track pagesAffected, so fall back to embed --stale
  if (!opts.noEmbed) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--stale']);
    } catch { /* embedding is best-effort */ }
  }

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: 0, modified: 0, deleted: 0, renamed: 0,
    chunksCreated: 0,
    pagesAffected: [],
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
  const skipFailed = args.includes('--skip-failed');
  const retryFailed = args.includes('--retry-failed');

  const opts: SyncOpts = { repoPath, dryRun, full, noPull, noEmbed, skipFailed, retryFailed };

  // Bug 9 — --retry-failed: before running normal sync, clear acknowledgment
  // flags so the sync picks them up as fresh work. The actual re-attempt
  // happens inside the regular incremental/full loop because once the commit
  // pointer is behind the failures, the diff naturally revisits them.
  if (retryFailed) {
    const failures = unacknowledgedSyncFailures();
    if (failures.length === 0) {
      console.log('No unacknowledged sync failures to retry.');
    } else {
      console.log(`Retrying ${failures.length} previously-failed file(s)...`);
      // Don't acknowledge them yet — they must succeed to clear.
    }
  }

  if (!watch) {
    const result = await performSync(engine, opts);
    printSyncResult(result);
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

function printSyncResult(result: SyncResult) {
  switch (result.status) {
    case 'up_to_date':
      console.log('Already up to date.');
      break;
    case 'synced':
      console.log(`Synced ${result.fromCommit?.slice(0, 8)}..${result.toCommit.slice(0, 8)}:`);
      console.log(`  +${result.added} added, ~${result.modified} modified, -${result.deleted} deleted, R${result.renamed} renamed`);
      console.log(`  ${result.chunksCreated} chunks created`);
      break;
    case 'first_sync':
      console.log(`First sync complete. Checkpoint: ${result.toCommit.slice(0, 8)}`);
      break;
    case 'dry_run':
      break; // already printed in performSync
    case 'blocked_by_failures':
      console.log(`Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed to parse.`);
      console.log(`  See ~/.gbrain/sync-failures.jsonl for details, or run 'gbrain doctor'.`);
      console.log(`  Fix the files then re-run 'gbrain sync', or 'gbrain sync --skip-failed' to move on.`);
      break;
  }
}
