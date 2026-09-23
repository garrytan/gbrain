/** Full-tree sync: `performFullSync` (first sync, fallbacks, --full). */
import { assertSourceFilesystemActive } from '../../core/minions/source-filesystem.ts';
import { currentJobSignal } from '../../core/minions/submission-authority.ts';
import { currentCompanyBrainSync, softDeleteSyncPages } from '../../core/company-brain/profile.ts';
import { relative } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../../core/engine-constants.ts';
import { collectSyncableFiles } from '../import.ts';
import {
  isSyncable,
  isPoisonedPath,
  sanitizePathForDisplay,
  unsyncableReason,
  matchesAnyGlob,
  loadSyncFailures,
  formatCodeBreakdown,
  formatFailedFileList,
  applySyncFailureGate,
  isSkippablePath,
  resolveAutoSkipThreshold,
  summarizeFailuresByCode,
  isEmbeddingInfraCode,
  DEFAULT_SOURCE_ID,
  RENAME_SENTINEL_PREFIX,
  resolveSlugForPath,
} from '../../core/sync.ts';
import { retireSupersededTwins } from '../../core/sync-twins.ts';
import { trackedSlugIndex } from './rename-reconcile.ts';
import { CHUNKER_VERSION } from '../../core/chunkers/code.ts';
import { autoConcurrency } from '../../core/sync-concurrency.ts';
import { slog, serr } from '../../core/console-prefix.ts';
import { newestCommitMs } from '../../core/source-health.ts';
import { gitRelativePath } from '../../core/sync-git.ts';
import {
  readSyncAnchor,
  writeSyncAnchor,
  writeChunkerVersion,
  type SlugRootMode,
} from '../../core/sync-anchor.ts';
import { buildPartialResult } from '../../core/sync-lock.ts';
import {
  MASS_RECONCILE_RATIO,
  planReconcileDeletes,
  listEverCommittedPaths,
  massReconcileAllowed,
} from '../../core/sync-reconcile.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import { heldRenameOrigins, holdRefusedImport, moveHeldRenames, noteScreenedImport, settleFullSyncHolds, wouldHoldFields, type LegacyHolds } from './holds.ts';
import { sweepOrphanedRenameSentinels } from './rename-reconcile.ts';

