/**
 * Incremental sync finalize (refactor wave 1, W4 sync): the zero-change exit,
 * then after the drains the final checkpoint flush, the pin-reachability
 * gate, the shared failure-ledger bookmark gate, and the post-advance
 * extract / facts / embed passes.
 */
import { CHUNKER_VERSION } from '../../core/chunkers/code.ts';
import { serr, slog } from '../../core/console-prefix.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { clearOpCheckpoint } from '../../core/op-checkpoint.ts';
import { commitTimeMs } from '../../core/source-health.ts';
import { writeSyncAnchor, writeChunkerVersion } from '../../core/sync-anchor.ts';
import { git } from '../../core/sync-git.ts';
import { buildPartialResult } from '../../core/sync-lock.ts';
import {
  sanitizePathForDisplay,
  DEFAULT_SOURCE_ID,
  resolveAutoSkipThreshold,
  applySyncFailureGate,
  formatCodeBreakdown,
  RENAME_SENTINEL_PREFIX,
  isSkippablePath,
  summarizeFailuresByCode,
  isEmbeddingInfraCode,
  formatFailedFileList,
} from '../../core/sync.ts';
import { shouldLogIngest } from '../import.ts';
import type { SyncResult } from '../sync.ts';
import { sweepOrphanedRenameSentinels } from './rename-reconcile.ts';
import { partial, flushCheckpoint } from './sync-run.ts';
import type { SyncPlan, SyncRun } from './sync-run.ts';

