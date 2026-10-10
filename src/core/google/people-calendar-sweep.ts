/**
 * people-calendar-sweep — the Contacts and Calendar sweeps of the google
 * source kind (peeled from google-source.ts). Cursor discipline per service:
 * the syncToken is committed only after that service's fully-successful
 * sweep; an expired token drops it and re-lists windowed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CALENDAR_HORIZON_DAYS, CalendarSyncWindow, planCalendarPage, unlistedCalendarPages } from './calendar-window.ts';
import { CalendarClient, GoogleCursorExpiredError, PeopleClient } from './google-clients.ts';
import { calendarRelPath, personSlugFromContact, renderCalendarEventPage, renderPersonPage } from './google-render.ts';
import { DEFAULT_CALENDAR_ID, type CalendarEventData, type GoogleSourceState } from './types.ts';
import { deletePageByRelPath, importRendered, type ActivePack, type GoogleSyncDeps, type GoogleSyncSummary } from './sweep-shared.ts';

// ── Contacts sweep ───────────────────────────────────────────────────────────

export async function sweepContacts(
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
    deps.tick(`contact ${c.resourceName}`);
  }
  // Cursor commits only after the whole sweep succeeded.
  if (result.nextSyncToken) state.contacts_sync_token = result.nextSyncToken;
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
): Promise<void> {
  const range = new CalendarSyncWindow(Date.now(), deps.cfg.historyDays);
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
    if (!(e instanceof GoogleCursorExpiredError)) throw e;
    deps.log('[google] calendar syncToken expired; windowed re-list');
    state.calendar_sync_token = null;
    wholeWindow = true;
    result = await list(range.listBounds());
  }
  const tally = { outside: 0 };
  const sweepCtx = { activePack, summary, countedSlugs };
  if (!await applyCalendarList(deps, result.events, range, sweepCtx, tally)) return;
  if (result.nextSyncToken) {
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
  if (wholeWindow || catchUpFrom !== null) state.calendar_horizon_ms = range.ceilMs;
  if (tally.outside > 0) {
    deps.log(`[google] calendar: ${tally.outside} listed event(s) outside the sync window (${deps.cfg.historyDays} days back, ${CALENDAR_HORIZON_DAYS} ahead) were not imported`);
  }
  if (deps.opts.full) await reconcileCalendarWindow(deps, new Set(result.events.map(ev => ev.id)), range, summary);
}

/**
 * Apply one calendar list to the brain, event by event. Returns false when
 * the sweep was aborted part-way, so the caller commits no cursor state.
 */
async function applyCalendarList(deps: GoogleSyncDeps, events: CalendarEventData[], range: CalendarSyncWindow,
  ctx: { activePack: ActivePack; summary: GoogleSyncSummary; countedSlugs: Set<string> }, tally: { outside: number }): Promise<boolean> {
  for (const ev of events) {
    if (deps.opts.signal?.aborted) return false;
    const page = renderCalendarEventPage(ev);
    const side = page ? range.side(ev.startIso, ev.endIso) : 'inside';
    if (side !== 'inside') tally.outside++;
    // Nothing is written or removed for an event that already ended before
    // the window, so skip the page lookup.
    if (side === 'before') continue;
    const change = planCalendarPage(side, page?.relPath ?? null, await calendarPageRelPathByEventId(deps, ev.id), calendarRelPath(ev));
    if (change.kind === 'remove') await deletePageByRelPath(deps, change.relPath, ctx.summary);
    if (change.kind !== 'write' || !page) continue;
    if (change.removeFirst) await deletePageByRelPath(deps, change.removeFirst, ctx.summary);
    await importRendered(deps, page.relPath, page.markdown, ctx.activePack, ctx.summary, ctx.countedSlugs);
    deps.tick(`event ${ev.id}`);
  }
  return !deps.opts.signal?.aborted;
}

/**
 * `--full`: delete the sweep's calendar pages whose event starts inside the
 * listed window but that the complete list no longer names (cancelled or
 * deleted upstream). Nothing before the floor qualifies. More than 200 at
 * once needs GBRAIN_ALLOW_MASS_RECONCILE, and a refusal marks the run partial.
 */
async function reconcileCalendarWindow(deps: GoogleSyncDeps, listedIds: ReadonlySet<string>, range: CalendarSyncWindow,
  summary: GoogleSyncSummary): Promise<void> {
  const pages = await deps.engine.executeRaw<{ source_path: string | null; event_id: string | null; start_iso: string | null }>(
    `SELECT source_path, frontmatter->>'event_id' AS event_id, frontmatter->>'start' AS start_iso FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'calendar/%' AND frontmatter->>'event_id' IS NOT NULL`,
    [deps.sourceId],
  );
  const gone = unlistedCalendarPages(pages, listedIds, range).flatMap(page => page.source_path === null ? [] : [page.source_path]);
  if (gone.length === 0) return;
  const { massReconcileAllowed } = await import('../../commands/sync.ts');
  if (gone.length > 200 && !massReconcileAllowed()) {
    deps.log(`[google] mass-delete guard refused ${gone.length} deletes for source ${deps.sourceId}`);
    summary.status = 'partial';
    return;
  }
  for (const relPath of gone) await deletePageByRelPath(deps, relPath, summary);
}
