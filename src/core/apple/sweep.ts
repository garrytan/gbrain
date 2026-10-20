/**
 * apple sweep — the Contacts, Calendar and Mail sweeps of the apple source
 * kind. Each sweep:
 *
 *   1. asks the injected reader for the configured window (a reader error is
 *      SOURCE-level: it propagates, commits nothing for that service, and is
 *      never counted toward an item hold);
 *   2. renders every item deterministically and hash-diffs it against the
 *      state (`id → sha256(path + markdown)`); an unchanged item whose page is
 *      still there costs nothing, so an identical rerun adds/modifies 0;
 *   3. writes changed items through the item holds: an item whose render or
 *      import fails on 3 consecutive runs is held and no longer blocks the run;
 *   4. on `--full` only, removes the pages of items inside the window that the
 *      complete listing no longer names. An incremental sweep never deletes
 *      anything upstream stopped listing (a staged rename of one item's own
 *      page excepted). More than 200 removals at once, or ANY removal when the
 *      listing came back EMPTY, needs GBRAIN_ALLOW_MASS_RECONCILE=1; a refusal
 *      removes nothing and marks the run partial. A listing the reader flags
 *      as cut short or unreadable (mail truncation, unreadable messages) never
 *      deletes either.
 *
 * Ownership is keyed on the marker frontmatter field (`apple_event_id`,
 * `apple_contact_id`, `apple_thread_id`), never on the path alone: a
 * hand-authored page at a contact's path is skipped, never overwritten.
 */
import type { ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { massReconcileAllowed } from '../sync-reconcile.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import {
  calendarItemKey,
  contactDisplayName,
  renderedHash,
  groupMailThreads,
  mailPriorFromPage,
  personSlugFromContact,
  renderCalendarEventPage,
  renderMailThreadPage,
  renderPersonPage,
  type RenderedPage,
} from './render.ts';
import {
  deletePageByRelPath,
  importRendered,
  loadLivePaths,
  loadOwnedPages,
  type ActivePack,
  type AppleSyncDeps,
  type AppleSyncSummary,
} from './sweep-shared.ts';
import { beginMailWalk } from './mail-walk.ts';
import { describeUnknownRouting, routingCoversAllAccounts } from './mail-routing.ts';
import { readerError } from './readers/errors.ts';
import { MAIL_THREAD_KEY, mergeThreadRef, parseThreadLocator, planMailHolds, readMailHolds, settleReadMessages, threadHoldKey, walkReaches } from './mail-holds.ts';
import { appleLoopsAvailability } from './loops-status.ts';
import { prepareLoopsState, trackMailLoops, type AppleLoopsRun } from './loops.ts';
import type { AppleCalendarEvent, AppleContact, AppleMailListing, AppleMailRouting, AppleSourceState } from './types.ts';

const DAY_MS = 86_400_000;

/** Removals one `--full` reconcile may make without GBRAIN_ALLOW_MASS_RECONCILE=1. */
export const APPLE_MASS_RECONCILE_LIMIT = 200;

export interface AppleSweepCtx {
  deps: AppleSyncDeps;
  state: AppleSourceState;
  activePack: ActivePack;
  summary: AppleSyncSummary;
  countedSlugs: Set<string>;
  holds: ConnectorHoldSession;
  /** Failures this run that must keep a cursor where it is: an item not held when the run began, or any failure that is not item-scoped. */
  pins?: number;
  /** Open-loop bookkeeping for this run; present only when Mail loop tracking is available (owner addresses set). */
  loops?: AppleLoopsRun;
  /** Newest remembered-message locator per Mail thread hold; written into the finished holds (`applyThreadRefs`). */
  mailRefs?: Map<string, string>;
  /** Hold keys whose item failed this run (a failure is never cleared by a later settle in the same run). */
  failedKeys?: Set<string>;
}

const byId = <T,>(key: (x: T) => string) => (a: T, b: T): number => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Item holds ───────────────────────────────────────────────────────────────

/** Counts one item failure (hold bookkeeping, summary, log). Managed write errors are rethrown by the hold session. */
interface FailDetail { ref?: string | null; upstreamAt?: string | null }

async function failItem(ctx: AppleSweepCtx, holdKey: string, error: unknown, version: string | null, page: RenderedPage | null, detail: FailDetail = {}): Promise<void> {
  const { deps, summary, holds } = ctx;
  const wasHeld = holds.isHeld(holdKey);
  (ctx.failedKeys ??= new Set()).add(holdKey);
  const classified = await holds.fail(holdKey, error, { version, slug: page ? page.relPath.replace(/\.md$/, '') : null,
    ...(detail.ref ? { ref: detail.ref } : {}), ...(detail.upstreamAt ? { meta: { upstream_at: detail.upstreamAt } } : {}) });
  summary.failedFiles++;
  deps.log(`[apple] ${holdKey} failed${classified.scope === 'rate_limit' ? ' (rate limited; not counted toward a hold)' : ''}: ${messageOf(error)}`);
  // A held item that fails again after being re-admitted neither makes the run partial nor holds a cursor back.
  if (!wasHeld || classified.scope !== 'item') {
    summary.status = 'partial';
    ctx.pins = (ctx.pins ?? 0) + 1;
  }
}

