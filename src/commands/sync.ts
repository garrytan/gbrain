import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import { readFileSync, statSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import {
  buildSyncManifest,
  isSyncable,
  resolveSlugForPath,
  recordSyncFailures,
  unacknowledgedSyncFailures,
  acknowledgeSyncFailures,
} from '../core/sync.ts';
import { estimateTokens, CHUNKER_VERSION } from '../core/chunkers/code.ts';
import { EMBEDDING_MODEL, estimateEmbeddingCostUsd } from '../core/embedding.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import type { SyncManifest } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface SyncResult {
  status: 'up_to_date' | 'synced' | 'first_sync' | 'dry_run' | 'blocked_by_failures';
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  chunksCreated: number;
  /** Pages re-embedded during this sync's auto-embed step. 0 if --no-embed or skipped. */
  embedded: number;
  pagesAffected: string[];
  failedFiles?: number; // count of parse failures (Bug 9)
}

/**
 * v0.20.0 Cathedral II Layer 8 (D1) — walk each source's working tree and
 * sum tokens for every syncable file. This is a conservative overestimate
 * (full file content, not just the incremental diff) because `sync --all`
 * on a source that hasn't been synced yet WILL embed every file in the
 * working tree. For already-synced sources with only incremental changes,
 * the overestimate is the ceiling, not the floor — users never get
 * surprised by MORE cost than the preview claims. The false-high bias is
 * intentional: a lower estimate that undersells the real bill would be
 * worse than one that oversells.
 */
function estimateSyncAllCost(sources: Array<{ local_path: string | null; config: Record<string, unknown> }>): {
  totalTokens: number;
  totalFiles: number;
  activeSources: number;
  perSource: Array<{ path: string; tokens: number; files: number }>;
} {
  let totalTokens = 0;
  let totalFiles = 0;
  let activeSources = 0;
  const perSource: Array<{ path: string; tokens: number; files: number }> = [];

  for (const src of sources) {
    if (!src.local_path) continue;
    const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
    if (cfg.syncEnabled === false) continue;
    activeSources++;
    let sourceTokens = 0;
    let sourceFiles = 0;
    try {
      walkSyncableFiles(src.local_path, (filePath: string, content: string) => {
        sourceTokens += estimateTokens(content);
        sourceFiles++;
      }, cfg.strategy ?? 'markdown');
    } catch {
      // Best-effort: a source whose local_path is gone or unreadable just
      // contributes 0. The sync itself would have failed anyway; no point
      // blocking the preview on a pre-existing fault.
    }
    totalTokens += sourceTokens;
    totalFiles += sourceFiles;
    perSource.push({ path: src.local_path, tokens: sourceTokens, files: sourceFiles });
  }

  return { totalTokens, totalFiles, activeSources, perSource };
}

/**
 * Walk a repo's working tree and invoke `cb(path, content)` for each
 * syncable file. Honors the same strategy as `isSyncable` so the preview
 * and the real sync agree on what's in scope.
 */