export async function finishWithoutChanges(
  engine: BrainEngine,
  plan: Pick<SyncPlan, 'opts' | 'company' | 'gitContextRoot' | 'lastCommit' | 'pin' | 'pullFailed' | 'ckpt' | 'malformedSkipped' | 'totalChanges'>,
  swept: number,
): Promise<SyncResult | undefined> {
  const { opts, company, gitContextRoot, lastCommit, pin, pullFailed, ckpt, malformedSkipped, totalChanges } = plan;
  if (totalChanges === 0) {
    // #3068: same guard as the git-HEAD-equality gate above — a failed pull
    // plus zero imports must not produce a clean `up_to_date` (and must not
    // advance the anchor past commits this run never looked at remotely).
    // Reached when local-only commits landed with no syncable content while
    // the pull kept failing. Nothing is imported (the #4786 sweep above may
    // have soft-deleted pages — report it); the next sync re-diffs the same
    // trivial range and retries the pull.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no syncable changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: swept, renamed: 0,
        reason: 'pull_failed',
      });
    }
    // Update sync state even with no syncable changes (git advanced). v0.42.x
    // (#1794): advance to the PINNED target, and clear any checkpoint (a resume
    // whose remaining range turned out to have no syncable changes still
    // completes cleanly here).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    if (!company) { await clearOpCheckpoint(engine, ckpt.paths); await clearOpCheckpoint(engine, ckpt.target); }
    // A commit whose ONLY changes are malformed filenames lands here with
    // totalChanges === 0 — the anchor advances past those files forever, so
    // this early return must surface the skips too (structured-review P2).
    if (malformedSkipped.length > 0) {
      serr(
        `  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
        `(brackets/control chars; rename to import): ` +
        malformedSkipped.map(sanitizePathForDisplay).join(', '),
      );
    }
    // #3479 blocker 2: this early return also bypasses the failure gate —
    // sweep orphaned `<rename:…>` sentinels here too.
    await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    return {
      status: swept > 0 ? 'synced' : 'up_to_date',
      fromCommit: lastCommit,
      toCommit: pin,
      added: 0, modified: 0, deleted: swept, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(malformedSkipped.length > 0 ? { malformedSkipped: malformedSkipped.length } : {}),
    };
  }
  return undefined;
}

export async function finalizeIncrementalSync(
  run: SyncRun,
  plan: SyncPlan,
  input: { noEmbed: boolean; typeWarningsEnabled: boolean; start: number },
): Promise<SyncResult> {
  const { engine, pagesAffected, typeWarningCounts } = run;
  const { opts, repoPath, headCommit, lastCommit, pin, filtered, malformedSkipped, totalChanges, uncommittedDrift } = plan;
  const { noEmbed, typeWarningsEnabled, start } = input;
  // v0.42.x (#1794): if checkpoint persistence died mid-run (pool dead through
  // the whole retry budget), do NOT advance last_commit — return a
  // checkpoint_unavailable partial so the next run re-drains (content_hash
  // short-circuits the re-import). partial() overrides the reason when
  // checkpointDead is set.
  if (run.checkpointDead) {
    return await partial(run, plan, 'timeout');
  }

  // v0.42.x (#1794): bank the final completed set before the gate so a block /
  // rewrite still persists everything drained this run (the next run resumes).
  await flushCheckpoint(run);
  // Past the final flush we're on a terminal path (blocked or success); both
  // either leave the checkpoint in place (blocked) or clear it (success), so the
  // SIGTERM one-shot flush has nothing left to add. Deregister so a SIGTERM
  // during the success-path git/anchor writes doesn't fire a stale flush.
  run.deregisterCheckpointCleanup();

  const headVerificationSucceeded = verifyPinnedHead(run, plan);

  const elapsed = Date.now() - start;

  const gated = await applyBookmarkGate(run, plan, headVerificationSucceeded);
  if ('done' in gated) return gated.done;
  const { gate } = gated;

  // Advanced. Surface what the gate did past the failures.
  if (gate.acknowledged > 0) {
    serr(`  Acknowledged ${gate.acknowledged} failure(s) and advanced past them.`);
  }
  if (gate.autoSkipped.length > 0) {
    serr(
      `\n  Auto-skipped ${gate.autoSkipped.length} file(s) that failed >= ` +
      `${resolveAutoSkipThreshold()} consecutive syncs:\n` +
      gate.autoSkipped.map(p => `    ${p}`).join('\n') + '\n' +
      `  Bookmark advanced; these pages are NOT indexed and remain in ` +
      `sync-failures.jsonl. 'gbrain doctor' will warn until they're fixed.`,
    );
  }

  // Log ingest. #3969: mirror runImport's shouldLogIngest gate — a run that
  // landed nothing (no pages written, no chunks, no failures acknowledged or
  // auto-skipped) is a poll, not an ingest event; skip the row unless
  // opts.logNoop opts back in.
  if (shouldLogIngest(
    {
      imported: pagesAffected.length,
      errors: gate.acknowledged + gate.autoSkipped.length,
      chunksCreated: run.chunksCreated,
    },
    opts.logNoop === true,
  )) {
    await engine.logIngest({
      // #3242 (attribution sub-bug): credit the sync to the source it wrote
      // to, not the shared 'default' bucket.
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
      source_type: 'git_sync',
      source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
      pages_updated: pagesAffected,
      summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${run.chunksCreated} chunks, ${elapsed}ms`,
    });
  }

  const extractError = await extractAffectedPages(run, plan);

  await backstopAffectedPageFacts(run, plan);

  const { embedded, embedSlugs } = await embedAffectedPages(run, plan, noEmbed);

  if (malformedSkipped.length > 0) {
    serr(
      `\n  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
      `(brackets/control chars) — rename to import. Not counted as failures.`,
    );
  }

  const typeWarnings = [...typeWarningCounts.values()];
  if (typeWarningsEnabled && typeWarnings.length > 0) {
    const { renderTypeWarningSummary } = await import('../../core/schema-pack/type-usage.ts');
    for (const line of renderTypeWarningSummary(typeWarnings)) serr(`  ${line}`);
    serr(`  (silence with: gbrain config set schema.type_warnings false)`);
  }

  return {
    status: 'synced',
    fromCommit: lastCommit,
    toCommit: pin,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length + run.swept,
    renamed: filtered.renamed.length,
    chunksCreated: run.chunksCreated,
    embedded,
    pagesAffected,
    ...(totalChanges > 100 && embedSlugs.length > 0 ? { embedDeferralReason: 'large_sync' as const } : {}),
    malformedSkipped: malformedSkipped.length,
    ...(typeWarningsEnabled && typeWarnings.length > 0 ? { type_warnings: typeWarnings } : {}),
    ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
    ...(extractError ? { extract_error: extractError } : {}),
  };
}