/**
 * One item through the holds. True when it was written. `admit` re-attempts a held item the holds would skip (a recovery
 * walk is reading its whole thread now); `settle: false` writes the page but leaves the record for the caller to settle
 * once the evidence is complete.
 */
async function attemptItem(ctx: AppleSweepCtx, holdKey: string, version: string, page: RenderedPage, work: () => Promise<void>, detail: FailDetail = {},
  opts: { admit?: boolean; settle?: boolean } = {}): Promise<boolean> {
  if (!ctx.holds.shouldAttempt(holdKey, version) && !opts.admit) {
    ctx.deps.tick(`${holdKey} held`);
    return false;
  }
  try {
    await work();
    if (opts.settle !== false) ctx.holds.succeed(holdKey);
    ctx.deps.tick(holdKey);
    return true;
  } catch (e) {
    await failItem(ctx, holdKey, e, version, page, detail);
    return false;
  }
}

/** Run a pure render; a throw is an item failure (version unknown), never a sweep failure. */
async function safeRender<T>(ctx: AppleSweepCtx, holdKey: string, render: () => T, detail: FailDetail = {}): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: render() };
  } catch (e) {
    if (!ctx.holds.shouldAttempt(holdKey, null)) return { ok: false };
    await failItem(ctx, holdKey, e, null, null, detail);
    return { ok: false };
  }
}

// ── Full reconcile ───────────────────────────────────────────────────────────

/**
 * Removes `gone` pages (already restricted to the sweep's window by the
 * caller). Returns whether the removal ran; a refusal aborts the whole
 * cleanup and marks the run partial.
 */
async function reconcileRemovals(ctx: AppleSweepCtx, service: string, gone: Array<{ key: string; path: string }>, listedCount: number): Promise<boolean> {
  if (gone.length === 0) return true;
  // An empty listing with pages still owned reads as "everything was deleted", which is also what a
  // reader that silently saw nothing looks like. Refuse unless the operator opts in.
  if (listedCount === 0 && !massReconcileAllowed()) {
    ctx.deps.log(`[apple] empty-listing guard refused ${gone.length} ${service} deletes for source ${ctx.deps.sourceId}: the reader listed nothing (set GBRAIN_ALLOW_MASS_RECONCILE=1 if that is really so)`);
    ctx.summary.status = 'partial';
    ctx.summary.incomplete.push(`${service}:empty_listing_refused`);
    return false;
  }
  if (gone.length > APPLE_MASS_RECONCILE_LIMIT && !massReconcileAllowed()) {
    ctx.deps.log(`[apple] mass-delete guard refused ${gone.length} ${service} deletes for source ${ctx.deps.sourceId} (set GBRAIN_ALLOW_MASS_RECONCILE=1 to allow)`);
    ctx.summary.status = 'partial';
    ctx.summary.incomplete.push(`${service}:mass_delete_refused`);
    return false;
  }
  for (const g of gone) await deletePageByRelPath(ctx.deps, g.path, ctx.summary);
  return true;
}

const signalOf = (ctx: AppleSweepCtx): { signal?: AbortSignal } => (ctx.deps.opts.signal ? { signal: ctx.deps.opts.signal } : {});
const aborted = (ctx: AppleSweepCtx): boolean => ctx.deps.opts.signal?.aborted === true;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// ── Calendar ─────────────────────────────────────────────────────────────────

