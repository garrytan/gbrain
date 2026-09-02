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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { CredentialError, isCredentialError } from '../creds/errors.ts';
import { GOOGLE_PROVIDER, GoogleTokenProvider, fetchSendAsAliases } from '../creds/providers/google.ts';
import { CommandAccessProvider, EnvAccessProvider, type GoogleAccessProvider } from './access.ts';
import { credentialId, openVault, type CredentialEntry, type CredentialVault } from '../creds/vault.ts';
import { createProgress, startHeartbeat } from '../progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../cli-options.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import {
  CalendarClient,
  GmailClient,
  GoogleCursorExpiredError,
  PeopleClient,
  type FetchImpl,
} from './google-clients.ts';
import {
  calendarRelPath,
  personSlugFromContact,
  renderCalendarEventPage,
  renderPersonPage,
  renderThreadPage,
} from './google-render.ts';
import {
  ALL_GOOGLE_SERVICES,
  DEFAULT_CALENDAR_ID,
  type GmailThreadData,
  type GoogleService,
  type GoogleSourceConfig,
  type GoogleSourceState,
} from './types.ts';
import { LOOPS_EXTRACT_WINDOW_DAYS, loopExtractionEligibility } from './loops-extract.ts';

export type { GoogleSourceConfig } from './types.ts';

// ── Config ───────────────────────────────────────────────────────────────────

const G_KIND = 'google';

export function isGoogleSourceConfig(config: Record<string, unknown>): boolean {
  return config.kind === G_KIND;
}

export function parseGoogleSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GoogleSourceConfig {
  const account =
    typeof config.g_account === 'string' ? config.g_account.trim().toLowerCase() : '';
  const services =
    typeof config.g_services === 'string'
      ? (config.g_services
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s): s is GoogleService => (ALL_GOOGLE_SERVICES as string[]).includes(s)))
      : [...ALL_GOOGLE_SERVICES];
  const historyDays =
    typeof config.g_history_days === 'number' &&
    Number.isFinite(config.g_history_days) &&
    config.g_history_days > 0
      ? Math.min(3650, Math.floor(config.g_history_days))
      : 90;
  const calendarId =
    typeof config.g_calendar_id === 'string' && config.g_calendar_id.trim().length > 0
      ? config.g_calendar_id.trim()
      : DEFAULT_CALENDAR_ID;
  const dir =
    typeof config.g_dir === 'string' && config.g_dir.length > 0 ? config.g_dir : fallbackDir;
  const access =
    config.g_access === 'command' || config.g_access === 'env' ? config.g_access : 'vault';
  return {
    account,
    services: services.length > 0 ? services : [...ALL_GOOGLE_SERVICES],
    historyDays,
    calendarId,
    dir,
    access,
    ...(typeof config.g_token_command === 'string' && config.g_token_command.trim()
      ? { tokenCommand: config.g_token_command }
      : {}),
    ...(typeof config.g_token_env === 'string' && config.g_token_env.trim()
      ? { tokenEnv: config.g_token_env }
      : {}),
  };
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
    try {
      renameSync(file, `${file}.corrupt`);
    } catch { /* best-effort */ }
    process.stderr.write(
      `[google] state file ${file} was corrupt (${e instanceof Error ? e.message : String(e)}); ` +
        `quarantined to .corrupt — cursors reset, the next sync re-anchors and resumes.\n`,
    );
    return emptyState();
  }
}

function writeGoogleState(dir: string, state: GoogleSourceState): void {
  mkdirSync(dir, { recursive: true });
  // Atomic (tmp+fsync+rename): this file is written once per backfill batch;
  // a torn write would silently reset every cursor (full re-backfill).
  atomicWriteFileSync(googleStateFile(dir), JSON.stringify(state, null, 2));
}

/** The "my addresses" identity set: account + Gmail sendAs aliases. */
export function myAddressSet(entry: CredentialEntry): Set<string> {
  const out = new Set<string>();
  if (entry.meta.account) out.add(entry.meta.account.toLowerCase());
  for (const a of entry.meta.sendas_aliases ?? []) out.add(a.toLowerCase());
  return out;
}

// ── Sync runner ──────────────────────────────────────────────────────────────

interface GoogleSyncSummary {
  /** 'up_to_date'/'first_sync' are computed on the SyncResult, never here. */
  status: 'synced' | 'partial';
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  embedded: number;
  pagesAffected: string[];
  threadsSeen: number;
  /**
   * Why each in-window thread was or was not sent to the extractor, keyed by
   * the machine reason from loopExtractionEligibility. Counts only — no
   * addresses, subjects or body text — so a sweep can be audited for
   * over-filtering without leaking mail content into logs.
   */
  extractEligibility: Record<string, number>;
  failedFiles: number;
}

