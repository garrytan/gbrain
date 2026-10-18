/**
 * people-calendar-sweep — the Contacts and Calendar sweeps of the google
 * source kind (peeled from google-source.ts). Cursor discipline per service:
 * the syncToken is committed only after that service's fully-successful
 * sweep; an expired token drops it and re-lists windowed.
 *
 * GBRA-130 A-3: each contact (`contact:<resourceName>`) and each event
 * (`event:<calendarId>:<eventId>`) goes through the connector item holds
 * (connectors/connector-hold-session.ts). An item-scoped failure is reported
 * and the sweep goes on; only a content-class one counts toward a hold.
 * While a failing item is not held the service's token stays where it is, so
 * the next sync lists it again; once it is held the token moves past it. A held item that retry-held or a due
 * reconsideration re-admits and no listing returns is re-fetched by id; one the provider no longer has (its
 * deletion passed in a delta while it was held) retires the page it owns through the same ownership-checked
 * deletion as a contact tombstone or a cancelled event, and its hold clears only once that deletion lands.
 * Run-scoped failures stop the sweep as before.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { abortsManagedRun, type ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { classifyConnectorError } from '../connectors/item-holds.ts';
import { assertConnectorIdentity } from '../connectors/connector-text.ts';
import { classifyItemFailure } from '../item-failure.ts';

import { CALENDAR_HORIZON_DAYS, CalendarSyncWindow, planCalendarPage, staleCalendarPages } from './calendar-window.ts';
import { CalendarClient, calendarUnreadableStatus, CONTACT_PERSON_FIELDS, GoogleCursorExpiredError, GoogleSyncTokenRejectedError, PeopleClient } from './google-clients.ts';
import { calendarRelPath, contactIdSlug, personSlugFromContact, renderCalendarEventPage, renderPersonPage } from './google-render.ts';
import { contactHoldKey, DEFAULT_CALENDAR_ID, eventHoldKey, type CalendarEventData, type ContactData, type GoogleSourceState } from './types.ts';
import { deletePageByRelPath, importRendered, type ActivePack, type GoogleSyncDeps, type GoogleSyncSummary } from './sweep-shared.ts';

// ── Contacts sweep ───────────────────────────────────────────────────────────

export async function sweepContacts(
  deps: GoogleSyncDeps,
  people: PeopleClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  holds?: ConnectorHoldSession,
): Promise<void> {
  const signal = deps.opts.signal ? { signal: deps.opts.signal } : {};
  // #6324: a syncToken is only valid with the request parameters that minted
  // it. A token minted under another `personFields` (legacy state has none
  // recorded) is unusable, so the sweep lists fully once and then records the
  // new token with the mask it was minted under.
  const maskChanged = state.contacts_person_fields !== CONTACT_PERSON_FIELDS;
  const syncToken = deps.opts.full || maskChanged ? null : state.contacts_sync_token;
  if (maskChanged && state.contacts_sync_token && !deps.opts.full) deps.log('[google] contacts field mask changed; full re-list');
  let result;
  try {
    result = await people.listConnections({ syncToken, ...signal });
  } catch (e) {
    // One bounded recovery: an expired or rejected token drops to a single
    // full list; a failure of that list propagates and commits nothing.
    if (!syncToken) throw e;
    if (e instanceof GoogleCursorExpiredError) deps.log('[google] contacts syncToken expired; full re-list');
    else if (e instanceof GoogleSyncTokenRejectedError) deps.log('[google] contacts syncToken rejected (HTTP 400); one full re-list');
    else throw e;
    state.contacts_sync_token = null;
    result = await people.listConnections({ syncToken: null, ...signal });
  }
  const groupNames = await resolveContactGroups(deps, people, state, result.contacts);
  const sweep = { activePack, summary, countedSlugs, groupNames };
  let blocked = false;
  for (const c of result.contacts) {
    if (deps.opts.signal?.aborted) return;
    const item = { key: contactHoldKey(c.resourceName), version: c.etag ?? null, title: c.displayName };
    if (!await throughHolds(deps, summary, holds, item, () => applyContact(deps, c, sweep))) blocked = true;
  }
  const prefix = contactHoldKey('');
  for (const key of holds?.dueHeldKeys().filter(k => k.startsWith(prefix)) ?? []) {
    if (deps.opts.signal?.aborted) return;
    await throughHolds(deps, summary, holds, { key, version: null, title: null }, async () => {
      const resourceName = key.slice(prefix.length);
      const c = await people.getContact(resourceName, signal)
        ?? { resourceName, displayName: null, emails: [], phones: [], organization: null, title: null, groups: [], deleted: true };
      await applyContact(deps, c, sweep);
    });
  }
  if (blocked) return;
  // Cursor and the mask it was minted under commit together, only after the
  // whole sweep succeeded. A full list that returned no replacement token
  // leaves no cursor behind (the next sweep lists fully again); a same-mask
  // list without one keeps the token it already had.
  if (result.nextSyncToken) state.contacts_sync_token = result.nextSyncToken;
  else if (maskChanged) state.contacts_sync_token = null;
  state.contacts_person_fields = CONTACT_PERSON_FIELDS;
}

/**
 * One contact applied to the brain: a tombstone retires the page this
 * contact owns, anything else renders (disambiguated on a name collision)
 * and lands, retiring the page it owned at an older path.
 */