export async function performFullSync(
  engine: BrainEngine,
  // #753/#774: the three roots resolved once at the top of performSyncInner.
  //   gitContextRoot — git repo root (git ops, slug base for scoped syncs)
  //   syncScopeRoot  — where files are walked/imported (== gitContextRoot
  //                    when no subpath scope is active)
  //   anchorPath     — what gets written back to sync.repo_path/local_path
  //   slugRootMode   — #4342 sticky namespace anchor (git-root|source-root)
  roots: { gitContextRoot: string; syncScopeRoot: string; anchorPath: string; slugRootMode: SlugRootMode },
  headCommit: string,
  opts: SyncOpts,
  holds: LegacyHolds | null = null,
): Promise<SyncResult> {
  const { gitContextRoot, syncScopeRoot, anchorPath, slugRootMode } = roots;
  const company = currentCompanyBrainSync(opts.sourceId);
  // Scoped 'git-root' sync → slugs/source_path are git-root-relative (matches
  // the incremental path's git-diff paths). Unscoped OR pinned 'source-root'
  // (#4342) → undefined (dir-relative — local_path IS the slug base).
  const slugRoot =
    syncScopeRoot !== gitContextRoot && slugRootMode === 'git-root' ? gitContextRoot : undefined;
  // Dry-run: walk the scope, count syncable files, return without writing.
  // Fixes the silent-write-on-dry-run bug where performFullSync called
  // runImport unconditionally regardless of opts.dryRun.
  //
  // v0.31.2 (codex C6): use the strategy-aware walker. Pre-fix this
  // hardcoded `collectMarkdownFiles(repoPath)` and filtered with
  // default-markdown `isSyncable(rel)`, so `gbrain sync --strategy
  // code --dry-run` always reported zero files even when ~1500 code
  // files were waiting.
  // #5988: paths are relative to the slug base, the same keys holds and the ledger use.
  const holdRoot = slugRoot ?? syncScopeRoot;
  if (opts.dryRun) return fullSyncDryRun(engine, syncScopeRoot, headCommit, opts, { holds, holdRoot });

  // v0.22.13 (PR #490 A1 + Q5): full sync is always "large" by definition
  // (entire working tree). Auto-concurrency fires unconditionally for Postgres;
  // PGLite stays serial because its engine is single-connection. Routes the
  // policy through autoConcurrency() so it stays consistent with incremental
  // sync and the jobs handler.
  const FULL_SYNC_LARGE_MARKER = Number.MAX_SAFE_INTEGER;
  const fullConcurrency = autoConcurrency(engine, FULL_SYNC_LARGE_MARKER, opts.concurrency);
  slog(`Running full import of ${syncScopeRoot}${fullConcurrency > 1 ? ` (${fullConcurrency} workers)` : ''}...`);
  const { runImport, ImportAbortError } = await import('../import.ts');
  const importArgs = [syncScopeRoot];
  if (opts.noEmbed) importArgs.push('--no-embed');
  if (opts.includeGitignored) importArgs.push('--include-gitignored');
  if (fullConcurrency > 1) importArgs.push('--workers', String(fullConcurrency));
  // v0.31.2: thread strategy through so code-strategy first sync
  // actually enumerates code files (closes bug 1).
  // v0.30.x: thread sourceId so performFullSync routes pages to the named
  // source (incremental path already does this).
  // #753/#774: thread exclude (--exclude CLI) + slugRoot (monorepo subdir).
  const _fullImportT0 = Date.now();
  serr(`[gbrain phase] sync.fullsync.import start strategy=${opts.strategy ?? 'markdown'}`);
  opts.onProgress?.({ phase: 'full_import' });
  await moveHeldRenames(engine, holds, holdRoot);
  let result: import('../import.ts').RunImportResult;
  try {
    result = await runImport(engine, importArgs, {
      signal: opts.signal,
      commit: headCommit,
      strategy: opts.strategy,
      sourceId: opts.sourceId,
      exclude: opts.exclude,
      includeHidden: opts.includeHidden,
      includeGitignored: opts.includeGitignored,
      slugRoot,
      // issue #1939: performFullSync owns the failure ledger + bookmark via the
      // shared gate below; don't let runImport double-record or write its own.
      managedBookmark: true,
      // #5988: a held rename destination whose old page changed is held, never imported as a new page.
      heldPaths: new Set(holds?.heldPaths),
      // #5988: content refusals are held, not failed (never gating the bookmark).
      onFileResult: async (path, filePath, fileResult) => {
        noteScreenedImport(holds, path, fileResult);
        return await holdRefusedImport(engine, holds, path, filePath, fileResult) ? 'held' : undefined;
      },
    });
    if (opts.signal?.aborted) throw new ImportAbortError('interrupted', 1, result);
  } catch (error) {
    assertSourceFilesystemActive(true);
    if (!(error instanceof ImportAbortError) || !error.partialResult || !opts.signal?.aborted || currentJobSignal()?.aborted) throw error;
    const partial = error.partialResult;
    return buildPartialResult({
      fromCommit: await readSyncAnchor(engine, opts.sourceId, 'last_commit'), toCommit: headCommit,
      filesImported: partial.imported, pagesAffected: [], chunksCreated: partial.chunksCreated,
      added: partial.imported, modified: 0, deleted: 0, renamed: 0, reason: 'timeout',
    });
  }
  serr(
    `[gbrain phase] sync.fullsync.import done ${Date.now() - _fullImportT0}ms ` +
    `imported=${result.imported} skipped=${result.skipped} errors=${result.errors}`,
  );

  // issue #1939 — gate the full-sync bookmark through the SAME shared ledger as
  // the incremental path (Codex #6: a wedge here on first/forced sync was
  // previously unreachable by the valve). A full re-import is authoritative for
  // the whole tree, so any previously-tracked failing path that ISN'T failing
  // now has been resolved → clear it (resets its auto-skip streak); current
  // failures still climb their attempts.
  const fullSourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const fullFailureSet = new Set(result.failures.map(f => f.path));
  if (holds?.existing.size || holds?.retryPaths.size) {
    const walked = new Set(collectSyncableFiles(syncScopeRoot, { strategy: opts.strategy ?? 'markdown', includeGitignored: opts.includeGitignored,
      includeHidden: opts.includeHidden }).map(abs => relative(holdRoot, abs)));
    await settleFullSyncHolds(engine, holds, { root: holdRoot, walked, failed: fullFailureSet });
  }
  const fullSucceeded = loadSyncFailures()
    .filter(e => e.source_id === fullSourceId && isSkippablePath(e.path) && !fullFailureSet.has(e.path))
    .map(e => e.path);
  const advanceFull = async (): Promise<void> => {
    // Persist sync state so the next sync is incremental. Routed through
    // writeSyncAnchor so --source pins the right sources row.
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit, newestCommitMs(gitContextRoot), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
  };

  const fullGate = await applySyncFailureGate({
    sourceId: fullSourceId,
    failedFiles: result.failures,
    succeededPaths: fullSucceeded,
    commit: headCommit,
    skipFailed: !company && opts.skipFailed === true,
    ...(company ? { threshold: 0 } : {}),
    advance: advanceFull,
  });
  // #3479 blocker 2 — the same orphaned-`<rename:…>`-sentinel self-heal the
  // incremental path applies (a full sync is often exactly the operator's
  // reset move after a wedge). AFTER and OUTSIDE the gate (#3583): a gate
  // that throws never clears anything, and the sweep carries the full
  // clear-then-verify-restore semantics.
  await sweepOrphanedRenameSentinels(engine, fullSourceId, fullFailureSet);
  if (!fullGate.advanced) return await reportBlockedFullSync(engine, opts, anchorPath, headCommit, result, fullGate);
  if (fullGate.acknowledged > 0) {
    serr(`  Acknowledged ${fullGate.acknowledged} failure(s) and advanced past them.`);
  }
  if (fullGate.autoSkipped.length > 0) {
    serr(
      `\n  Auto-skipped ${fullGate.autoSkipped.length} file(s) that failed >= ` +
      `${resolveAutoSkipThreshold()} consecutive syncs. These pages are NOT indexed; ` +
      `'gbrain doctor' will warn until they're fixed.`,
    );
  }

  const reconciledDeletes = await reconcileFullSyncDeletes(engine, opts, { company, gitContextRoot, syncScopeRoot, slugRoot });

  // #3479 blocker 2 — the post-gate sweep above ran BEFORE this reconcile,
  // so a `<rename:…>` sentinel whose stale row the reconcile just removed
  // would stay open until the NEXT run. Sweep again afterwards: a full sync
  // is the operator's usual reset move, and it should converge in one run.
  await sweepOrphanedRenameSentinels(engine, fullSourceId, fullFailureSet);

  // Full sync doesn't track pagesAffected, so fall back to embed --stale.
  // v0.37 fix wave (Lane D.3 + CDX2-8): switched to runEmbedCore for the
  // same reason as the incremental path — surface dim-mismatch via hint
  // instead of silently swallowing or killing the process.
  let embedded = 0;
  if (!opts.noEmbed) {
    try {
      const { runEmbedCore } = await import('../embed.ts');
      await runEmbedCore(engine, { stale: true });
      embedded = result.imported;
    } catch (e: unknown) {
      const { EmbeddingDimMismatchError } = await import('../embed.ts');
      if (e instanceof EmbeddingDimMismatchError) {
        serr('\n' + e.recipeMessage + '\n');
        serr(`Tip: pass --no-embed to sync without embedding, then`);
        serr(`run 'gbrain embed --stale' after fixing the schema.\n`);
      }
      // Other errors stay best-effort.
    }
  }

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: result.imported,
    modified: 0,
    deleted: reconciledDeletes,
    renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded,
    pagesAffected: [],
    // Warning aggregates ride the result for worker/JSON consumers — a full
    // sync that only prints to a daemon's stderr hides them from cron
    // topologies (codex re-review; same rationale as the incremental path).
    ...(result.malformedSkipped ? { malformedSkipped: result.malformedSkipped } : {}),
    ...(result.type_warnings ? { type_warnings: result.type_warnings } : {}),
    ...(result.resealed ? { resealed: result.resealed } : {}),
  };
}