interface GoogleSyncDeps {
  engine: BrainEngine;
  sourceId: string;
  cfg: GoogleSourceConfig;
  opts: SyncOpts;
  entry: CredentialEntry;
  log: (msg: string) => void;
  /** Threads whose newest message falls in the recent window — LLM
   *  extraction candidates, enqueued (capped) after the sweep. */
  extractCandidates: Array<{ slug: string; threadId: string; newestMs: number }>;
}

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;

function assertContained(dir: string, path: string): void {
  if (!isWriteTargetContained(path, dir)) {
    throw new Error(`Path escapes managed dir: "${path}"`);
  }
}

async function importRendered(
  deps: GoogleSyncDeps,
  relPath: string,
  markdown: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<string> {
  const filePath = join(deps.cfg.dir, relPath);
  assertContained(deps.cfg.dir, filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const before = existsSync(filePath);
  // Temp-write → import → rename: a failed import never destroys the
  // previously-good page (github-source pattern).
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, markdown, 'utf-8');
  try {
    const { importFile } = await import('../import-file.ts');
    const result = await importFile(deps.engine, tmpPath, relPath, {
      noEmbed: true, // embeds handled by the size gate below, like sync
      sourceId: deps.sourceId,
      ...(activePack ? { activePack } : {}),
    });
    if (result.status === 'error' || result.error) {
      throw new Error(result.error ?? `Import failed for ${relPath}`);
    }
    renameSync(tmpPath, filePath);
    if (result.status === 'imported') {
      summary.pagesAffected.push(result.slug);
      summary.chunksCreated += result.chunks;
      if (!countedSlugs.has(result.slug)) {
        if (before) summary.modified++;
        else summary.added++;
        countedSlugs.add(result.slug);
      }
    }
    return result.slug;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

async function deletePageByRelPath(
  deps: GoogleSyncDeps,
  relPath: string,
  summary: GoogleSyncSummary,
): Promise<void> {
  const rows = await deps.engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL`,
    [deps.sourceId, relPath],
  );
  if (rows.length > 0) {
    await deps.engine.deletePages(rows.map((r) => r.slug), { sourceId: deps.sourceId });
    summary.deleted += rows.length;
  }
  // Same containment guard as the write path: a hostile/corrupt DB path
  // carrying `../` must never unlink outside the managed dir.
  const target = join(deps.cfg.dir, relPath);
  if (isWriteTargetContained(target, deps.cfg.dir)) rmSync(target, { force: true });
}

// ── Contacts sweep ───────────────────────────────────────────────────────────

async function sweepContacts(
  deps: GoogleSyncDeps,
  people: PeopleClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<void> {
  let result;
  try {
    result = await people.listConnections({
      syncToken: deps.opts.full ? null : state.contacts_sync_token,
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError) {
      deps.log('[google] contacts syncToken expired; full re-list');
      state.contacts_sync_token = null;
      result = await people.listConnections({ syncToken: null, ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    } else {
      throw e;
    }
  }
  // Ownership is keyed on google_contact_id, not path alone: a page owned by
  // a DIFFERENT contact (name collision — two "John Smith"s) must neither be
  // rewritten nor deleted; the colliding contact gets a disambiguated slug.
  const ownerOf = (relPath: string): string | null => {
    const filePath = join(deps.cfg.dir, relPath);
    if (!existsSync(filePath)) return null;
    const m = readFileSync(filePath, 'utf-8').match(/^google_contact_id:\s*"([^"]+)"/m);
    return m ? m[1] : 'hand-authored';
  };
  for (const c of result.contacts) {
    if (deps.opts.signal?.aborted) return;
    // DB lookup by contact id FIRST: deletion tombstones typically carry only
    // resourceName + deleted (no names/emails — slug derivation yields null),
    // and a renamed contact's current name derives a DIFFERENT slug than the
    // page it owns. Both cases need the id-keyed path (mirror of the calendar
    // sweep's event_id keying).
    const existingPath = await contactPageRelPathByContactId(deps, c.resourceName);
    if (c.deleted) {
      if (existingPath && ownerOf(existingPath) === c.resourceName) {
        await deletePageByRelPath(deps, existingPath, summary);
      } else {
        // Page not (yet) in the DB — fall back to slug candidates, guarded
        // by file ownership. Delete only the page THIS contact owns.
        for (const slug of [personSlugFromContact(c, false), personSlugFromContact(c, true)]) {
          if (slug && ownerOf(`${slug}.md`) === c.resourceName) {
            await deletePageByRelPath(deps, `${slug}.md`, summary);
          }
        }
      }
      continue;
    }
    const baseSlug = personSlugFromContact(c);
    if (!baseSlug) continue;
    const baseOwner = ownerOf(`${baseSlug}.md`);
    const collides = baseOwner !== null && baseOwner !== 'hand-authored' && baseOwner !== c.resourceName;
    const rendered = renderPersonPage(c, collides);
    if (!rendered) continue;
    const owner = ownerOf(rendered.relPath);
    if (owner === 'hand-authored') {
      deps.log(`[google] skipping hand-authored ${rendered.relPath}`);
      continue;
    }
    // Rename: this contact previously rendered elsewhere — remove the page it
    // owned there, or the old slug lives on as a stale orphan.
    if (existingPath && existingPath !== rendered.relPath && ownerOf(existingPath) === c.resourceName) {
      await deletePageByRelPath(deps, existingPath, summary);
    }
    await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  }
  // Cursor commits only after the whole sweep succeeded.
  if (result.nextSyncToken) state.contacts_sync_token = result.nextSyncToken;
}

// ── Calendar sweep ───────────────────────────────────────────────────────────

/** Existing calendar page's source_path for an event id, or null. */
/** Existing person page's source_path for a google contact id, or null. */
async function contactPageRelPathByContactId(
  deps: GoogleSyncDeps,
  resourceName: string,
): Promise<string | null> {
  try {
    const rows = await deps.engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'people/%'
         AND frontmatter->>'google_contact_id' = $2
       LIMIT 1`,
      [deps.sourceId, resourceName],
    );
    return rows[0]?.source_path ?? null;
  } catch {
    return null;
  }
}

async function calendarPageRelPathByEventId(
  deps: GoogleSyncDeps,
  eventId: string,
): Promise<string | null> {
  try {
    const rows = await deps.engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'calendar/%'
         AND frontmatter->>'event_id' = $2
       LIMIT 1`,
      [deps.sourceId, eventId],
    );
    return rows[0]?.source_path ?? null;
  } catch {
    return null;
  }
}



async function sweepCalendar(
  deps: GoogleSyncDeps,
  calendar: CalendarClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<void> {
  const now = Date.now();
  const windowOpts = {
    timeMinIso: new Date(now - deps.cfg.historyDays * 86_400_000).toISOString(),
    timeMaxIso: new Date(now + 60 * 86_400_000).toISOString(),
  };
  // The stored token is bound to the calendar it was minted for (legacy state
  // without calendar_id predates secondary calendars, so it was primary's).
  // A re-pointed source starts a fresh window; pairing the NEW calendar with
  // the OLD cursor would silently import a foreign delta.
  const tokenCalendarId = state.calendar_id ?? DEFAULT_CALENDAR_ID;
  if (state.calendar_sync_token && tokenCalendarId !== deps.cfg.calendarId) {
    deps.log(
      `[google] calendar changed (${tokenCalendarId} → ${deps.cfg.calendarId}); discarding its sync token, windowed re-list`,
    );
    state.calendar_sync_token = null;
  }
  let result;
  try {
    result = await calendar.listEvents(deps.cfg.account, {
      calendarId: deps.cfg.calendarId,
      ...(deps.opts.full || !state.calendar_sync_token ? windowOpts : { syncToken: state.calendar_sync_token }),
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError) {
      deps.log('[google] calendar syncToken expired; windowed re-list');
      state.calendar_sync_token = null;
      result = await calendar.listEvents(deps.cfg.account, {
        calendarId: deps.cfg.calendarId,
        ...windowOpts,
        ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
      });
    } else {
      throw e;
    }
  }
  for (const ev of result.events) {
    if (deps.opts.signal?.aborted) return;
    // The page path derives from MUTABLE fields (start date, summary) while
    // identity is the immutable event id — look up the existing page by
    // frontmatter event_id so reschedules move (old page deleted) and
    // cancelled skeletons (id + status only, per the Calendar API) still
    // find their page instead of computing a 1970 ghost path.
    const existingPath = await calendarPageRelPathByEventId(deps, ev.id);
    const rendered = renderCalendarEventPage(ev);
    if (!rendered) {
      await deletePageByRelPath(deps, existingPath ?? calendarRelPath(ev), summary);
      continue;
    }
    if (existingPath && existingPath !== rendered.relPath) {
      await deletePageByRelPath(deps, existingPath, summary); // rescheduled → moved
    }
    await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  }
  if (result.nextSyncToken) {
    state.calendar_sync_token = result.nextSyncToken;
    state.calendar_id = deps.cfg.calendarId;
  }
}

// ── Gmail sweep ──────────────────────────────────────────────────────────────

const BACKFILL_BATCH_THREADS = 25;

async function processThread(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  threadId: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
): Promise<GmailThreadData | null> {
  const thread = await gmail.getThread(threadId, deps.cfg.account, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  summary.threadsSeen++;
  const rendered = renderThreadPage(thread);
  // Pure noise renders no page AND skips detection — an all-noise thread
  // produces an empty verdict anyway, so nothing opens and nothing closes.
  if (!rendered) return thread;
  const slug = await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  await applyLoopDetection(deps, thread, slug);
  // LLM extraction candidates: trickle + the bounded recent window only —
  // the deep historical backfill is never extracted (spend honesty, F9).
  const newestMs = thread.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
  const windowMs = LOOPS_EXTRACT_WINDOW_DAYS * 86_400_000;
  if (newestMs > 0 && Date.now() - newestMs <= windowMs) {
    // Structural eligibility, not "everything recent": bulk mail the owner
    // never joined would otherwise both pay for model calls AND crowd real
    // threads out of the sweep.
    const verdict = loopExtractionEligibility(thread, myAddressSet(deps.entry));
    summary.extractEligibility[verdict.reason] =
      (summary.extractEligibility[verdict.reason] ?? 0) + 1;
    if (verdict.eligible) {
      deps.extractCandidates.push({ slug, threadId: thread.threadId, newestMs });
    }
  }
  return thread;
}

/** Enqueue loops_extract jobs for every eligible candidate in this sweep. */
async function enqueueLoopsExtraction(deps: GoogleSyncDeps): Promise<void> {
  if (deps.extractCandidates.length === 0) return;
  try {
    const { isLoopsExtractionEnabled, LOOPS_EXTRACT_JOB, LOOPS_EXTRACT_ENQUEUE_CEILING } = await import('./loops-extract.ts');
    if (!(await isLoopsExtractionEnabled(deps.engine))) return;
    // No chat provider (keyless install, outage) → enqueue NOTHING. A job the
    // handler cannot run would fail-and-die and burn its revision-keyed
    // idempotency slot for nothing; the eligible threads stay unconsumed and
    // re-candidate on their next touch or on `sync --full` once a provider is
    // configured. One line per sweep names the reason — never silent.
    const { isAvailable } = await import('../ai/gateway.ts');
    if (!isAvailable('chat')) {
      deps.log(
        `[google] loops_extract: chat provider unavailable (no configured chat model / API key) — ` +
          `skipped enqueue of ${deps.extractCandidates.length} eligible thread(s); they are queued on ` +
          `their next touch (or \`gbrain sync --source ${deps.sourceId} --full\`) once a provider is configured`,
      );
      return;
    }
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(deps.engine);
    // EVERY eligible candidate is enqueued (up to a generous safety ceiling).
    // The queue is the backlog; the worker's concurrency is the rate limit.
    //
    // This used to keep only the newest LOOPS_EXTRACT_MAX_PER_SWEEP and log
    // the rest as "deferring … (they re-candidate on next touch)". That was
    // silent data loss, not deferral: a thread only re-candidates when the
    // thread CHANGES, so a dropped thread that nobody writes to again was
    // never extracted at all. `maxWaiting` was a second, subtler leak — the
    // queue evaluates it AFTER the idempotency-key lookup, so a brand-new key
    // could be coalesced onto some unrelated thread's waiting job and return
    // a row its own payload was never registered against.
    //
    // Newest first only orders the enqueue, so the freshest threads reach the
    // worker first. The ceiling (10x the old cap) is a spend backstop for
    // pathological sweeps — and it is a WAITING-DEPTH budget, not just a
    // per-sweep count: with a stalled worker, repeated pathological sweeps
    // would otherwise stack another ceiling's worth of waiting jobs each.
    // Jobs already waiting shrink this sweep's budget; overflow is a
    // DEFERRAL (the backlog still covers older revisions, and a deferred
    // thread re-candidates on its next touch), logged loudly either way.
    //
    // The depth is PER SOURCE (payload `sourceId`, the key this enqueue
    // writes): a brain-wide count let one Google account's stalled backlog
    // pin every other source's budget at 0 forever.
    const ordered = [...deps.extractCandidates].sort((a, b) => b.newestMs - a.newestMs);
    // Depth = every PENDING row, not just 'waiting': during a provider outage
    // each claimed job fails and parks as 'delayed' (retry backoff), and rows
    // in flight are 'active'. Counting 'waiting' alone read ~0 mid-outage and
    // let every sweep stack another ceiling's worth of jobs on the backlog.
    let waitingDepth = 0;
    try {
      const rows = await deps.engine.executeRaw<{ n: string }>(
        `SELECT count(*)::text AS n FROM minion_jobs
          WHERE name = $1 AND status IN ('waiting', 'delayed', 'active') AND data->>'sourceId' = $2`,
        [LOOPS_EXTRACT_JOB, deps.sourceId],
      );
      waitingDepth = parseInt(rows[0]?.n ?? '0', 10) || 0;
    } catch {
      // Fail-open: a missing table / transient error must never block enqueue.
    }
    const budget = Math.max(0, LOOPS_EXTRACT_ENQUEUE_CEILING - waitingDepth);
    const picked = ordered.slice(0, budget);
    const dropped = ordered.length - picked.length;
    if (dropped > 0) {
      deps.log(
        `[google] loops_extract enqueue budget (ceiling ${LOOPS_EXTRACT_ENQUEUE_CEILING}, ` +
          `${waitingDepth} already pending): enqueuing ${picked.length}, ` +
          `deferring ${dropped} oldest eligible thread(s) — a deferred thread is next ` +
          `enqueued when it changes, so a persistent backlog needs worker attention`,
      );
    }
    for (const c of picked) {
      await queue.add(
        LOOPS_EXTRACT_JOB,
        { slug: c.slug, sourceId: deps.sourceId, threadId: c.threadId },
        {
          priority: 5,
          // Page-revision keyed: a re-sweep of an unchanged thread is a no-op,
          // and this is now the ONLY dedupe mechanism in play (no maxWaiting —
          // its cap-hit coalesce loses brand-new keys, see above).
          idempotency_key: `loops:${deps.sourceId}:${c.slug}:${c.newestMs}`,
        },
      );
    }
    deps.log(`[google] loops_extract: enqueued ${picked.length} eligible thread(s)`);
  } catch (e) {
    deps.log(`[google] loops_extract enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Loop detection hook — wired to loop-detect.ts (Phase 4); tolerant when absent. */
async function applyLoopDetection(
  deps: GoogleSyncDeps,
  thread: GmailThreadData,
  pageSlug: string,
): Promise<void> {
  try {
    const { applyThreadLoopVerdict } = await import('./loop-detect.ts');
    await applyThreadLoopVerdict(deps.engine, deps.sourceId, thread, myAddressSet(deps.entry), pageSlug);
  } catch (e) {
    // Detection must never fail a sync; it re-runs on the next touch.
    deps.log(`[google] loop detection failed for ${thread.threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How many consecutive fetch failures before a thread is skipped (poison). */
const MAX_THREAD_FAILURES = 3;

/**
 * Returns true when every gmail thread this run either imported or was
 * deliberately skipped (404-vanished, poison ledger). False = real failures
 * remain, and the caller must NOT stamp `last_sync_at` — a poison thread
 * silently wedging the pipeline while the staleness gate reads fresh is the
 * exact trust failure the gate exists to prevent.
 */
async function sweepGmail(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  progressTick: (note: string) => void,
): Promise<boolean> {
  const nowMs = Date.now();
  const cutoffMs = nowMs - deps.cfg.historyDays * 86_400_000;
  // A --full run retries poisoned threads (fresh ledger); steady-state runs
  // keep skipping them so one bad thread can't wedge every sync.
  if (deps.opts.full) state.gmail_fail_counts = {};
  const failCounts = (state.gmail_fail_counts ??= {});
  const poisoned = (tid: string): boolean => {
    if ((failCounts[tid] ?? 0) < MAX_THREAD_FAILURES) return false;
    deps.log(
      `[google] thread ${tid} failed ${MAX_THREAD_FAILURES}x; skipping it so the sweep can proceed ` +
        `(gbrain sync --source ${deps.sourceId} --full retries poisoned threads)`,
    );
    progressTick(`thread ${tid} skipped (poison)`);
    return true;
  };

  // ── Initial (or resumed) backfill ──
  if (!state.gmail_backfill_done) {
    // Anchor the delta lane BEFORE importing anything: changes that land
    // during the backfill are replayed by history.list afterwards.
    if (!state.gmail_history_id) {
      const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
      if (profile.emailAddress.toLowerCase() !== deps.cfg.account) {
        deps.log(`[google] warning: token account ${profile.emailAddress} != source account ${deps.cfg.account}`);
      }
      state.gmail_history_id = profile.historyId;
      writeGoogleState(deps.cfg.dir, state);
    }
    let floorMs = state.gmail_backfill_floor_ms ?? nowMs + 60_000;
    for (;;) {
      if (deps.opts.signal?.aborted) return false;
      const q = `after:${Math.floor(cutoffMs / 1000)} before:${Math.ceil(floorMs / 1000)}`;
      // Page-BOUNDED listing (partialOk): a busy inbox can hold far more ids
      // than the client's 500-page safety cap; an unbounded drain would
      // throw before any thread processed and wedge the backfill forever.
      // The floor cursor makes partial listings safe — each iteration takes
      // the newest ~2,000 messages in the window, processes them, drops the
      // floor, and re-queries.
      const ids = await gmail.listMessageIds(q, {
        maxPages: 20,
        partialOk: true,
        ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
      });
      if (ids.length === 0) break;
      // Newest-first listing → unique threads in newest-first order.
      const threadIds = [...new Set(ids.map((m) => m.threadId))];
      let processedAny = false;
      let batchFailed = false;
      let batchOldest = floorMs;
      for (let i = 0; i < threadIds.length; i += BACKFILL_BATCH_THREADS) {
        if (deps.opts.signal?.aborted) break;
        const batch = threadIds.slice(i, i + BACKFILL_BATCH_THREADS);
        for (const tid of batch) {
          if (deps.opts.signal?.aborted) break;
          if (poisoned(tid)) continue;
          try {
            const thread = await processThread(deps, gmail, tid, activePack, summary, countedSlugs);
            processedAny = true;
            if (failCounts[tid]) delete failCounts[tid];
            const newest = thread?.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
            if (newest > 0 && newest < batchOldest) batchOldest = newest;
            if (newest > (state.gmail_newest_ms ?? 0)) state.gmail_newest_ms = newest;
            progressTick(`thread ${tid}`);
          } catch (e) {
            if (e instanceof GoogleCursorExpiredError && e.status === 404) {
              // Thread deleted between listing and fetch — gone is gone.
              // Skipping (not failing) keeps the cursor moving; --full
              // reconcile removes any page it left behind.
              deps.log(`[google] thread ${tid} vanished (404); skipping`);
              progressTick(`thread ${tid} gone`);
              continue;
            }
            failCounts[tid] = (failCounts[tid] ?? 0) + 1;
            batchFailed = true;
            summary.failedFiles++;
            summary.status = 'partial';
            deps.log(`[google] thread ${tid} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Monotone forward progress: the floor commits per FULLY-SUCCESSFUL
        // batch. A batch with any failure must NOT advance the floor — a
        // failed thread NEWER than a committed floor would fall outside the
        // resume window (`before:floor`) forever, and the delta lane can't
        // replay it either (its messages predate the history anchor).
        if (batchFailed) break;
        if (processedAny && batchOldest < floorMs) {
          state.gmail_backfill_floor_ms = batchOldest;
          writeGoogleState(deps.cfg.dir, state);
        }
      }
      if (deps.opts.signal?.aborted) return false;
      if (batchFailed) {
        // Leave the floor at the last good batch; the next run re-lists from
        // there and retries the failed thread first. Persist the fail ledger
        // so repeated failures accumulate toward the poison threshold across
        // runs, then report the failure — this run did NOT refresh the data.
        writeGoogleState(deps.cfg.dir, state);
        return false;
      }
      if (!processedAny || batchOldest >= floorMs) {
        // Nothing moved the floor (all skipped/vanished or all
        // same-timestamp): step below the oldest listed page to guarantee
        // termination. Only reachable with zero failures.
        state.gmail_backfill_floor_ms = Math.max(cutoffMs - 1, floorMs - 86_400_000);
        writeGoogleState(deps.cfg.dir, state);
      }
      floorMs = state.gmail_backfill_floor_ms ?? cutoffMs;
      if (floorMs <= cutoffMs) break;
    }
    if (summary.failedFiles === 0) {
      state.gmail_backfill_done = true;
      state.gmail_backfill_floor_ms = null;
      writeGoogleState(deps.cfg.dir, state);
    } else {
      // Failures stay in the window; the next run retries from the floor.
      writeGoogleState(deps.cfg.dir, state);
      return false;
    }
  }

  // ── Delta lane ──
  if (!state.gmail_history_id) return true;
  let threadIds: string[];
  let newHistoryId: string | null = null;
  try {
    ({ threadIds, newHistoryId } = await gmail.listHistoryThreadIds(state.gmail_history_id, {
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    }));
  } catch (e) {
    if (!(e instanceof GoogleCursorExpiredError)) throw e;
    // History expired (~1 week idle): windowed fallback from the newest
    // imported message. BOUNDED like the backfill (the same >cap population
    // exists here) — and the fresh historyId is only re-anchored when the
    // listing was COMPLETE; a capped partial listing keeps the fallback lane
    // active (gmail_newest_ms advances per processed thread, converging).
    deps.log('[google] historyId expired; falling back to bookmark window');
    // Anchor BEFORE listing (mirrors the backfill's zero-gap ordering): a
    // message arriving between these two calls is either in the listing
    // (post-anchor arrival) or replayed by history.list from the anchor.
    // Anchoring after the listing would silently drop that message forever.
    const profile = await gmail.getProfile({ ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
    const anchorCandidate = profile.historyId;
    const sinceSec = Math.floor(((state.gmail_newest_ms ?? cutoffMs) - 86_400_000) / 1000);
    const FALLBACK_MAX_PAGES = 20;
    const ids = await gmail.listMessageIds(`after:${sinceSec}`, {
      maxPages: FALLBACK_MAX_PAGES,
      partialOk: true,
      ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
    });
    threadIds = [...new Set(ids.map((m) => m.threadId))];
    const likelyCapped = ids.length >= FALLBACK_MAX_PAGES * 100;
    if (!likelyCapped) newHistoryId = anchorCandidate;
  }
  let failed = 0;
  for (const tid of threadIds) {
    if (deps.opts.signal?.aborted) return false;
    if (poisoned(tid)) continue;
    try {
      const thread = await processThread(deps, gmail, tid, activePack, summary, countedSlugs);
      if (failCounts[tid]) delete failCounts[tid];
      const newest = thread?.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
      if (newest > (state.gmail_newest_ms ?? 0)) state.gmail_newest_ms = newest;
      progressTick(`thread ${tid}`);
    } catch (e) {
      if (e instanceof GoogleCursorExpiredError && e.status === 404) {
        // Thread deleted after the history record was written — gone is
        // gone. Treating this as a failure would freeze the delta cursor
        // and re-404 the same thread every sync until the historyId itself
        // expired (~1 week of wedged deltas).
        deps.log(`[google] thread ${tid} vanished (404); skipping`);
        progressTick(`thread ${tid} gone`);
        continue;
      }
      failCounts[tid] = (failCounts[tid] ?? 0) + 1;
      failed++;
      summary.failedFiles++;
      summary.status = 'partial';
      deps.log(`[google] thread ${tid} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The delta cursor advances only when every flagged thread landed —
  // a partial drain re-lists the same window next run (idempotent).
  if (failed === 0 && newHistoryId) {
    state.gmail_history_id = newHistoryId;
  }
  return failed === 0;
}

// ── Full reconcile (deletes) ─────────────────────────────────────────────────

async function reconcileGmailDeletes(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
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
  await deps.engine.deletePages(stale.map((s) => s.slug), { sourceId: deps.sourceId });
  for (const s of stale) {
    if (!s.source_path) continue;
    // Containment guard mirrors the write path (defense-in-depth on DB rows).
    const target = join(deps.cfg.dir, s.source_path);
    if (isWriteTargetContained(target, deps.cfg.dir)) rmSync(target, { force: true });
  }
  summary.deleted += stale.length;
}

// ── Extract + embed (mirrors github-source's size-gated tail) ───────────────

async function runExtractAndEmbed(
  deps: GoogleSyncDeps,
  summary: GoogleSyncSummary,
): Promise<void> {
  const totalChanges = summary.added + summary.modified;
  const pagesAffected = summary.pagesAffected;
  if (totalChanges === 0 || pagesAffected.length === 0) return;

  if (!deps.opts.noExtract && totalChanges <= 100) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted } = await import('../../commands/extract.ts');
      const extractOpts = { sourceId: deps.sourceId };
      await extractLinksForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await extractTimelineForSlugs(deps.engine, deps.cfg.dir, pagesAffected, extractOpts);
      await stampExtracted(
        deps.engine,
        pagesAffected.map((slug) => ({ slug, source_id: deps.sourceId })),
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
  if (!cfg.account) {
    throw new Error(
      `Google source "${sourceId}" has no account configured. Re-add it: gbrain sources add ${sourceId} --kind google --account <email>`,
    );
  }
  const log = (msg: string): void => {
    process.stderr.write(msg + '\n');
  };
  // Access resolution: the vault is the default; command/env modes let a
  // stack that already holds Google access (gog, gcloud, a credential
  // gateway) drive this source without gbrain's own OAuth flow. Non-vault
  // modes synthesize a minimal identity entry: no meta.scopes (so the scope
  // preflight below trusts cfg.services), no sendas_aliases (best-effort
  // live fetch below), account from the source config.
  let entry: CredentialEntry;
  let tokens: GoogleAccessProvider;
  if (cfg.access === 'command' || cfg.access === 'env') {
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
    } catch { /* account-only identity */ }
  } else {
    const vault = vaultOverride ?? openVault();
    const vaultEntry = await vault.get(credentialId(GOOGLE_PROVIDER, cfg.account));
    if (!vaultEntry) {
      throw new CredentialError('not_connected', ` for ${cfg.account} — run: gbrain google connect --account ${cfg.account}`);
    }
    entry = vaultEntry;
    tokens = new GoogleTokenProvider(vault, entry.id, fetchImpl ?? fetch);
  }
  const clientArgs = [tokens, fetchImpl ?? fetch, log, entry.meta.client_id] as const;
  const gmail = new GmailClient(...clientArgs);
  const calendar = new CalendarClient(...clientArgs);
  const people = new PeopleClient(...clientArgs);
  const deps: GoogleSyncDeps = { engine, sourceId, cfg, opts, entry, log, extractCandidates: [] };

  const summary: GoogleSyncSummary = {
    status: 'synced',
    added: 0,
    modified: 0,
    deleted: 0,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    threadsSeen: 0,
    extractEligibility: {},
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
    log(new CredentialError('scope_missing', undefined, `services without grant: ${missingServices.join(', ')}`).toHuman());
  }
  const activeServices = grantedScopes.length > 0 ? grantedServices : cfg.services;

  const state = readGoogleState(cfg.dir);
  const firstRun = !state.gmail_backfill_done && state.gmail_history_id === null;
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('sync.google_materialize');
  const tick = (note: string): void => progress.tick(1, note);

  try {
    const serviceErrors: string[] = [];

    if (activeServices.includes('contacts')) {
      const stop = startHeartbeat(progress, 'contacts sweep');
      try {
        await sweepContacts(deps, people, state, activePack, summary, countedSlugs);
      } catch (e) {
        serviceErrors.push(`contacts: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] contacts sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    if (activeServices.includes('calendar')) {
      const stop = startHeartbeat(progress, 'calendar sweep');
      try {
        await sweepCalendar(deps, calendar, state, activePack, summary, countedSlugs);
      } catch (e) {
        serviceErrors.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
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
        // sweepGmail reports thread-level failures via its return value —
        // they exit through normal returns, not throws, and stamping
        // last_sync_at over them would blind the staleness gate (H1).
        gmailSweepOk = await sweepGmail(deps, gmail, state, activePack, summary, countedSlugs, tick);
        if (opts.full) await reconcileGmailDeletes(deps, gmail, summary);
      } catch (e) {
        serviceErrors.push(`gmail: ${e instanceof Error ? e.message : String(e)}`);
        summary.status = 'partial';
        if (isCredentialError(e)) log(e.toHuman());
        else log(`[google] gmail sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        stop();
      }
    }

    summary.pagesAffected = [...new Set(summary.pagesAffected)];
    if (grantedScopes.length > 0 && missingServices.length > 0) summary.status = 'partial';
    if (opts.signal?.aborted) summary.status = 'partial';
    if (opts.full && summary.status === 'synced') state.last_full_at = new Date().toISOString();

    // Per-service cursors were advanced in-place only on success; persist.
    writeGoogleState(cfg.dir, state);
    // An aborted run (wall-clock budget, serve-delegation timeout) skips the
    // extract/embed/extraction tails — the deferred backfill machinery picks
    // them up on the next full run instead of overshooting the budget.
    if (!opts.signal?.aborted) {
      await runExtractAndEmbed(deps, summary);
      await enqueueLoopsExtraction(deps);
      // Auditable per-reason counts (loopExtractionEligibility) — no
      // addresses, subjects or body text ever reach the log.
      if (Object.keys(summary.extractEligibility).length > 0) {
        log(
          `[google] loops_extract eligibility: ${Object.entries(summary.extractEligibility)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
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
    if (gmailSweepOk) {
      try {
        await engine.executeRaw(
          `UPDATE sources SET last_sync_at = now(), newest_content_at = $1::timestamptz WHERE id = $2`,
          [new Date(state.gmail_newest_ms ?? Date.now()).toISOString(), sourceId],
        );
      } catch { /* best-effort */ }
    }

    const changed = summary.added + summary.modified + summary.deleted > 0;
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
    };
  } finally {
    progress.finish();
  }
}