async function applyContact(deps: GoogleSyncDeps, c: ContactData,
  sweep: { activePack: ActivePack; summary: GoogleSyncSummary; countedSlugs: Set<string>; groupNames: Record<string, string> }): Promise<void> {
  assertConnectorIdentity({ google_contact_id: c.resourceName, emails: c.emails });
  const contactsDir = deps.cfg.contactsDir;
  // DB lookup by contact id FIRST, in any directory: deletion tombstones
  // typically carry only resourceName + deleted (no names/emails — slug
  // derivation yields null), a renamed contact's current name derives a
  // DIFFERENT slug than the page it owns, and a changed `g_contacts_dir`
  // (#4845) moves every page. All three need the id-keyed path (mirror of
  // the calendar sweep's event_id keying).
  const existingPath = await contactPageRelPathByContactId(deps, c.resourceName);
  if (c.deleted) {
    if (existingPath && await contactOwner(deps, existingPath) === c.resourceName) {
      await deletePageByRelPath(deps, existingPath, sweep.summary);
    } else {
      // Page not (yet) in the DB — fall back to slug candidates, guarded
      // by file ownership. Delete only the page THIS contact owns.
      for (const slug of [personSlugFromContact(c, false, contactsDir), personSlugFromContact(c, true, contactsDir), contactIdSlug(c.resourceName, contactsDir)]) {
        if (slug && await contactOwner(deps, `${slug}.md`) === c.resourceName) {
          await deletePageByRelPath(deps, `${slug}.md`, sweep.summary);
        }
      }
    }
    return;
  }
  const baseSlug = personSlugFromContact(c, false, contactsDir);
  if (!baseSlug) return;
  const baseOwner = await contactOwner(deps, `${baseSlug}.md`);
  const collides = baseOwner !== null && baseOwner !== 'hand-authored' && baseOwner !== c.resourceName;
  const rendered = renderPersonPage(
    { ...c, groups: c.groups.map((g) => ({ id: g.id, name: sweep.groupNames[g.id] ?? null })) },
    collides,
    contactsDir,
  );
  if (!rendered) return;
  const owner = await contactOwner(deps, rendered.relPath);
  if (owner === 'hand-authored') {
    deps.log(`[google] skipping hand-authored ${rendered.relPath}`);
    return;
  }
  // Staged rename: this contact previously rendered elsewhere (a rename, or
  // a changed contacts directory). The new page lands first, then the page
  // it owned at the old path is retired, so a sweep that dies in between
  // leaves the contact with a page rather than none.
  await importRendered(deps, rendered.relPath, rendered.markdown, sweep.activePack, sweep.summary, sweep.countedSlugs);
  if (existingPath && existingPath !== rendered.relPath && await contactOwner(deps, existingPath) === c.resourceName) {
    await deletePageByRelPath(deps, existingPath, sweep.summary);
  }
  deps.tick(`contact ${c.resourceName}`);
}

/**
 * Ownership is keyed on google_contact_id, not path alone: a page owned by
 * a DIFFERENT contact (name collision — two "John Smith"s) must neither be
 * rewritten nor deleted; the colliding contact gets a disambiguated slug.
 */
