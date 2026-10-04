/** `gbrain sync` CLI body (`runSyncInner`): flag parsing, --all fan-out, watch mode. */
import { existsSync } from 'fs';
import { getCompanyBrainProfile } from '../../core/company-brain/profile.ts';
import { slog, withSourcePrefix } from '../../core/console-prefix.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { msysToNativePath } from '../../core/path-confine.ts';
import { syncFailureJsonFields, readManagedSyncFailures } from '../../core/persistence/sync-failures.ts';
import { getDefaultSourcePath } from '../../core/source-resolver.ts';
import {
  resolveSyncAllEmbedPlan,
  syncProducedEmbeddableContent,
  resolveSyncEmbedBackfill,
  formatSyncEmbedBackfillOutcome,
  resolveSingleSyncEmbedPlan,
  buildSingleSyncJsonEnvelope,
} from '../../core/sync-embed-backfill.ts';
import type { SyncEmbedBackfillOutcome } from '../../core/sync-embed-backfill.ts';
import { runBreakLock } from '../../core/sync-lock.ts';
import { isSyncDisabledConfig } from '../../core/sync-policy.ts';
import { syncContentDirectory } from '../../core/sync-applicability.ts';
import { composeAbortSignals } from '../../core/sync-reconcile.ts';
import { acknowledgeFailures, unacknowledgedSyncFailures } from '../../core/sync.ts';
import type { SyncResult, SyncOpts } from '../sync.ts';
import { printSyncHelp, parseSyncFlags, parseSyncFanoutFlags } from './args.ts';
import type { SyncFlags, SyncFanoutFlags } from './args.ts';
import { manageGitignoreAtGitRoot } from './gitignore.ts';
import { partitionMissingPathSources } from './missing-path.ts';
import { performSync } from './perform.ts';
import {
  maybeExtractionNudge,
  maybeBackupCoverageRefresh,
  printSyncResult,
  shouldNudgeAfterSync,
  isFailedPartial,
} from './report.ts';
import { runSyncTrigger } from './trigger.ts';
import { writeJsonDocument } from '../../core/cli-force-exit.ts';

/** D2: under the `--json` guard only writeStdoutFinal reaches fd 1 (writeJsonDocument). */
const emitJson = (text: string): void => { void writeJsonDocument(text); };

type SyncAllSourceRow = { id: string; name: string; local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null };

// Per-source result accumulator for the optional --json envelope.
type PerSourceResult = {
  sourceId: string;
  sourceName: string;
  status: 'ok' | 'error' | 'skipped_missing_path';
  result?: SyncResult;
  error?: string;
  localPath?: string;
};

export async function runSyncInner(engine: BrainEngine, args: string[]) {
  // v0.40 Federated Sync v2: `gbrain sync trigger` subcommand
  // Routes to runSyncTrigger which queues a 'sync' minion job with
  // auto_embed_backfill=true. Falls through to the normal sync path
  // if 'trigger' isn't the first arg.
  if (args[0] === 'trigger') {
    return runSyncTrigger(engine, args.slice(1));
  }

  // v0.37 fix wave (Lane D.4 + CDX2-12): print usage when `--help`/`-h` is
  // passed. Pre-fix this was unreachable because the dispatcher's generic
  // CLI-only short-circuit fired first; sync is now in CLI_ONLY_SELF_HELP.
  if (args.includes('--help') || args.includes('-h')) {
    printSyncHelp();
    return;
  }

  const flags = parseSyncFlags(args);
  const { repoPath, dryRun, skipFailed, syncAll, jsonOut, breakLock, forceBreakLock, maxAgeSeconds } = flags;
  let { noEmbed } = flags;

  // v0.41.13.0 (T4 + D1): handle --break-lock / --force-break-lock BEFORE
  // the sync would otherwise contend on the lock. v3's plan dropped the
  // --all refusal at the same point so cron can self-heal across every
  // source in one call; runBreakLock now widens to iterate sources when
  // --all is set and accept maxAgeSeconds for age-gated breaks.
  if (breakLock || forceBreakLock) return await runSyncBreakLock(engine, args, { syncAll, jsonOut, forceBreakLock, maxAgeSeconds });

  const fanout = parseSyncFanoutFlags(args, syncAll);

  // --skip-failed: acknowledge pre-existing unacked failures BEFORE the sync
  // runs, not only ones the current run produces. Without this, the common
  // recovery flow — fix the YAML, re-run sync, then run --skip-failed to
  // clear the log — fails to clear anything: when there are no NEW failures
  // (because the files are now fixed), the inner ack path in performSync is
  // never reached, and "Already up to date." leaves the log untouched. Both
  // doctor and printSyncResult instruct users to run --skip-failed in
  // exactly this case, so the flag has to handle stale entries up-front.
  const cli = await resolveCliSyncSource(engine, args, { repoPath, syncAll, dryRun, jsonOut, noEmbed });
  const { sourceId, companyPolicy, embeddingCredentialError } = cli;
  noEmbed = cli.noEmbed;

  // --skip-failed: acknowledge pre-existing unacked failures BEFORE the sync
  // runs, not only ones the current run produces. Without this, the common
  // recovery flow — fix the YAML, re-run sync, then run --skip-failed to clear
  // the log — fails to clear anything (no NEW failures → the inner ack path in
  // performSync is never reached, and "Already up to date." leaves the log).
  //
  // v0.42.42.0 (#2139, D13C): scoped PER SOURCE. `--all` clears every source's
  // open failures; single-source clears only its own (don't ack source B's
  // failures when syncing source A). Safe under parallel — the ledger
  // serializes writes via `withLedgerLock` and keys rows by `source_id`
  // (#1939), which is why the old D15 "no --skip-failed under parallel"
  // refusal is lifted below.
  if (skipFailed) {
    const acked = syncAll ? acknowledgeFailures() : acknowledgeFailures(sourceId);
    if (acked.count > 0) slog(`Acknowledged ${acked.count} pre-existing failure(s).`);
  }

  // v0.19.0 — `sync --all` iterates all registered sources with a
  // local_path. Sources are the canonical v0.18.0 abstraction: per-source
  // last_commit, last_sync_at, config.federated flags. Per-source
  // bookmarks live in the sources table (not ~/.gbrain/config.json),
  // which is why this path replaced Garry's OpenClaw `multi-repo.ts` shim.
  //
  // Only sources with a non-null local_path participate. A GitHub-only
  // source (no checkout) has nothing for `sync` to pull. Sources with
  // syncEnabled=false in config.jsonb are skipped too.
  if (syncAll) return await runSyncAll(engine, { ...flags, ...fanout }, { noEmbed, embeddingCredentialError });

  return await runSingleSourceSync(engine, { ...flags, ...fanout }, { sourceId, companyPolicy, noEmbed });
}

