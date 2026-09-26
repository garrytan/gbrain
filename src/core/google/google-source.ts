import { withConnectorSync, rethrowConnectorWriteError, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { resolveGoogleAccount } from '../persistence/connector-account.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { carryLegacyFailCounts } from '../connectors/item-holds.ts';
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

import { chmodSync, closeSync, existsSync, fchmodSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
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
import { atomicWriteFileSync, mkdirPrivate } from '../atomic-write.ts';
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
  threadRelPath,
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
import type { ThreadLoopVerdict } from './loop-detect.ts';
import { pendingLoopsExtractDepth, recordGraceVerdict, runLoopsCatchup, seedGraceBackfill, settleDueGraceHolds, type LoopsEnqueueReport } from './loop-catchup.ts';

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

/**
 * Write a page's temp file privately: a stale `.tmp` left by a crash is
 * removed first (never followed), then the temp file is created exclusively at
 * 0600 and fchmod-ed past the umask before any byte lands. Renaming it over
 * the page makes new and rewritten pages 0600.
 */
function writePrivateTemp(tmpPath: string, markdown: string): void {
  let stale: ReturnType<typeof lstatSync> | null = null;
  try { stale = lstatSync(tmpPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stale?.isDirectory()) {
    throw new Error(`Stale temporary path ${tmpPath} is a directory; remove it and re-run the sync.`);
  }
  if (stale) unlinkSync(tmpPath);
  const buf = Buffer.from(markdown, 'utf-8');
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw new Error(`Short write to ${tmpPath} at offset ${off}/${buf.length}`);
      off += n;
    }
  } finally {
    closeSync(fd);
  }
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
  attachmentInspection: Record<string, number>;
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
  managed: ManagedConnectorSync | null;
  engine: BrainEngine;
  sourceId: string;
  cfg: GoogleSourceConfig;
  opts: SyncOpts;
  entry: CredentialEntry;
  log: (msg: string) => void;
  /** Threads whose newest message falls in the recent window — LLM
   *  extraction candidates, enqueued (capped) after the sweep. */
  extractCandidates: Array<{ slug: string; threadId: string; newestMs: number }>;
  /** #5868: the run's state (grace holds are recorded on it) and the threads detection ran on. */
  loopState?: GoogleSourceState;
  processedThreads: Set<string>;
  graceBackfillSeeded?: boolean;
}

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;

async function saveGoogleState(deps: GoogleSyncDeps, state: GoogleSourceState): Promise<void> {
  if (deps.managed) await deps.managed.saveState(state);
  else writeGoogleState(deps.cfg.dir, state);
}

/** #5867/#5868 state a partial managed run still publishes (E20): never the Gmail cursor. */
function loopRecoveryState(state: GoogleSourceState): Record<string, unknown> {
  const fields = { loop_grace_holds: state.loop_grace_holds, loop_grace_backfill_done: state.loop_grace_backfill_done, loops_catchup: state.loops_catchup };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

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
  identity: Record<string, string | readonly string[]> = {},
): Promise<string> {
  markdown = connectorRender(markdown, { path: relPath, account: deps.cfg.account, ...identity });
  if (deps.managed) {
    const result = await deps.managed.importMarkdown(relPath, markdown);
    if (result.status === 'imported') {
      summary.pagesAffected.push(result.slug);
      summary.chunksCreated += result.chunks;
      if (!countedSlugs.has(result.slug)) {
        if (result.created) summary.added++; else summary.modified++;
        countedSlugs.add(result.slug);
      }
    }
    return result.slug;
  }
  const filePath = join(deps.cfg.dir, relPath);
  assertContained(deps.cfg.dir, filePath);
  mkdirPrivate(dirname(filePath), deps.cfg.dir);
  const before = existsSync(filePath);
  // Temp-write → import → rename: a failed import never destroys the
  // previously-good page (github-source pattern).
  const tmpPath = `${filePath}.tmp`;
  writePrivateTemp(tmpPath, markdown);
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
  if (deps.managed) {
    for (const row of rows) if (await deps.managed.delete(row.slug, relPath)) summary.deleted++;
    return;
  }
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
  const ownerOf = async (relPath: string): Promise<string | null> => {
    if (deps.managed) {
      const page = await deps.managed.page(relPath.replace(/\.md$/, ''));
      if (!page) return null;
      return typeof page.frontmatter.google_contact_id === 'string' ? page.frontmatter.google_contact_id : 'hand-authored';
    }
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
      if (existingPath && await ownerOf(existingPath) === c.resourceName) {
        await deletePageByRelPath(deps, existingPath, summary);
      } else {
        // Page not (yet) in the DB — fall back to slug candidates, guarded
        // by file ownership. Delete only the page THIS contact owns.
        for (const slug of [personSlugFromContact(c, false), personSlugFromContact(c, true)]) {
          if (slug && await ownerOf(`${slug}.md`) === c.resourceName) {
            await deletePageByRelPath(deps, `${slug}.md`, summary);
          }
        }
      }
      continue;
    }
    const baseSlug = personSlugFromContact(c);
    if (!baseSlug) continue;
    const baseOwner = await ownerOf(`${baseSlug}.md`);
    const collides = baseOwner !== null && baseOwner !== 'hand-authored' && baseOwner !== c.resourceName;
    const rendered = renderPersonPage(c, collides);
    if (!rendered) continue;
    const owner = await ownerOf(rendered.relPath);
    if (owner === 'hand-authored') {
      deps.log(`[google] skipping hand-authored ${rendered.relPath}`);
      continue;
    }
    // Rename: this contact previously rendered elsewhere — remove the page it
    // owned there, or the old slug lives on as a stale orphan.
    if (existingPath && existingPath !== rendered.relPath && await ownerOf(existingPath) === c.resourceName) {
      await deletePageByRelPath(deps, existingPath, summary);
    }
    await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs);
  }
  // Cursor commits only after the whole sweep succeeded.
  if (result.nextSyncToken) state.contacts_sync_token = result.nextSyncToken;
}