/** v0.42.x (#1794, T3): pin-reachability gate; records a `<head>` sentinel on a rewrite. */
function verifyPinnedHead(run: SyncRun, plan: Pick<SyncPlan, 'company' | 'gitContextRoot' | 'pin'>): boolean {
  const { failedFiles } = run;
  const { company, gitContextRoot, pin } = plan;
  // v0.42.x (#1794, T3): pin-reachability gate, replacing the pre-v0.42 strict
  // "HEAD == captured" head-drift gate. CODEX-3 originally blocked on ANY HEAD
  // movement to catch external `git checkout`/`reset` that would make the
  // imported chunks reflect a different tree. But the #1794 repro has an enrich
  // process committing to the SAME repo every ~2 min, so the strict gate
  // blocked every run — a co-equal cause of non-convergence. Under pinning we
  // drain a FIXED lastCommit..pin range, so:
  //   - HEAD == pin           → nothing moved; advance.
  //   - HEAD is descendant of pin (forward progress) → SAFE. The new commits
  //     are outside this run's range and get picked up by the next sync's
  //     pin..HEAD diff. Advance to pin.
  //   - pin NOT an ancestor of HEAD (history REWRITE / reset / force-push) →
  //     the tree we imported against is gone. Block; do not advance.
  let headVerificationSucceeded = false;
  try {
    const currentHead = company ? company.plan.revision!.commit : git(gitContextRoot, ['rev-parse', 'HEAD']);
    if (currentHead !== pin) {
      let pinStillReachable = false;
      try {
        git(gitContextRoot, ['merge-base', '--is-ancestor', pin, currentHead]);
        pinStillReachable = true;
      } catch {
        pinStillReachable = false;
      }
      if (!pinStillReachable) {
        failedFiles.push({
          path: '<head>',
          error: `git history rewritten during sync: pinned target ${pin.slice(0, 8)} is no longer an ancestor of HEAD ${currentHead.slice(0, 8)}`,
        });
      } else {
        headVerificationSucceeded = true;
      }
      // else: forward progress (enrich committed on top) — safe, advance to pin.
    } else {
      headVerificationSucceeded = true;
    }
  } catch (e) {
    // rev-parse failure is itself a drift signal (worktree disappeared).
    failedFiles.push({
      path: '<head>',
      error: `git HEAD verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return headVerificationSucceeded;
}

async function applyBookmarkGate(
  run: SyncRun,
  plan: Pick<SyncPlan, 'opts' | 'company' | 'gitContextRoot' | 'anchorPath' | 'lastCommit' | 'pin' | 'ckpt' | 'filtered'>,
  headVerificationSucceeded: boolean,
): Promise<{ done: SyncResult } | { gate: Awaited<ReturnType<typeof applySyncFailureGate>> }> {
  const { engine, succeededPaths, failedFiles, pagesAffected } = run;
  const { opts, company, gitContextRoot, anchorPath, lastCommit, pin, ckpt, filtered } = plan;
  // issue #1939 — gate the bookmark through the shared failure ledger.
  //   • Fresh failures still BLOCK (fail-closed): the next sync re-walks the
  //     diff and re-attempts. Escape hatch: --skip-failed.
  //   • A file that fails >= threshold consecutive syncs AUTO-SKIPS so a poison
  //     file can't wedge all indexing forever (recorded, surfaced by doctor).
  //   • A `<head>` SENTINEL (history rewrite) HARD-BLOCKS even with
  //     --skip-failed — advancing would record a commit that no longer matches
  //     the indexed tree.
  // `advance` is the bookmark write; the gate runs it ONLY when advancing, and
  // ALWAYS before marking anything auto-skipped/acknowledged (crash-atomic).
  const advance = async (): Promise<void> => {
    // v0.42.x (#1794): advance to the PINNED target (not live HEAD) — commits
    // past the pin are the next sync's pin..HEAD diff. `commitTimeMs(pin)` stamps
    // newest_content_at against the commit we drained to. `last_sync_at` is bumped
    // HERE and ONLY here so the autopilot scheduler never sees a stuck source as
    // "fresh". The checkpoint rows clear here — CONVERGENCE CONTRACT: sync
    // convergence == IMPORT convergence; downstream extract/facts/embed is
    // decoupled (its own resumable stale sweeps).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    if (!company) { await clearOpCheckpoint(engine, ckpt.paths); await clearOpCheckpoint(engine, ckpt.target); }
  };

  // issue #1939 adversarial finding #1: a file that failed to parse (open ledger
  // row) and is then deleted/renamed-away never re-enters failedFiles and never
  // imports, so its row would never clear and would age doctor to a permanent
  // FAIL. Treat removed paths as resolved so the ledger self-heals.
  const resolvedPaths = [
    ...succeededPaths,
    ...filtered.deleted,
    ...filtered.renamed.map(r => r.from),
    // A prior transient rev-parse timeout records a hard-blocking sentinel that
    // operators cannot acknowledge manually. Once pin ancestry is verified on
    // a later run, clear that stale sentinel through the ordinary success path.
    ...(headVerificationSucceeded ? ['<head>'] : []),
  ];

  const gate = await applySyncFailureGate({
    sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID,
    failedFiles,
    succeededPaths: resolvedPaths,
    commit: pin,
    skipFailed: !company && opts.skipFailed === true,
    ...(company ? { threshold: 0 } : {}),
    advance,
  });
  // #3479 blocker 2 — self-heal for orphaned `<rename:…>` sentinels: a
  // force-push that invalidates the pinned target means the rename never
  // re-enters the diff, so the ordinary convergence path above can never
  // clear the row and doctor ages it to a permanent FAIL no CLI can fix.
  // Deliberately AFTER the gate and OUTSIDE it (#3583): the gate used to
  // clear these via succeededPaths, which cleared BEFORE advance() — a
  // throwing advance then lost the sentinel with the verify never reached.
  // Out here, a gate that throws never clears anything (fail-closed), and
  // the sweep carries the full clear-then-verify-restore semantics.
  await sweepOrphanedRenameSentinels(
    engine, opts.sourceId ?? DEFAULT_SOURCE_ID, new Set(failedFiles.map(f => f.path)),
  );

  if (!gate.advanced) {
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    // Two sentinel classes block here: `<head>` (pin ancestry broken) and
    // `<rename:…>` (#3056 — a rename-reconcile delete failed and advancing
    // would permanently bank the duplicate). Pick the message by which fired —
    // and when BOTH fired, the rename detail is appended to the head message
    // rather than silently losing to it (#3479 review).
    const renameRows = failedFiles.filter(f => f.path.startsWith(RENAME_SENTINEL_PREFIX));
    // The failing rows verbatim (path + error): the error names the stale
    // slug and the old path, which the operator remedy below points at —
    // a code-count breakdown alone can't tell them which row to delete.
    const renameDetail = renameRows.map(f => `  ${f.path}: ${f.error}`).join('\n');
    // #3479 blocker 1 — the sentinel hard-blocks even --skip-failed by
    // design, so an environment where the DELETE can never succeed (RLS
    // denying DELETE, an FK RESTRICT) needs a documented exit or a cosmetic
    // duplicate becomes a total sync outage. The remedy is deliberately NOT
    // pitched at a fully read-only database: 'gbrain delete' soft-deletes
    // via UPDATE, so it unwedges exactly the environments where writes work
    // but this DELETE does not.
    const renameRemedy =
      `The next 'gbrain sync' retries the reconcile from the same diff. If the delete ` +
      `keeps failing in your environment (RLS denying DELETE, an FK RESTRICT — anywhere ` +
      `UPDATE still works), remove the stale row yourself: 'gbrain delete <stale-slug>' ` +
      `with the stale slug named above (the reconcile only names rows whose backing file ` +
      `is gone from the working tree — never a live page). A sentinel reading 'stale row ?' ` +
      `names nothing on purpose: that run could not prove ANY row stale, usually because a ` +
      `tracked file could not be read — fix or remove that file instead of deleting a page. ` +
      `The reconcile then finds nothing left to delete and the sentinel clears on the next run.`;
    if (gate.sentinelBlocked && failedFiles.some(f => f.path === '<head>')) {
      serr(
        `\nSync blocked: repository history changed during sync (force-push / reset).\n` +
        `${codeBreakdown}\n\n` +
        `The pinned target is no longer an ancestor of HEAD; advancing would record ` +
        `a commit that doesn't match the indexed tree. Re-run sync to re-pin against ` +
        `current HEAD.` +
        (renameRows.length > 0
          ? `\n\nA rename also left a stale duplicate that could not be removed:\n` +
            `${renameDetail}\n\n${renameRemedy}`
          : ''),
      );
    } else if (gate.sentinelBlocked) {
      serr(
        `\nSync blocked: a rename left a stale duplicate that could not be removed:\n` +
        `${renameDetail || codeBreakdown}\n\n` +
        renameRemedy,
      );
    } else {
      const fileFailCount = failedFiles.filter(f => isSkippablePath(f.path)).length;
      // #3875: code-aware copy. Provider-infra failures (embed timeout /
      // rate limit / quota) are NOT bad files — suggesting --skip-failed for
      // them acknowledges away perfectly good content. Point at provider
      // health + a plain re-run (or --full to rebuild) instead.
      const infraCodes = summarizeFailuresByCode(failedFiles).filter(c => isEmbeddingInfraCode(c.code));
      if (infraCodes.length > 0) {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed — embedding provider errors:\n` +
          `${codeBreakdown}\n\n` +
          `These are provider-health failures (timeout / rate limit / quota), not bad ` +
          `files — do NOT use --skip-failed for them. Check the embedding provider ` +
          `(is it running? out of quota?), then re-run 'gbrain sync' (only the failed ` +
          `files are re-attempted), or 'gbrain sync --full' to rebuild.`,
        );
      } else {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed to parse:\n` +
          `${codeBreakdown}\n${formatFailedFileList(failedFiles)}\n\n` +
          `Pinpoint a file with 'gbrain frontmatter validate <path>' (--fix auto-repairs), ` +
          `fix the frontmatter and re-run, or use 'gbrain sync --skip-failed' to ` +
          `acknowledge and move on. A file that keeps failing auto-skips after ` +
          `${resolveAutoSkipThreshold()} consecutive syncs.`,
        );
      }
    }
    // Update last_run + repo_path (progress on infra) but NOT last_commit. The
    // checkpoint is INTENTIONALLY left in place — the banked completed set lets
    // the next run skip the drained files and re-attempt only the failures.
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    // v0.42.x (#1794): surface banked progress so a blocked run doesn't read as
    // total loss (last_commit is unchanged by design; the checkpoint is banked).
    serr(
      `[sync] banked ${run.bankedFiles} file(s) this run; next 'gbrain sync' resumes ` +
      `from the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
    );
    return { done: {
      status: 'blocked_by_failures',
      fromCommit: lastCommit,
      toCommit: pin,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length + run.swept,
      renamed: filtered.renamed.length,
      chunksCreated: run.chunksCreated,
      embedded: 0,
      pagesAffected,
      failedFiles: failedFiles.length,
      failureCodes: summarizeFailuresByCode(failedFiles),
      bankedFiles: run.bankedFiles,
    } };
  }
  return { gate };
}

async function extractAffectedPages(run: SyncRun, plan: Pick<SyncPlan, 'opts' | 'gitContextRoot' | 'pin' | 'totalChanges'>): Promise<string | undefined> {
  const { engine, pagesAffected } = run;
  const { opts, gitContextRoot, pin, totalChanges } = plan;
  // Auto-extract links + timeline (cheap CPU, but skip-inline for LARGE syncs).
  // Thread opts.sourceId so the extract phase reconciles edges + timeline
  // entries against the right source — pre-fix (Data R1 HIGH 1) this phase
  // bypassed sourceId entirely and the bare-slug subquery in addTimelineEntry
  // (Data R1 HIGH 2) crashed with 21000 in multi-source brains.
  //
  // v0.42.x (#1794, T4): size-gate inline extract on `totalChanges <= 100`
  // (same threshold as noEmbed). A large sync (the #1794 case) would otherwise
  // run links+timeline extraction over tens of thousands of pages inline,
  // re-coupling a slow pass into the just-decoupled convergence path. Instead we
  // leave `links_extracted_at` UNSTAMPED so the resumable `extract --stale`
  // watermark sweep (run by the autopilot cycle / on demand) picks the pages
  // up. For resumed large syncs, pagesAffected holds only THIS run's slugs, but
  // the stale sweep scans the whole source, so banked-across-runs pages are
  // covered regardless.
  const extractOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  if (!opts.noExtract && totalChanges > 100 && pagesAffected.length > 0) {
    // #2849: above the size gate the deferred extraction must be DURABLY
    // QUEUED, not just hinted. The autopilot cycle's extract phase is
    // slug-scoped (an up_to_date follow-up sync hands it an empty
    // pagesAffected), so a webhook-driven large sync left
    // `links_extracted_at` unstamped FOREVER unless an operator ran
    // `gbrain extract --stale` by hand. Submit a source-scoped stale-sweep
    // job bound to the consumed commit (idempotency key) so repeated
    // webhook deliveries / sync retries of the same commit coalesce onto
    // one job. The sweep itself is the watermark scan — it picks up the
    // pages this run imported AND any banked across resumed runs.
    // Best-effort: queue submission failure falls back to the hint-only
    // behavior (the pages stay stale + visible to doctor, never mis-stamped).
    let queuedJobId: number | string | null = null;
    try {
      const { MinionQueue } = await import('../../core/minions/queue.ts');
      const { STALE_TIME_BUDGET_MS } = await import('../extract.ts');
      const queue = new MinionQueue(engine);
      const payload = {
        stale: true,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        reason: 'sync_size_gate',
        // Bound to the PIN this run drained to (== headCommit unless resuming
        // a stored target), not live HEAD — the sweep covers what we imported.
        deferred_commit: pin,
      };
      // The stale sweep has its own internal wall-clock budget
      // (GBRAIN_EXTRACT_TIME_BUDGET_MS-derived); without an explicit
      // timeout_ms the job would inherit the tight null-default and get
      // wall-clock-killed mid-sweep (#1737 class). 5-min headroom.
      const timeoutMs = STALE_TIME_BUDGET_MS + 5 * 60 * 1000;
      // NO maxWaiting here: with an unscoped (NULL-sourceId) payload the
      // queue's coalesce filter matches ANY waiting 'extract' job (e.g. a
      // remediation-submitted {mode:'links'} row) and returns THAT job —
      // silently dropping the sweep while we log "queued". The idempotency
      // key alone is the dedup for repeat submissions toward the same pin.
      const key = `extract-stale:${opts.sourceId ?? 'default'}:${pin}`;
      const isLiveSweep = (j: { status: string; data: Record<string, unknown> }): boolean =>
        j.data?.stale === true && ['waiting', 'delayed', 'active'].includes(j.status);
      let job = await queue.add('extract', payload, { idempotency_key: key, timeout_ms: timeoutMs });
      if (!isLiveSweep(job)) {
        // The key slot holds a FINISHED row: a prior sweep toward this pin
        // that completed BEFORE this run's pages landed (checkpoint-resume /
        // blocked-advance re-sync of the same target). Those pages went
        // stale after that sweep's watermark pass, so coalescing onto the
        // finished row would strand them — queue a fresh sweep under a
        // run-unique key. (An 'active' sweep is safe to coalesce onto: its
        // end-of-run staleRemaining re-count chains a continuation.)
        job = await queue.add('extract', payload, {
          idempotency_key: `${key}:${Date.now()}`,
          timeout_ms: timeoutMs,
        });
      }
      // Only claim "queued" once we verified the returned row IS a live
      // stale sweep — never trust queue.add's row blind.
      if (isLiveSweep(job)) queuedJobId = job.id;
    } catch { /* best-effort — hint below still tells the operator */ }
    slog(
      `  Large sync: deferring link/timeline extraction` +
      (queuedJobId != null
        ? ` — queued stale-sweep job #${queuedJobId} (source: ${opts.sourceId ?? 'default'}); a running jobs worker will consume it.`
        : `.`) +
      ` Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' to extract now.`,
    );
  }
  let extractError: string | undefined;
  if (!opts.noExtract && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted, slugsSafeToStamp } = await import('../extract.ts');
      // #774: pages' source_path is git-root-relative, so extract resolves
      // files from gitContextRoot (== repoPath realpath when unscoped).
      const linksResult = await extractLinksForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      const timelineResult = await extractTimelineForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      if (linksResult.created > 0 || timelineResult.created > 0) {
        slog(`  Extracted: ${linksResult.created} links, ${timelineResult.created} timeline entries`);
      }
      // v0.42.7 (#1696, CDX-6): stamp the links_extracted_at watermark for the
      // pages we just extracted, AFTER the import set their updated_at, so
      // links_extracted_at >= updated_at (page is now fresh, not flagged stale).
      // Source-correct via opts.sourceId. Stamp at the CALL SITE (not inside
      // extractLinksForSlugs) so we use the per-source sourceId the sync owns.
      // Best-effort: a stamp miss just means extract --stale re-sweeps later.
      // Only the slugs both hooks actually read — a page the extractor
      // skipped must stay stale so the sweep still owes it.
      await stampExtracted(
        engine,
        slugsSafeToStamp(linksResult, timelineResult)
          .map((slug) => ({ slug, source_id: opts.sourceId ?? 'default' })),
      );
      const failed = [...(linksResult.errors ?? []), ...(timelineResult.errors ?? [])];
      if (failed.length > 0) extractError = `${failed.length} page(s) not extracted, e.g. ${failed[0]!.slug}: ${failed[0]!.error}`;
    } catch (e) {
      extractError = e instanceof Error ? e.message : String(e);
    }
    // A15: best-effort (the import stands and failed pages stay stale for
    // `extract --stale`), but never silent.
    if (extractError) serr(`  Link/timeline extraction failed: ${extractError}. Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' after fixing it.`);
  }
  return extractError;
}