async function fullSyncDryRun(engine: BrainEngine, syncScopeRoot: string, headCommit: string, opts: SyncOpts,
  hold: { holds: LegacyHolds | null; holdRoot: string }): Promise<SyncResult> {
  const dryRunMalformed: string[] = [];
  let allFiles = collectSyncableFiles(syncScopeRoot, {
    strategy: opts.strategy ?? 'markdown',
    includeGitignored: opts.includeGitignored,
    onExcluded: (rel) => { dryRunMalformed.push(rel); },
    includeHidden: opts.includeHidden,
  });
  if (opts.exclude && opts.exclude.length > 0) {
    allFiles = allFiles.filter(abs => !matchesAnyGlob(relative(syncScopeRoot, abs), opts.exclude));
  }
  slog(
    `Full-sync dry run (strategy=${opts.strategy ?? 'markdown'}): ` +
    `${allFiles.length} file(s) would be imported ` +
    `from ${syncScopeRoot} @ ${headCommit.slice(0, 8)}.`,
  );
  if (dryRunMalformed.length > 0) {
    slog(
      `  ${dryRunMalformed.length} file(s) would be skipped: malformed filename ` +
      `(brackets/control chars; rename to import): ` +
      dryRunMalformed.slice(0, 20).map(sanitizePathForDisplay).join(', ') +
      (dryRunMalformed.length > 20 ? `, … (+${dryRunMalformed.length - 20} more)` : ''),
    );
  }
  return {
    status: 'dry_run',
    fromCommit: null,
    toCommit: headCommit,
    added: allFiles.length,
    modified: 0,
    deleted: 0,
    renamed: 0,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    ...(await wouldHoldFields(engine, hold.holds, hold.holdRoot, allFiles.map(abs => relative(hold.holdRoot, abs)))),
  };
}

