/**
 * apple-source — Calendar/Contacts/Mail sync for the `apple` source kind
 * (issue #6855). macOS-only and read-only toward Apple: the readers
 * (readers/*) spawn fixed, package-local helpers and return normalized
 * items; this module renders them as markdown under the source's managed dir
 * and flows them through the standard import pipeline.
 *
 * Mirrors google-source.ts: sweep order contacts → calendar → mail; each
 * service is independent (a failing or disabled service never touches
 * another's pages or hashes); cursor state is committed only by a run whose
 * sweeps all succeeded (managed) or per run with whatever landed (unmanaged,
 * hash-keyed so a re-run is idempotent).
 *
 * Errors: a reader failure (permission, automation, helper) is SOURCE-level —
 * it fails that service's sweep, is logged with its fix, recorded in
 * `last_probe`, and is never counted toward an item hold. Only a single
 * item's render/import failure feeds the item holds (3 consecutive failing
 * runs → held, shown by `sources status`, re-attempted by `retry-held`).
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import {
  pendingConnectorResult,
  rethrowConnectorWriteError,
  withConnectorSync,
  type ManagedConnectorSync,
} from '../persistence/connector-sync.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../cli-options.ts';
import { AppleReaderError } from './readers/errors.ts';
import { parseAppleSourceConfig } from './source-config.ts';
import { emptyAppleState, normalizeAppleState, readAppleState, writeAppleState } from './state.ts';
import { appleLoopsAvailability } from './loops-status.ts';
import { applyThreadRefs, mailHoldGroup, retainedUnits } from './mail-holds.ts';
import { reconcileRecovery } from './mail-recovery.ts';
import { enqueueAppleLoopsExtraction, newAppleLoopsRun, prepareLoopsState } from './loops.ts';
import { sweepCalendar, sweepContacts, sweepMail, type AppleSweepCtx } from './sweep.ts';
import {
  newAppleSummary,
  type ActivePack,
  type AppleSyncDeps,
  type AppleSyncSummary,
} from './sweep-shared.ts';
import {
  ALL_APPLE_SERVICES,
  type AppleReaders,
  type AppleService,
  type AppleSourceConfig,
  type AppleSourceState,
} from './types.ts';

export { parseAppleSourceConfig } from './source-config.ts';
export { appleStateFile, readAppleState } from './state.ts';
export type { AppleSourceConfig } from './types.ts';

// ── Config ───────────────────────────────────────────────────────────────────

export const APPLE_KIND = 'apple' as const;

export function isAppleSourceConfig(config: Record<string, unknown>): boolean {
  return config.kind === APPLE_KIND;
}

export interface AppleSyncInjection {
  /** Reader bundle; defaults to the macOS helper readers (readers/index.ts). */
  readers?: AppleReaders;
  /** Clock for the sync windows (tests). */
  now?: () => number;
  /** Log sink (tests); defaults to stderr. */
  log?: (msg: string) => void;
}

// ── Extract + embed (size-gated tail, mirrors google-source) ────────────────