// ── Calendar sweep ───────────────────────────────────────────────────────────

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
  } catch (error) {
    if (deps.managed) throw error;
    return null;
  }
}

/** Existing calendar page's source_path for an event id, or null. */
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
  } catch (error) {
    if (deps.managed) throw error;
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

/**
 * Existing email-thread page's source_path for a gmail thread id, or null.
 * Runs once per fetched thread, so it uses containment (`@>`), which the GIN
 * index on frontmatter serves; `->>` equality would scan every email page.
 */
async function threadPageRelPathByThreadId(
  deps: GoogleSyncDeps,
  threadId: string,
): Promise<string | null> {
  try {
    const rows = await deps.engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'emails/%'
         AND frontmatter @> jsonb_build_object('thread_id', $2::text)
       LIMIT 1`,
      [deps.sourceId, threadId],
    );
    return rows[0]?.source_path ?? null;
  } catch (error) {
    if (deps.managed) throw error;
    return null;
  }
}

async function processThread(
  deps: GoogleSyncDeps,
  gmail: GmailClient,
  threadId: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  seen: { thread?: GmailThreadData } = {},
): Promise<GmailThreadData | null> {
  const thread = await gmail.getThread(threadId, deps.cfg.account, {
    ...(deps.opts.signal ? { signal: deps.opts.signal } : {}),
  });
  seen.thread = thread;
  summary.threadsSeen++;
  const rendered = renderThreadPage(thread);
  // Pure noise renders no page AND skips detection — an all-noise thread
  // produces an empty verdict anyway, so nothing opens and nothing closes.
  if (!rendered) return thread;
  // The path derives from the subject through the slug grammar, so a page
  // rendered under an older grammar (#12: non-Latin subjects used to slug to
  // `no-subject`) sits elsewhere — look it up by thread_id and move it.
  const existingPath = await threadPageRelPathByThreadId(deps, thread.threadId);
  if (existingPath && existingPath !== rendered.relPath) {
    await deletePageByRelPath(deps, existingPath, summary);
  }
  const slug = await importRendered(deps, rendered.relPath, rendered.markdown, activePack, summary, countedSlugs,
    { thread_id: thread.threadId, message_ids: thread.messages.map((m) => m.id) });
  for (const message of thread.messages) {
    const state = message.attachmentInspection?.state ?? 'not_inspected';
    summary.attachmentInspection[state] = (summary.attachmentInspection[state] ?? 0) + 1;
  }
  deps.processedThreads.add(thread.threadId);
  const verdict = await applyLoopDetection(deps, thread, slug);
  if (verdict && deps.loopState) recordGraceVerdict(deps.loopState, thread, verdict, slug, myAddressSet(deps.entry), deps.log);
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

/**
 * Enqueue loops_extract jobs for every eligible candidate in this sweep, in
 * both persistence modes (#5867: `--no-extract` gates only the inline
 * link/timeline extract). Every skip logs its reason.
 */
async function enqueueLoopsExtraction(deps: GoogleSyncDeps): Promise<LoopsEnqueueReport> {
  const report: LoopsEnqueueReport = { enqueued: 0, deferred: 0, skipped_reason: null };
  if (deps.extractCandidates.length === 0) {
    deps.log('[google] loops_extract: no eligible thread in this sweep; nothing to enqueue');
    return { ...report, skipped_reason: 'no_candidates' };
  }
  try {
    const { isLoopsExtractionEnabled, LOOPS_EXTRACT_JOB, LOOPS_EXTRACT_ENQUEUE_CEILING } = await import('./loops-extract.ts');
    if (!(await isLoopsExtractionEnabled(deps.engine))) {
      deps.log(`[google] loops_extract: extraction disabled (loops.extraction_enabled) — skipped enqueue of ${deps.extractCandidates.length} eligible thread(s)`);
      return { ...report, skipped_reason: 'extraction_disabled' };
    }
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
      return { ...report, skipped_reason: 'chat_unavailable' };
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
    // One candidate per page revision: a thread re-landed in one sweep is queued once.
    const ordered = [...new Map(deps.extractCandidates.map((c) => [`${c.slug}:${c.newestMs}`, c])).values()].sort((a, b) => b.newestMs - a.newestMs);
    // Depth = every PENDING row, not just 'waiting': during a provider outage
    // each claimed job fails and parks as 'delayed' (retry backoff), and rows
    // in flight are 'active'. Counting 'waiting' alone read ~0 mid-outage and
    // let every sweep stack another ceiling's worth of jobs on the backlog.
    // Fail-open: a missing table / transient error must never block enqueue.
    const waitingDepth = await pendingLoopsExtractDepth(deps.engine, deps.sourceId);
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
        { slug: c.slug, sourceId: deps.sourceId, threadId: c.threadId, newestMs: c.newestMs },
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
    return { enqueued: picked.length, deferred: dropped, skipped_reason: null };
  } catch (e) {
    deps.log(`[google] loops_extract enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...report, skipped_reason: 'enqueue_failed' };
  }
}