export async function sweepCalendar(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const nowMs = deps.now();
  const from = new Date(nowMs - deps.cfg.historyDays * DAY_MS);
  const to = new Date(nowMs + deps.cfg.futureDays * DAY_MS);
  // A reader error propagates: source-level, nothing is committed or held.
  const listed = await deps.readers.calendar({ from, to, calendarIds: deps.cfg.calendarIds, ...signalOf(ctx) });
  summary.itemsSeen.calendar = listed.length;

  const events = new Map<string, AppleCalendarEvent>();
  for (const ev of listed) events.set(calendarItemKey(ev), ev);

  const pathByKey = new Map<string, string>();
  const startByKey = new Map<string, string>();
  for (const o of await loadOwnedPages(deps, 'apple_event_id')) {
    const id = str(o.frontmatter.apple_event_id);
    const cal = str(o.frontmatter.apple_calendar_id);
    if (id === null || cal === null) continue;
    const key = `${cal}:${id}`;
    pathByKey.set(key, o.sourcePath);
    startByKey.set(key, str(o.frontmatter.start) ?? '');
  }

  const live = new Set<string>();
  for (const key of [...events.keys()].sort()) {
    if (aborted(ctx)) return;
    const ev = events.get(key)!;
    const holdKey = `calendar:${key}`;
    const rendered = await safeRender(ctx, holdKey, () => renderCalendarEventPage(ev, deps.cfg.account));
    if (!rendered.ok) { live.add(key); continue; }
    const page = rendered.value;
    // Cancelled: not rendered, not live; an incremental sweep leaves any existing page alone.
    if (!page) continue;
    live.add(key);
    const hash = renderedHash(page.relPath, page.markdown);
    const existing = pathByKey.get(key);
    if (state.calendar.hashes[key] === hash && existing === page.relPath) continue;
    await attemptItem(ctx, holdKey, hash, page, async () => {
      await importRendered(deps, page.relPath, page.markdown, ctx.activePack, summary, ctx.countedSlugs,
        { apple_event_id: ev.id, apple_calendar_id: ev.calendarId });
      // Staged rename (the event moved to another day or title): the new page lands first.
      if (existing && existing !== page.relPath) await deletePageByRelPath(deps, existing, summary);
      state.calendar.hashes[key] = hash;
      pathByKey.set(key, page.relPath);
      startByKey.set(key, ev.start);
    });
  }
  if (aborted(ctx)) return;

  if (deps.opts.full) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [key, path] of pathByKey) {
      if (live.has(key)) continue;
      const start = Date.parse(startByKey.get(key) ?? '');
      // Only events starting inside the listed window can be judged gone.
      if (Number.isFinite(start) && start >= from.getTime() && start < to.getTime()) gone.push({ key, path });
    }
    if (await reconcileRemovals(ctx, 'calendar', gone, listed.length)) {
      for (const g of gone) delete state.calendar.hashes[g.key];
      for (const key of Object.keys(state.calendar.hashes)) {
        if (!live.has(key) && !pathByKey.has(key)) delete state.calendar.hashes[key];
      }
    }
  }
  state.calendar.window = { from: from.toISOString(), to: to.toISOString() };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function sweepContacts(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const dir = deps.cfg.contactsDir;
  const listed = await deps.readers.contacts({ ...signalOf(ctx) });
  summary.itemsSeen.contacts = listed.length;

  const contacts = new Map<string, AppleContact>();
  for (const c of listed) contacts.set(c.id, c);

  const pathById = new Map<string, string>();
  const ownerByPath = new Map<string, string>();
  for (const o of await loadOwnedPages(deps, 'apple_contact_id')) {
    const id = str(o.frontmatter.apple_contact_id);
    if (id === null) continue;
    pathById.set(id, o.sourcePath);
    ownerByPath.set(o.sourcePath, id);
  }
  const livePaths = await loadLivePaths(deps, `${dir}/`);

  const live = new Set<string>();
  // Sorted so a name collision resolves the same way on every run.
  for (const c of [...contacts.values()].sort(byId((x) => x.id))) {
    if (aborted(ctx)) return;
    const holdKey = `contacts:${c.id}`;
    const rendered = await safeRender(ctx, holdKey, () => {
      const baseSlug = personSlugFromContact(c, false, dir);
      if (!baseSlug) return null;
      const baseOwner = ownerByPath.get(`${baseSlug}.md`);
      return renderPersonPage(c, baseOwner !== undefined && baseOwner !== c.id, dir);
    });
    if (!rendered.ok) { live.add(c.id); continue; }
    const page = rendered.value;
    if (!page) continue;
    live.add(c.id);
    const owner = ownerByPath.get(page.relPath);
    if (owner === undefined && livePaths.has(page.relPath)) {
      // Hand-authored (or another connector's) page: body and frontmatter untouched.
      deps.log(`[apple] skipping hand-authored ${page.relPath}`);
      continue;
    }
    if (owner !== undefined && owner !== c.id) {
      deps.log(`[apple] skipping ${page.relPath}: owned by another contact`);
      continue;
    }
    const hash = renderedHash(page.relPath, page.markdown);
    const existing = pathById.get(c.id);
    if (state.contacts.hashes[c.id] === hash && existing === page.relPath) continue;
    await attemptItem(ctx, holdKey, hash, page, async () => {
      await importRendered(deps, page.relPath, page.markdown, ctx.activePack, summary, ctx.countedSlugs, { apple_contact_id: c.id });
      // Staged rename (renamed contact or changed contacts dir): retire the old page once the new one exists.
      if (existing && existing !== page.relPath && ownerByPath.get(existing) === c.id) {
        await deletePageByRelPath(deps, existing, summary);
        ownerByPath.delete(existing);
      }
      ownerByPath.set(page.relPath, c.id);
      pathById.set(c.id, page.relPath);
      state.contacts.hashes[c.id] = hash;
    });
  }
  if (aborted(ctx)) return;

  if (deps.opts.full) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [id, path] of pathById) if (!live.has(id)) gone.push({ key: id, path });
    if (await reconcileRemovals(ctx, 'contacts', gone, listed.length)) {
      for (const g of gone) delete state.contacts.hashes[g.key];
      for (const id of Object.keys(state.contacts.hashes)) {
        if (!live.has(id) && !pathById.has(id)) delete state.contacts.hashes[id];
      }
    }
  }
}