async function contactOwner(deps: GoogleSyncDeps, relPath: string): Promise<string | null> {
  if (deps.managed) {
    const page = await deps.managed.page(relPath.replace(/\.md$/, ''));
    if (!page) return null;
    return typeof page.frontmatter.google_contact_id === 'string' ? page.frontmatter.google_contact_id : 'hand-authored';
  }
  const filePath = join(deps.cfg.dir, relPath);
  if (!existsSync(filePath)) return null;
  const m = readFileSync(filePath, 'utf-8').match(/^google_contact_id:\s*"([^"]+)"/m);
  return m ? m[1] : 'hand-authored';
}

/**
 * One contact or event through the connector item holds. A held item is
 * skipped unless re-admitted; an item-scoped failure is reported and the
 * sweep goes on, and only a content-class one (the item fails the same way
 * until it changes) counts toward a hold; a run-scoped failure, and on a
 * managed brain a failed coordinator write, stop the sweep uncounted as
 * before. Returns false
 * when the item failed and was not already held: the service's token must
 * not move past it.
 */
async function throughHolds(deps: GoogleSyncDeps, summary: GoogleSyncSummary, holds: ConnectorHoldSession | undefined,
  item: { key: string; version: string | null; title: string | null }, apply: () => Promise<void>): Promise<boolean> {
  if (!holds) {
    await apply();
    return true;
  }
  if (!holds.shouldAttempt(item.key, item.version)) {
    deps.tick(`${item.key} held`);
    return true;
  }
  try {
    await apply();
    holds.succeed(item.key);
    return true;
  } catch (e) {
    // A failed managed write keeps its own path (the run ends; `--retry-failed` re-admits it), as before.
    if (classifyItemFailure(e).scope === 'run' || deps.managed && abortsManagedRun(e)) throw e;
    const classified = classifyConnectorError(e);
    if (classified.scope !== 'item') throw e;
    const wasHeld = holds.isHeld(item.key);
    // Only a failure the item will repeat until it changes counts toward a hold; a transient one is retried next sync.
    if (classified.class === 'content') await holds.fail(item.key, e, { version: item.version, meta: { title: item.title } });
    summary.failedFiles++;
    deps.log(`[google] ${JSON.stringify(item.key)} failed (${classified.code}): ${classified.message}; `
      + (classified.class === 'content' ? `counted toward a hold (see: gbrain sources status ${deps.sourceId})` : 'retried on the next sync'));
    if (wasHeld) return true;
    summary.status = 'partial';
    return false;
  }
}

/**
 * #6324: group names for this sweep's pages. Read the directory only when a
 * listed contact carries a user group; a complete read replaces the cache (a
 * deleted or renamed group is current for every page rendered from now on,
 * an untouched contact's page refreshes when it next changes or on `--full`),
 * an incomplete read is merged over it and said so, an unreadable directory
 * falls back to the cache. A group no entry names is rendered as its raw id.
 */
async function resolveContactGroups(
  deps: GoogleSyncDeps,
  people: PeopleClient,
  state: GoogleSourceState,
  contacts: ContactData[],
): Promise<Record<string, string>> {
  const cached = state.contact_groups ?? {};
  if (!contacts.some((c) => !c.deleted && c.groups.length > 0)) return cached;
  try {
    const { names, complete } = await people.listContactGroups(deps.opts.signal ? { signal: deps.opts.signal } : {});
    if (!complete) deps.log('[google] contact groups directory exceeds the bounded read; groups it did not name keep their ids');
    state.contact_groups = complete ? names : { ...cached, ...names };
    return state.contact_groups;
  } catch (e) {
    deps.log(`[google] contact groups unavailable (${e instanceof Error ? e.message : String(e)}); pages keep cached names or raw ids`);
    return cached;
  }
}