/** Loop detection hook — wired to loop-detect.ts (Phase 4); tolerant when absent. */
async function applyLoopDetection(
  deps: GoogleSyncDeps,
  thread: GmailThreadData,
  pageSlug: string,
): Promise<ThreadLoopVerdict | null> {
  try {
    const { applyThreadLoopVerdict } = await import('./loop-detect.ts');
    return await applyThreadLoopVerdict(deps.engine, deps.sourceId, thread, myAddressSet(deps.entry), pageSlug);
  } catch (e) {
    // Detection must never fail a sync; it re-runs on the next touch.
    deps.log(`[google] loop detection failed for ${thread.threadId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * A rate-limit failure is transient and self-clearing (Google's own quota
 * window, not a problem with this thread) — it never counts toward a hold.
 * The google-clients.ts retry loop already retries a rate-limited request
 * patiently (DEFAULT_RATE_LIMIT_RETRIES, backoff + jitter) before giving up
 * and throwing this; reaching here means the client's own retry budget was
 * exhausted, not that the thread is bad.
 */
function threadFailureMessage(tid: string, rateLimited: boolean, e: unknown): string {
  return (
    `[google] thread ${tid} failed${rateLimited ? ' (rate limited; not counted toward a hold)' : ''}: ` +
    `${e instanceof Error ? e.message : String(e)}`
  );
}

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
  gmail: GmailClient;
  state: GoogleSourceState;
  activePack: ActivePack;
  summary: GoogleSyncSummary;
  countedSlugs: Set<string>;
  progressTick: (note: string) => void;
  holds: ConnectorHoldSession;
}

type ThreadOutcome = { kind: 'landed'; newestMs: number } | { kind: 'gone' | 'skipped' | 'failed' | 'rate_limited' };

/**
 * One thread through the item holds: a held thread is skipped unless
 * re-admitted; a failure is counted (a held thread failing again does not
 * block the cursor). On a managed brain a write error aborts the run after
 * the abort path publishes the holds.
 */
async function attemptThread(g: GmailSweep, tid: string, version: string | null): Promise<ThreadOutcome> {
  if (!g.holds.shouldAttempt(tid, version)) {
    g.progressTick(`thread ${tid} held`);
    return { kind: 'skipped' };
  }
  const seen: { thread?: GmailThreadData } = {};
  try {
    const thread = await processThread(g.deps, g.gmail, tid, g.activePack, g.summary, g.countedSlugs, seen);
    g.holds.succeed(tid);
    const newestMs = thread?.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
    if (newestMs > (g.state.gmail_newest_ms ?? 0)) g.state.gmail_newest_ms = newestMs;
    g.progressTick(`thread ${tid}`);
    return { kind: 'landed', newestMs };
  } catch (e) {
    if (e instanceof GoogleCursorExpiredError && e.status === 404) {
      // Thread deleted between listing and fetch — gone is gone. Skipping
      // (not failing) keeps the cursor moving; --full reconcile removes any
      // page it left behind.
      g.holds.drop(tid);
      g.deps.log(`[google] thread ${tid} vanished (404); skipping`);
      g.progressTick(`thread ${tid} gone`);
      return { kind: 'gone' };
    }
    const wasHeld = g.holds.isHeld(tid);
    const first = seen.thread?.messages[0];
    const last = seen.thread?.messages[seen.thread.messages.length - 1];
    const classified = await g.holds.fail(tid, e, { version, slug: seen.thread ? threadRelPath(seen.thread).replace(/\.md$/, '') : null,
      meta: { sender: last?.from ?? null, subject: first?.subject ?? null, upstream_at: last ? last.dateIso : null } });
    const rateLimited = classified.scope === 'rate_limit';
    g.summary.failedFiles++;
    g.deps.log(threadFailureMessage(tid, rateLimited, e));
    if (wasHeld && !rateLimited) return { kind: 'skipped' };
    g.summary.status = 'partial';
    return { kind: rateLimited ? 'rate_limited' : 'failed' };
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
  if (!state.gmail_history_id) return true;

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
  // Held threads no listing of this run reached: re-attempt those retry-held
  // asked for or whose transient reconsideration is due. A failure keeps the
  // hold and never blocks the cursor.
  for (const tid of g.holds.dueHeldKeys()) {
    if (deps.opts.signal?.aborted) return false;
    await attemptThread(g, tid, null);
  }
  if (await settleGraceHolds(g) === 'aborted') return false;
  const isCurrent = (): boolean => {
    if (delta !== 'done' || state.gmail_gap_floor_ms != null) return false;
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

/**
 * #5868: seeds the one-shot grace backfill, then settles due grace holds.
 * A re-fetch goes straight through processThread (never the item holds), so
 * a failed grace re-fetch keeps the grace hold and is not an item failure.
 */
async function settleGraceHolds(g: GmailSweep): Promise<'aborted' | void> {
  const { deps, state } = g;
  try {
    await seedGraceBackfill(deps.engine, deps.sourceId, state, deps.log);
    deps.graceBackfillSeeded = true;
  } catch (e) {
    deps.log(`[google] loop grace backfill failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
  }
  const settled = await settleDueGraceHolds({ engine: deps.engine, sourceId: deps.sourceId, state, log: deps.log, signal: deps.opts.signal,
    processed: deps.processedThreads, refetch: async (tid) => {
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
    const outcome = await attemptThread(g, tid, version);
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
  if (deps.managed) {
    for (const page of stale) if (await deps.managed.delete(page.slug, page.source_path)) summary.deleted++;
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
    (managed, options) => runGoogleSyncInner(engine, sourceId, cfg, options, managed, fetchImpl, vaultOverride), pendingConnectorResult);
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
  const deps: GoogleSyncDeps = { engine, sourceId, cfg, opts, entry, log, extractCandidates: [], managed, processedThreads: new Set() };

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
  if (managed) {
    const email = await resolveGoogleAccount({ gmail, calendar, people }, activeServices, opts.signal);
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
        if (managed) rethrowConnectorWriteError(e);
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
        if (managed) rethrowConnectorWriteError(e);
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
        gmailSweepOk = await sweepGmail({ deps, gmail, state, activePack, summary, countedSlugs, progressTick: tick, holds }, async () => {
          // #5581: current mail is complete but the backfill is not: bank freshness now, while the managed lease can still write.
          if (managed && summary.status !== 'partial' && !opts.signal?.aborted) {
            await managed.saveState(state, true, new Date(state.gmail_newest_ms ?? Date.now()).toISOString());
          }
        });
        if (opts.full) await reconcileGmailDeletes(deps, gmail, summary);
      } catch (e) {
        if (managed) rethrowConnectorWriteError(e);
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

    // #5867 managed-only 30-day catch-up and the #5868 one-shot backfill marker; never on an aborted sweep.
    let catchup: LoopsEnqueueReport | null = null;
    if (activeServices.includes('gmail') && !opts.signal?.aborted) {
      if (deps.graceBackfillSeeded) state.loop_grace_backfill_done = true;
      if (managed) {
        try {
          catchup = await runLoopsCatchup({ engine, sourceId, state, log, signal: opts.signal, myAddresses: myAddressSet(entry),
            inFlight: new Set(deps.extractCandidates.map(c => c.slug)),
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
      ...(loopsEnqueue ? { loops_enqueue: loopsEnqueue } : {}),
      ...connectorHoldsResult(sourceId, holds.summary()),
    };
  } finally {
    progress.finish();
  }
}