// ── Mail ─────────────────────────────────────────────────────────────────────

/** Re-read this much before the newest message of the last complete run (late-arriving / re-dated mail). */
export const APPLE_MAIL_OVERLAP_MS = 2 * DAY_MS;

/**
 * Where this run starts reading. `--full` always reads the whole configured window (its removals are
 * judged against that listing); an incremental run reads from a 2-day overlap before the newest
 * message it has seen, or from where a capped run stopped, never earlier than the window.
 */
export function mailReadSince(state: AppleSourceState, windowStart: Date, full: boolean): Date {
  if (full) return windowStart;
  const resume = Date.parse(state.mail.resume_from ?? '');
  const newest = Date.parse(state.mail.newest ?? '');
  const from = Number.isFinite(resume) ? resume - 1 : Number.isFinite(newest) ? newest - APPLE_MAIL_OVERLAP_MS : windowStart.getTime();
  return new Date(Math.max(windowStart.getTime(), from));
}

/**
 * Which Mail accounts this run may read. A reader without `mailRouting` (an injected fake) is read as before. An
 * unclassifiable enabled account stops the WHOLE Mail sweep before anything is read or any state is touched (fail closed).
 */
async function resolveMailRouting(ctx: AppleSweepCtx): Promise<AppleMailRouting | undefined> {
  const { deps } = ctx;
  if (!deps.readers.mailRouting) return undefined;
  const routing = await deps.readers.mailRouting(signalOf(ctx));
  if (routing.status === 'unknown') throw readerError('mail_routing_unknown', 'mail', `${describeUnknownRouting(routing)} The whole Mail sync was skipped and nothing was read.`);
  if (routing.status === 'no_enabled_accounts') throw readerError('mail_not_running_or_unconfigured', 'mail', 'Mail.app has no enabled account to read.');
  return routing;
}

/**
 * Binds every Mail cursor to the routing scope. A different fingerprint (or none: a cursor from before routing existed)
 * restarts the read of the window and drops staged recovery evidence, because both were made under another set of accounts
 * (staged bodies may have come from an account that is now Google). Stored pages and holds are NEVER touched: a hold is not
 * cleared as gone because its message is no longer in scope, and the sticky `legacy` mark keeps `--full` from removing any
 * mail page once pages of unknown account origin exist.
 */
function applyMailRouting(ctx: AppleSweepCtx, routing: AppleMailRouting, hasPages: boolean): void {
  const { deps, state } = ctx;
  const stored = state.mail.routing;
  if (stored && stored.v === routing.version && stored.fp === routing.fingerprint) return;
  const m = state.mail;
  const hashed = Object.keys(m.hashes).length > 0;
  const hadMail = hasPages || hashed || m.since !== undefined || m.newest !== undefined || m.resume_from !== undefined || m.walk !== undefined || state.mail_recovery !== undefined;
  const legacy = stored?.legacy === true || hasPages || hashed;
  state.mail.routing = { v: routing.version, fp: routing.fingerprint, ...(legacy ? { legacy: true as const } : {}) };
  if (!stored && !hadMail) return; // a first Mail read: nothing was made under another scope
  delete m.newest; delete m.resume_from; delete m.resume_id; delete m.walk;
  const staged = state.mail_recovery ? Object.keys(state.mail_recovery.staged).length : 0;
  delete state.mail_recovery;
  if (state.mail_loops) { state.mail_loops.reread = true; delete state.mail_loops.complete_at; }
  deps.log(`[apple] mail account routing ${stored ? 'changed' : 'is new for this cursor'}: the mail window is read again from its start and ${staged} staged recovery message(s) are dropped (they may have come from an account that is no longer read); stored pages and holds are kept`);
}

/** A read must have been made under exactly the routing this run resolved; anything else is refused before it is rendered. */
function assertListingScope(listing: AppleMailListing, routing: AppleMailRouting): void {
  if (listing.routing?.version !== routing.version || listing.routing.fingerprint !== routing.fingerprint) {
    throw readerError('mail_routing_changed', 'mail', 'the Mail read was not made under the account routing this run resolved');
  }
}