async function reportBlockedFullSync(
  engine: BrainEngine,
  opts: SyncOpts,
  anchorPath: string,
  headCommit: string,
  result: import('../import.ts').RunImportResult,
  fullGate: Awaited<ReturnType<typeof applySyncFailureGate>>,
): Promise<SyncResult> {
  const codeBreakdown = formatCodeBreakdown(result.failures);
  if (fullGate.sentinelBlocked) {
    // #3479 review — say WHICH sentinel fired: a `<rename:…>` block here
    // used to print the history-changed message, pointing the operator at
    // a force-push that never happened.
    const fullRenameRows = result.failures.filter(f => f.path.startsWith(RENAME_SENTINEL_PREFIX));
    if (fullRenameRows.length > 0) {
      serr(
        `\nFull sync blocked: a rename left a stale duplicate that could not be removed:\n` +
        `${fullRenameRows.map(f => `  ${f.path}: ${f.error}`).join('\n')}\n\n` +
        `If the delete keeps failing in your environment, remove the stale row ` +
        `yourself: 'gbrain delete <stale-slug>' with the stale slug named above ` +
        `(only rows whose backing file is gone are ever named — never a live page). ` +
        `A sentinel reading 'stale row ?' names nothing on purpose: that run could not ` +
        `prove ANY row stale — fix the unreadable tracked file it reports instead. ` +
        `The sentinel then clears on the next sync.`,
      );
    } else {
      serr(`\nFull sync blocked: repository history changed during sync.\n${codeBreakdown}`);
    }
  } else {
    const fileFailCount = result.failures.filter(f => isSkippablePath(f.path)).length;
    // #3875: code-aware copy — provider-infra failures must not be routed
    // to --skip-failed (same rationale as the incremental gate above).
    const infraCodes = summarizeFailuresByCode(result.failures).filter(c => isEmbeddingInfraCode(c.code));
    if (infraCodes.length > 0) {
      serr(
        `\nFull sync blocked: ${fileFailCount} file(s) failed — embedding provider errors:\n` +
        `${codeBreakdown}\n\n` +
        `These are provider-health failures (timeout / rate limit / quota), not bad ` +
        `files — do NOT use --skip-failed for them. Check the embedding provider, ` +
        `then re-run 'gbrain sync --full'.`,
      );
    } else {
      serr(
        `\nFull sync blocked: ${fileFailCount} file(s) failed:\n` +
        `${codeBreakdown}\n${formatFailedFileList(result.failures)}\n\n` +
        `Pinpoint a file with 'gbrain frontmatter validate <path>' (--fix auto-repairs), ` +
        `fix the YAML and re-run, or use '--skip-failed'. A file ` +
        `that keeps failing auto-skips after ${resolveAutoSkipThreshold()} consecutive syncs.`,
      );
    }
  }
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
  return {
    status: 'blocked_by_failures',
    fromCommit: null,
    toCommit: headCommit,
    added: 0, modified: 0, deleted: 0, renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded: 0,
    pagesAffected: [],
    failedFiles: result.failures.length,
    failureCodes: summarizeFailuresByCode(result.failures),
  };
}