async function backstopAffectedPageFacts(run: SyncRun, plan: Pick<SyncPlan, 'opts'>): Promise<void> {
  const { engine, pagesAffected } = run;
  const { opts } = plan;
  // v0.31.2: facts extraction now routes through the shared
  // src/core/facts/backstop.ts helper (PR1 commit 6). Sync uses
  // queue mode (fire-and-forget) + 'high-only' filter so a 50-page
  // sync doesn't block on N sequential Sonnet calls. The pre-fix
  // inline loop is gone — it carried (a) a dead-code type filter
  // ('conversation'/'transcript'/'therapy'/'call' aren't real
  // PageTypes), (b) a divergent eligibility shape from put_page,
  // and (c) raw extract→insert without dedup/supersede.
  if (!opts.noExtract && pagesAffected.length > 0 && pagesAffected.length <= 50) {
    const { runFactsBackstop } = await import('../../core/facts/backstop.ts');
    const factsSourceId = opts.sourceId ?? 'default';
    for (const slug of pagesAffected) {
      try {
        // v0.40 D21: source-scoped getPage. Pre-v0.40 this called
        // engine.getPage(slug) WITHOUT sourceId, then wrote facts under
        // factsSourceId. On a federated brain with the same slug in two
        // sources (e.g. people/garry-tan in default + zion-brain), this
        // would attribute facts to the wrong source. Codex outside-voice
        // catch on the v0.40 plan review.
        const page = await engine.getPage(slug, { sourceId: factsSourceId });
        if (!page) continue;
        await runFactsBackstop(
          {
            slug,
            type: page.type,
            compiled_truth: page.compiled_truth ?? '',
            frontmatter: page.frontmatter ?? {},
          },
          {
            engine,
            sourceId: factsSourceId,
            sessionId: `sync:${slug}`,
            source: 'sync:import',
            mode: 'queue',
            notabilityFilter: 'high-only',
          },
        );
      } catch { /* per-page enqueue is best-effort */ }
    }
  }
}