function walkSyncableFiles(
  repoRoot: string,
  cb: (path: string, content: string) => void,
  strategy: 'markdown' | 'code' | 'auto',
): void {
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      // Skip hidden dirs, .git, node_modules (same rules isSyncable applies).
      if (name.startsWith('.') || name === 'node_modules' || name === 'ops') continue;
      const fullPath = `${dir}/${name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const relativePath = fullPath.slice(repoRoot.length + 1);
        if (!isSyncable(relativePath, { strategy })) continue;
        try {
          const stat = statSync(fullPath);
          if (stat.size > 5_000_000) continue; // skip large binaries
          const content = readFileSync(fullPath, 'utf-8');
          cb(fullPath, content);
        } catch {
          // Ignore files we can't read; consistent with sync's own tolerance.
        }
      }
    }
  }
}

/** Interactive [y/N] prompt. Resolves false on non-y answers or EOF. */
async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
    rl.on('close', () => resolve(false));
  });
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
  /**
   * v0.18.0 Step 5 — sync a specific named source. When set, sync reads
   * local_path + last_commit from the sources table (not the global
   * config.sync.* keys) and writes last_commit + last_sync_at back to
   * the same row. Backward compat: when undefined, sync uses the
   * pre-v0.17 global-config path unchanged.
   */
  sourceId?: string;
  /** Multi-repo: sync strategy override (markdown, code, auto). */
  strategy?: 'markdown' | 'code' | 'auto';
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

// v0.18.0 Step 5: source-scoped sync state helpers. When opts.sourceId
// is set, read/write the per-source row instead of the global config
// keys. These wrappers centralize the branch so every read/write site
// picks the right storage — future Step 5 work (failure-tracking per
// source) hooks here too.
async function readSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
): Promise<string | null> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    const rows = await engine.executeRaw<Record<string, string | null>>(
      `SELECT ${col} AS value FROM sources WHERE id = $1`,
      [sourceId],
    );
    return rows[0]?.value ?? null;
  }
  return await engine.getConfig(`sync.${which}`);
}

async function writeSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
  value: string,
): Promise<void> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    // last_sync_at bookmarked on every last_commit advance.
    if (which === 'last_commit') {
      await engine.executeRaw(
        `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
        [value, sourceId],
      );
    } else {
      await engine.executeRaw(
        `UPDATE sources SET ${col} = $1 WHERE id = $2`,
        [value, sourceId],
      );
    }
    return;
  }
  await engine.setConfig(`sync.${which}`, value);
}

/**
 * v0.20.0 Cathedral II Layer 12 (SP-1 fix) — read/write the chunker version
 * last used to sync a given source. When it mismatches CURRENT_CHUNKER_VERSION,
 * `performSync` forces a full walk regardless of git HEAD equality. Without
 * this gate, bumping CHUNKER_VERSION does NOTHING on an unchanged repo
 * because sync short-circuits at `up_to_date` before reaching
 * `importCodeFile`'s content_hash check.
 *
 * Per-source storage matches writeSyncAnchor's shape — sources.chunker_version
 * TEXT column from the v27 migration. No global fallback: non-source syncs
 * (pre-v0.17 brains with no sources table) never had CHUNKER_VERSION
 * version-gating, so they keep the v0.19.0 behavior.
 */