async function runSyncBreakLock(
  engine: BrainEngine,
  args: string[],
  input: { syncAll: boolean; jsonOut: boolean; forceBreakLock: boolean; maxAgeSeconds: number | undefined },
): Promise<void> {
  const { syncAll, jsonOut, forceBreakLock, maxAgeSeconds } = input;
  if (syncAll) {
    const { listSources } = await import('../../core/sources-ops.ts');
    const sources = await listSources(engine);
    // listSources omits archived sources by default. We also require
    // local_path because the lock key is per-source; pure-DB sources
    // (no local_path) don't hold sync locks.
    const activeSources = sources.filter((s) => s.local_path);
    if (activeSources.length === 0) {
      if (jsonOut) emitJson(JSON.stringify({ status: 'no_sources' }));
      else console.error('No active sources to break-lock against.');
      process.exit(0);
    }
    let worstExit = 0;
    for (const src of activeSources) {
      const lockKey = `gbrain-sync:${src.id}`;
      const exit = await runBreakLock(engine, lockKey, src.id, {
        force: forceBreakLock,
        json: jsonOut,
        maxAgeSeconds,
      });
      if (exit > worstExit) worstExit = exit;
    }
    process.exit(worstExit);
  }
  const sourceArg = args.find((a, i) => args[i - 1] === '--source');
  // #4412: this branch used to hardcode `sourceArg ?? 'default'` while the
  // sync itself resolves through the full ambient chain (--source >
  // GBRAIN_SOURCE > dotfile > cwd > sole-non-default). Under
  // GBRAIN_SOURCE=<src>, `sync --force-break-lock` inspected
  // gbrain-sync:default — absent — printed "nothing to break", exit 0, and
  // left the dead holder's row on gbrain-sync:<src>; the follow-up sync
  // then refused for the 60s takeover grace. Resolve the SAME source the
  // sync would lock. Explicit --source keeps the resolver-free path (no
  // assertSourceExists) so leftover locks of deleted sources stay breakable.
  const { resolveSourceWithTier: resolveBreakSource } = await import('../../core/source-resolver.ts');
  const sourceId = sourceArg ?? (await resolveBreakSource(engine, null)).source_id;
  const lockKey = `gbrain-sync:${sourceId}`;
  const exit = await runBreakLock(engine, lockKey, sourceId, {
    force: forceBreakLock,
    json: jsonOut,
    maxAgeSeconds,
  });
  process.exit(exit);
}

/**
 * Resolve the source a single-source (or `--all`) CLI sync writes to, refusing
 * the ambiguous cases, and validate embedding credentials before any work.
 */