/**
 * Soft-delete file-backed pages whose source file is gone (advancing full
 * syncs only). Returns the number of pages that transitioned.
 */
async function reconcileFullSyncDeletes(
  engine: BrainEngine,
  opts: SyncOpts,
  input: { company: ReturnType<typeof currentCompanyBrainSync>; gitContextRoot: string; syncScopeRoot: string; slugRoot: string | undefined },
): Promise<number> {
  const { company, gitContextRoot, syncScopeRoot, slugRoot } = input;
  // #1970 (F-A): runImport is import-only — it never purges pages whose backing
  // file was deleted since the last sync. A full re-import is authoritative for
  // the whole tree, so reconcile deletes here too (this is what makes the
  // object-absent fallback at performSyncInner correct for deletes, not just
  // imports). Runs only on an advancing full sync (we're past the
  // !fullGate.advanced early-return).
  //
  // SAFETY — must NOT re-introduce the #1433 stale-page data loss. A page is
  // deleted ONLY when ALL three hold:
  //   1. source_path != null      → file-backed pages only; put_page/manual
  //      pages (null source_path) are never swept.
  //   2. isSyncable(source_path)  → excludes metafiles (README/log.md, the
  //      #1433 class) AND the wrong strategy (a markdown sync can't delete a
  //      code page, and vice versa).
  //   3. source_path ∉ current    → the backing file is genuinely gone from the
  //      working tree (collectSyncableFiles == the same enumeration runImport
  //      used, so paths are in the identical relative form as source_path).
  // Skipped on the legacy no-sourceId path (the batch delete primitives require
  // a sourceId; matches every other source-scoped feature).
  let reconciledDeletes = 0;
  if (opts.sourceId) {
    const sid = opts.sourceId;
    const reconcileSyncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
    // collectSyncableFiles returns ABSOLUTE paths; source_path is stored
    // repo-relative (importFile uses `relative(dir, filePath)`), so relativize
    // to the same form before membership-testing — otherwise every page looks
    // stale and the reconcile would wrongly delete live pages.
    //
    // #2828: planReconcileDeletes ALSO normalizes path separators on both sides
    // of the membership test. On a Windows checkout `path.relative` yields
    // backslash paths while a stored source_path can hold git-derived forward
    // slashes; without normalization every file-backed page mismatches, looks
    // stale, and the reconcile wipes the whole source.
    // #774: scoped syncs store git-root-relative source_paths (slugRoot), so
    // relativize the walk to the same base — otherwise every page mismatches
    // and the mass-delete valve trips on a perfectly healthy scoped source.
    // includeHidden MUST be threaded here too: if it isn't, any page a
    // --include-hidden full sync just imported would look "gone" on the
    // very next reconcile pass (its file was never in this collection) and
    // the mass-delete valve would remove it.
    const currentFiles = company ? company.plan.manifest.filter(entry => entry.disposition === 'included').map(entry => entry.path) : collectSyncableFiles(syncScopeRoot, {
      strategy: opts.strategy ?? 'markdown',
      includeGitignored: opts.includeGitignored,
      includeHidden: opts.includeHidden,
    })
      .map(abs => relative(slugRoot ?? syncScopeRoot, abs));
    // #5988 (E13): the old page of a held rename keeps its origin until the
    // renamed file imports; its file being gone does not make it stale.
    const heldOrigins = await heldRenameOrigins(engine, sid);
    const rows = (await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path FROM pages WHERE source_id = $1 AND source_path IS NOT NULL AND deleted_at IS NULL`,
      [sid],
    )).filter(row => !heldOrigins.has(row.source_path!));
    // #774: a scoped full sync is authoritative ONLY for its scope — pages
    // whose source_path lives outside the subpath (e.g. from an earlier
    // root-level sync of this source) are out of this walk's sight and must
    // not be treated as stale.
    const scopePrefix = slugRoot ? gitRelativePath(gitContextRoot, syncScopeRoot) + '/' : '';
    // 'malformed-path' rows ARE reconcile-eligible: junk filenames (bracket /
    // control-char paths minted by misbehaving producers) can never be
    // re-imported, so their rows are permanent search pollution unless the
    // reconcile can sweep them. Strategy safety is preserved by classifier
    // ordering — a path that fails the strategy check classifies as
    // 'strategy', never 'malformed-path', so a markdown sync still can't
    // delete code pages. The #1433 metafile protection is likewise untouched.
    const reconcileEligible = (p: string): boolean =>
      isSyncable(p, reconcileSyncOpts) ||
      // Only the poison signature is sweepable; bare-bracket markdown rows
      // from pre-gate releases survive reconcile (their file still exists —
      // deleting the row would be silent data loss; cross-model finding).
      (unsyncableReason(p, reconcileSyncOpts) === 'malformed-path' && isPoisonedPath(p));
    const plan = planReconcileDeletes(
      rows,
      currentFiles,
      p => (scopePrefix === '' || p.startsWith(scopePrefix)) && reconcileEligible(p),
      p => resolveSlugForPath(p),
    );
    if (plan.staleSlugs.length > 0 && plan.massDelete && !massReconcileAllowed()) {
      // #2828 mass-delete safety valve: a reconcile that would sweep more than
      // half of the pages this strategy manages, on a source with a non-trivial
      // number of them, is almost always a path-comparison bug or the wrong repo
      // path — NOT a genuine bulk deletion. Skip the delete and warn loudly
      // instead of silently wiping the brain.
      serr(
        `\n  WARNING: refusing to reconcile-delete ${plan.staleSlugs.length} of ` +
        `${plan.reconcilableCount} file-backed page(s) for source '${sid}' ` +
        `(> ${Math.round(MASS_RECONCILE_RATIO * 100)}% of them).\n` +
        `  A full sync removes pages only when their backing file is gone. Deleting\n` +
        `  this many at once almost always means the paths were compared wrong (e.g.\n` +
        `  a path-separator mismatch) or the WRONG repo path was synced — not that\n` +
        `  you actually deleted that many files. No pages were deleted.\n` +
        `  If this bulk removal is genuinely intended, re-run with ` +
        `GBRAIN_ALLOW_MASS_RECONCILE=1 to restore the old behavior.`,
      );
    } else if (plan.staleSlugs.length > 0) {
      // #2426: a stale page whose source_path was NEVER committed to git is
      // DB-only write-through (the file was written into the clone but never
      // committed/pushed, then lost — e.g. a fresh clone). "Absent from git"
      // is the SYMPTOM of that bug, not evidence the content is disposable.
      // Keep those pages and re-export their markdown to the working tree so
      // they're file-backed again; only pages whose file once existed in git
      // history (i.e. was genuinely deleted) are reconcile-deleted.
      const everCommitted = company ? null : listEverCommittedPaths(gitContextRoot);
      const pathBySlug = new Map(rows.map(r => [r.slug, r.source_path]));
      let deletableSlugs = plan.staleSlugs;
      const dbOnlySlugs: string[] = [];
      if (everCommitted) {
        deletableSlugs = [];
        for (const slug of plan.staleSlugs) {
          const sp = pathBySlug.get(slug);
          if (sp && !everCommitted.has(sp.replace(/\\/g, '/'))) dbOnlySlugs.push(slug);
          else deletableSlugs.push(slug);
        }
      }
      if (dbOnlySlugs.length > 0) {
        let reExported = 0;
        try {
          const { writePageThrough } = await import('../../core/write-through.ts');
          for (const slug of dbOnlySlugs) {
            const r = await writePageThrough(engine, slug, { sourceId: sid });
            if (r.written) reExported++;
          }
        } catch { /* best-effort — pages are preserved either way */ }
        serr(
          `\n  Kept ${dbOnlySlugs.length} page(s) whose markdown was never committed to git ` +
          `(DB-only write-through — not deleting).` +
          (reExported > 0 ? ` Re-exported ${reExported} of them to the working tree.` : '') +
          `\n  Commit + push them (e.g. scripts/brain-commit-push.sh, or 'gbrain sources harden') ` +
          `so the next sync sees them as file-backed.`,
        );
      }
      const deleteScopedOpts = { sourceId: sid };
      // Malformed-path rows get their own line: unlike genuinely-deleted
      // files, THEIR backing file is usually still on disk (the walker
      // excludes it), so "source file was removed" would be a lie and the
      // rename-to-rescue path must be stated at the moment of removal, not
      // only in a doctor check the operator may see later (red-team catch).
      const malformedDeleted = deletableSlugs.filter(slug => {
        const sp = pathBySlug.get(slug);
        return sp != null && unsyncableReason(sp, reconcileSyncOpts) === 'malformed-path';
      }).length;
      for (let i = 0; i < deletableSlugs.length; i += DELETE_BATCH_SIZE) {
        const batch = deletableSlugs.slice(i, i + DELETE_BATCH_SIZE);
        try {
          // #4587: reconcile soft-deletes (72h recovery). Already-soft-
          // deleted rows are excluded by the primitive's predicate, so the
          // count only reports real transitions.
          const deleted = await softDeleteSyncPages(engine, batch, deleteScopedOpts);
          reconciledDeletes += deleted.length;
        } catch {
          // Per-slug fallback on a batch blip (mirrors the incremental delete
          // loop's decompose). A stale page that won't delete is best-effort,
          // not fatal — the run continues.
          for (const slug of batch) {
            try { reconciledDeletes += (await softDeleteSyncPages(engine, [slug], deleteScopedOpts)).length; }
            catch { /* best-effort */ }
          }
        }
      }
      if (reconciledDeletes > 0) {
        slog(`  Reconciled ${reconciledDeletes} stale page(s) whose source file was removed (soft-deleted, recoverable 72h).`);
        if (malformedDeleted > 0) {
          slog(
            `  (${malformedDeleted} of them had malformed bracket/control-char filenames — ` +
            `their files may still exist on disk; rename a file to re-import its content.)`,
          );
        }
      }
    }
    await retireSupersededTwins(engine, sid, plan.superseded, slog, () => trackedSlugIndex(gitContextRoot));
  }
  return reconciledDeletes;
}