async function readChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<string | null> {
  if (!sourceId) return null;
  const rows = await engine.executeRaw<{ chunker_version: string | null }>(
    `SELECT chunker_version FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.chunker_version ?? null;
}

async function writeChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
  version: string,
): Promise<void> {
  if (!sourceId) return;
  await engine.executeRaw(
    `UPDATE sources SET chunker_version = $1 WHERE id = $2`,
    [version, sourceId],
  );
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // Resolve repo path
  const repoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!repoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
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

  // Read sync state (source-scoped when sourceId is set, global otherwise)
  const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

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

  // v0.20.0 Cathedral II Layer 12 (codex SP-1 fix): before returning
  // 'up_to_date' on git-HEAD equality, check the chunker version gate.
  // If sources.chunker_version mismatches CURRENT_CHUNKER_VERSION, force
  // a full re-walk so existing chunks get re-chunked under the new
  // pipeline (qualified symbol names, parent scope, doc-comment column
  // population, etc.). Without this, upgraded brains silently stay on
  // the old chunks — the whole reason we bumped the version.
  const storedVersion = await readChunkerVersion(engine, opts.sourceId);
  const currentVersion = String(CHUNKER_VERSION);
  const versionMismatch = storedVersion !== null && storedVersion !== currentVersion;
  const versionNeverSet = storedVersion === null && opts.sourceId !== undefined;

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet) {
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    console.log(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    const result = await performFullSync(engine, repoPath, headCommit, opts);
    await writeChunkerVersion(engine, opts.sourceId, currentVersion);
    return result;
  }

  // Diff using git diff (net result, not per-commit)
  const diffOutput = git(repoPath, 'diff', '--name-status', '-M', `${lastCommit}..${headCommit}`);
  const manifest = buildSyncManifest(diffOutput);

  // Filter to syncable files (strategy-aware)
  const syncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => isSyncable(p, syncOpts)),
    modified: manifest.modified.filter(p => isSyncable(p, syncOpts)),
    deleted: manifest.deleted.filter(p => isSyncable(p, syncOpts)),
    renamed: manifest.renamed.filter(r => isSyncable(r.to, syncOpts)),
  };

  // Delete pages that became un-syncable (modified but filtered out).
  // v0.20.0 Cathedral II SP-5: resolveSlugForPath picks the right slug shape
  // (markdown vs code) based on the chunker's classifier, so a Rust file that
  // became un-syncable (e.g., moved under `.gitignore` or filtered by
  // strategy=markdown) deletes the actual code-slug page, not a ghost
  // markdown-slug that never existed.
  const unsyncableModified = manifest.modified.filter(p => !isSyncable(p, syncOpts));
  for (const path of unsyncableModified) {
    const slug = resolveSlugForPath(path);
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
      embedded: 0,
      pagesAffected: [],
    };
  }

  if (totalChanges === 0) {
    // Update sync state even with no syncable changes (git advanced)
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
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

  // Per-file progress on stderr so agents see each step of a big sync.
  // Phases: sync.deletes, sync.renames, sync.imports.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Process deletes first (prevents slug conflicts). SP-5: resolveSlugForPath
  // dispatches to the right slug shape so code file deletes hit the real page.
  if (filtered.deleted.length > 0) {
    progress.start('sync.deletes', filtered.deleted.length);
    for (const path of filtered.deleted) {
      const slug = resolveSlugForPath(path);
      await engine.deletePage(slug);
      pagesAffected.push(slug);
      progress.tick(1, slug);
    }
    progress.finish();
  }

  // Process renames (updateSlug preserves page_id, chunks, embeddings).
  // SP-5: both old and new slugs use resolveSlugForPath so a .ts → .ts
  // rename (code→code), .md → .md (markdown→markdown), or cross-kind rename
  // all resolve to the right slug shape for each side.
  if (filtered.renamed.length > 0) {
    progress.start('sync.renames', filtered.renamed.length);
    for (const { from, to } of filtered.renamed) {
      const oldSlug = resolveSlugForPath(from);
      const newSlug = resolveSlugForPath(to);
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
      progress.tick(1, newSlug);
    }
    progress.finish();
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
  //
  // v0.15.2: per-file progress on stderr via the shared reporter.
  // Bug 9: per-file failures captured in `failedFiles` so the caller can
  // gate `sync.last_commit` advancement and record recoverable errors.
  const failedFiles: Array<{ path: string; error: string; line?: number }> = [];
  const addsAndMods = [...filtered.added, ...filtered.modified];
  if (addsAndMods.length > 0) {
    progress.start('sync.imports', addsAndMods.length);
    for (const path of addsAndMods) {
      const filePath = join(repoPath, path);
      if (!existsSync(filePath)) {
        progress.tick(1, `skip:${path}`);
        continue;
      }
      try {
        const result = await importFile(engine, filePath, path, { noEmbed });
        if (result.status === 'imported') {
          chunksCreated += result.chunks;
          pagesAffected.push(result.slug);
        } else if (result.status === 'skipped' && (result as any).error) {
          // importFile returned a non-throw skip with a reason.
          failedFiles.push({ path, error: String((result as any).error) });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  Warning: skipped ${path}: ${msg}`);
        failedFiles.push({ path, error: msg });
      }
      progress.tick(1, path);
    }
    progress.finish();
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
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: lastCommit,
        toCommit: headCommit,
        added: filtered.added.length,
        modified: filtered.modified.length,
        deleted: filtered.deleted.length,
        renamed: filtered.renamed.length,
        chunksCreated,
        embedded: 0,
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

  // Update sync state AFTER all changes succeed (source-scoped when
  // opts.sourceId is set, global config otherwise).
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist the chunker version we just
  // finished with so the next sync's up_to_date gate respects it. Only
  // source-scoped syncs track this (see readChunkerVersion for rationale).
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));

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
  let embedded = 0;
  if (!noEmbed && pagesAffected.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--slugs', ...pagesAffected]);
      // Before commit 2 lands: runEmbed is void. Best estimate is pagesAffected,
      // since runEmbed re-embeds every requested slug. Commit 2 sharpens this
      // with EmbedResult.embedded.
      embedded = pagesAffected.length;
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
    embedded,
    pagesAffected,
  };
}

