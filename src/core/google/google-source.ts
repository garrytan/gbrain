import { withConnectorSync, rethrowConnectorWriteError, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { resolveGoogleAccount } from '../persistence/connector-account.ts';
import { googleApiProblem, googleUserinfo } from './api-access.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { carryLegacyFailCounts } from '../connectors/item-holds.ts';
import { connectorDryRunResult } from '../connectors/api-source.ts';
/**
 * google-source — Gmail/Calendar/Contacts sync for the `google` source kind.
 *
 * Mirrors the github source kind (github-source.ts): a source registered
 * with kind=google is API-backed, not git-backed. Threads, events, and
 * contacts materialize as markdown under the source's managed dir and flow
 * through the standard import pipeline (chunks, embeds, aliases, links).
 *
 * Sweep order: contacts → calendar → gmail — alias rows must exist before
 * the loop detector resolves counterparties.
 *
 * Cursor discipline (per service, independent):
 *  - contacts / calendar: syncToken committed only after that service's
 *    fully-successful sweep; 410 GONE drops the token and re-runs windowed.
 *  - gmail delta: history.list from gmail_history_id; 404 (expired, ~1 week)
 *    falls back to a bookmark-windowed messages.list, then re-anchors.
 *  - gmail INITIAL BACKFILL is explicitly resumable (outside-voice F7a): the
 *    window is drained newest→oldest with a floor cursor persisted per
 *    batch, so a killed 50k-message backfill resumes at the floor instead of
 *    restarting. historyId is captured BEFORE the backfill starts, so the
 *    delta lane takes over with zero gap (overlap re-renders are idempotent).
 *
 * Credentials come from the vault (gbrain google connect) — never from
 * sources.config, which stores only the account pointer.
 */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { CredentialError, isCredentialError } from '../creds/errors.ts';
import { GOOGLE_PROVIDER, GoogleTokenProvider, fetchSendAsAliases } from '../creds/providers/google.ts';
import { CommandAccessProvider, EnvAccessProvider, type GoogleAccessProvider } from './access.ts';
import { credentialId, openVault, type CredentialEntry, type CredentialVault } from '../creds/vault.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../cli-options.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { atomicWriteFileSync, mkdirPrivate } from '../atomic-write.ts';
import { importRendered, isUsageLimit, markPartial, myAddressSet, type ActivePack, type GoogleSyncDeps, type GoogleSyncSummary } from './sweep-shared.ts';
import { connectorSpeakerOwnerStamp } from '../identity/speaker-owner.ts';
export { myAddressSet } from './sweep-shared.ts';
import { sweepCalendar, sweepContacts } from './people-calendar-sweep.ts';
import { applyLoopDetection, enqueueLoopsExtraction, resolveSweepExclusion } from './loops-enqueue.ts';
import { NO_EXCLUSION } from './loops-exclusion.ts';
import {
  CalendarClient,
  GmailClient,
  GoogleCursorExpiredError,
  PeopleClient,
  type FetchImpl,
  type GmailReader,
} from './google-clients.ts';
import { GbrainioGmailReader } from './gbrainio-gmail.ts';
import { applyTierFrontmatter, classifyThreadTier, entryHash, isPrivateThread, parsePrivateSenders, type IngestTier, type PrivateSenders } from './ingest-tiers.ts';
import { renderThreadPage, threadRelPath } from './google-render.ts';
import { slugifyPath } from '../sync.ts';
import {
  ALL_GOOGLE_SERVICES,
  isGmailHoldKey,
  type GmailThreadData,
  type GoogleApiProblem,
  type GoogleService,
  type GoogleSourceConfig,
  type GoogleSourceState,
} from './types.ts';
import { LOOPS_EXTRACT_WINDOW_DAYS, loopExtractionEligibility } from './loops-extract.ts';
import { recordGraceVerdict, recordWithheldVerdict, runLoopsCatchup, seedGraceBackfill, seedLoopRechecks, settleDueGraceHolds, type LoopsEnqueueReport } from './loop-catchup.ts';

export type { GoogleSourceConfig } from './types.ts';
export { runGoogleAttachmentBackfill } from './attachment-backfill.ts';
export { parseGoogleSourceConfig } from './source-config.ts';
import { parseGoogleSourceConfig } from './source-config.ts';

// ── Config ───────────────────────────────────────────────────────────────────

const G_KIND = 'google';

export function isGoogleSourceConfig(config: Record<string, unknown>): boolean {
  return config.kind === G_KIND;
}

// ── State ────────────────────────────────────────────────────────────────────

export function googleStateFile(dir: string): string {
  return join(dir, '.google-source.json');
}

function emptyState(): GoogleSourceState {
  return {
    gmail_history_id: null,
    gmail_backfill_floor_ms: null,
    gmail_backfill_done: false,
    gmail_newest_ms: null,
    calendar_sync_token: null,
    calendar_id: null,
    calendar_horizon_ms: null,
    contacts_sync_token: null,
    last_full_at: null,
  };
}

export function readGoogleState(dir: string): GoogleSourceState {
  const file = googleStateFile(dir);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<GoogleSourceState>;
    return { ...emptyState(), ...parsed };
  } catch (e) {
    // A CORRUPT existing state file is not a fresh install: silently
    // returning emptyState() would re-run the entire backfill with zero
    // diagnostic. Quarantine for forensics and say so loudly.
    const quarantine = `${file}.corrupt`;
    let failure: { step: 'chmod' | 'rename'; path: string; error: unknown } | null = null;
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      failure = { step: 'chmod', path: file, error };
    }
    try {
      renameSync(file, quarantine);
      if (failure) failure.path = quarantine;
    } catch (error) {
      failure ??= { step: 'rename', path: file, error };
    }
    process.stderr.write(
      `[google] state file ${file} was corrupt (${e instanceof Error ? e.message : String(e)}); ` +
        `quarantined to .corrupt — cursors reset, the next sync re-anchors and resumes.\n`,
    );
    if (failure) {
      process.stderr.write(
        `[google] could not secure the quarantined state file ${failure.path}: ${failure.step} failed ` +
          `(${failure.error instanceof Error ? failure.error.message : String(failure.error)}). ` +
          `It may be readable by other local users; run chmod 600 ${failure.path} or delete it.\n`,
      );
    }
    return emptyState();
  }
}