async function embedAffectedPages(
  run: SyncRun,
  plan: Pick<SyncPlan, 'opts' | 'totalChanges'>,
  noEmbed: boolean,
): Promise<{ embedded: number; embedSlugs: string[] }> {
  const { engine, pagesAffected, deletedSlugs } = run;
  const { opts, totalChanges } = plan;
  // Auto-embed (skip for large syncs — embedding calls OpenAI).
  // Thread sourceId so incremental source syncs embed the page row they just
  // imported instead of falling back to the default source.
  //
  // v0.37 fix wave (Lane D.3 + CDX2-8): switched from `runEmbed` (which
  // does its own process.exit) to `runEmbedCore` so sync can detect the
  // dim-mismatch class and surface a stderr hint without killing the
  // sync. Non-mismatch errors stay best-effort (rate limits, transient
  // network) — those shouldn't break sync.
  let embedded = 0;
  // #1284: never hand deleted slugs to the embedder — embedPage throws
  // 'Page not found' per deleted slug and logs one error line each. Filter
  // against this run's confirmed-deleted set (slugs re-imported later in the
  // run were removed from it at their push sites).
  const embedSlugs = pagesAffected.filter((s) => !deletedSlugs.has(s));
  if (!noEmbed && embedSlugs.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbedCore } = await import('../embed.ts');
      const embedOpts = opts.sourceId
        ? { slugs: embedSlugs, sourceId: opts.sourceId }
        : { slugs: embedSlugs };
      await runEmbedCore(engine, embedOpts);
      embedded = embedSlugs.length;
    } catch (e: unknown) {
      const { EmbeddingDimMismatchError } = await import('../embed.ts');
      if (e instanceof EmbeddingDimMismatchError) {
        serr('\n' + e.recipeMessage + '\n');
        serr(`Tip: pass --no-embed to sync without embedding, then`);
        serr(`run 'gbrain embed --stale' after fixing the schema.\n`);
      }
      // Other errors stay best-effort — rate limits, transient network.
    }
  } else if (noEmbed || totalChanges > 100) {
    slog(`Text imported. Run 'gbrain embed --stale' to generate embeddings.`);
  }
  return { embedded, embedSlugs };
}