async function performFullSync(
  engine: BrainEngine,
  repoPath: string,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  // Dry-run: walk the repo, count syncable files, return without writing.
  // Fixes the silent-write-on-dry-run bug where performFullSync called
  // runImport unconditionally regardless of opts.dryRun.
  if (opts.dryRun) {
    const { collectMarkdownFiles } = await import('./import.ts');
    const allFiles = collectMarkdownFiles(repoPath);
    const syncableRelPaths = allFiles
      .map(abs => relative(repoPath, abs))
      .filter(rel => isSyncable(rel));
    console.log(
      `Full-sync dry run: ${syncableRelPaths.length} file(s) would be imported ` +
      `from ${repoPath} @ ${headCommit.slice(0, 8)}.`,
    );
    return {
      status: 'dry_run',
      fromCommit: null,
      toCommit: headCommit,
      added: syncableRelPaths.length,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

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
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: null,
        toCommit: headCommit,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        chunksCreated: result.chunksCreated,
        embedded: 0,
        pagesAffected: [],
        failedFiles: result.failures.length,
      };
    }
    const acked = acknowledgeSyncFailures();
    if (acked > 0) console.error(`  Acknowledged ${acked} failure(s) and advancing past them.`);
  }

  // Persist sync state so next sync is incremental (C1 fix: was missing).
  // v0.18.0 Step 5: routed through writeSyncAnchor so --source pins it
  // to the right sources row rather than the global config.
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit);
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist chunker version for the gate.
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));

  // Full sync doesn't track pagesAffected, so fall back to embed --stale.
  // Before commit 2: runEmbed is void; use result.imported as best estimate of
  // pages touched. Commit 2 sharpens this with real EmbedResult counts.
  let embedded = 0;
  if (!opts.noEmbed) {
    try {
      const { runEmbed } = await import('./embed.ts');
      await runEmbed(engine, ['--stale']);
      embedded = result.imported;
    } catch { /* embedding is best-effort */ }
  }

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: result.imported,
    modified: 0,
    deleted: 0,
    renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded,
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
  const syncAll = args.includes('--all');
  const jsonOut = args.includes('--json');
  const yesFlag = args.includes('--yes');
  const strategyArg = args.find((a, i) => args[i - 1] === '--strategy') as SyncOpts['strategy'] | undefined;

  // v0.18.0 Step 5: --source resolves to a sources(id) row. Falls back
  // to pre-v0.17 global config (sync.repo_path + sync.last_commit) when
  // no flag, no env, no dotfile is present.
  const explicitSource = args.find((a, i) => args[i - 1] === '--source') || null;
  let sourceId: string | undefined = undefined;
  if (explicitSource || process.env.GBRAIN_SOURCE) {
    const { resolveSourceId } = await import('../core/source-resolver.ts');
    sourceId = await resolveSourceId(engine, explicitSource);
  }

  // v0.19.0 — `sync --all` iterates all registered sources with a
  // local_path. Sources are the canonical v0.18.0 abstraction: per-source
  // last_commit, last_sync_at, config.federated flags. Per-source
  // bookmarks live in the sources table (not ~/.gbrain/config.json),
  // which is why this path replaced Wintermute's `multi-repo.ts` shim.
  //
  // Only sources with a non-null local_path participate. A GitHub-only
  // source (no checkout) has nothing for `sync` to pull. Sources with
  // syncEnabled=false in config.jsonb are skipped too.
  if (syncAll) {
    const sources = await engine.executeRaw<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }>(
      `SELECT id, name, local_path, config FROM sources WHERE local_path IS NOT NULL`,
    );
    if (!sources || sources.length === 0) {
      console.log('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
      return;
    }

    // v0.20.0 Cathedral II Layer 8 D1 — cost preview + ConfirmationRequired
    // gate. Before kicking off a multi-source sync that may embed tens of
    // thousands of chunks (real money), walk the sync-diff set(s), sum
    // tokens, compute USD estimate, and gate:
    //   - TTY + !json + !yes → interactive [y/N] prompt
    //   - non-TTY OR --json OR piped → emit ConfirmationRequired envelope,
    //     exit 2 (reserve 1 for runtime errors)
    //   - --yes → skip prompt entirely
    //   - --dry-run → preview + exit 0
    // Skipped entirely when --no-embed is set (user already opted out of
    // the cost and will run `embed --stale` later).
    if (!noEmbed) {
      const preview = estimateSyncAllCost(sources);
      const costUsd = estimateEmbeddingCostUsd(preview.totalTokens);
      const previewMsg =
        `sync --all preview: ${preview.totalFiles} files across ${preview.activeSources} source(s), ` +
        `~${preview.totalTokens.toLocaleString()} tokens, est. $${costUsd.toFixed(2)} on ${EMBEDDING_MODEL}.`;

      if (dryRun) {
        if (jsonOut) {
          console.log(JSON.stringify({ status: 'dry_run', preview, costUsd, model: EMBEDDING_MODEL }));
        } else {
          console.log(previewMsg);
          console.log('--dry-run: exit without syncing.');
        }
        return;
      }

      if (!yesFlag) {
        const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
        if (!isTTY || jsonOut) {
          // Agent-facing path: emit structured envelope, exit 2.
          const envelope = serializeError(errorFor({
            class: 'ConfirmationRequired',
            code: 'cost_preview_requires_yes',
            message: previewMsg,
            hint: 'Pass --yes to proceed, or --dry-run to see the preview and exit 0.',
          }));
          console.log(JSON.stringify({ error: envelope, preview, costUsd, model: EMBEDDING_MODEL }));
          process.exit(2);
        }
        // Interactive TTY path: prompt [y/N].
        console.log(previewMsg);
        const answer = await promptYesNo('Proceed? [y/N] ');
        if (!answer) {
          console.log('Cancelled.');
          return;
        }
      }
    }

    for (const src of sources) {
      const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
      if (cfg.syncEnabled === false) {
        console.log(`Skipping disabled source: ${src.name}`);
        continue;
      }
      console.log(`\n--- Syncing source: ${src.name} ---`);
      const repoOpts: SyncOpts = {
        repoPath: src.local_path!,
        dryRun, full, noPull, noEmbed, skipFailed, retryFailed,
        sourceId: src.id,
        strategy: cfg.strategy,
      };
      try {
        const result = await performSync(engine, repoOpts);
        printSyncResult(result);
      } catch (e: unknown) {
        console.error(`Error syncing ${src.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return;
  }

  const opts: SyncOpts = { repoPath, dryRun, full, noPull, noEmbed, skipFailed, retryFailed, sourceId, strategy: strategyArg };

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
      console.log(`  ${result.chunksCreated} chunks created${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'first_sync':
      console.log(`First sync complete. Checkpoint: ${result.toCommit.slice(0, 8)}`);
      console.log(`  ${result.added} file(s) imported, ${result.chunksCreated} chunks${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
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