export async function sweepMail(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const windowStart = new Date(deps.now() - deps.cfg.mailDays * DAY_MS);
  // Owner changes and unresolved coverage require a scope-bound whole-window walk.
  const trackLoops = ctx.loops !== undefined && appleLoopsAvailability(deps.cfg).available;
  // Which Mail accounts may be read at all (Google-hosted ones never are). Resolved first: an unknown account stops here.
  const routing = await resolveMailRouting(ctx);
  const ownedPages = await loadOwnedPages(deps, 'apple_thread_id');
  if (routing) {
    applyMailRouting(ctx, routing, ownedPages.length > 0);
    if (routing.eligible.length === 0) {
      // Every enabled account is Google: Apple Mail has nothing to read, and the mail the Google connector owns is not ours to judge.
      summary.itemsSeen.mail = 0;
      summary.incomplete.push('mail:google_only');
      deps.log('[apple] every enabled Mail account is hosted by Google, so Apple Mail reads nothing (connect them with `gbrain google setup`); stored pages and holds are kept');
      if (trackLoops && state.mail_loops) { delete state.mail_loops.complete_at; ctx.loops?.gaps.push('google_routed'); }
      return;
    }
  }
  const rereadAll = trackLoops && prepareLoopsState(state, deps.cfg);
  const incrementalSince = mailReadSince(state, windowStart, false);
  // Held messages are not read (they cost body time and would starve their neighbours); the ones that are due for a
  // re-attempt (retry-held, a transient reconsideration, --full) are read again by id below, however old they are.
  // A due hold no remembered list can rebuild (oversize thread, unusable locator) asks for a whole-window recovery walk.
  const plan = planMailHolds(ctx.holds, windowStart);
  if (plan.unreachable.length > 0) {
    deps.log(`[apple] ${plan.unreachable.length} held mail thread(s) have messages older than the mail window (a_mail_days); a window read cannot recover them, so they stay held and mail coverage stays incomplete until the window covers them`);
  }
  const walk = beginMailWalk(state, deps.cfg, windowStart, deps.opts.full === true, rereadAll, incrementalSince, plan.walk, new Date(deps.now()).toISOString(), routing?.fingerprint);
  // A full or recovery walk is the evidence that can rebuild a held oversize thread; a held thread is cleared only when it ends.
  const recoveryWalk = walk.recover !== undefined;
  const since = new Date(Math.max(Date.parse(walk.since), Date.parse(state.mail.resume_from ?? '') - 1 || 0));
  const failedBefore = summary.failedFiles;
  const pinsBefore = ctx.pins ?? 0;
  const read = await deps.readers.mail({ since, mailboxes: deps.cfg.mailMailboxes, max: deps.cfg.mailMax,
    ...(state.mail.resume_from && state.mail.resume_id ? { after: { date: state.mail.resume_from, id: state.mail.resume_id } } : {}),
    ...(plan.exclude.length > 0 ? { exclude: plan.exclude } : {}), ...(routing ? { routing } : {}), ...signalOf(ctx) });
  const listing: AppleMailListing = Array.isArray(read) ? { messages: read } : read;
  if (routing) assertListingScope(listing, routing);
  const messages = listing.messages;
  const truncated = listing.truncated === true;
  const readable = listing.incomplete !== true;
  summary.itemsSeen.mail = messages.length;
  if (truncated) {
    summary.status = 'partial';
    summary.incomplete.push('mail:truncated');
    deps.log(listing.budgetExhausted === true
      ? `[apple] mail read stopped at the helper's body time budget after ${messages.length} message(s) (Mail.app is slow to produce some bodies); the rest is read on the next run`
      : `[apple] mail listing truncated at ${deps.cfg.mailMax} messages (a_mail_max); the rest is read on the next run`);
  }
  const holdRun = await readMailHolds({ holds: ctx.holds, plan, listing, mailboxes: deps.cfg.mailMailboxes,
    readTargets: deps.readers.mailMessages ? (o) => deps.readers.mailMessages!(o) : undefined, ...(routing ? { routing } : {}), state, now: deps.now, ...signalOf(ctx), log: deps.log });
  if (holdRun.readFailed) summary.status = 'partial';
  // The listing the cursor follows is the main read; messages read by id only feed rendering and open-loop evidence.
  const listed = new Set(messages.map((m) => m.id));
  const allMessages = holdRun.extra.length > 0 ? [...messages, ...holdRun.extra.filter((m) => !listed.has(m.id))] : messages;
  if (holdRun.pin) {
    summary.status = 'partial';
    summary.incomplete.push('mail:unavailable_threads');
    deps.log(`[apple] ${new Set([...(listing.unavailableThreads ?? []), ...holdRun.failedThreads, ...holdRun.deferred]).size} mail thread(s) contain unreadable messages; the cursor will not advance`);
  }
  if (!readable) {
    summary.status = 'partial';
    summary.incomplete.push('mail:unreadable_messages');
    deps.log('[apple] some mail messages could not be read; nothing is removed this run');
  }

  const pathByThread = new Map<string, string>();
  const frontmatterByThread = new Map<string, Record<string, unknown>>();
  for (const o of ownedPages) {
    const id = str(o.frontmatter.apple_thread_id);
    if (id === null) continue;
    pathByThread.set(id, o.sourcePath);
    frontmatterByThread.set(id, o.frontmatter);
  }

  // A thread with an unreadable message still exists upstream: it is live for the sweep (never deleted), and stays live
  // while a message hold keeps its page incomplete, even after the cursor has moved past the message.
  const live = new Set<string>([...walk.seen, ...(listing.unavailableThreads ?? []), ...holdRun.blockedThreads()]);
  const threads = groupMailThreads(allMessages);
  for (const thread of threads) live.add(thread.threadId);
  // Open-loop bookkeeping: threads with a page this run, and those whose page did not land (failed render/import, held).
  const rendered = new Set<string>();
  const notLanded = new Set<string>();
  const landedSlug = new Map<string, string>();
  // Held oversize threads this run rebuilt while a recovery walk is reading the whole window (settled only when it ends).
  const walkLanded = new Set<string>();
  for (const thread of threads) {
    if (aborted(ctx)) return;
    const holdKey = threadHoldKey(thread.threadId);
    const record = ctx.holds.holds.record(holdKey);
    // What a later re-attempt needs to rebuild this thread when it is no longer in the incremental listing: everything the
    // record remembers plus what this run lists (never just this run's slice, never a stale shorter list).
    const ref = mergeThreadRef(record, thread.messages, str(frontmatterByThread.get(thread.threadId)?.first_message_date));
    const detail: FailDetail = { ref, upstreamAt: thread.messages[thread.messages.length - 1]?.date ?? null };
    let walkKind = false; // a held thread only a whole-window walk can rebuild: never settled at a landing
    let walkBound = false; // ...and admitted by the walk now
    if (record) {
      (ctx.mailRefs ??= new Map()).set(holdKey, ref);
      const locator = parseThreadLocator(record.ref);
      // A thread with an outstanding import record is rebuilt only from COMPLETE evidence: every remembered message is
      // listed, on the page already, read by id this run or gone upstream; an oversize thread needs the whole-window walk.
      const have = new Set<string>([...thread.messages.map((m) => m.id), ...strList(frontmatterByThread.get(thread.threadId)?.apple_message_ids)]);
      // A whole-window walk proves a held oversize thread only when its oldest known message lies inside the walk's window
      // (a locator without that boundary is trusted only when this view names at least as many messages as it stands for).
      // Otherwise rebuilding from what the window still lists would land a partial page and clear the hold falsely.
      const reach = locator.walk ? walkReaches(locator, walk.since) : 'yes';
      const provable = reach === 'yes' || (reach === 'unknown' && have.size >= locator.size);
      const complete = locator.walk ? record.state !== 'held' || (recoveryWalk && provable) : locator.targets.every((t) => have.has(t.id) || holdRun.gone.has(t.id) || holdRun.unreadable.has(t.id));
      if (!complete) {
        live.add(thread.threadId);
        notLanded.add(thread.threadId);
        deps.log(`[apple] mail thread ${record.state === 'held' ? 'held' : 'failing'}: not every remembered message is available this run; it is not rebuilt from partial evidence`);
        continue;
      }
      // Admitted once per walk: a rebuild that failed since the walk began waits for its backoff like any held retry.
      walkKind = locator.walk && record.state === 'held';
      walkBound = walkKind && Date.parse(record.last_failed_at) < Date.parse(walk.recover ?? '');
    }
    const first = await safeRender(ctx, holdKey, () => renderMailThreadPage(thread, deps.cfg.account), detail);
    if (!first.ok) { live.add(thread.threadId); notLanded.add(thread.threadId); continue; }
    let page = first.value;
    if (!page) { if (walkKind) walkLanded.add(thread.threadId); continue; } // automated mail renders nothing
    live.add(thread.threadId);
    rendered.add(thread.threadId);
    const existing = pathByThread.get(thread.threadId);
    if (state.mail.hashes[thread.threadId] === renderedHash(page.relPath, page.markdown) && existing === page.relPath) { if (walkKind) walkLanded.add(thread.threadId); continue; }
    if (existing) {
      // The read window no longer lists the oldest messages of a long thread: carry them forward from the page.
      const stored = frontmatterByThread.get(thread.threadId) ?? {};
      let prior;
      try { prior = await loadMailPrior(ctx, existing, stored); } catch (e) {
        if (ctx.holds.shouldAttempt(holdKey, null)) await failItem(ctx, holdKey, e, null, null, detail);
        notLanded.add(thread.threadId);
        continue;
      }
      if (prior) {
        const carried = await safeRender(ctx, holdKey, () => renderMailThreadPage(thread, deps.cfg.account, prior), detail);
        if (!carried.ok) { notLanded.add(thread.threadId); continue; }
        if (carried.value) page = carried.value;
      } else {
        // The stored page names messages this listing no longer returns and its body cannot be split back
        // into per-message blocks: rewriting it from the listing would silently drop them. Keep the page.
        const listedIds = new Set(thread.messages.map((m) => m.id));
        const storedIds = Array.isArray(stored.apple_message_ids) ? stored.apple_message_ids.filter((x): x is string => typeof x === 'string') : [];
        const dropped = storedIds.filter((id) => !listedIds.has(id));
        if (dropped.length > 0) {
          if (ctx.holds.shouldAttempt(holdKey, null)) {
            await failItem(ctx, holdKey, new Error(`stored mail page ${existing} holds ${dropped.length} message(s) the reader no longer lists and cannot be carried forward; page left unchanged`), null, null, detail);
          }
          notLanded.add(thread.threadId);
          continue;
        }
      }
    }
    const final = page;
    const hash = renderedHash(final.relPath, final.markdown);
    if (state.mail.hashes[thread.threadId] === hash && existing === final.relPath) { if (walkKind) walkLanded.add(thread.threadId); continue; }
    const landed = await attemptItem(ctx, holdKey, hash, final, async () => {
      const slug = await importRendered(deps, final.relPath, final.markdown, ctx.activePack, summary, ctx.countedSlugs,
        { apple_thread_id: thread.threadId, apple_message_ids: thread.messages.map((m) => m.id) });
      landedSlug.set(thread.threadId, slug);
      if (existing && existing !== final.relPath) await deletePageByRelPath(deps, existing, summary);
      state.mail.hashes[thread.threadId] = hash;
      pathByThread.set(thread.threadId, final.relPath);
    }, detail, { admit: walkBound, settle: !walkKind });
    if (!landed) notLanded.add(thread.threadId);
    else if (walkKind) walkLanded.add(thread.threadId);
  }
  if (aborted(ctx)) return;
  if (recoveryWalk) {
    // The walk remembers which held threads it has rebuilt so far; one that failed or was not rebuilt this run is forgotten.
    const landed = new Set([...(walk.landed ?? []), ...walkLanded]);
    for (const id of notLanded) landed.delete(id);
    walk.landed = [...landed].sort();
  }
  // A message read again only clears its hold (or counts as a healthy attempt) when its thread's page landed.
  settleReadMessages(ctx.holds, holdRun, allMessages, notLanded);
  const blockedThreads = holdRun.blockedThreads();

  // The removal verdict needs a complete listing of the whole window: an incremental read, a capped read
  // and an unreadable-message read are all partial views. A held message's thread is live, so it never counts as gone.
  if (walk.purpose === 'full' && !truncated && readable && !holdRun.pin && summary.failedFiles === failedBefore && notLanded.size === 0) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [tid, path] of pathByThread) {
      if (live.has(tid)) continue;
      const firstDate = Date.parse(str(frontmatterByThread.get(tid)?.first_message_date) ?? '');
      // Threads that began before the mail window are out of enumeration scope.
      if (Number.isFinite(firstDate) && firstDate >= windowStart.getTime()) gone.push({ key: tid, path });
    }
    if (state.mail.routing?.legacy === true) {
      // Pages of unknown account origin exist (imported before account routing, or from an account since routed away or
      // disabled), and a page cannot tell which account a thread came from: not listed is NOT proof it was deleted. No mail
      // page is ever removed automatically here; removing them is an explicit cleanup the owner approves.
      if (gone.length > 0) deps.log(`[apple] --full kept ${gone.length} mail page(s) no longer listed: some stored mail pages may come from an account the Apple connector no longer reads, so none is removed automatically`);
    } else if (await reconcileRemovals(ctx, 'mail', gone, live.size)) {
      for (const g of gone) delete state.mail.hashes[g.key];
      for (const tid of Object.keys(state.mail.hashes)) {
        if (!live.has(tid) && !pathByThread.has(tid)) delete state.mail.hashes[tid];
      }
    }
  }

  if (trackLoops && state.mail_loops) {
    if (!readable) state.mail_loops.coverage_gap = true;
    else if (walk.purpose !== 'incremental' && !truncated && live.size > 0 && summary.failedFiles === failedBefore
      && !holdRun.pin) delete state.mail_loops.coverage_gap;
    if (state.mail_loops.coverage_gap) ctx.loops?.gaps.push('unresolved_coverage');
  }
  // Mail the Google connector owns is never read here, so the answer is never "complete": it does not force a re-read (nothing more to read).
  if (trackLoops && ctx.loops && routing) {
    if (routing.google.length > 0) ctx.loops.gaps.push('google_routed');
    if (routing.disabled.length > 0) ctx.loops.gaps.push('disabled_routed');
  }
  if (trackLoops && ctx.loops) {
    const slugByThread = new Map(landedSlug);
    const missing = [...rendered].filter((id) => !slugByThread.has(id) && !notLanded.has(id));
    if (missing.length > 0) {
      const rows = await deps.engine.executeRaw<{ slug: string; tid: string }>(
        `SELECT slug, frontmatter->>'apple_thread_id' AS tid FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = ANY(string_to_array($2, E'\\n'))`,
        [deps.sourceId, missing.join('\n')]);
      for (const r of rows) slugByThread.set(r.tid, r.slug);
    }
    // A rendered thread whose page is not in the brain (pending managed write) cannot carry a loop yet.
    for (const id of rendered) if (!slugByThread.has(id)) notLanded.add(id);
    // A thread whose page import is HELD keeps coverage incomplete like a held message does, wherever the cursor is
    // (also when the incremental read no longer lists it), without a whole-window re-read per run.
    const heldThreads = new Set(blockedThreads);
    const listedThreads = new Set(threads.map((t) => t.threadId));
    for (const record of Object.values(ctx.holds.holds.initial().items)) {
      if (record.state !== 'held' || !record.key.startsWith(MAIL_THREAD_KEY)) continue;
      const id = record.key.slice(MAIL_THREAD_KEY.length);
      if (!listedThreads.has(id) || notLanded.has(id)) heldThreads.add(id);
    }
    await trackMailLoops({
      engine: deps.engine, sourceId: deps.sourceId, cfg: deps.cfg, state, log: deps.log, now: deps.now, ...signalOf(ctx),
      run: ctx.loops, messages: allMessages, slugByThread, notLanded, unavailableThreads: new Set(listing.unavailableThreads ?? []),
      heldThreads, recoveredThreads: holdRun.clearedThreads(),
      listingClean: !truncated && readable && !holdRun.pin && summary.failedFiles === failedBefore && [...notLanded].every(id => heldThreads.has(id)) && !summary.incomplete.some(g => g.startsWith('mail:')),
    });
  }

  state.mail.since = windowStart.toISOString();
  const newestMs = messages.reduce((m, x) => Math.max(m, Date.parse(x.date) || 0), 0);
  // A thread that did not land blocks the cursor unless it was already held when the run began (held threads are visible
  // through the holds and never hold a cursor back); a first-time failure, a pending write or a non-item error does.
  const landingPin = [...notLanded].some((id) => !ctx.holds.holds.isHeld(threadHoldKey(id)));
  const unresolved = !readable || holdRun.pin || (ctx.pins ?? 0) !== pinsBefore || landingPin
    || (!truncated && summary.incomplete.some(g => g.startsWith('mail:')));
  if (recoveryWalk && !unresolved && !truncated) {
    // The walk is complete: a held oversize thread it rebuilt (and that has not failed since) is recovered; one it never saw
    // is gone upstream (or older than the window) and has nothing left to rebuild.
    const landed = new Set(walk.landed ?? []);
    for (const record of Object.values(ctx.holds.holds.initial().items)) {
      if (record.state !== 'held' || !record.key.startsWith(MAIL_THREAD_KEY) || !parseThreadLocator(record.ref).walk) continue;
      const id = record.key.slice(MAIL_THREAD_KEY.length);
      if (ctx.failedKeys?.has(record.key) || notLanded.has(id)) continue;
      if (landed.has(id)) ctx.holds.succeed(record.key);
      // Never seen by a walk that reaches all of it: gone upstream. One the window cannot reach (or whose reach is unknown) stays.
      else if (!live.has(id) && (!routing || routingCoversAllAccounts(routing)) && walkReaches(parseThreadLocator(record.ref), walk.since) === 'yes') {
        // An incomplete provider scope may simply have excluded every message in this held thread (Google / disabled account).
        // Never clear an old thread hold as gone merely because it was filtered; the owner can remove it explicitly.
        ctx.holds.shouldAttempt(record.key); ctx.holds.drop(record.key);
      }
    }
  }
  if (!unresolved && truncated && messages.length > 0) {
    // Advance by a stable (date,id) key, not timestamp alone: Mail.app can have
    // hundreds of messages at one timestamp and its native filter is date-only.
    const boundary = messages[messages.length - 1]!;
    state.mail.resume_from = boundary.date;
    state.mail.resume_id = boundary.id;
    walk.seen = [...live].sort();
  } else if (!unresolved && !truncated) {
    delete state.mail.resume_from;
    delete state.mail.resume_id;
    delete state.mail.walk;
    if (newestMs > 0) state.mail.newest = new Date(Math.max(newestMs, Date.parse(state.mail.newest ?? '') || 0)).toISOString();
  }
  // On any failed import or coverage gap, keep the previous boundary so the
  // next run repeats the unresolved slice rather than skipping past it.
}

/**
 * The prior mail page, for carrying forward messages the reader window no
 * longer lists. A mail thread page is inline by construction (bounded message
 * bodies); a segmented one is refused with `page_body_segmented` rather than
 * rewritten without its older messages.
 */
async function loadMailPrior(ctx: AppleSweepCtx, relPath: string, frontmatter: Record<string, unknown>) {
  const rows = await ctx.deps.engine.executeRaw<{ compiled_truth: string | null; title: string | null; body_storage: string | null; slug: string }>(
    `SELECT compiled_truth, title, body_storage, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL LIMIT 1`,
    [ctx.deps.sourceId, relPath],
  );
  const row = rows[0];
  if (row) assertInlineBody({ body_storage: row.body_storage as 'inline' | 'segmented' | null, slug: row.slug, source_id: ctx.deps.sourceId }, 'apple mail carry-forward');
  const body = row?.compiled_truth;
  return typeof body === 'string' ? mailPriorFromPage(relPath, frontmatter, body, row?.title ?? null) : null;
}

export { contactDisplayName };