async function resolveCliSyncSource(
  engine: BrainEngine,
  args: string[],
  input: { repoPath: string | undefined; syncAll: boolean; dryRun: boolean; jsonOut: boolean; noEmbed: boolean },
): Promise<{ sourceId: string; companyPolicy: Awaited<ReturnType<typeof getCompanyBrainProfile>> | null; noEmbed: boolean; embeddingCredentialError: Error | undefined }> {
  const { repoPath, syncAll, dryRun, jsonOut } = input;
  let { noEmbed } = input;
  // v0.18.0 Step 5: --source resolves to a sources(id) row. Falls back
  // to pre-v0.17 global config (sync.repo_path + sync.last_commit) when
  // no flag, no env, no dotfile is present.
  //
  // v0.41.13 (#1434): always call the resolver, not just when explicit/env
  // is set. Pre-fix, `gbrain sync` without --source skipped resolution and
  // left sourceId undefined — which the engine treated as the seeded
  // 'default' source. Users with a single non-default registered source
  // (studiovault, etc.) silently routed every write to a source holding
  // 0 pages, then createVersion threw on the slug lookup.
  //
  // The resolver's new `sole_non_default` tier (5.5) routes those
  // single-source brains to the right place automatically; the nudge
  // surfaces the auto-route to stderr so the user knows what happened
  // and can pass --source to override if needed.
  const explicitSource = args.find((a, i) => args[i - 1] === '--source') || null;
  const { resolveSourceWithTier, resolveSourceForRepoPath, formatSoleNonDefaultNudge, defaultWriteAllowedByEnv } =
    await import('../../core/source-resolver.ts');
  // #3765: an explicit --repo anchors source resolution at the REPO dir, not
  // the caller's cwd. Pre-fix, `gbrain sync --repo ~/other-vault` parsed the
  // path but resolved the source from cwd — anchors, page writes, and the
  // per-source lock (`syncLockId(sourceId)`) all followed the WRONG source.
  // Precedence: --source flag > repo-derived (dotfile/local_path at the repo
  // dir) > the ambient chain. A conflicting GBRAIN_SOURCE refuses loudly.
  let resolved: { source_id: string; tier: string; detail?: string } | null = null;
  if (!explicitSource && repoPath) {
    const derived = await resolveSourceForRepoPath(engine, repoPath);
    if (derived) {
      const envSource = process.env.GBRAIN_SOURCE;
      if (envSource && envSource !== derived.source_id) {
        console.error(
          `--repo resolves to source '${derived.source_id}' (via ${derived.tier}) but ` +
          `GBRAIN_SOURCE='${envSource}' is set. Pass --source <id> to disambiguate.`,
        );
        process.exit(1);
      }
      resolved = derived;
      process.stderr.write(
        `[gbrain] routing sync to source '${derived.source_id}' (resolved from --repo via ${derived.tier}).\n`,
      );
    }
  }
  if (!resolved) resolved = await resolveSourceWithTier(engine, explicitSource);
  const sourceId: string = resolved.source_id;
  const companyPolicy = !syncAll ? await getCompanyBrainProfile(engine, sourceId) : null;
  if (companyPolicy) noEmbed = true;
  let embeddingCredentialError: Error | undefined;
  if (!noEmbed && !dryRun) {
    const { validateEmbeddingCreds, EmbeddingCredentialError } = await import('../../core/embed-preflight.ts');
    try { validateEmbeddingCreds(); }
    catch (error) {
      if (!syncAll) {
        if (!(error instanceof EmbeddingCredentialError)) throw error;
        if (jsonOut) emitJson(JSON.stringify({ status: 'embedding_credentials_missing', diagnosis: error.diagnosis }));
        else console.error(`\n${error.userMessage}\n`);
        process.exit(1);
      }
      embeddingCredentialError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (resolved.tier === 'sole_non_default') {
    const nudge = formatSoleNonDefaultNudge(sourceId);
    if (nudge) process.stderr.write(nudge + '\n');
  }

  // #4583 (fixes #4564's misrouted-write symptom): refuse an unscoped
  // single-source sync that would silently land in 'default' on a
  // bulk-non-default brain. Exempt: `--all` (iterates every source, not an
  // unscoped-to-default write) and `--dry-run` (writes nothing — the preview
  // runs and the guard only WARNS that a real run would be refused). Escape:
  // `--source default` (tier 'flag', never seed_default) or
  // GBRAIN_ALLOW_DEFAULT_WRITE=1. Fail-open: a query error never blocks a sync.
  if (resolved.tier === 'seed_default' && !syncAll && !defaultWriteAllowedByEnv()) {
    const { assessDefaultWriteGuard, formatDefaultWriteRefusal } = await import('../../core/source-resolver.ts');
    const assessment = await assessDefaultWriteGuard(engine);
    if (assessment.shouldGuard) {
      console.error((dryRun ? '[dry-run] a real run would be refused:\n' : '') + formatDefaultWriteRefusal('sync', assessment));
      if (!dryRun) process.exit(1);
    }
  }
  return { sourceId, companyPolicy, noEmbed, embeddingCredentialError };
}

/** `sync --all`: every registered source with a local_path, fanned out or serial. */
async function runSyncAll(
  engine: BrainEngine,
  flags: SyncFlags & SyncFanoutFlags,
  input: { noEmbed: boolean; embeddingCredentialError: Error | undefined },
): Promise<void> {
  const {
    dryRun, full, noPull, noExtract, skipFailed, retryFailed, noSchemaPack, explicitProcessing, includeGitignored,
    workingTree, missingPathMode, jsonOut, yesFlag, serialFlag, noAutoEmbed, maxSources, concurrency, timeoutSeconds,
  } = flags;
  const { noEmbed, embeddingCredentialError } = input;
  // v0.41.31: SELECT carries last_commit + chunker_version so the inline
  // cost preview's "unchanged source → 0" short-circuit can mirror sync's
  // own "do work?" gate (sync.ts:1057+1075) + doctor's sync_freshness.
  // Both columns predate v0.41 (writeSyncAnchor / writeChunkerVersion); no
  // schema migration needed.
  // #3880: archived sources must not re-enter `sync --all`. The archived
  // column is v34+ — fall back to the unfiltered query on older brains
  // (house style per pickSoleNonDefaultSource).
  let sources: SyncAllSourceRow[];
  try {
    sources = await engine.executeRaw<SyncAllSourceRow>(
      `SELECT id, name, local_path, config, last_commit, chunker_version FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
    );
  } catch {
    sources = await engine.executeRaw<SyncAllSourceRow>(
      `SELECT id, name, local_path, config, last_commit, chunker_version FROM sources WHERE local_path IS NOT NULL`,
    );
  }
  if (!sources || sources.length === 0) {
    slog('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
    return;
  }

  // v0.41.31 — mode-aware cost gate. Resolve federated_v2 ONCE here so both
  // the gate (below) and the fan-out (further down) share it.
  const { isFederatedV2Enabled } = await import('../../core/feature-flags.ts');
  const v2Enabled = await isFederatedV2Enabled(engine);

  // v0.40.5.0 Federated Sync v2 (master) + v0.40.6.0 layering (this branch):
  // master added parallel fan-out via pMapAllSettled, embed-backfill auto-
  // submit, --serial / --max-sources / --no-auto-embed flags, and feature-
  // flagged the whole thing behind sync.federated_v2. This branch layers
  // additive improvements on top:
  //   - humanSink swap so `--json` keeps stdout clean (D4)
  //   - --skip-failed / --retry-failed reject under parallel>1 (D15 — the
  //     sync-failures.jsonl is brain-global, parallel acks race)
  //   - connection-budget stderr warning at parallel × workers × 2 > 16 (D10)
  //   - withSourcePrefix wrap inside runOne so slog/serr lines from
  //     performSync get the [<source-id>] prefix under parallel mode (D6)
  //   - stable JSON envelope {schema_version:1, sources, ...} when --json
  // v0.41.31: v2Enabled resolved once above (cost gate). Reused here.
  const notApplicable: string[] = [];
  for (const s of sources) {
    if (await syncContentDirectory(engine, { sourceId: s.id, repoPath: s.local_path ?? undefined })) notApplicable.push(s.id);
  }
  const activeSources = sources.filter((s) => !isSyncDisabledConfig(s.config) && !notApplicable.includes(s.id));
  const disabledCount = sources.filter((s) => isSyncDisabledConfig(s.config)).length;
  const humanSink: NodeJS.WriteStream = jsonOut ? process.stderr : process.stdout;
  const writeHuman = (line: string) => humanSink.write(line + '\n');

  if (disabledCount > 0) {
    writeHuman(`Skipping ${disabledCount} disabled source(s).`);
  }
  if (notApplicable.length > 0) {
    writeHuman(`Skipping ${notApplicable.length} source(s) where sync does not apply (gbrain-owned content directory, not a Git checkout): ${notApplicable.join(', ')}. Add markdown files with \`gbrain import <dir> --source <id>\`.`);
  }

  // --missing-path skip: classify sources whose checkout is not on this
  // machine instead of failing them (see parseMissingPathMode's rationale).
  // Under the default 'fail' this is a no-op and behavior is unchanged.
  let skippedMissingPath: typeof activeSources = [];
  let runnableSources = activeSources;
  if (missingPathMode === 'skip') {
    const parts = partitionMissingPathSources(activeSources, existsSync);
    runnableSources = parts.runnable;
    skippedMissingPath = parts.missing;
    for (const src of skippedMissingPath) {
      writeHuman(`  ⊘ ${src.name}: skipped — local_path not present on this host (${src.local_path})`);
    }
    if (skippedMissingPath.length > 0) {
      writeHuman(`Skipped ${skippedMissingPath.length} source(s) whose local_path is not present on this host (--missing-path skip).`);
    }
  }

  if (runnableSources.length === 0) {
    if (jsonOut) {
      emitJson(JSON.stringify({
        schema_version: 1,
        sources: skippedMissingPath
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((s) => ({
            source_id: s.id,
            name: s.name,
            status: 'skipped_missing_path',
            local_path: s.local_path,
          })),
        parallel: 0,
        ok_count: 0,
        error_count: 0,
        skipped_count: skippedMissingPath.length,
      }));
    }
    return;
  }

  // v0.42.42.0 (#2139) cost gate — shared with single-source sync. Above
  // the floor, non-interactive runs keep importing (never exit 2), but the
  // delivery statement is capability-aware: background queue only when a
  // worker can drain it, otherwise an exact manual command.
  const companyPolicies = new Map<string, Awaited<ReturnType<typeof getCompanyBrainProfile>>>();
  const policyFailures = new Map<string, unknown>();
  for (const source of runnableSources) {
    try { companyPolicies.set(source.id, await getCompanyBrainProfile(engine, source.id)); }
    catch (error) { policyFailures.set(source.id, error); }
  }
  const embedPlan = await resolveSyncAllEmbedPlan(engine, runnableSources.filter(src => !policyFailures.has(src.id) && !companyPolicies.get(src.id)), {
    v2Enabled, serialFlag, noEmbed: noEmbed || !!embeddingCredentialError, noAutoEmbed, dryRun, jsonOut, yesFlag, full, includeGitignored,
  });
  if (embedPlan.stop) return;
  const {
    workerSurface: backfillSurface, fanOutEligible, effectiveNoEmbed, shouldBackfill,
  } = embedPlan;

  const embedBackfillBySource = new Map<string, SyncEmbedBackfillOutcome>();

  const perSourceResults: PerSourceResult[] = [];
  for (const src of skippedMissingPath) {
    perSourceResults.push({
      sourceId: src.id,
      sourceName: src.name,
      status: 'skipped_missing_path',
      localPath: src.local_path ?? undefined,
    });
  }

  // #1633 (Part B): one shared SIGINT controller for the whole --all fan-out.
  // process-cleanup.ts doesn't own SIGINT, so without this Ctrl-C hard-cuts the
  // run and can leak per-source locks; here it aborts every in-flight source so
  // each performSync returns `partial` + releases its lock cleanly.
  const allInterrupt = new AbortController();
  const onAllSigint = () => { try { allInterrupt.abort(new Error('SIGINT')); } catch { /* */ } };

  const runOne = async (src: typeof sources[number]): Promise<SyncResult> => {
    if (policyFailures.has(src.id)) throw policyFailures.get(src.id);
    const companyPolicy = companyPolicies.get(src.id);
    if (!companyPolicy && embeddingCredentialError) throw embeddingCredentialError;
    const cfg = (src.config || {}) as { strategy?: 'markdown' | 'code' | 'auto' };
    // D18/#2139: planned fan-out or a cost-gate auto-defer skips inline
    // embedding; the post-run delivery below reports/queues each source.
    // v0.41.13.0 (T6 / D-V3-3 / D-V4-mech-6) — per-source AbortController.
    //
    // When the user passes --timeout, each source gets its OWN
    // AbortController + countdown that starts when THIS runOne invocation
    // starts. NOT a shared global controller — codex pass 2 caught that
    // shared shape would starve later sources of their fair budget.
    //
    // try/finally + timer.unref() (D-V4-mech-6):
    //   - finally clearTimeout guarantees cleanup even when performSync
    //     throws (which pMapAllSettled catches outside this closure).
    //     Without finally, a throw would leak the timer and keep the CLI
    //     alive past `setTimeout(..., timeoutMs)`.
    //   - timer.unref() (Node-specific; the optional-chain handles
    //     environments without it) tells the event loop NOT to keep the
    //     process alive solely for this timer. Belt-and-suspenders with
    //     finally — even on a missed clearTimeout, the process can exit
    //     once all real work resolves.
    const controller = timeoutSeconds !== undefined ? new AbortController() : undefined;
    const timer = timeoutSeconds !== undefined
      ? setTimeout(() => controller!.abort(), timeoutSeconds * 1000)
      : undefined;
    timer?.unref?.();
    const repoOpts: SyncOpts = {
      repoPath: msysToNativePath(src.local_path!), // #2955: heal MSYS /c/... before joins
      dryRun, full, noPull,
      noEmbed: effectiveNoEmbed,
      noExtract,
      skipFailed, retryFailed, noSchemaPack, explicitProcessing,
      includeGitignored,
      workingTree,
      sourceId: src.id,
      strategy: cfg.strategy,
      concurrency,
      signal: composeAbortSignals(allInterrupt.signal, controller?.signal),
    };
    // v0.40.6.0 (D6): wrap performSync in withSourcePrefix so every slog /
    // serr line emitted from inside the sync code path gets prefixed with
    // `[<source-id>] `. Under master's pMapAllSettled fan-out, this is
    // what makes `grep '\[media-corpus\]'` against parallel output work.
    //
    // v0.41.13.0 (T6): wrap the performSync call in try/finally so the
    // per-source timer is always cleared, even on throw.
    let result: SyncResult;
    try {
      result = await withSourcePrefix(src.id, () => performSync(engine, repoOpts));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // v0.41.13.0 (T7 / D-V3-5): partial joins dry_run + blocked_by_failures
    // in the conservative posture — defer gitignore management to the next
    // clean sync. A partial sync's set of db_only paths isn't fully
    // reconciled, so writing .gitignore entries based on it could leave
    // stale or missing entries.
    if (
      !companyPolicy && result.status !== 'dry_run' &&
      result.status !== 'blocked_by_failures' &&
      result.status !== 'partial'
    ) {
      manageGitignoreAtGitRoot(src.local_path!, engine.kind);
    }
    // Deliver planned or intrinsic >100-file deferrals. Intrinsic delivery
    // is v2-only on worker-backed engines; no-worker engines still need a
    // manual outcome. This preserves the worker-backed v2-off rollback.
    if (
      !companyPolicy && (shouldBackfill || (
        result.embedDeferralReason === 'large_sync' &&
        (v2Enabled || backfillSurface.status === 'no_worker_surface')
      )) &&
      !dryRun &&
      result.status !== 'dry_run' &&
      result.status !== 'up_to_date' &&
      result.status !== 'partial' && syncProducedEmbeddableContent(result)
    ) {
      try {
        const outcome = await resolveSyncEmbedBackfill(engine, src.id, {
          reason: 'sync_all', autoSubmitDisabled: noAutoEmbed,
        });
        embedBackfillBySource.set(src.id, outcome);
        writeHuman(`  → ${formatSyncEmbedBackfillOutcome(outcome, src.name)}`);
      } catch (e) {
        process.stderr.write(`  → embed-backfill submission failed for ${src.name}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    return result;
  };

  // v0.42.42.0 (#2139, D13C): the v0.40.6.0 (D15) refusal of --skip-failed /
  // --retry-failed under parallel sync is LIFTED. It existed because the
  // failure ledger was once brain-global with racing acks; #1939 made the
  // ledger per-(source_id, path) and serialized every write through
  // `withLedgerLock`, so parallel per-source acks no longer race. Lifting it
  // also removes the forcing-function that pushed recovery syncs to --serial
  // (and thus armed the inline cost gate) — the root cause behind #2139.

  // Effective parallelism — surfaced in the --json envelope so consumers
  // know how the run was actually dispatched. 1 in the serial fallback,
  // capped at min(sourceCount, --max-sources, 8) in the parallel path.
  const effectiveParallel = fanOutEligible
    ? Math.min(runnableSources.length, maxSources ?? 8)
    : 1;

  await dispatchSyncAll({ fanOutEligible, effectiveParallel, concurrency, runnableSources, runOne, writeHuman, humanSink, perSourceResults, onAllSigint });

  const okCount = perSourceResults.filter((r) => r.status === 'ok').length;
  const errCount = perSourceResults.filter((r) => r.status === 'error').length;

  if (jsonOut) emitSyncAllEnvelope({ perSourceResults, embedBackfillBySource, effectiveParallel, okCount, errCount, costGate: embedPlan.costGate });

  // v0.42.7 (#1696): brain-wide extraction-lag nudge after the --all wave.
  // Best-effort, stderr-only; skipped on dry-run.
  if (!dryRun) await maybeExtractionNudge(engine);
  // Monthly backup-coverage stale-only refresh (trusted local engine holder).
  if (!dryRun) await maybeBackupCoverageRefresh(engine);

  // #3068: any source wedged on a failed pull (partial/pull_failed) makes
  // the whole --all run non-zero — it will not self-heal on retry, so a
  // green exit would hide it from cron/monitoring. Timeout-class partials
  // keep the pre-existing exit-0 behavior (they converge on retry).
  const pullFailedCount = perSourceResults.filter(
    (r) => r.status === 'ok' && r.result && isFailedPartial(r.result),
  ).length;
  if (errCount > 0 || pullFailedCount > 0) process.exit(1);
  return;
}

async function dispatchSyncAll(input: {
  fanOutEligible: boolean;
  effectiveParallel: number;
  concurrency: number | undefined;
  runnableSources: SyncAllSourceRow[];
  runOne: (src: SyncAllSourceRow) => Promise<SyncResult>;
  writeHuman: (line: string) => void;
  humanSink: NodeJS.WriteStream;
  perSourceResults: PerSourceResult[];
  onAllSigint: () => void;
}): Promise<void> {
  const { fanOutEligible, effectiveParallel, concurrency, runnableSources, runOne, writeHuman, humanSink, perSourceResults, onAllSigint } = input;
  process.on('SIGINT', onAllSigint);
  try {
  if (fanOutEligible) {
    const { pMapAllSettled } = await import('../../core/parallel.ts');
    const cap = effectiveParallel;

    // v0.40.6.0 (D10): connection-budget stderr warning. Each per-file
    // worker opens its own PostgresEngine with poolSize=2, so the real
    // live-connection ceiling is `cap × workers × 2` per wave plus the
    // parent pool. The original PR understated by 2× — fix the math.
    const effectiveWorkers = concurrency ?? 4;
    const budget = cap * effectiveWorkers * 2;
    if (budget > 16) {
      process.stderr.write(
        `[sync --all] Connection budget: parallel=${cap} × workers=${effectiveWorkers} × 2 ` +
        `(per-file pool) = ${budget} concurrent connections per fan-out wave (+ parent pool). ` +
        `Check pgbouncer/Postgres max_connections (SELECT count(*) FROM pg_stat_activity); ` +
        `raise the cap or lower --max-sources/--workers if you see "too many clients" errors.\n`,
      );
    }

    writeHuman(`\nParallel sync: ${runnableSources.length} sources, ${cap} concurrent workers.\n`);
    const results = await pMapAllSettled(runnableSources, cap, async (src) => {
      const r = await runOne(src);
      return { name: src.name, result: r };
    });
    // Print per-source aggregate at the end. humanSink so --json stays clean.
    writeHuman('\n--- sync --all aggregate ---');
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const src = runnableSources[i];
      if (r.status === 'fulfilled') {
        writeHuman(`  ${r.value.result.managedWrite || r.value.result.status === 'blocked_by_failures' ? '✗' : '✓'} ${src.name}: ${r.value.result.status} (added=${r.value.result.added}, modified=${r.value.result.modified}, deleted=${r.value.result.deleted})`);
        if (r.value.result.managedWrite || r.value.result.status === 'blocked_by_failures') printSyncResult(r.value.result, humanSink);
        perSourceResults.push({
          sourceId: src.id,
          sourceName: src.name,
          status: r.value.result.managedWrite || r.value.result.status === 'blocked_by_failures' ? 'error' : 'ok',
          result: r.value.result,
        });
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        process.stderr.write(`  ✗ ${src.name}: ${msg}\n`);
        perSourceResults.push({
          sourceId: src.id,
          sourceName: src.name,
          status: 'error',
          error: msg,
        });
      }
    }
  } else {
    for (const src of runnableSources) {
      writeHuman(`\n--- Syncing source: ${src.name} ---`);
      try {
        const result = await runOne(src);
        printSyncResult(result, humanSink);
        perSourceResults.push({
          sourceId: src.id,
          sourceName: src.name,
          status: result.managedWrite || result.status === 'blocked_by_failures' ? 'error' : 'ok',
          result,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`Error syncing ${src.name}: ${msg}\n`);
        perSourceResults.push({
          sourceId: src.id,
          sourceName: src.name,
          status: 'error',
          error: msg,
        });
      }
    }
  }
  } finally {
    process.off('SIGINT', onAllSigint);
  }
}

function emitSyncAllEnvelope(input: {
  perSourceResults: PerSourceResult[];
  embedBackfillBySource: Map<string, SyncEmbedBackfillOutcome>;
  effectiveParallel: number;
  okCount: number;
  errCount: number;
  costGate: Record<string, unknown> | undefined;
}): void {
  const { perSourceResults, embedBackfillBySource, effectiveParallel, okCount, errCount, costGate } = input;
  // Sort by source_id at emit time so the envelope is deterministic
  // even though completion order is not (pMapAllSettled semantics).
  const sortedSources = perSourceResults
    .slice()
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((r) => ({
      source_id: r.sourceId,
      name: r.sourceName,
      status: r.status,
      ...(r.localPath ? { local_path: r.localPath } : {}),
      ...(r.result ? {
        ...syncFailureJsonFields(r.result),
        sync_status: r.result.status,
        // #3068: surface the partial reason (e.g. pull_failed) so JSON
        // consumers can distinguish a self-healing timeout from a wedge.
        ...(r.result.reason ? { reason: r.result.reason } : {}),
        ...(r.result.managedWrite ? { managed_write: r.result.managedWrite } : {}),
        added: r.result.added,
        modified: r.result.modified,
        deleted: r.result.deleted,
        chunks_created: r.result.chunksCreated,
        embedded: r.result.embedded,
        // Warning aggregates (malformed filenames, alias/undeclared
        // types) — the whole point of the result-field plumbing is that
        // JSON/worker consumers can see them (codex re-review).
        ...(r.result.malformedSkipped ? { malformed_skipped: r.result.malformedSkipped } : {}),
        ...(r.result.type_warnings ? { type_warnings: r.result.type_warnings } : {}),
      } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(embedBackfillBySource.has(r.sourceId)
        ? { embed_backfill: embedBackfillBySource.get(r.sourceId) }
        : {}),
    }));
  emitJson(JSON.stringify({
    schema_version: 1,
    sources: sortedSources,
    parallel: effectiveParallel,
    ok_count: okCount,
    error_count: errCount,
    skipped_count: perSourceResults.filter((r) => r.status === 'skipped_missing_path').length,
    // #4684: the cost-gate status object rides inside the ONE envelope.
    ...(costGate ? { cost_gate: costGate } : {}),
  }));
}

/** Single-source sync (one run, or `--watch`). */
async function runSingleSourceSync(
  engine: BrainEngine,
  flags: SyncFlags & SyncFanoutFlags,
  input: { sourceId: string; companyPolicy: Awaited<ReturnType<typeof getCompanyBrainProfile>> | null; noEmbed: boolean },
): Promise<void> {
  const {
    repoPath, watch, interval, dryRun, full, noPull, noExtract, skipFailed, retryFailed, resetCheckpoint, noSchemaPack,
    explicitProcessing, includeGitignored, workingTree, jsonOut, yesFlag, noAutoEmbed, strategyArg, srcSubpath,
    excludePatterns, includeHiddenPatterns, concurrency, timeoutSeconds,
  } = flags;
  const { sourceId, companyPolicy, noEmbed } = input;
  // v0.41.13.0 (T6) — single-source --timeout: same per-source AbortController
  // shape as the --all runOne closure. Timer scoped to this CLI invocation;
  // try/finally clears it after performSync resolves (or throws).
  const singleSourceController = timeoutSeconds !== undefined ? new AbortController() : undefined;
  const singleSourceTimer = timeoutSeconds !== undefined
    ? setTimeout(() => singleSourceController!.abort(), timeoutSeconds * 1000)
    : undefined;
  singleSourceTimer?.unref?.();
  // #1633 (Part B): graceful SIGINT cancel. process-cleanup.ts owns SIGTERM
  // (lock release + exit) and the watchdog owns the hard deadline; SIGINT is
  // deliberately left to callers, so Ctrl-C during a long sync aborts the
  // in-flight import cleanly (performSync returns `partial`, bookmark unadvanced,
  // lock released by its own finally) instead of a hard cut.
  const singleSourceInterrupt = new AbortController();
  const onSingleSourceSigint = () => { try { singleSourceInterrupt.abort(new Error('SIGINT')); } catch { /* */ } };
  const opts: SyncOpts = {
    repoPath, dryRun, full, noPull, noEmbed, noExtract, skipFailed, retryFailed, resetCheckpoint, noSchemaPack, explicitProcessing, includeGitignored, workingTree, sourceId,
    strategy: strategyArg, concurrency,
    srcSubpath,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
    includeHidden: includeHiddenPatterns.length > 0 ? includeHiddenPatterns : undefined,
    signal: composeAbortSignals(singleSourceInterrupt.signal, singleSourceController?.signal),
  };

  // v0.42.42.0 (#2139, Step 4b): single-source `gbrain sync` gets the SAME
  // inline cost gate as `--all`. Previously single-source embedded inline with
  // NO gate (only rail: the ≤100-file inline cap). Single-source always embeds
  // INLINE (not the parallel-deferred fan-out), so mode is forced 'inline'.
  // Skipped on --no-embed, --dry-run (performSync's own dry-run previews and
  // spends nothing), and watch. Non-TTY above floor AUTO-DEFERS — so adding
  // the gate can never wedge an existing cron; it converts silent ungated
  // inline spend into informed inline-or-deferred spend.
  let singleSourceAutoDefer = false;
  let singleSourceNoWorkerSurface = false;
  let singleCostGate: Record<string, unknown> | undefined;
  if (!noEmbed && !dryRun && !watch) {
    const gateRows = await engine.executeRaw<{ local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null }>(
      `SELECT local_path, config, last_commit, chunker_version FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (gateRows.length > 0) {
      const gate = await resolveSingleSyncEmbedPlan(engine, {
        sourceId,
        local_path: gateRows[0].local_path ?? repoPath ?? null,
        config: gateRows[0].config ?? {},
        last_commit: gateRows[0].last_commit,
        chunker_version: gateRows[0].chunker_version,
      }, {
        dryRun: false,
        jsonOut, yesFlag, full, includeGitignored, noAutoEmbed,
      });
      singleSourceNoWorkerSurface = gate.workerSurface.status === 'no_worker_surface';
      singleCostGate = gate.costGate;
      if (gate.stop) return;
      if (gate.autoDeferEmbeds) {
        opts.noEmbed = true;
        singleSourceAutoDefer = true;
      }
    }
  }

  if (retryFailed) {
    // v0.42.42.0 (#2139, D13C): scope the retry count to THIS source — rows
    // carry source_id (#1939), so a single-source retry shouldn't report
    // another source's failures.
    const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
    const failures = brain?.enabled ? await readManagedSyncFailures(engine, [sourceId]) : unacknowledgedSyncFailures().filter(f => f.source_id === sourceId);
    if (failures.length === 0) {
      slog('No local ledger entries; checking the durable sync cursor for unfinished or failed writes.');
    } else {
      slog(`Retrying ${failures.length} previously-failed file(s)...`);
    }
  }

  if (!watch) {
    // v0.41.13.0 (T6): try/finally clears the single-source timer so it
    // doesn't fire after performSync resolves OR throws.
    let result: SyncResult;
    process.on('SIGINT', onSingleSourceSigint);
    try {
      result = await performSync(engine, opts);
    } finally {
      if (singleSourceTimer !== undefined) clearTimeout(singleSourceTimer);
      process.off('SIGINT', onSingleSourceSigint);
    }
    printSyncResult(result, jsonOut ? process.stderr : process.stdout);
    // #3068: a pull_failed partial is NOT a success — unlike timeout-class
    // partials (which converge on retry), a failing pull will not self-heal.
    // Exit non-zero so cron/monitoring sees the wedge instead of a green run.
    // Routed through the owned verdict channel (NOT bare `process.exitCode`,
    // which PGLite's Emscripten runtime clobbers mid-run — see
    // src/core/cli-force-exit.ts).
    if (result.managedWrite || result.status === 'blocked_by_failures' || isFailedPartial(result)) {
      const { setCliExitVerdict } = await import('../../core/cli-force-exit.ts');
      setCliExitVerdict(1);
    }
    // v0.42.7 (#1696, D5): extraction-lag nudge after a completed single-source
    // sync. Fire on every non-error completion (synced | first_sync | up_to_date)
    // — NOT just 'synced'; a fresh/--full import (`first_sync`) is the biggest
    // un-extracted backlog. Scoped to this source; best-effort, stderr-only.
    if (shouldNudgeAfterSync(result.status)) await maybeExtractionNudge(engine, sourceId);
    // Monthly backup-coverage: the sync CLI legitimately holds the engine
    // (trusted local), so the stale-only compute piggybacks here — covering
    // active CLI users without any serve involvement. Dry-run stays pure.
    if (result.status !== 'dry_run') await maybeBackupCoverageRefresh(engine);
    // Issue #2 + eng-review pass-2 finding #1 + Codex P1: manage .gitignore ONLY
    // on successful sync. Skip on dry-run (don't mutate disk in preview mode)
    // and blocked_by_failures (sync state is inconsistent — defer .gitignore
    // until next clean run). v0.41.13.0 (T7 / D-V3-5): partial also skips —
    // conservative posture matches blocked_by_failures. Resolve the effective
    // repo path so the wire-up fires in the common case where the user runs
    // `gbrain sync` without passing --repo every time.
    if (
      !companyPolicy && result.status !== 'dry_run' &&
      result.status !== 'blocked_by_failures' &&
      result.status !== 'partial'
    ) {
      const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
      if (effectiveRepoPath && !companyPolicy) {
        manageGitignoreAtGitRoot(effectiveRepoPath, engine.kind);
      }
    }
    // v0.42.42.0 (#2139, Step 4b): the inline gate auto-deferred this run's
    // embeds (non-TTY, above floor) — enqueue a capped backfill job so the
    // NULL-embedded chunks get embedded out of band instead of being stranded.
    // Mirror --all: an intrinsic >100-file deferral is delivered on a worker-backed
    // engine when federated v2 is on, and as a manual drain when no worker exists.
    // An explicit --no-embed never submits a backfill.
    let singleV2Enabled = false;
    if (result.embedDeferralReason === 'large_sync' && !noEmbed && !singleSourceNoWorkerSurface) {
      const { isFederatedV2Enabled } = await import('../../core/feature-flags.ts');
      singleV2Enabled = await isFederatedV2Enabled(engine);
    }
    let singleEmbedBackfill: SyncEmbedBackfillOutcome | undefined;
    if (
      !companyPolicy && (singleSourceAutoDefer || (
        result.embedDeferralReason === 'large_sync' && (singleSourceNoWorkerSurface || singleV2Enabled)
      )) &&
      result.status !== 'dry_run' &&
      result.status !== 'up_to_date' &&
      result.status !== 'partial' && syncProducedEmbeddableContent(result)
    ) {
      try {
        singleEmbedBackfill = await resolveSyncEmbedBackfill(engine, sourceId, {
          reason: 'sync_autodefer', autoSubmitDisabled: noAutoEmbed,
        });
        process.stderr.write(`  → ${formatSyncEmbedBackfillOutcome(singleEmbedBackfill)}.\n`);
      } catch (e) {
        process.stderr.write(`  → embed-backfill submission failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (jsonOut) {
      emitJson(JSON.stringify({ ...buildSingleSyncJsonEnvelope(sourceId, result, singleEmbedBackfill, singleCostGate),
        ...(result.managedWrite ? { managed_write: result.managedWrite } : {}) }));
    }
    return;
  }

  // Watch mode
  let consecutiveErrors = 0;
  slog(`Watching for changes every ${interval}s... (Ctrl+C to stop)`);

  while (true) {
    try {
      const result = await performSync(engine, { ...opts, full: false });
      consecutiveErrors = 0;
      if (result.status === 'synced') {
        const ts = new Date().toISOString().slice(11, 19);
        slog(`[${ts}] Synced: +${result.added} ~${result.modified} -${result.deleted} R${result.renamed}`);
      }
      // Same gate as non-watch: only manage .gitignore on successful sync.
      // v0.41.13.0 (T7 / D-V3-5): partial joins the deferred posture.
      // Same repo-resolution path so watch mode catches the implicit-resolved case.
      if (
        !companyPolicy && result.status !== 'dry_run' &&
        result.status !== 'blocked_by_failures' &&
        result.status !== 'partial'
      ) {
        const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
        if (effectiveRepoPath) {
          manageGitignoreAtGitRoot(effectiveRepoPath, engine.kind);
        }
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