async function runExtractAndEmbed(deps: AppleSyncDeps, summary: AppleSyncSummary): Promise<void> {
  if (deps.managed) return;
  const totalChanges = summary.added + summary.modified;
  const pagesAffected = summary.pagesAffected;
  if (totalChanges === 0 || pagesAffected.length === 0) return;

  if (!deps.opts.noExtract && totalChanges <= 100) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted, slugsSafeToStamp } = await import('../../commands/extract.ts');
      const extractOpts = { sourceId: deps.sourceId };
      const linksResult = await extractLinksForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      const timelineResult = await extractTimelineForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await stampExtracted(
        deps.engine,
        slugsSafeToStamp(linksResult, timelineResult).map((slug) => ({ slug, source_id: deps.sourceId })),
      );
    } catch { /* extraction is best-effort */ }
  } else if (totalChanges > 100 && !deps.opts.noExtract) {
    deps.log(`[apple] large sync (${totalChanges} pages); extraction deferred to 'gbrain extract --stale --source-id ${deps.sourceId}'`);
  }

  if (!deps.opts.noEmbed && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { runEmbedCore } = await import('../../commands/embed.ts');
      await runEmbedCore(deps.engine, { slugs: pagesAffected, sourceId: deps.sourceId });
      summary.embedded = pagesAffected.length;
    } catch { /* embed is best-effort */ }
  } else if (!deps.opts.noEmbed && totalChanges > 100) {
    const drainHint = `run 'gbrain embed --stale --source ${deps.sourceId}' to drain now`;
    try {
      const { submitEmbedBackfill } = await import('../embed-backfill-submit.ts');
      const sub = await submitEmbedBackfill(deps.engine, deps.sourceId, { reason: 'apple_sync_defer' });
      deps.log(sub.status === 'submitted'
        ? `[apple] large sync (${totalChanges} pages); embeds deferred to embed-backfill job ${sub.jobId} — or ${drainHint}`
        : `[apple] large sync (${totalChanges} pages); embed-backfill not queued (${sub.status}) — ${drainHint}`);
    } catch (err) {
      deps.log(`[apple] embed-backfill submission failed: ${err instanceof Error ? err.message : String(err)} — ${drainHint}`);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runAppleSync(
  engine: BrainEngine,
  sourceId: string,
  cfg: AppleSourceConfig,
  opts: SyncOpts,
  injection: AppleSyncInjection = {},
): Promise<SyncResult> {
 if (opts.dryRun) throw new OperationError('invalid_params', 'Apple connector sync does not support --dry-run.',
   `Apple sync reads system data and materializes pages; refusing before any Apple reader runs. Run gbrain sync --source ${sourceId} without --dry-run.`);
 return withConnectorSync(engine, sourceId, APPLE_KIND, cfg, opts,
    (managed, options) => runAppleSyncInner(engine, sourceId, cfg, options, managed, injection), pendingConnectorResult);
}

async function runAppleSyncInner(
  engine: BrainEngine,
  sourceId: string,
  cfg: AppleSourceConfig,
  opts: SyncOpts,
  managed: ManagedConnectorSync | null,
  injection: AppleSyncInjection,
): Promise<SyncResult> {
  const log = injection.log ?? ((msg: string): void => { process.stderr.write(msg + '\n'); });
  const readers = injection.readers ?? (await import('./readers/index.ts')).createAppleReaders();
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  const tick = (note: string): void => progress.tick(1, note);
  const deps: AppleSyncDeps = { managed, engine, sourceId, cfg, opts, readers, log, tick, now: injection.now ?? Date.now };
  const summary = newAppleSummary();
  const countedSlugs = new Set<string>();

  // Active pack for pack-aware typing, mirroring performSyncInner.
  let activePack: ActivePack;
  if (!opts.noSchemaPack) {
    try {
      const { loadActivePack } = await import('../schema-pack/load-active.ts');
      const { loadConfig } = await import('../config.ts');
      const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
      activePack = { page_types: resolved.manifest.page_types };
    } catch { /* legacy prefix typing */ }
  }

  // The account is a free label, not a credential: a managed run pins it so a
  // re-pointed source cannot silently continue another account's checkpoint.
  if (managed) await managed.assertAccount({ kind: APPLE_KIND, account: cfg.account });

  const state: AppleSourceState = managed ? normalizeAppleState(managed.state(emptyAppleState())) : readAppleState(cfg.dir);
  const firstRun = Object.keys(state.calendar.hashes).length + Object.keys(state.contacts.hashes).length + Object.keys(state.mail.hashes).length === 0
    && state.calendar.window === undefined && state.mail.since === undefined;
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyAppleState() as unknown as Record<string, unknown>,
    state.item_holds, { full: opts.full, groupOf: mailHoldGroup, now: deps.now });
  state.item_holds = holds.holds.initial();
  progress.start('sync.apple_materialize');

  try {
    // Mail loop tracking runs only with explicit owner addresses; otherwise Mail syncs exactly as before.
    const loopsAvail = appleLoopsAvailability(cfg);
    if (loopsAvail.available && managed) {
      prepareLoopsState(state, cfg);
      // Commit conservative observation bookkeeping while the coordinator lease is still valid,
      // BEFORE an abortable reader can discover gaps (or crash). publishHolds retains the last
      // committed ingestion cursor and uses the normal journal/CAS/authority path, fresh=false.
      // Keep the working state unchanged: a successful observation can still prove complete,
      // including an empty listing. An interrupted observation must instead recover a whole window.
      // Detach nested caches/holds too: later detection must not mutate the session's checkpointBefore.
      const observation = structuredClone(state.mail_loops ?? {});
      observation.reread = true;
      observation.coverage_gap = true;
      delete observation.complete_at;
      const committed = await managed.publishHolds(emptyAppleState() as unknown as Record<string, unknown>, state.item_holds,
        { mail_loops: observation });
      if (!committed) {
        opts.signal?.throwIfAborted();
        throw new OperationError('storage_error', 'Mail observation invalidation could not be confirmed; no reader was started.',
          `Inspect the canonical writer before retrying: gbrain sources writer status --source ${deps.sourceId} --json`);
      }
    }

    const ctx: AppleSweepCtx = { deps, state, activePack, summary, countedSlugs, holds, ...(loopsAvail.available ? { loops: newAppleLoopsRun() } : {}) };
    const sweeps: Record<AppleService, (c: AppleSweepCtx) => Promise<void>> = {
      contacts: sweepContacts,
      calendar: sweepCalendar,
      mail: sweepMail,
    };
    const enabled = new Set<AppleService>(cfg.services);
    const serviceErrors: string[] = [];
    // Services whose sweep finished with no reader error, item failure or refusal: they alone move freshness.
    let cleanServices = 0;
    state.last_probe ??= {};

    // contacts → calendar → mail. A service not in cfg.services is not read,
    // not hashed and its pages are not deleted.
    for (const service of (['contacts', 'calendar', 'mail'] as const).filter((s) => ALL_APPLE_SERVICES.includes(s) && enabled.has(s))) {
      if (opts.signal?.aborted) break;
      const stop = startHeartbeat(progress, `${service} sweep`);
      const failedBefore = summary.failedFiles;
      const incompleteBefore = summary.incomplete.length;
      try {
        await sweeps[service](ctx);
        state.last_probe[service] = { ok: true, at: new Date(deps.now()).toISOString() };
        if (summary.failedFiles === failedBefore && summary.incomplete.length === incompleteBefore && !opts.signal?.aborted) cleanServices++;
      } catch (e) {
        if (managed) rethrowConnectorWriteError(e);
        if (service === 'mail' && state.mail_loops) { delete state.mail_loops.complete_at; state.mail_loops.reread = true; state.mail_loops.coverage_gap = true; }
        serviceErrors.push(`${service}: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (e instanceof AppleReaderError) {
          // Source-level: recorded for doctor, logged with its fix, never an item hold.
          state.last_probe[service] = { ok: false, at: new Date(deps.now()).toISOString(), code: e.code };
          log(`[apple] ${service} reader failed (${e.code}): ${e.message}. Fix: ${e.fix}`);
        } else {
          log(`[apple] ${service} sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        stop();
      }
    }

    summary.pagesAffected = [...new Set(summary.pagesAffected)];
    if (opts.signal?.aborted) {
      summary.status = 'partial';
      if (state.mail_loops) { delete state.mail_loops.complete_at; state.mail_loops.reread = true; }
    }
    if (opts.full && summary.status === 'synced') state.last_full_at = new Date(deps.now()).toISOString();

    // Throws connector_holds_exhausted before any save, so the cursor stays.
    state.item_holds = holds.finish();
    if (ctx.mailRefs?.size) applyThreadRefs(state.item_holds, ctx.mailRefs);
    // The staged recovery evidence follows the holds just merged: a cleared hold takes its mail text with it (same checkpoint write).
    reconcileRecovery(state, retainedUnits(state.item_holds), deps.now());
    // Every cursor here is a content hash set only after its item landed, so a partial run's state is safe to
    // save: a denied or failing service leaves its own hashes untouched and cannot stall the services that
    // succeeded. Freshness moves when at least one service synced cleanly.
    if (managed) {
      if (!opts.signal?.aborted) {
        await managed.saveState(state, cleanServices > 0, new Date(deps.now()).toISOString());
        // saveState defers while writes are pending; the recorded denials and holds must still land (publishHolds' `extra`).
        if (managed.deferred) {
          // A pending publication cannot leave the previous complete Mail answer authoritative.
          if (state.mail_loops) { delete state.mail_loops.complete_at; state.mail_loops.reread = true; }
          await managed.publishHolds(emptyAppleState() as unknown as Record<string, unknown>, state.item_holds,
            { last_probe: state.last_probe, ...(state.mail_loops ? { mail_loops: state.mail_loops } : {}), mail_recovery: state.mail_recovery });
        }
      }
    } else {
      writeAppleState(cfg.dir, state);
    }
    await holds.complete();
    if (!opts.signal?.aborted) await runExtractAndEmbed(deps, summary);
    // Paid extraction is queued only after the cursor and loop state are saved, and only with BOTH the global
    // switch and this source's consent (enqueueAppleLoopsExtraction). It never fails the sync.
    let loopsEnqueue: Awaited<ReturnType<typeof enqueueAppleLoopsExtraction>>;
    if (ctx.loops && !opts.signal?.aborted && !(managed?.deferred)) {
      try {
        loopsEnqueue = await enqueueAppleLoopsExtraction({ engine, sourceId, cfg, run: ctx.loops, log });
        const counts = (r: Record<string, number>): string => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ');
        if (Object.keys(ctx.loops.eligibility).length > 0) log(`[apple] loops_extract eligibility: ${counts(ctx.loops.eligibility)}`);
        if (Object.keys(ctx.loops.withheld).length > 0) log(`[apple] reply-owed loops withheld: ${counts(ctx.loops.withheld)}`);
      } catch (e) {
        log(`[apple] loops_extract enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // last_sync_at feeds the staleness gate: it moves when at least one enabled service synced cleanly, so a
    // permanently denied service does not freeze the others' freshness.
    if (cleanServices > 0 && !managed && !opts.signal?.aborted) {
      try {
        await engine.executeRaw(
          `UPDATE sources SET last_sync_at = now(), newest_content_at = $1::timestamptz WHERE id = $2`,
          [new Date(deps.now()).toISOString(), sourceId],
        );
      } catch { /* best-effort */ }
    }

    const changed = summary.added + summary.modified + summary.deleted > 0;
    return {
      status: summary.status === 'partial' ? 'partial' : firstRun && changed ? 'first_sync' : changed ? 'synced' : 'up_to_date',
      fromCommit: null,
      toCommit: '',
      added: summary.added,
      modified: summary.modified,
      deleted: summary.deleted,
      renamed: 0,
      chunksCreated: summary.chunksCreated,
      embedded: summary.embedded,
      pagesAffected: summary.pagesAffected,
      ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
      ...connectorHoldsResult(sourceId, holds.summary()),
      ...(loopsEnqueue ? { loops_enqueue: loopsEnqueue } : {}),
    };
  } finally {
    progress.finish();
  }
}

/** Convenience for callers holding only the raw `sources.config` blob. */
export function parseAppleConfigFromSource(config: Record<string, unknown>, localPath: string | null): AppleSourceConfig {
  return parseAppleSourceConfig(config, localPath ?? '');
}