function writeGoogleState(dir: string, state: GoogleSourceState): void {
  mkdirPrivate(dir);
  // Atomic (tmp+fsync+rename): this file is written once per backfill batch;
  // a torn write would silently reset every cursor (full re-backfill).
  // 0600 is reasserted on every write, so a legacy 0644 file tightens.
  atomicWriteFileSync(googleStateFile(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Reads a source's private-senders file; a missing or unreadable file throws private_senders_unreadable rather than run without it. */
export function loadPrivateSenders(path: string): PrivateSenders {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new CredentialError('private_senders_unreadable', ' (' + String((e as { code?: unknown } | null)?.code ?? 'read failed') + ')');
  }
  return parsePrivateSenders(text);
}

// ── Sync runner ──────────────────────────────────────────────────────────────

async function saveGoogleState(deps: GoogleSyncDeps, state: GoogleSourceState): Promise<void> {
  if (deps.managed) await deps.managed.saveState(state);
  else writeGoogleState(deps.cfg.dir, state);
}

/** #5867/#5868 state a partial managed run still publishes (E20): never the Gmail cursor. */
function loopRecoveryState(state: GoogleSourceState): Record<string, unknown> {
  const fields = { loop_grace_holds: state.loop_grace_holds, loop_grace_backfill_done: state.loop_grace_backfill_done, loops_catchup: state.loops_catchup,
    loop_withheld_senders: state.loop_withheld_senders, loop_automated_backfill_done: state.loop_automated_backfill_done, calendar_unreadable: state.calendar_unreadable,
    api_access: state.api_access };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * #9011: a thread whose import was still pending when processThread ran detection, then refused as purged content,
 * leaves what detection derived from a page that never landed. Drops its extract candidate and grace hold, and the open
 * loops of that slug while no live page holds it (open_loops.page_slug has no foreign key); the loops also for a refusal
 * an earlier run recorded, which may have resolved after that run's cleanup.
 */
async function forgetRefusedPurgedThreads(deps: GoogleSyncDeps, managed: ManagedConnectorSync, state: GoogleSourceState): Promise<void> {
  await managed.drainPending();
  const slugs = managed.refusedPurgedSlugs(true);
  if (!slugs.length) return;
  const refused = new Set(managed.refusedPurgedSlugs());
  deps.extractCandidates = deps.extractCandidates.filter((c) => !refused.has(c.slug));
  for (const [tid, hold] of Object.entries(state.loop_grace_holds ?? {})) if (hold.slug && refused.has(hold.slug)) delete state.loop_grace_holds![tid];
  await deps.engine.executeRaw(`DELETE FROM open_loops WHERE source_id=$1 AND page_slug=ANY($2::text[])
    AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.slug=open_loops.page_slug AND p.deleted_at IS NULL)`, [deps.sourceId, slugs]);
}

// ── Gmail sweep ──────────────────────────────────────────────────────────────

const BACKFILL_BATCH_THREADS = 25;

async function processThread(
  deps: GoogleSyncDeps,
  gmail: GmailReader,
  threadId: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  seen: { thread?: GmailThreadData; tier?: IngestTier; slug?: string | null } = {},
  cutoffMs?: number,
): Promise<GmailThreadData | null> {
  const thread = await gmail.getThread(threadId, deps.cfg.account, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  seen.thread = thread;
  summary.threadsSeen++;
  const newestMs = thread.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
  // #8482: the change feed and held retries name threads of any age; the history window keeps a thread with no page out, as the backfill does.
  if (cutoffMs !== undefined && newestMs < cutoffMs) {
    const [page] = await deps.engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL',
      [deps.sourceId, slugifyPath(threadRelPath(thread))]);
    if (!page) return null;
  }
  const ownerStamp = await connectorSpeakerOwnerStamp(deps.engine, deps.sourceId);
  const rendered = renderThreadPage(thread, ownerStamp ?? undefined);
  // Pure noise renders no page AND skips detection — an all-noise thread
  // produces an empty verdict anyway, so nothing opens and nothing closes.
  if (!rendered) return thread;
  let markdown = rendered.markdown;
  let tier: IngestTier = 'full';
  if (deps.cfg.ingestTiers || deps.privateSenders) {
    const privateSenders = deps.privateSenders ?? null;
    tier = deps.cfg.ingestTiers
      ? await classifyThreadTier(deps.engine, thread, myAddressSet(deps.entry), privateSenders)
      : privateSenders && isPrivateThread(thread, privateSenders) ? 'private' : 'full';
    summary.ingestTiers = { ...summary.ingestTiers, [tier]: (summary.ingestTiers?.[tier] ?? 0) + 1 };
    seen.tier = tier;
    if (tier === 'none') return thread;
    markdown = applyTierFrontmatter(markdown, tier);
  }
  const slug = await importRendered(deps, rendered.relPath, markdown, activePack, summary, countedSlugs,
    { thread_id: thread.threadId, message_ids: thread.messages.map((m) => m.id) });
  seen.slug = slug;
  // #8644/#8938: a purged thread is neither detected nor extracted, and its grace hold is dropped, so its text does not
  // come back through open loops.
  if (slug === null) {
    delete deps.loopState?.loop_grace_holds?.[thread.threadId];
    return thread;
  }
  for (const message of thread.messages) {
    const state = message.attachmentInspection?.state ?? 'not_inspected';
    summary.attachmentInspection[state] = (summary.attachmentInspection[state] ?? 0) + 1;
  }
  deps.processedThreads.add(thread.threadId);
  const verdict = await applyLoopDetection(deps, thread, slug);
  if (verdict && deps.loopState) recordGraceVerdict(deps.loopState, thread, verdict, slug, myAddressSet(deps.entry), deps.log, deps.exclusion);
  if (verdict && deps.loopState) recordWithheldVerdict(deps.loopState, verdict);
  if (verdict?.withheld) summary.loopsWithheld[verdict.withheld.reason] = (summary.loopsWithheld[verdict.withheld.reason] ?? 0) + 1;
  // LLM extraction candidates: trickle + the bounded recent window only —
  // the deep historical backfill is never extracted (spend honesty, F9).
  // Record and private pages are never read by a model, so they are never extraction candidates.
  const windowMs = LOOPS_EXTRACT_WINDOW_DAYS * 86_400_000;
  if (tier === 'full' && newestMs > 0 && Date.now() - newestMs <= windowMs) {
    // Structural eligibility, not "everything recent": bulk mail the owner
    // never joined would otherwise both pay for model calls AND crowd real
    // threads out of the sweep.
    const verdict = loopExtractionEligibility(thread, myAddressSet(deps.entry), deps.exclusion);
    summary.extractEligibility[verdict.reason] =
      (summary.extractEligibility[verdict.reason] ?? 0) + 1;
    if (verdict.eligible) {
      deps.extractCandidates.push({ slug, threadId: thread.threadId, newestMs });
    }
  }
  return thread;
}

/**
 * A rate-limit failure is transient and self-clearing (Google's own quota
 * window, not a problem with this thread) — it never counts toward a hold.
 * The google-clients.ts retry loop already retries a rate-limited request
 * patiently (DEFAULT_RATE_LIMIT_RETRIES, backoff + jitter) before giving up
 * and throwing this; reaching here means the client's own retry budget was
 * exhausted, not that the thread is bad.
 */
function threadFailureMessage(tid: string, notCounted: boolean, usageLimit: boolean, e: unknown): string {
  return (
    `[google] thread ${tid} failed${usageLimit ? ' (rate limited; not counted toward a hold)' : notCounted ? ' (not counted toward a hold)' : ''}: ` +
    `${e instanceof Error ? e.message : String(e)}`
  );
}

/** GST-3452: a provider usage or rate limit (gbrain.io's allowance, Google's quota): the sweep stops and the next sync resumes. */

/**
 * #5581: current mail must be imported down to this far below the newest
 * message before a sweep may call the source fresh. A new install's history
 * anchor only replays changes AFTER it, so until the backfill's newest→oldest
 * floor has passed this horizon the recent inbox is still missing.
 */
export const GMAIL_RECENT_HORIZON_MS = 14 * 86_400_000;
/**
 * #5581 (Eng): the parked delta thread ids are capped at 1,000 ids or 64 KB
 * serialized. A delta larger than the cap is drained in bounded batches: the
 * history listing stops at the last record that fits, the anchor advances only
 * to that record once its threads are landed or parked, and the next run
 * resumes the history from there, so no change is ever dropped.
 */
export const GMAIL_PENDING_MAX_IDS = 1_000;
export const GMAIL_PENDING_MAX_BYTES = 64 * 1024;
/** Test seam: bounded-batch fixtures lower the cap instead of flagging 1,000 threads. */
export const gmailPendingCap = { ids: GMAIL_PENDING_MAX_IDS, bytes: GMAIL_PENDING_MAX_BYTES };
const fitsPendingCap = (ids: readonly string[]) => ids.length <= gmailPendingCap.ids && Buffer.byteLength(JSON.stringify(ids)) <= gmailPendingCap.bytes;

type WalkOutcome = 'done' | 'failed' | 'aborted' | 'more';

interface GmailSweep {
  deps: GoogleSyncDeps;
  gmail: GmailReader;
  state: GoogleSourceState;
  activePack: ActivePack;
  summary: GoogleSyncSummary;
  countedSlugs: Set<string>;
  holds: ConnectorHoldSession;
  /** Window mode: threads landed or found unchanged this run, so a later page listing an older message of one is not a change. */
  walked: Set<string>;
}

type ThreadOutcome = { kind: 'landed'; newestMs: number } | { kind: 'gone' | 'skipped' | 'failed' | 'rate_limited' };

/**
 * One thread through the item holds: a held thread is skipped unless
 * re-admitted; a failure is counted (a held thread failing again does not
 * block the cursor). On a managed brain a write error aborts the run after
 * the abort path publishes the holds.
 */
async function attemptThread(g: GmailSweep, tid: string, version: string | null, cutoffMs?: number): Promise<ThreadOutcome> {
  if (!g.holds.shouldAttempt(tid, version)) {
    g.deps.tick(`thread ${tid} held`);
    return { kind: 'skipped' };
  }
  // Window mode re-lists recent mail every run: a thread whose newest message is the one it landed with is unchanged.
  const known = g.gmail.supportsHistory ? undefined : g.state.gmail_window_seen?.[tid];
  if (known && (known.v === version || g.walked.has(tid)) && !g.holds.isHeld(tid)) {
    g.walked.add(tid);
    g.deps.tick(`thread ${tid} unchanged`);
    return { kind: 'landed', newestMs: known.ms };
  }
  const seen: { thread?: GmailThreadData } = {};
  try {
    const thread = await processThread(g.deps, g.gmail, tid, g.activePack, g.summary, g.countedSlugs, seen, cutoffMs);
    g.holds.succeed(tid);
    const last = thread?.messages[thread.messages.length - 1];
    const newestMs = last?.internalDateMs ?? 0;
    if (newestMs > (g.state.gmail_newest_ms ?? 0)) g.state.gmail_newest_ms = newestMs;
    if (!g.gmail.supportsHistory && last) {
      (g.state.gmail_window_seen ??= {})[tid] = { v: version ?? last.id, ms: newestMs };
      g.walked.add(tid);
    }
    g.deps.tick(`thread ${tid}`);
    return { kind: 'landed', newestMs };
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError && e.status === 404) {
      // Thread deleted between listing and fetch — gone is gone. Skipping
      // (not failing) keeps the cursor moving; --full reconcile removes any
      // page it left behind.
      g.holds.drop(tid);
      g.deps.log(`[google] thread ${tid} vanished (404); skipping`);
      g.deps.tick(`thread ${tid} gone`);
      return { kind: 'gone' };
    }
    const wasHeld = g.holds.isHeld(tid);
    const first = seen.thread?.messages[0];
    const last = seen.thread?.messages[seen.thread.messages.length - 1];
    const classified = await g.holds.fail(tid, e, { version, slug: seen.thread ? threadRelPath(seen.thread).replace(/\.md$/, '') : null,
      meta: { sender: last?.from ?? null, subject: first?.subject ?? null, upstream_at: last ? last.dateIso : null } });
    const rateLimited = classified.scope === 'rate_limit';
    const usageLimit = rateLimited && isUsageLimit(e);
    g.summary.failedFiles++;
    g.deps.log(threadFailureMessage(tid, rateLimited, usageLimit, e));
    if (wasHeld && !rateLimited) return { kind: 'skipped' };
    if (usageLimit) {
      g.summary.limitStopped = true;
      g.summary.limitedItems = (g.summary.limitedItems ?? 0) + 1;
    } else markPartial(g.summary, `gmail thread failed: ${e instanceof Error ? e.message : String(e)}`, true);
    return { kind: usageLimit ? 'rate_limited' : 'failed' };
  }
}

/**
 * Drain `[lowerMs, state[floorKey])` newest→oldest, committing the floor per
 * fully-successful batch so a killed walk resumes where it stopped (F7a).
 * Shared by the historical backfill and the history-expired gap.
 */
async function walkGmailWindow(g: GmailSweep, floorKey: 'gmail_backfill_floor_ms' | 'gmail_gap_floor_ms', lowerMs: number): Promise<WalkOutcome> {
  const { deps, gmail, state } = g;
  let floorMs = state[floorKey] ?? Date.now() + 60_000;
  while (floorMs > lowerMs) {
    if (deps.opts.signal?.aborted) return 'aborted';
    const q = `after:${Math.floor(lowerMs / 1000)} before:${Math.ceil(floorMs / 1000)}`;
    // Page-BOUNDED listing (partialOk): a busy inbox can hold far more ids
    // than the client's 500-page safety cap; the floor cursor makes partial
    // listings safe — each iteration takes the newest ~2,000 messages in the
    // window, processes them, drops the floor, and re-queries.
    const ids = await gmail.listMessageIds(q, { maxPages: 20, partialOk: true, ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    if (ids.length === 0) break;
    // Newest-first listing → unique threads in newest-first order; a thread's
    // newest listed message id is its upstream version for the holds.
    const versions = new Map<string, string>();
    for (const m of ids) if (!versions.has(m.threadId)) versions.set(m.threadId, m.id);
    const threadIds = [...versions.keys()];
    let processedAny = false;
    let batchFailed = false;
    let batchOldest = floorMs;
    for (let i = 0; i < threadIds.length; i += BACKFILL_BATCH_THREADS) {
      if (deps.opts.signal?.aborted) break;
      for (const tid of threadIds.slice(i, i + BACKFILL_BATCH_THREADS)) {
        if (deps.opts.signal?.aborted) break;
        const outcome = await attemptThread(g, tid, versions.get(tid) ?? null);
        if (outcome.kind === 'landed') {
          processedAny = true;
          if (outcome.newestMs > 0 && outcome.newestMs < batchOldest) batchOldest = outcome.newestMs;
        } else if (outcome.kind === 'failed' || outcome.kind === 'rate_limited') {
          // A failed thread NEWER than a committed floor would fall outside
          // the resume window (`before:floor`) forever, so the batch holds the
          // floor. A rate limit is per-user: defer the rest of the batch.
          batchFailed = true;
          if (outcome.kind === 'rate_limited') break;
        }
      }
      if (batchFailed || deps.managed && deps.opts.signal?.aborted) break;
      if (processedAny && batchOldest < floorMs) {
        state[floorKey] = batchOldest;
        await saveGoogleState(deps, state);
      }
    }
    if (deps.opts.signal?.aborted) return 'aborted';
    if (batchFailed) return 'failed';
    if (!processedAny || batchOldest >= floorMs) {
      // Nothing moved the floor (all held/vanished or all same-timestamp):
      // step below the oldest listed page to guarantee termination. Only
      // reachable with zero failures.
      state[floorKey] = Math.max(lowerMs - 1, floorMs - 86_400_000);
      await saveGoogleState(deps, state);
    }
    floorMs = state[floorKey] ?? lowerMs;
  }
  return 'done';
}

/**
 * #5581: returns true when CURRENT mail is complete: the history delta
 * drained, no history-expired gap remains, and the recent inbox is
 * imported (backfill done or its floor past GMAIL_RECENT_HORIZON_MS). Held
 * threads never block it; `gbrain waiting` reports them as partial coverage.
 * False = the caller must NOT stamp `last_sync_at`. The deep historical
 * backfill runs AFTER current mail and does not gate freshness; its failures
 * still mark the run partial.
 */
async function sweepGmail(g: GmailSweep, onCurrent?: () => Promise<void>): Promise<boolean> {
  const { deps, gmail, state } = g;
  const cutoffMs = Date.now() - deps.cfg.historyDays * 86_400_000;

  // #5438: a completed backfill whose covered bound is above a now-WIDER
  // window reopens strictly below that bound (the floor's own `before:`).
  const covered = state.gmail_backfill_cutoff_ms;
  if (state.gmail_backfill_done && covered != null && cutoffMs < covered - 86_400_000) {
    deps.log(`[google] history window widened; resuming backfill below ${new Date(covered).toISOString()}`);
    state.gmail_backfill_done = false;
    state.gmail_backfill_floor_ms = covered;
    await saveGoogleState(deps, state);
  }

  if (deps.privateSenders && await retierPrivatePages(g) === 'aborted') return false;

  let currentDrained: boolean;
  if (!gmail.supportsHistory) {
    const recent = await walkRecentWindow(g, cutoffMs);
    if (recent === 'aborted') return false;
    currentDrained = recent === 'done';
  } else {
  // Anchor the delta lane BEFORE importing anything: changes that land
  // during the backfill are replayed by history.list.
  if (!state.gmail_backfill_done && !state.gmail_history_id) {
    const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    if (profile.emailAddress.toLowerCase() !== deps.cfg.account) {
      deps.log(`[google] warning: token account ${profile.emailAddress} != source account ${deps.cfg.account}`);
    }
    state.gmail_history_id = profile.historyId;
    await saveGoogleState(deps, state);
  }
  if (!state.gmail_history_id) {
    // A finished backfill with no change-feed anchor is a window-mode cursor (a gbrain.io source moved to vault): anchor
    // history now and drain from the newest landed message by window, as an expired history id does.
    const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    state.gmail_gap_floor_ms = null;
    openGmailGap(state, cutoffMs);
    state.gmail_history_id = profile.historyId;
    await saveGoogleState(deps, state);
  }

  // ── Current mail first: delta, then any history-expired gap ──
  const delta = await drainGmailDelta(g, cutoffMs);
  if (delta === 'aborted') return false;
  if (state.gmail_gap_floor_ms != null) {
    const gap = await walkGmailWindow(g, 'gmail_gap_floor_ms', state.gmail_gap_after_ms ?? cutoffMs);
    if (gap === 'aborted') return false;
    if (gap === 'done') {
      state.gmail_gap_after_ms = null;
      state.gmail_gap_floor_ms = null;
          await saveGoogleState(deps, state);
    }
  }
  currentDrained = delta === 'done' && state.gmail_gap_floor_ms == null;
  }
  // Held threads no listing of this run reached: re-attempt those retry-held
  // asked for or whose transient reconsideration is due. A failure keeps the
  // hold and never blocks the cursor.
  for (const tid of g.holds.dueHeldKeys().filter(isGmailHoldKey)) {
    if (deps.opts.signal?.aborted) return false;
    await attemptThread(g, tid, null, cutoffMs);
  }
  if (await settleGraceHolds(g, cutoffMs) === 'aborted') return false;
  const isCurrent = (): boolean => {
    if (!currentDrained) return false;
    if (state.gmail_backfill_done) return true;
    const floor = state.gmail_backfill_floor_ms;
    if (floor == null || state.gmail_newest_ms == null) return false;
    return floor <= Math.max(cutoffMs, state.gmail_newest_ms - GMAIL_RECENT_HORIZON_MS);
  };
  // Stamp freshness BEFORE the backfill spends the rest of the budget: a
  // managed sweep cannot write once its wall-clock signal aborts.
  if (!state.gmail_backfill_done && isCurrent()) await onCurrent?.();

  // ── Historical backfill (resumable, oldest mail last) ──
  if (!state.gmail_backfill_done) {
    const backfill = await walkGmailWindow(g, 'gmail_backfill_floor_ms', cutoffMs);
    if (backfill === 'done') {
      state.gmail_backfill_done = true;
      state.gmail_backfill_cutoff_ms = Math.min(cutoffMs, state.gmail_backfill_floor_ms ?? cutoffMs);
      state.gmail_backfill_floor_ms = null;
      await saveGoogleState(deps, state);
    }
  }
  return isCurrent();
}

/** Window mode re-lists this far below the newest landed message, so mail that arrived late is not missed. */
const WINDOW_OVERLAP_MS = 60 * 60_000;
/** Window mode remembers landed threads this long; an older thread that changes is simply fetched again. */
const WINDOW_SEEN_KEEP_MS = 3 * 86_400_000;

/**
 * Window mode (a reader with no change feed): current mail is the window from
 * an hour below the newest landed message up to now, listed again every run
 * and drained newest to oldest with the resumable floor walk. Unchanged
 * threads are skipped through gmail_window_seen. Before the first backfill has
 * started there is nothing to refresh: the backfill itself starts at now.
 */
async function walkRecentWindow(g: GmailSweep, cutoffMs: number): Promise<WalkOutcome> {
  const { deps, state } = g;
  const now = Date.now();
  const seen = state.gmail_window_seen ?? {};
  for (const [tid, entry] of Object.entries(seen)) if (!(entry.ms >= now - WINDOW_SEEN_KEEP_MS)) delete seen[tid];
  state.gmail_window_seen = seen;
  if (!state.gmail_backfill_done && state.gmail_backfill_floor_ms == null) return 'done';
  const after = Math.max(cutoffMs, (state.gmail_newest_ms ?? state.gmail_backfill_floor_ms ?? cutoffMs) - WINDOW_OVERLAP_MS);
  // A window an earlier run could not finish keeps its lower bound; its floor restarts at now so new mail comes first.
  state.gmail_gap_after_ms = Math.min(state.gmail_gap_after_ms ?? after, after);
  state.gmail_gap_floor_ms = now + 60_000;
  const outcome = await walkGmailWindow(g, 'gmail_gap_floor_ms', state.gmail_gap_after_ms);
  if (outcome === 'done') {
    state.gmail_gap_after_ms = null;
    state.gmail_gap_floor_ms = null;
    await saveGoogleState(deps, state);
  }
  return outcome;
}

/**
 * Entries added to the private-senders list since the pages were last tiered:
 * every page of this source with one of them among its participants is fetched
 * and written again, so it becomes private. The list's hashes are banked only
 * when every such page was rewritten.
 */
const RETIER_MAX_THREADS = 200;

async function retierPrivatePages(g: GmailSweep): Promise<'aborted' | void> {
  const { deps, state } = g;
  const list = deps.privateSenders!;
  const banked = new Set(state.private_senders_hashes ?? []);
  if (list.hashes.length === banked.size && list.hashes.every((h) => banked.has(h))) return;
  const addresses = [...list.addresses].filter((a) => !banked.has(entryHash(a)));
  const domains = [...list.domains].filter((d) => !banked.has(entryHash('@' + d)));
  let rows: Array<{ slug: string; source_path: string | null; tid: string | null }> = [];
  if (addresses.length > 0 || domains.length > 0) {
    rows = await deps.engine.executeRaw<{ slug: string; source_path: string | null; tid: string | null }>(
      `SELECT slug, source_path, frontmatter->>'thread_id' AS tid FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'emails/%'
          AND NOT (COALESCE(frontmatter->>'visibility', '') = 'private' AND COALESCE(frontmatter->>'extract_atoms', '') = 'false'
                   AND COALESCE(frontmatter->>'facts_backstop', '') = 'false')
          AND jsonb_typeof(frontmatter->'participants') = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(frontmatter->'participants') a
                       WHERE lower(a) = ANY($2::text[]) OR split_part(lower(a), '@', 2) = ANY($3::text[]))`,
      [deps.sourceId, addresses, domains],
    );
  }
  const byThread = new Map<string, Array<{ slug: string; source_path: string | null }>>();
  for (const r of rows) {
    if (!r.tid || !/^[A-Za-z0-9]{1,128}$/.test(r.tid)) continue;
    byThread.set(r.tid, [...(byThread.get(r.tid) ?? []), { slug: r.slug, source_path: r.source_path }]);
  }
  let failed = 0;
  let limited = false;
  let failure: string | null = null;
  let rewritten = 0;
  let unsettled = 0;
  for (const [tid, threadPages] of [...byThread].slice(0, RETIER_MAX_THREADS)) {
    if (deps.opts.signal?.aborted) return 'aborted';
    const seen: { tier?: IngestTier; slug?: string | null } = {};
    try {
      await processThread(deps, g.gmail, tid, g.activePack, g.summary, g.countedSlugs, seen);
    } catch (e) {
      if (e instanceof GoogleCursorExpiredError && e.status === 404) {
        unsettled++;
        deps.log(`[google] thread ${tid} was not found while re-tiering; its page(s) ${threadPages.map((p) => p.slug).join(', ')} are kept as they are and it is retried next sweep`);
        continue;
      }
      if (deps.managed) rethrowConnectorWriteError(e);
      failed++;
      deps.log(`[google] re-tiering thread ${tid} as private failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
      if (isUsageLimit(e)) { limited = true; break; }
      failure = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (typeof seen.slug !== 'string') {
      unsettled++;
      deps.log(`[google] thread ${tid} was read but no page was rewritten while re-tiering; it is retried next sweep`);
      continue;
    }
    rewritten++;
    const moved = threadPages.filter((p) => p.slug !== seen.slug);
    if (moved.length > 0) g.summary.deleted += await deleteEmailPages(deps, moved);
  }
  if (rewritten > 0) {
    deps.log(`[google] ${rewritten} page(s) rewritten as private after the private-senders list grew; on a git-backed brain, earlier commits still hold their previous text`);
  }
  if (failed > 0) {
    if (limited) g.summary.limitStopped = true;
    if (failure !== null) markPartial(g.summary, `private re-tier failed: ${failure}`);
    return;
  }
  if (unsettled > 0) return;
  if (byThread.size > RETIER_MAX_THREADS) {
    deps.log(`[google] re-tiered ${RETIER_MAX_THREADS} of ${byThread.size} threads as private; the rest continue next sweep`);
    return;
  }
  state.private_senders_hashes = [...list.hashes];
  await saveGoogleState(deps, state);
}

/**
 * #5868: seeds the one-shot grace backfill, then settles due grace holds.
 * A re-fetch goes straight through processThread (never the item holds), so
 * a failed grace re-fetch keeps the grace hold and is not an item failure.
 */
async function settleGraceHolds(g: GmailSweep, cutoffMs: number): Promise<'aborted' | void> {
  const { deps, state } = g;
  try {
    await seedGraceBackfill(deps.engine, deps.sourceId, state, deps.log);
    deps.graceBackfillSeeded = true;
  } catch (e) {
    deps.log(`[google] loop grace backfill failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await seedLoopRechecks(deps.engine, deps.sourceId, state, deps.log, Date.now(), state.gmail_backfill_done ? null : cutoffMs);
  } catch (e) {
    deps.log(`[google] loop re-check seeding failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
  }
  const settled = await settleDueGraceHolds({ engine: deps.engine, sourceId: deps.sourceId, state, log: deps.log, signal: deps.opts.signal,
    exclusion: deps.exclusion, processed: deps.processedThreads, refetch: async (tid) => {
      try {
        await processThread(deps, g.gmail, tid, g.activePack, g.summary, g.countedSlugs);
        return 'ok';
      } catch (e) {
        if (e instanceof GoogleCursorExpiredError && e.status === 404) return 'gone';
        if (deps.managed) rethrowConnectorWriteError(e);
        deps.log(`[google] grace re-check of thread ${tid} failed (kept for the next sweep): ${e instanceof Error ? e.message : String(e)}`);
        return 'failed';
      }
    } });
  if (settled === 'aborted') return 'aborted';
}

/** Opens (or widens) the gap window `[after, floor)` that the floor walk drains newest→oldest. */
function openGmailGap(state: GoogleSourceState, cutoffMs: number): void {
  const after = (state.gmail_newest_ms ?? cutoffMs) - 86_400_000;
  state.gmail_gap_after_ms = Math.min(state.gmail_gap_after_ms ?? after, after);
  state.gmail_gap_floor_ms ??= Date.now() + 60_000;
}

async function drainGmailDelta(g: GmailSweep, cutoffMs: number): Promise<WalkOutcome> {
  const { deps, gmail, state } = g;
  let threadIds: string[] = [];
  let newHistoryId: string | null = null;
  let truncated = false;
  let versions = new Map<string, string>();
  const parked = state.gmail_pending_thread_ids ?? [];
  // Room left under the pending cap; a full pending set drains before any new history is listed.
  const room = gmailPendingCap.ids - parked.length;
  if (room > 0) {
    try {
      ({ threadIds, newHistoryId, truncated, versions } = await gmail.listHistoryThreadIds(state.gmail_history_id!, {
        maxThreads: room, ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
      }));
    } catch (e) {
      if (!(e instanceof GoogleCursorExpiredError)) throw e;
      // History expired (~1 week idle, or a long backfill): re-anchor NOW and
      // open a gap from the newest imported message to the anchor. Anchor and
      // gap persist together: a message arriving after the anchor is replayed
      // by history.list, one before it lies inside the gap.
      deps.log('[google] historyId expired; re-anchoring and draining the gap by window');
      const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
      state.gmail_gap_floor_ms = null;
      openGmailGap(state, cutoffMs);
      state.gmail_history_id = profile.historyId;
      await saveGoogleState(deps, state);
    }
  } else {
    // A full pending set drains before any new history is listed: current mail is not yet checked.
    truncated = true;
  }
  if (truncated) deps.log(`[google] history delta over the ${gmailPendingCap.ids}-thread pending cap; draining it in bounded batches`);
  let merged = [...new Set([...parked, ...threadIds])];
  // A pathological id set over the byte cap never advances the anchor: only the parked ids drain.
  if (!fitsPendingCap(merged)) { newHistoryId = null; truncated = true; merged = parked; threadIds = []; }
  // A thread flagged by this listing changed upstream (even when it is also parked): its hold may re-admit it.
  const fromHistory = new Set(threadIds);
  // `unlanded` shrinks as threads land or are dropped (404) or held.
  const unlanded = new Set(merged);
  // Bank drain progress: advancing the anchor is safe because every flagged
  // thread not yet landed stays parked (within the cap).
  const checkpoint = async (): Promise<void> => {
    if (newHistoryId) state.gmail_history_id = newHistoryId;
    state.gmail_pending_thread_ids = [...unlanded];
    await saveGoogleState(deps, state);
  };
  // A managed sweep cannot write once its signal aborts (the lease refuses),
  // so it banks as soon as its first thread lands and then once per batch; an
  // abort then repeats at most one batch. A run that lands nothing writes no
  // checkpoint, so a failed drain leaves the cursor where it was.
  let failed = 0;
  let landedSinceCheckpoint = deps.managed ? BACKFILL_BATCH_THREADS - 1 : 0;
  for (const tid of merged) {
    if (deps.opts.signal?.aborted) {
      if (!deps.managed) await checkpoint();
      return 'aborted';
    }
    // Thread-specific version (the latest history record touching it), so unrelated mail never resets a count.
    const version = fromHistory.has(tid) && versions.get(tid) ? `history:${versions.get(tid)}` : null;
    const outcome = await attemptThread(g, tid, version, cutoffMs);
    if (outcome.kind === 'failed' || outcome.kind === 'rate_limited') {
      failed++;
      // Per-user quota: the remaining threads would burn the client's retry
      // budget against the same exhausted window; they stay parked.
      if (outcome.kind === 'rate_limited') break;
      continue;
    }
    unlanded.delete(tid);
    if (outcome.kind === 'landed' && (failed === 0 || deps.managed) && ++landedSinceCheckpoint >= BACKFILL_BATCH_THREADS) {
      landedSinceCheckpoint = 0;
      await checkpoint();
    }
  }
  if (deps.opts.signal?.aborted) {
    if (!deps.managed) await checkpoint();
    return 'aborted';
  }
  state.gmail_pending_thread_ids = [...unlanded];
  // Unmanaged: the delta cursor advances only when every flagged thread
  // landed — a partial drain re-lists the same window next run (idempotent).
  // A managed sweep that landed a thread already advanced it, parking the rest.
  if (failed === 0 && newHistoryId) state.gmail_history_id = newHistoryId;
  // Bank a clean batch even when nothing landed (every thread gone or held), or a bounded
  // batch of deleted threads would be re-listed forever on a managed brain. A batch with a
  // failure keeps the cursor its checkpoints committed.
  if (deps.managed && failed === 0) await saveGoogleState(deps, state);
  // A bounded batch is not a drained delta: current mail is complete only once the listing is not truncated.
  return failed !== 0 ? 'failed' : truncated ? 'more' : 'done';
}

// ── Full reconcile (deletes) ─────────────────────────────────────────────────

async function reconcileGmailDeletes(
  deps: GoogleSyncDeps,
  gmail: GmailReader,
  summary: GoogleSyncSummary,
): Promise<void> {
  // Enumerate the live window; anything under emails/ not in it vanished
  // (trash/spam/deleted). Only runs when enumeration fully succeeded — an
  // errored listing must never read as a bulk deletion.
  const cutoffSec = Math.floor((Date.now() - deps.cfg.historyDays * 86_400_000) / 1000);
  const ids = await gmail.listMessageIds(`after:${cutoffSec}`, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  const liveThreads = new Set(ids.map((m) => m.threadId));
  const rows = await deps.engine.executeRaw<{ slug: string; source_path: string | null; frontmatter: unknown }>(
    `SELECT slug, source_path, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'emails/%'`,
    [deps.sourceId],
  );
  const stale: Array<{ slug: string; source_path: string | null }> = [];
  for (const r of rows) {
    const fm =
      typeof r.frontmatter === 'string'
        ? (JSON.parse(r.frontmatter) as Record<string, unknown>)
        : ((r.frontmatter ?? {}) as Record<string, unknown>);
    const tid = typeof fm.thread_id === 'string' ? fm.thread_id : null;
    const firstIso = typeof fm.first_message_date === 'string' ? fm.first_message_date : null;
    // Pages older than the window are out of enumeration scope — keep them.
    if (firstIso && Date.parse(firstIso) / 1000 < cutoffSec) continue;
    if (tid && !liveThreads.has(tid)) stale.push({ slug: r.slug, source_path: r.source_path });
  }
  if (stale.length === 0) return;
  const { massReconcileAllowed } = await import('../../commands/sync.ts');
  if (stale.length > 200 && !massReconcileAllowed()) {
    deps.log(`[google] mass-delete guard refused ${stale.length} deletes for source ${deps.sourceId}`);
    return;
  }
  summary.deleted += await deleteEmailPages(deps, stale);
}

async function deleteEmailPages(deps: GoogleSyncDeps, pages: Array<{ slug: string; source_path: string | null }>): Promise<number> {
  if (deps.managed) {
    let deleted = 0;
    for (const page of pages) if (await deps.managed.delete(page.slug, page.source_path)) deleted++;
    return deleted;
  }
  await deps.engine.deletePages(pages.map((p) => p.slug), { sourceId: deps.sourceId });
  for (const p of pages) {
    if (!p.source_path) continue;
    // Containment guard mirrors the write path (defense-in-depth on DB rows).
    const target = join(deps.cfg.dir, p.source_path);
    if (isWriteTargetContained(target, deps.cfg.dir)) rmSync(target, { force: true });
  }
  return pages.length;
}

// ── Extract + embed (mirrors github-source's size-gated tail) ───────────────

async function runExtractAndEmbed(
  deps: GoogleSyncDeps,
  summary: GoogleSyncSummary,
): Promise<void> {
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
      // Stamp only the slugs both hooks actually read from disk; a page the
      // extractor skipped stays stale for 'gbrain extract --stale'.
      await stampExtracted(
        deps.engine,
        slugsSafeToStamp(linksResult, timelineResult)
          .map((slug) => ({ slug, source_id: deps.sourceId })),
      );
    } catch { /* extraction is best-effort */ }
  } else if (totalChanges > 100 && !deps.opts.noExtract) {
    process.stderr.write(`[google] large sync (${totalChanges} pages); extraction deferred to 'gbrain extract --stale --source-id ${deps.sourceId}'\n`);
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
      const sub = await submitEmbedBackfill(deps.engine, deps.sourceId, { reason: 'google_sync_defer' });
      if (sub.status === 'submitted') {
        process.stderr.write(`[google] large sync (${totalChanges} pages); embeds deferred to embed-backfill job ${sub.jobId} — or ${drainHint}\n`);
      } else if (sub.status === 'embedding_disabled') {
        process.stderr.write(`[google] large sync (${totalChanges} pages); embed-backfill not queued: embedding is disabled on this brain (keyless by choice)\n`);
      } else {
        process.stderr.write(`[google] large sync (${totalChanges} pages); embed-backfill not queued (${sub.status}) — ${drainHint}\n`);
      }
    } catch (err) {
      process.stderr.write(`[google] embed-backfill submission failed: ${err instanceof Error ? err.message : String(err)} — ${drainHint}\n`);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runGoogleSync(
  engine: BrainEngine,
  sourceId: string,
  cfg: GoogleSourceConfig,
  opts: SyncOpts,
  fetchImpl?: FetchImpl,
  vaultOverride?: CredentialVault,
): Promise<SyncResult> {
  return withConnectorSync(engine, sourceId, 'google', cfg, opts,
    async (managed, options) => options.dryRun ? connectorDryRunResult('google', sourceId) : runGoogleSyncInner(engine, sourceId, cfg, options, managed, fetchImpl, vaultOverride), pendingConnectorResult);
}

/**
 * Access resolution: the vault is the default; command/env modes let a stack that already holds Google access drive
 * the source without gbrain's own OAuth flow, and gbrainio reads Gmail through a gbrain.io terminal with no Google
 * token at all. Non-vault modes synthesize a minimal identity entry (no meta.scopes, so the scope preflight trusts
 * cfg.services; sendas aliases best-effort; account from the source config).
 */
async function resolveSyncAccess(cfg: GoogleSourceConfig, opts: SyncOpts, log: (msg: string) => void, fetchImpl?: FetchImpl,
  vaultOverride?: CredentialVault): Promise<{ entry: CredentialEntry; tokens: GoogleAccessProvider; reader: GbrainioGmailReader | null }> {
  let entry: CredentialEntry;
  let tokens: GoogleAccessProvider;
  let reader: GbrainioGmailReader | null = null;
  if (cfg.access === 'gbrainio') {
    // gbrain.io holds the mailbox grant; gbrain holds no Google token, so any Google API call is refused.
    const noToken = async (): Promise<string> => { throw new CredentialError('gbrainio_unsupported', ' (no Google token on a gbrain.io source)'); };
    tokens = { getAccessToken: noToken, forceRefresh: noToken };
    reader = new GbrainioGmailReader(cfg.gbrainioCommand ?? 'gbrainio', cfg.account, log);
    entry = {
      id: credentialId(GOOGLE_PROVIDER, cfg.account),
      provider: GOOGLE_PROVIDER,
      kind: 'bearer',
      client_ref: 'byo',
      secret: {},
      meta: { account: cfg.account, connected_at: new Date().toISOString() },
    };
    const aliases = await reader.sendAsAliases(opts.signal ? { signal: opts.signal } : {});
    if (aliases.length > 0) entry.meta.sendas_aliases = aliases;
  } else if (cfg.access === 'command' || cfg.access === 'env') {
    tokens =
      cfg.access === 'command'
        ? new CommandAccessProvider(cfg.tokenCommand ?? '')
        : new EnvAccessProvider(cfg.tokenEnv ?? '');
    entry = {
      id: credentialId(GOOGLE_PROVIDER, cfg.account),
      provider: GOOGLE_PROVIDER,
      kind: 'bearer',
      client_ref: 'byo',
      secret: {},
      meta: { account: cfg.account, connected_at: new Date().toISOString() },
    };
    try {
      // sendAs aliases sharpen "is this message mine" (loop direction). The
      // token may not carry the settings scope — degrade to account-only.
      const aliases = await fetchSendAsAliases(await tokens.getAccessToken(), fetchImpl ?? fetch);
      if (aliases.length > 0) entry.meta.sendas_aliases = aliases;
    } catch { /* account-only identity */ } // silent-read-ok: the token may lack the Gmail settings scope; identity then falls back to the account address alone
  } else {
    const vault = vaultOverride ?? openVault();
    const vaultEntry = await vault.get(credentialId(GOOGLE_PROVIDER, cfg.account));
    if (!vaultEntry) {
      throw new CredentialError('not_connected', ` for ${cfg.account} — run: gbrain google connect --account ${cfg.account}`);
    }
    entry = vaultEntry;
    tokens = new GoogleTokenProvider(vault, entry.id, fetchImpl ?? fetch);
  }
  return { entry, tokens, reader };
}

async function runGoogleSyncInner(engine: BrainEngine, sourceId: string, cfg: GoogleSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, fetchImpl?: FetchImpl, vaultOverride?: CredentialVault): Promise<SyncResult> {
  if (!cfg.account) {
    throw new Error(
      `Google source "${sourceId}" has no account configured. Re-add it: gbrain sources add ${sourceId} --kind google --account <email>`,
    );
  }
  const log = (msg: string): void => {
    process.stderr.write(msg + '\n');
  };
  // GST-3452: a usage limit already spent before any mail is read (gbrain.io answers the identity reads too) stops the run
  // as a usage limit with nothing written, so the next sync resumes; any other failure here still throws.
  const usageLimitStop = (e: unknown): SyncResult => {
    log(`[google] stopped at a usage limit before reading mail: ${e instanceof Error ? e.message : String(e)}; the next sync resumes`);
    return { status: 'partial', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0,
      pagesAffected: [], stopped_on: 'usage_limit' };
  };
  let access: Awaited<ReturnType<typeof resolveSyncAccess>>;
  try {
    access = await resolveSyncAccess(cfg, opts, log, fetchImpl, vaultOverride);
  } catch (e) {
    if (isUsageLimit(e)) return usageLimitStop(e);
    throw e;
  }
  const { entry, tokens, reader } = access;
  const clientArgs = [tokens, fetchImpl ?? fetch, log, entry.meta.client_id] as const;
  const gmail: GmailReader = reader ?? new GmailClient(...clientArgs);
  const calendar = new CalendarClient(...clientArgs);
  const people = new PeopleClient(...clientArgs);
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  const tick = (note: string): void => progress.tick(1, note);
  // A configured private-senders list that cannot be read stops the run here, before any page is written.
  const privateSenders = cfg.privateSendersFile ? loadPrivateSenders(cfg.privateSendersFile) : null;
  const deps: GoogleSyncDeps = { engine, sourceId, cfg, opts, entry, log, tick, exclusion: NO_EXCLUSION, extractCandidates: [], managed, processedThreads: new Set(),
    privateSenders };

  const summary: GoogleSyncSummary = {
    status: 'synced',
    added: 0,
    modified: 0,
    deleted: 0,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    threadsSeen: 0,
    attachmentInspection: {},
    extractEligibility: {},
    loopsWithheld: {},
    failedFiles: 0,
  };
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

  // Scope preflight: a source configured for a service the credential's
  // grant doesn't cover (connect --scopes gmail, source defaults to all
  // three) must fail that service with the catalog's scope_missing fix —
  // not an opaque per-sweep 403 forever.
  const grantedScopes = entry.meta.scopes ?? [];
  const scopeFor: Record<GoogleService, string> = {
    gmail: 'https://www.googleapis.com/auth/gmail.readonly',
    calendar: 'https://www.googleapis.com/auth/calendar.readonly',
    contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  };
  const grantedServices = cfg.services.filter((svc) => grantedScopes.includes(scopeFor[svc]));
  const missingServices = cfg.services.filter((svc) => !grantedScopes.includes(scopeFor[svc]));
  if (grantedScopes.length > 0 && missingServices.length > 0) {
    if (managed) throw new CredentialError('scope_missing', undefined, `services without grant: ${missingServices.join(', ')}`);
    log(new CredentialError('scope_missing', undefined, `services without grant: ${missingServices.join(', ')}`).toHuman());
  }
  const activeServices = grantedScopes.length > 0 ? grantedServices : cfg.services;
  // #5686: every enabled service reads as the pinned account; checked before any service runs.
  if (managed && reader) {
    // Every gbrain.io answer names its mailbox and the reader refuses a mismatch; the profile read proves the terminal answers.
    try {
      await reader.getProfile(opts.signal ? { signal: opts.signal } : {});
    } catch (e) {
      if (isUsageLimit(e)) return usageLimitStop(e);
      throw e;
    }
    await managed.assertAccount({ kind: 'google', email: cfg.account });
  } else if (managed) {
    const { email } = await resolveGoogleAccount({ gmail: gmail as GmailClient, calendar, people, userinfo: googleUserinfo(tokens, fetchImpl ?? fetch) }, activeServices, opts.signal);
    await managed.assertAccount(email ? { kind: 'google', email } : null);
  }

  const state = managed ? managed.state(emptyState()) : readGoogleState(cfg.dir);
  deps.loopState = state;
  const firstRun = !state.gmail_backfill_done && state.gmail_history_id === null;
  // Fix wave 4: the Gmail poison ledger is read once and carried into the item holds.
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyState() as unknown as Record<string, unknown>,
    carryLegacyFailCounts(state.item_holds, state.gmail_fail_counts, (id) => id, new Date().toISOString()), { full: opts.full });
  state.item_holds = holds.holds.initial();
  delete state.gmail_fail_counts;
  progress.start('sync.google_materialize');

  try {
    const serviceErrors: string[] = [];
    // #7073: services this run could not reach, and those it reached, for the stored api_access record.
    const apiProblems: GoogleApiProblem[] = (grantedScopes.length > 0 ? missingServices : []).flatMap((svc) => googleApiProblem(svc, new CredentialError('scope_missing')) ?? []);
    const reached = new Set<GoogleService>();
    const serviceFailed = (svc: GoogleService, e: unknown): void => {
      const problem = googleApiProblem(svc, e);
      if (problem) apiProblems.push(problem);
    };

    if (activeServices.includes('contacts')) {
      const stop = startHeartbeat(progress, 'contacts sweep');
      try {
        await sweepContacts(deps, people, state, activePack, summary, countedSlugs, holds, () => saveGoogleState(deps, state));
        reached.add('contacts');
      } catch (e) {
        if (managed) rethrowConnectorWriteError(e);
        serviceFailed('contacts', e);
        serviceErrors.push(`contacts: ${e instanceof Error ? e.message : String(e)}`);
        if (isUsageLimit(e)) summary.limitStopped = true;
        else markPartial(summary, `contacts sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] contacts sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    if (activeServices.includes('calendar')) {
      const stop = startHeartbeat(progress, 'calendar sweep');
      try {
        await sweepCalendar(deps, calendar, state, activePack, summary, countedSlugs, holds);
        reached.add('calendar');
      } catch (e) {
        if (managed) rethrowConnectorWriteError(e);
        serviceFailed('calendar', e);
        serviceErrors.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
        if (isUsageLimit(e)) summary.limitStopped = true;
        else markPartial(summary, `calendar sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] calendar sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    let gmailSweepOk = !activeServices.includes('gmail'); // gmail not active = not gating freshness
    if (activeServices.includes('gmail')) {
      const stop = startHeartbeat(progress, 'gmail sweep');
      try {
        deps.exclusion = await resolveSweepExclusion(deps, gmail);
        // sweepGmail reports thread-level failures via its return value —
        // they exit through normal returns, not throws, and stamping
        // last_sync_at over them would blind the staleness gate (H1).
        gmailSweepOk = await sweepGmail({ deps, gmail, state, activePack, summary, countedSlugs, holds, walked: new Set() }, async () => {
          // #5581: current mail is complete but the backfill is not: bank freshness now, while the managed lease can still write.
          if (managed && summary.status !== 'partial' && !summary.limitStopped && !opts.signal?.aborted) {
            await managed.saveState(state, true, new Date(state.gmail_newest_ms ?? Date.now()).toISOString());
          }
        });
        reached.add('gmail');
        if (summary.ingestTiers) log(`[google] ingest tiers: ${Object.entries(summary.ingestTiers).map(([tier, n]) => `${tier}=${n}`).join(' ')}`);
        // A delete scan lists the whole window in one go; gbrain.io sources read by window and keep pages of deleted mail.
        if (opts.full && !gmail.supportsHistory) log('[google] --full delete reconcile skipped: this source reads mail through gbrain.io');
        else if (opts.full) await reconcileGmailDeletes(deps, gmail, summary);
      } catch (e) {
        if (managed) rethrowConnectorWriteError(e);
        serviceFailed('gmail', e);
        serviceErrors.push(`gmail: ${e instanceof Error ? e.message : String(e)}`);
        if (isUsageLimit(e)) summary.limitStopped = true;
        else markPartial(summary, `gmail sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] gmail sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    summary.pagesAffected = [...new Set(summary.pagesAffected)];
    const settled = new Set<GoogleService>([...reached, ...apiProblems.map((p) => p.service)]);
    const keptProblems = (state.api_access?.problems ?? []).filter((p) => !settled.has(p.service) && cfg.services.includes(p.service));
    const problems = [...apiProblems, ...keptProblems];
    if (problems.length > 0 && JSON.stringify(problems) !== JSON.stringify(state.api_access?.problems)) state.api_access = { problems, at: new Date().toISOString() };
    else if (problems.length === 0 && state.api_access) state.api_access = null;
    if (grantedScopes.length > 0 && missingServices.length > 0) markPartial(summary, `no granted scope for ${missingServices.join(', ')}`);
    if (opts.signal?.aborted) markPartial(summary, 'run aborted');
    const stoppedOnUsageLimit = summary.limitStopped === true && summary.status === 'synced' && summary.failedFiles === (summary.limitedItems ?? 0);
    if (summary.limitStopped) markPartial(summary, 'usage limit reached');
    if (opts.full && summary.status === 'synced') state.last_full_at = new Date().toISOString();

    // #5867 managed-only 30-day catch-up and the #5868 one-shot backfill marker; never on an aborted sweep.
    let catchup: LoopsEnqueueReport | null = null;
    if (activeServices.includes('gmail') && !opts.signal?.aborted) {
      if (deps.graceBackfillSeeded) state.loop_grace_backfill_done = true;
      if (managed) {
        try {
          catchup = await runLoopsCatchup({ engine, sourceId, state, log, signal: opts.signal, myAddresses: myAddressSet(entry),
            exclusion: deps.exclusion, inFlight: new Set(deps.extractCandidates.map(c => c.slug)),
            fetchThread: async (tid) => {
              try { return await gmail.getThread(tid, cfg.account, opts.signal ? { signal: opts.signal } : {}); }
              catch (e) { if (e instanceof GoogleCursorExpiredError && e.status === 404) return null; throw e; }
            } });
        } catch (e) {
          log(`[google] loops catch-up failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Per-service cursors were advanced in-place only on success; persist.
    // Throws connector_holds_exhausted before any save, so the cursor stays.
    if (managed && !opts.signal?.aborted) await forgetRefusedPurgedThreads(deps, managed, state);
    state.item_holds = holds.finish();
    if (managed) {
      if (summary.status !== 'partial' && gmailSweepOk) await managed.saveState(state, true, new Date(state.gmail_newest_ms ?? Date.now()).toISOString());
      // A partial run keeps the cursor its mid-run checkpoints committed and publishes changed holds plus the loop recovery state (#5867/#5868).
      else if (!opts.signal?.aborted) await managed.publishHolds(emptyState() as unknown as Record<string, unknown>, state.item_holds, loopRecoveryState(state));
    } else writeGoogleState(cfg.dir, state);
    await holds.complete();
    // An aborted run (wall-clock budget, serve-delegation timeout) skips the
    // extract/embed/extraction tails — the deferred backfill machinery picks
    // them up on the next full run instead of overshooting the budget.
    let loopsEnqueue: LoopsEnqueueReport | undefined;
    if (!opts.signal?.aborted) {
      await runExtractAndEmbed(deps, summary);
      const enqueued = await enqueueLoopsExtraction(deps);
      loopsEnqueue = catchup ? { enqueued: enqueued.enqueued + catchup.enqueued, deferred: enqueued.deferred + catchup.deferred,
        skipped_reason: enqueued.skipped_reason } : enqueued;
      // Auditable per-reason counts (loopExtractionEligibility) — no
      // addresses, subjects or body text ever reach the log.
      if (Object.keys(summary.extractEligibility).length > 0) {
        log(
          `[google] loops_extract eligibility: ${Object.entries(summary.extractEligibility)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
      }
      if (Object.keys(summary.loopsWithheld).length > 0) {
        log(`[google] reply-owed loops withheld: ${Object.entries(summary.loopsWithheld).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
    }

    // Commitment-loop staleness pass (v1 close semantics): overdue >14d or
    // >90d inactive → 'stale'. Cheap indexed UPDATE, once per sweep.
    try {
      const { markStaleLoops } = await import('../loops/loops-store.ts');
      await markStaleLoops(engine, sourceId);
    } catch { /* best-effort */ }

    // last_sync_at feeds the trust-critical staleness gate (`gbrain waiting`
    // refuses on stale sources). A sync whose GMAIL sweep failed did not
    // refresh the loops' data — stamping it would let a revoked token +
    // frequent cron keep the gate green forever (red-team F2 bypass).
    if (gmailSweepOk && !managed) {
      try {
        await engine.executeRaw(
          `UPDATE sources SET last_sync_at = now(), newest_content_at = $1::timestamptz WHERE id = $2`,
          [new Date(state.gmail_newest_ms ?? Date.now()).toISOString(), sourceId],
        );
      } catch { /* best-effort */ }
    }

    const changed = summary.added + summary.modified + summary.deleted > 0;
    if (activeServices.includes('gmail')) {
      log(`[google] attachment inspection (this sweep only): ${Object.entries(summary.attachmentInspection).map(([state, count]) => `${state}=${count}`).join(' ') || 'no messages inspected'}; historical completeness is not established by incremental sync.`);
    }
    return {
      status:
        summary.status === 'partial'
          ? 'partial'
          : firstRun && changed
            ? 'first_sync'
            : changed
              ? 'synced'
              : 'up_to_date',
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
      ...(stoppedOnUsageLimit && !holds.summary().held ? { stopped_on: 'usage_limit' as const } : {}),
      ...(summary.status === 'partial' && summary.partialCauses?.length ? { partial_causes: summary.partialCauses } : {}),
      ...(loopsEnqueue ? { loops_enqueue: loopsEnqueue } : {}),
      ...connectorHoldsResult(sourceId, holds.summary()),
    };
  } finally {
    progress.finish();
  }
}