/** Existing calendar page's source_path for an event id, or null. */
/** Existing person page's source_path for a google contact id, or null. */
async function contactPageRelPathByContactId(
  deps: GoogleSyncDeps,
  resourceName: string,
): Promise<string | null> {
  try {
    const rows = await deps.engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL
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

export async function sweepCalendar(
  deps: GoogleSyncDeps,
  calendar: CalendarClient,
  state: GoogleSourceState,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  holds?: ConnectorHoldSession,
): Promise<void> {
  const range = new CalendarSyncWindow(Date.now(), deps.cfg.historyDays, deps.cfg.futureDays ?? CALENDAR_HORIZON_DAYS);
  const list = (query: { syncToken: string } | { timeMinIso: string; timeMaxIso: string }) =>
    calendar.listEvents(deps.cfg.account, { calendarId: deps.cfg.calendarId, ...query, ...(deps.opts.signal ? { signal: deps.opts.signal } : {}) });
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
  const deltaToken = deps.opts.full ? null : state.calendar_sync_token;
  let wholeWindow = deltaToken === null;
  let result;
  try {
    result = await list(deltaToken === null ? range.listBounds() : { syncToken: deltaToken });
  } catch (e) {
    if (deltaToken === null || !(e instanceof GoogleCursorExpiredError)) {
      if (recordCalendarUnreadable(deps, state, e)) return;
      throw e;
    }
    deps.log('[google] calendar syncToken expired; windowed re-list');
    state.calendar_sync_token = null;
    wholeWindow = true;
    try {
      result = await list(range.listBounds());
    } catch (relist) {
      if (recordCalendarUnreadable(deps, state, relist)) return;
      throw relist;
    }
  }
  state.calendar_unreadable = null;
  const tally = { outside: 0, blocked: 0 };
  const sweepCtx = { activePack, summary, countedSlugs, holds };
  if (!await applyCalendarList(deps, result.events, range, sweepCtx, tally)) return;
  // A failing event that is not held yet keeps the token here, so the next sync lists it again.
  if (result.nextSyncToken && !tally.blocked) {
    state.calendar_sync_token = result.nextSyncToken;
    state.calendar_id = deps.cfg.calendarId;
  }
  // A delta never names unchanged instances that crossed the leading edge
  // since the last list, so list that stretch on its own. This list's sync
  // token is discarded (the delta cursor stays authoritative), and the
  // horizon moves only once a list really reached the ceiling.
  const catchUpFrom = range.coverageStartMs(state.calendar_horizon_ms, wholeWindow);
  if (catchUpFrom !== null) {
    const caughtUp = await list(range.listBounds(catchUpFrom));
    if (!await applyCalendarList(deps, caughtUp.events, range, sweepCtx, tally)) return;
  }
  if (!tally.blocked && (wholeWindow || catchUpFrom !== null)) state.calendar_horizon_ms = range.ceilMs;
  const prefix = eventHoldKey(deps.cfg.calendarId, '');
  for (const key of holds?.dueHeldKeys().filter(k => k.startsWith(prefix)) ?? []) {
    if (deps.opts.signal?.aborted) return;
    await throughHolds(deps, summary, holds, { key, version: null, title: null }, async () => {
      const eventId = key.slice(prefix.length);
      const ev = await calendar.getEvent(deps.cfg.account, deps.cfg.calendarId, eventId, deps.opts.signal ? { signal: deps.opts.signal } : {});
      if (ev) return applyEvent(deps, ev, range, sweepCtx, tally);
      const owned = await calendarPageRelPathByEventId(deps, eventId);
      if (owned) await deletePageByRelPath(deps, owned, summary);
    });
  }
  if (tally.outside > 0) {
    deps.log(`[google] calendar: ${tally.outside} listed event(s) outside the sync window (${deps.cfg.historyDays} days back, ${range.futureDays} ahead) were not imported`);
  }
  if (deps.opts.full) await reconcileCalendarWindow(deps, new Set(result.events.map(ev => ev.id)), range, summary);
}

/**
 * #5012 item 9: a 403 or 404 from `events.list` on the configured calendar
 * means this account cannot read it. Instead of a sweep that looks like an
 * empty calendar, the typed result is recorded in source state (doctor's
 * `google_calendar_readable` reads it with no network call) and the log line
 * names the fix. The run is not failed: the calendar stays unreadable until
 * the user changes the source, and a failed run would also hold back Gmail's
 * freshness on every sync.
 */
function recordCalendarUnreadable(deps: GoogleSyncDeps, state: GoogleSourceState, e: unknown): boolean {
  const httpStatus = calendarUnreadableStatus(e);
  if (httpStatus === null) return false;
  state.calendar_unreadable = { code: 'calendar_unreadable', calendar_id: deps.cfg.calendarId, http_status: httpStatus, at: new Date().toISOString() };
  deps.log(`[google] calendar_unreadable: ${deps.cfg.account} cannot read calendar "${deps.cfg.calendarId}" (HTTP ${httpStatus}); no events were synced. `
    + `List the calendars it can read: gbrain google calendars --account ${deps.cfg.account}; `
    + `then point the source at one: gbrain sources set-calendar ${deps.sourceId} <calendar-id>`);
  return true;
}

type CalendarSweepCtx = { activePack: ActivePack; summary: GoogleSyncSummary; countedSlugs: Set<string>; holds?: ConnectorHoldSession };

/**
 * Apply one calendar list to the brain, event by event, each through the
 * item holds (`tally.blocked` counts failing events not held yet). Returns
 * false when the sweep was aborted part-way, so the caller commits no cursor
 * state.
 */
async function applyCalendarList(deps: GoogleSyncDeps, events: CalendarEventData[], range: CalendarSyncWindow,
  ctx: CalendarSweepCtx, tally: { outside: number; blocked: number }): Promise<boolean> {
  for (const ev of events) {
    if (deps.opts.signal?.aborted) return false;
    const item = { key: eventHoldKey(deps.cfg.calendarId, ev.id), version: ev.etag ?? null, title: ev.summary };
    if (!await throughHolds(deps, ctx.summary, ctx.holds, item, () => applyEvent(deps, ev, range, ctx, tally))) tally.blocked++;
  }
  return !deps.opts.signal?.aborted;
}

/** One event: written, moved or removed by where it falls against the sync window. */
async function applyEvent(deps: GoogleSyncDeps, ev: CalendarEventData, range: CalendarSyncWindow, ctx: CalendarSweepCtx,
  tally: { outside: number }): Promise<void> {
  assertConnectorIdentity({ event_id: ev.id, attendees: ev.attendees.map((a) => a.email) });
  const page = renderCalendarEventPage(ev);
  const side = page ? range.side(ev.startIso, ev.endIso) : 'inside';
  if (side !== 'inside') tally.outside++;
  // Nothing is written or removed for an event that already ended before
  // the window, so skip the page lookup.
  if (side === 'before') return;
  const change = planCalendarPage(side, page?.relPath ?? null, await calendarPageRelPathByEventId(deps, ev.id), calendarRelPath(ev));
  if (change.kind === 'remove') await deletePageByRelPath(deps, change.relPath, ctx.summary);
  if (change.kind !== 'write' || !page) return;
  if (change.removeFirst) await deletePageByRelPath(deps, change.removeFirst, ctx.summary);
  await importRendered(deps, page.relPath, page.markdown, ctx.activePack, ctx.summary, ctx.countedSlugs);
  deps.tick(`event ${ev.id}`);
}

/**
 * `--full`: delete the sweep's calendar pages whose event starts inside the
 * listed window but that the complete list no longer names (cancelled or
 * deleted upstream), and the sweep's pages whose event starts at or past the
 * horizon (#5442: a windowed list never names those). Nothing before the
 * floor qualifies. More than 200 at once needs GBRAIN_ALLOW_MASS_RECONCILE,
 * and a refusal aborts the whole cleanup and marks the run partial.
 */
async function reconcileCalendarWindow(deps: GoogleSyncDeps, listedIds: ReadonlySet<string>, range: CalendarSyncWindow,
  summary: GoogleSyncSummary): Promise<void> {
  const pages = await deps.engine.executeRaw<{ source_path: string | null; event_id: string | null; start_iso: string | null }>(
    `SELECT source_path, frontmatter->>'event_id' AS event_id, frontmatter->>'start' AS start_iso FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'calendar/%' AND frontmatter->>'event_id' IS NOT NULL`,
    [deps.sourceId],
  );
  const gone = staleCalendarPages(pages, listedIds, range).flatMap(page => page.source_path === null ? [] : [page.source_path]);
  if (gone.length === 0) return;
  const { massReconcileAllowed } = await import('../../commands/sync.ts');
  if (gone.length > 200 && !massReconcileAllowed()) {
    deps.log(`[google] mass-delete guard refused ${gone.length} deletes for source ${deps.sourceId}`);
    summary.status = 'partial';
    return;
  }
  for (const relPath of gone) await deletePageByRelPath(deps, relPath, summary);
}
