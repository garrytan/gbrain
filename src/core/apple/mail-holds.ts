/**
 * apple mail-holds — the Apple Mail side of the shared connector item holds (connectors/item-holds.ts).
 *
 * Two kinds of hold exist for Mail, both in the one shared `item_holds` state and both on the shared 3-run
 * threshold, held-at-start skip, `retry-held` request and cursor rules:
 *
 *   `mail:<threadId>`          a thread whose page failed to render or import (existing).
 *   `mail-message:<messageId>` ONE message the reader proved unreadable (Mail.app cannot produce its body). The
 *                              record keeps the stable id (key), the received date (`meta.upstream_at`) and the owning
 *                              thread (`ref`), which is what a targeted re-read, deletion protection and the open-loop
 *                              coverage need after the cursor has moved past the message.
 *
 * Rules (the Google connector's, plus what Mail needs on top):
 *  - only a PROVEN unreadable message is counted (`unavailableMessages`); a thread the reader merely could not
 *    resolve in time (`deferredThreads`), an unattributable message (`incomplete`), a reader/source error, a helper
 *    timeout or a budget truncation is never an item hold and keeps pinning the cursor as before;
 *  - a message counts as a failed run only when the run attempted it; runs 1-3 pin the cursor, a hold that exists when
 *    a run STARTS is excluded from the read (it costs no body time and cannot starve its neighbours) and never pins;
 *  - a held message is re-attempted by `retry-held`, a due transient reconsideration or `sync --full` through a
 *    targeted read by id and date, so it is reachable however old it is;
 *  - while a message hold is outstanding its thread stays live (never removed as deleted) and Mail open-loop coverage
 *    stays incomplete until the message is actually read again;
 *  - the circuit breaker judges messages and threads as separate groups, and a held record that is only RE-attempted is
 *    exempt from it (`mailHoldGroup`): a poison message failing again advances its reconsideration and backoff however
 *    many poison messages are held and however quiet or busy the mailbox is, while fresh failures keep the breaker;
 *  - a held thread import is rebuilt only from COMPLETE evidence. Its locator is the remembered (id, date) list, read by
 *    id in bounded batches of one run and rendered once every message is accounted for (read, proven unreadable or gone
 *    upstream); a thread too long for a list (or an unreadable locator) is recovered by a whole-window walk
 *    (`MailHoldPlan.walk`) and cleared only when that walk completes. A partial batch never lands or clears anything.
 *  - the evidence of a held thread accumulates ACROSS runs (mail-recovery.ts: bounded persistent staging in the one cursor
 *    state), because a slow Mail hands the helper only a few bodies per call. Each call asks only for what is still
 *    unresolved, oldest first, in whole-unit packs sized to what the helper has been seen to resolve; units rotate by a
 *    persisted turn (not by failures: truncation is not poison and never counts); a call that resolves nothing ends the run's
 *    reads; the thread is rendered and its hold cleared only when every remembered message is resolved.
 *  - a targeted read uses the SAME routing scope as the main read (Google-hosted accounts are never read), and a read made
 *    under another scope aborts the sweep before anything is rendered. A target the scoped read cannot find while accounts
 *    are routed away or disabled is `targetOutOfScope`, never `targetMissing`: it may live in an account that is no longer
 *    read, so its hold is kept (the hold is visible, nothing is cleared as gone merely because it was filtered).
 *  - a whole-window walk can prove a thread only when the thread's remembered oldest message lies inside the walk's window
 *    (`ThreadLocator.oldest`); otherwise the hold, the thread and the coverage gap stay until the window covers it again.
 */
import type { ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { ConnectorItemUnreadableError } from '../connectors/item-holds.ts';
import { AppleReaderError, readerError } from './readers/errors.ts';
import { admit, APPLE_MAIL_TARGET_MAX, isEmptyRecovery, reconcileRecovery, stage } from './mail-recovery.ts';
import type { AppleMailListing, AppleMailMessage, AppleMailRecoveryState, AppleMailRouting, AppleMailTarget, AppleSourceState, AppleUnavailableMessage } from './types.ts';

export const MAIL_THREAD_KEY = 'mail:';
export const MAIL_MESSAGE_KEY = 'mail-message:';
export { APPLE_MAIL_TARGET_MAX };
/**
 * Messages asked for by id per run (at most RECOVERY_MAX / TARGET_MAX helper calls): a bounded cost. A call asks only for
 * what is still unresolved; what a run could not finish stays staged for the next one (mail-recovery.ts).
 */
export const APPLE_MAIL_RECOVERY_MAX = 100;
/** Messages remembered per failed thread import, so the thread can be rebuilt without its (old) listing. */
export const APPLE_THREAD_REF_MAX = 100;

export const messageHoldKey = (id: string): string => `${MAIL_MESSAGE_KEY}${id}`;
export const threadHoldKey = (id: string): string => `${MAIL_THREAD_KEY}${id}`;
export const isMessageHoldKey = (key: string): boolean => key.startsWith(MAIL_MESSAGE_KEY);

/**
 * The circuit-breaker group of a hold key: message holds are judged against messages, everything else together. A record
 * that was already held when the run began is only re-attempted (retry-held, backoff, --full): it is not judged by the
 * breaker (a held item failing again is not news of an outage) and keeps counting its reconsideration, unless a judged
 * group tripped the breaker this run.
 */
export const mailHoldGroup = (key: string, heldAtStart = false): string | null => (heldAtStart ? null : isMessageHoldKey(key) ? 'mail-message' : 'item');

/**
 * Locator stored on a failed thread import (`ref`):
 *   `{"m":[[id,date],...]}`  the (id, date) of every message the page is built from (at most APPLE_THREAD_REF_MAX);
 *   `{"w":n,"o":date}`       a thread of n messages too long for a list: it is recovered by a whole-window walk. `o` is the
 *                            oldest message date known when the locator was made; a walk whose window starts after it cannot
 *                            reach every message, so it proves nothing about this thread. An older locator without `o` is
 *                            trusted only by the count of messages the walk finds (never as proof of identity).
 * A locator is only ever REPLACED by `mergeThreadRef`, which unions what is remembered with what is listed, so a growing
 * thread never keeps a stale shorter list and never keeps a partial one.
 */
export interface ThreadLocator {
  /** The remembered messages (empty when `walk`). */
  targets: AppleMailTarget[];
  /** Recovered by a whole-window walk: oversize, or a locator that cannot be trusted to name every message. */
  walk: boolean;
  /** Messages the locator stands for. */
  size: number;
  /** Walk locators: the oldest message date the locator knew (ISO), when it knew one. */
  oldest?: string;
}

/** Whether a whole-window walk starting at `since` can reach every message a walk locator stands for. */
export function walkReaches(locator: ThreadLocator, since: string | Date): 'yes' | 'no' | 'unknown' {
  if (!locator.walk) return 'yes';
  if (!locator.oldest) return 'unknown';
  const start = since instanceof Date ? since.getTime() : Date.parse(since);
  return Number.isFinite(start) && Date.parse(locator.oldest) > start ? 'yes' : 'no';
}

export function parseThreadLocator(ref: string | null | undefined): ThreadLocator {
  const unlocatable: ThreadLocator = { targets: [], walk: true, size: 0 };
  if (!ref) return unlocatable;
  try {
    const parsed = JSON.parse(ref) as { m?: unknown; w?: unknown; o?: unknown };
    if (typeof parsed.w === 'number' && Number.isFinite(parsed.w)) {
      const oldest = typeof parsed.o === 'string' && Number.isFinite(Date.parse(parsed.o)) ? parsed.o : undefined;
      return { targets: [], walk: true, size: Math.max(0, Math.floor(parsed.w)), ...(oldest ? { oldest } : {}) };
    }
    if (!Array.isArray(parsed.m) || parsed.m.length === 0 || parsed.m.length > APPLE_THREAD_REF_MAX) return unlocatable;
    const targets: AppleMailTarget[] = [];
    for (const pair of parsed.m) {
      // One malformed entry makes the whole list untrustworthy: rebuilding from the rest would drop that message silently.
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0] || typeof pair[1] !== 'string' || !Number.isFinite(Date.parse(pair[1]))) return unlocatable;
      targets.push({ id: pair[0], date: pair[1] });
    }
    return { targets, walk: false, size: targets.length };
  } catch { return unlocatable; }
}

const listRef = (targets: readonly AppleMailTarget[]): string => JSON.stringify({ m: targets.map((t) => [t.id, t.date]) });
const walkRef = (size: number, oldest?: string): string => JSON.stringify(oldest ? { w: size, o: oldest } : { w: size });
const olderOf = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined || !Number.isFinite(Date.parse(a)) ? (b !== undefined && Number.isFinite(Date.parse(b)) ? b : undefined) : b === undefined || !Number.isFinite(Date.parse(b)) || Date.parse(a) <= Date.parse(b) ? a : b;

/**
 * The locator for a thread import that failed now: the union of what the previous record remembered and the messages of
 * this run, by id. `previous` is the stored record (absent = a first failure). Longer than the bound, or built on a
 * locator that cannot be trusted, it becomes a walk locator; the stale list is never kept. A walk locator remembers the
 * oldest message date it ever knew (`pageFirst` is the stored page's first message, when the thread already has a page); an
 * untrusted or boundary-less previous locator stays boundary-less: a boundary is never invented from a partial view.
 */
export function mergeThreadRef(previous: { ref: string | null } | undefined, messages: ReadonlyArray<Pick<AppleMailMessage, 'id' | 'date'>>, pageFirst?: string | null): string {
  const before = previous ? parseThreadLocator(previous.ref) : null;
  const oldestOf = (dates: Array<string | undefined>): string | undefined => dates.reduce<string | undefined>((a, d) => olderOf(a, d), undefined);
  const seenOldest = oldestOf([...messages.map((m) => m.date), pageFirst ?? undefined]);
  if (before?.walk) return walkRef(Math.max(before.size, messages.length), before.oldest ? olderOf(before.oldest, seenOldest) : undefined);
  const union = new Map<string, AppleMailTarget>();
  for (const t of before?.targets ?? []) union.set(t.id, t);
  for (const m of messages) union.set(m.id, { id: m.id, date: m.date });
  return union.size > APPLE_THREAD_REF_MAX
    ? walkRef(union.size, oldestOf([...union.values()].map((t) => t.date).concat(pageFirst ?? [])))
    : listRef([...union.values()]);
}

/** The locator of a thread seen for the first time (no record). */
export const encodeThreadRef = (messages: ReadonlyArray<Pick<AppleMailMessage, 'id' | 'date'>>): string => mergeThreadRef(undefined, messages);

/** Writes the sweep's merged locators into the finished holds (a record that survived the run keeps its newest locator). */
export function applyThreadRefs(state: unknown, refs: ReadonlyMap<string, string>): void {
  const items = (state as { items?: Record<string, { ref: string | null }> } | null)?.items;
  if (!items) return;
  for (const [key, ref] of refs) if (items[key]) items[key]!.ref = ref;
}

/** One re-read: a held message, or a thread's remembered messages. Whole units only, so a thread is never half-rendered. */
export interface RecoveryUnit {
  key: string;
  kind: 'message' | 'thread';
  targets: AppleMailTarget[];
  /** Tie-break only (persisted `last_failed_at`); the rotation itself is the staging's turn (mail-recovery.ts). */
  order: string;
}

export interface MailHoldPlan {
  /** Held message ids this run must not read. */
  exclude: string[];
  /** What is due for a re-read by id. */
  units: RecoveryUnit[];
  /** A due record no list can rebuild (oversize or unreadable locator) that a walk starting at the window can reach: this run needs a whole-window recovery walk. */
  walk: boolean;
  /** Held walk-locator threads the current window cannot reach (their oldest known message is older than it): no walk is asked for them. */
  unreachable: string[];
}

/** The (id, date) targets of every Mail hold that can be read by id (a thread's remembered list, a message), due or not: what the staging may keep. */
export function retainedUnits(holdsState: unknown): Map<string, AppleMailTarget[]> {
  const out = new Map<string, AppleMailTarget[]>();
  const items = (holdsState as { items?: Record<string, { key: string; ref: string | null; meta?: { upstream_at?: string | null } }> } | null)?.items ?? {};
  for (const record of Object.values(items)) {
    if (isMessageHoldKey(record.key)) {
      const date = record.meta?.upstream_at;
      if (date && Number.isFinite(Date.parse(date))) out.set(record.key, [{ id: record.key.slice(MAIL_MESSAGE_KEY.length), date }]);
      continue;
    }
    if (!record.key.startsWith(MAIL_THREAD_KEY)) continue;
    const locator = parseThreadLocator(record.ref);
    if (!locator.walk) out.set(record.key, locator.targets);
  }
  return out;
}

/** What the sweep must act on before it reads: which held messages to skip and which to re-read wherever they are. */
export function planMailHolds(holds: ConnectorHoldSession, windowStart: Date = new Date(0)): MailHoldPlan {
  const exclude: string[] = [];
  const units: RecoveryUnit[] = [];
  const unreachable: string[] = [];
  let walk = false;
  for (const record of Object.values(holds.holds.initial().items)) {
    if (isMessageHoldKey(record.key)) {
      if (record.state !== 'held') continue;
      const id = record.key.slice(MAIL_MESSAGE_KEY.length);
      if (!holds.holds.shouldAttempt(record.key)) { exclude.push(id); continue; }
      const date = record.meta.upstream_at;
      if (date && Number.isFinite(Date.parse(date))) units.push({ key: record.key, kind: 'message', targets: [{ id, date }], order: record.last_failed_at });
      else walk = true; // no usable date: only a window read can reach it
    } else if (record.key.startsWith(MAIL_THREAD_KEY)) {
      // A failing thread import (not yet held) is re-attempted too: its cursor pin only re-reads the main slice.
      if (record.state !== 'failing' && !holds.holds.shouldAttempt(record.key)) continue;
      const locator = parseThreadLocator(record.ref);
      if (locator.walk) {
        if (record.state !== 'held') continue;
        // A walk cannot reach a message older than its window: asking for one would be a whole-window read that proves nothing.
        if (walkReaches(locator, windowStart) === 'no') unreachable.push(record.key.slice(MAIL_THREAD_KEY.length));
        else walk = true;
        continue;
      }
      units.push({ key: record.key, kind: 'thread', targets: locator.targets, order: record.last_failed_at });
    }
  }
  units.sort((a, b) => a.order.localeCompare(b.order) || a.key.localeCompare(b.key));
  return { exclude, units, walk, unreachable };
}

/** One run's settlement of the Mail holds; the sweep reads its verdicts, `settleReadMessages` completes it after the pages land. */
export class MailHoldRun {
  /** Messages read by id this run (not part of the cursor's listing); merged for rendering only. */
  extra: AppleMailMessage[] = [];
  /** Something forces the cursor to stay: a first-time unreadable message, an unexplained thread, an unattributable message. */
  pin = false;
  /** Threads with an unreadable message the reader could not resolve (deferred or unexplained): present upstream, never judged. */
  readonly deferred = new Set<string>();
  /** Threads of messages that failed this run. */
  readonly failedThreads = new Set<string>();
  /** Message holds this run settled: recovered (read again and its thread landed) or gone upstream. */
  readonly cleared = new Set<string>();
  /** The targeted read itself failed (source-level): the run is partial but nothing was counted. */
  readFailed = false;
  /** Messages a targeted read found gone upstream (deleted or moved): they no longer need to be part of any rebuilt thread. */
  readonly gone = new Set<string>();
  /** Messages proven unreadable this run: accounted for by their message hold, so a thread can be rebuilt without them. */
  readonly unreadable = new Set<string>();

  constructor(private readonly holds: ConnectorHoldSession, private readonly log: (msg: string) => void) {}

  /** Counts one proven-unreadable message; a first-time failure pins the cursor, a re-attempt of a message held at start does not. */
  async fail(m: AppleUnavailableMessage): Promise<void> {
    const { holds } = this;
    const key = messageHoldKey(m.id);
    this.failedThreads.add(m.threadId);
    this.unreadable.add(m.id);
    // Held and not re-admitted: a skip that neither counts nor pins (the reader normally excludes it already).
    if (holds.holds.isHeld(key) && !holds.holds.shouldAttempt(key)) return;
    const wasHeld = holds.isHeld(key);
    holds.shouldAttempt(key);
    const classified = await holds.fail(key, new ConnectorItemUnreadableError('Mail could not produce this message (body unreadable); it is read again by id when retried.'),
      { meta: { upstream_at: m.date }, ref: m.threadId });
    this.log(`[apple] mail message unreadable${wasHeld ? ' (held; re-attempt failed)' : ''}${classified.scope === 'item' ? '' : ' (not counted)'}`);
    if (!wasHeld || classified.scope !== 'item') this.pin = true;
  }

  /**
   * Threads with an outstanding unreadable-message hold after this run: still-held records not settled above, plus this
   * run's failures. They stay live (never removed as deleted) and keep Mail open-loop coverage incomplete.
   */
  blockedThreads(): Set<string> {
    const out = new Set(this.failedThreads);
    for (const record of Object.values(this.holds.holds.initial().items)) {
      if (isMessageHoldKey(record.key) && record.state === 'held' && record.ref && !this.cleared.has(record.key)) out.add(record.ref);
    }
    return out;
  }

  /** Threads whose outstanding message hold this run settled (read again and landed, or gone upstream). */
  clearedThreads(): Set<string> {
    const out = new Set<string>();
    for (const key of this.cleared) { const ref = this.holds.holds.record(key)?.ref; if (ref) out.add(ref); }
    return out;
  }
}

const byDateId = (a: AppleMailTarget, b: AppleMailTarget): number => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

/**
 * Settles the reader's unavailable-message verdicts and re-reads the due targets. Reader errors of the targeted read
 * are source-level and never counted (the run goes on without it); only an abort propagates.
 *
 * The re-read is resumable. Evidence read by id is kept in the bounded staging (`state.mail_recovery`, mail-recovery.ts),
 * so a thread the helper can only hand over a few messages at a time is finished across runs; each call asks only for what
 * is still unresolved. A unit (a held message, or a held thread's remembered list) is used for rendering only when every
 * target is resolved, whether this run or an earlier one resolved it.
 */
export async function readMailHolds(input: {
  holds: ConnectorHoldSession;
  plan: MailHoldPlan;
  listing: AppleMailListing;
  mailboxes: string[];
  readTargets: ((opts: { mailboxes: string[]; targets: AppleMailTarget[]; routing?: AppleMailRouting; signal?: AbortSignal }) => Promise<AppleMailListing>) | undefined;
  /** The routing scope this run reads under (absent for a reader without account routing). */
  routing?: AppleMailRouting;
  state: AppleSourceState;
  now?: () => number;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<MailHoldRun> {
  const { holds, plan, listing, log, state } = input;
  const nowMs = (input.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const run = new MailHoldRun(holds, log);
  const proven = listing.unavailableMessages ?? [];
  const accounted = new Set(proven.map((m) => m.threadId));
  // A reader without message detail, or a thread it could not explain by a proven message: the conservative behavior.
  for (const t of listing.deferredThreads ?? (listing.unavailableThreads ?? []).filter((x) => !accounted.has(x))) run.deferred.add(t);
  if (run.deferred.size > 0) run.pin = true;
  for (const m of proven) await run.fail(m);

  // Staging in line with the holds that exist, before anything reads or renders: expired or orphaned evidence is gone.
  reconcileRecovery(state, retainedUnits(holds.holds.initial()), nowMs);
  const rec: AppleMailRecoveryState = state.mail_recovery ?? { version: 1, turn: 0, units: {}, staged: {}, gone: {} };
  const attach = (): void => { if (!state.mail_recovery && !isEmptyRecovery(rec)) state.mail_recovery = rec; };
  // A message already known to be gone upstream (read earlier) needs no read now.
  for (const unit of plan.units) for (const t of unit.targets) if (rec.gone[t.id]) run.gone.add(t.id);

  // Everything that is accounted for this run: listed, proven unreadable (listing or this run's reads), gone, staged or read now.
  const resolvedNow = new Set<string>([...listing.messages.map((m) => m.id), ...proven.map((m) => m.id)]);
  const fresh = new Map<string, AppleMailMessage>();
  const unavailable = new Map<string, AppleUnavailableMessage>();
  const have = (id: string): boolean => resolvedNow.has(id) || run.gone.has(id) || rec.staged[id] !== undefined || fresh.has(id);
  const pendingOf = (unit: RecoveryUnit): AppleMailTarget[] => unit.targets.filter((t) => !have(t.id)).sort(byDateId);

  const works = plan.units.filter((u) => u.targets.length > 0);
  const waiting = works.filter((u) => pendingOf(u).length > 0);
  if (waiting.length > 0) {
    const readTargets = input.readTargets;
    if (!readTargets) {
      log(`[apple] ${waiting.reduce((n, u) => n + pendingOf(u).length, 0)} held mail message(s) are due for a re-read, but this reader cannot read a message by id; they stay held`);
    } else {
      // Room in the staging for the whole unit, or none (then it is read within the run only, as it always was).
      for (const u of waiting) admit(rec, u.key, u.targets.length, nowIso);
      attach();
      const turn = ++rec.turn;
      const served = new Set<string>();
      const dead = new Set<string>();
      const progressed = new Set<string>();
      const maxCalls = Math.ceil(APPLE_MAIL_RECOVERY_MAX / APPLE_MAIL_TARGET_MAX);
      let capacity = Math.max(1, Math.min(APPLE_MAIL_TARGET_MAX, rec.capacity ?? APPLE_MAIL_TARGET_MAX));
      const stageable = (id: string): boolean => works.some((u) => rec.units[u.key] && u.targets.some((t) => t.id === id));
      for (let call = 0; call < maxCalls; call++) {
        // Longest waiting first (the persisted turn, bumped once a run), then the least left to read, so what is started is
        // finished and small units are not held up behind a large one; a unit that fits whole is asked whole, a larger one alone.
        // A unit that could not be admitted to the staging is read only if this run can finish it (it would otherwise be read
        // again from scratch every run and starve the admitted ones); it is admitted as soon as a reservation frees up.
        const reachable = capacity * (maxCalls - call);
        const order = waiting.filter((u) => !dead.has(u.key) && pendingOf(u).length > 0 && (rec.units[u.key] !== undefined || pendingOf(u).length <= reachable)).sort((a, b) =>
          (rec.units[a.key]?.turn ?? 0) - (rec.units[b.key]?.turn ?? 0) || pendingOf(a).length - pendingOf(b).length
          || a.order.localeCompare(b.order) || a.key.localeCompare(b.key));
        const batch = new Map<string, AppleMailTarget>();
        const members: RecoveryUnit[] = [];
        for (const u of order) {
          const need = pendingOf(u).filter((t) => !batch.has(t.id));
          const room = capacity - batch.size;
          if (need.length === 0 || room <= 0) continue;
          if (need.length <= room) { for (const t of need) batch.set(t.id, t); members.push(u); }
          else if (batch.size === 0) { for (const t of need.slice(0, room)) batch.set(t.id, t); members.push(u); }
          if (batch.size >= capacity) break;
        }
        if (batch.size === 0) break;
        // The failure is captured, not caught-and-rethrown here: the per-item-loop catch ratchet reserves that shape for
        // classifyItemFailure/ItemRun, and a source-level read failure is not an item failure.
        const read = await (async () => readTargets({ mailboxes: input.mailboxes, targets: [...batch.values()], ...(input.routing ? { routing: input.routing } : {}), ...(input.signal ? { signal: input.signal } : {}) }))()
          .then((listing) => ({ failed: false as const, listing }), (error: unknown) => ({ failed: true as const, error }));
        if (read.failed) {
          const e = read.error;
          if (input.signal?.aborted) throw e;
          // The Mail accounts changed under this run: nothing read so far may be rendered, and nothing here counts as a failure.
          if (e instanceof AppleReaderError && e.code === 'mail_routing_changed') throw e;
          // A targeted read that fails or times out is a SOURCE problem: not an item failure, not a hold. Whatever earlier
          // calls resolved is kept. The batch is halved next time (a smaller ask may fit) and its units go to the back.
          log(`[apple] re-reading held mail messages failed (${e instanceof Error ? e.message : String(e)}); they stay held`);
          run.readFailed = true;
          rec.capacity = capacity = Math.max(1, Math.floor(batch.size / 2));
          for (const u of members) served.add(u.key);
          break;
        }
        const result: AppleMailListing = read.listing;
        if (input.routing && (result.routing?.fingerprint !== input.routing.fingerprint || result.routing.version !== input.routing.version)) {
          throw readerError('mail_routing_changed', 'mail', 'a targeted Mail read was not made under this run\'s account routing');
        }
        let progress = 0;
        const resolveOne = (id: string): void => { if (!resolvedNow.has(id) && !run.gone.has(id) && !fresh.has(id) && rec.staged[id] === undefined) { progress++; progressed.add(id); } };
        for (const m of result.messages) {
          if (!batch.has(m.id)) continue; // never accept what was not asked for
          resolveOne(m.id);
          fresh.set(m.id, m);
          if (stageable(m.id)) stage(rec, m, nowIso); // refused at a bound: kept for this run only
        }
        for (const m of result.unavailableMessages ?? []) if (batch.has(m.id)) { resolveOne(m.id); unavailable.set(m.id, m); resolvedNow.add(m.id); }
        const outOfScope = (result.targetOutOfScope ?? []).filter((id) => batch.has(id));
        if (outOfScope.length > 0) log(`[apple] ${outOfScope.length} held mail message(s) were not found in the Mail accounts the Apple connector reads (other accounts are routed away or disabled); they may be gone or may live there, so their holds stay`);
        for (const id of result.targetMissing ?? []) {
          if (!batch.has(id)) continue;
          resolveOne(id);
          run.gone.add(id);
          if (stageable(id)) rec.gone[id] = nowIso;
        }
        const exhausted = result.budgetExhausted === true || result.truncated === true;
        if (exhausted && progress > 0 && progress < batch.size) rec.capacity = capacity = Math.max(1, progress);
        else if (!exhausted && batch.size >= capacity && capacity < APPLE_MAIL_TARGET_MAX) rec.capacity = capacity = Math.min(APPLE_MAIL_TARGET_MAX, capacity * 2);
        for (const u of members) {
          const gained = u.targets.some((t) => batch.has(t.id) && have(t.id));
          if (gained || !exhausted) served.add(u.key);
          if (!gained && !exhausted) dead.add(u.key); // silently dropped by the helper: not asked again this run
        }
        // The helper's body-time budget ran out without resolving anything: Mail is stalled right now; another call would only
        // spend another budget. What was resolved is kept; nothing is counted (truncation is not poison).
        if (exhausted && progress === 0) { log('[apple] re-reading held mail messages made no progress within the helper\'s time budget; they are read again on the next run'); break; }
      }
      // The rotation moves once per run, for the units this run really worked on (or asked in full): never by a failure count.
      for (const key of served) if (rec.units[key]) rec.units[key]!.turn = turn;
      for (const u of works) if (rec.units[u.key] && u.targets.some((t) => progressed.has(t.id))) rec.units[u.key]!.at = nowIso;
      const left = works.reduce((n, u) => n + pendingOf(u).length, 0);
      if (left > 0) log(`[apple] held mail recovery is partial: ${left} message(s) of ${waiting.length} held record(s) still to be read; progress is kept for the next run`);
    }
  }
  attach();

  // Units fully resolved (this run or earlier) may feed rendering; a half-read thread feeds nothing.
  const usable = new Set<string>();
  for (const unit of works) if (unit.targets.every((t) => have(t.id))) for (const t of unit.targets) usable.add(t.id);
  const evidence = (id: string): AppleMailMessage | undefined => fresh.get(id) ?? rec.staged[id]?.m;
  const listed = new Set(listing.messages.map((m) => m.id));
  run.extra = [...usable].filter((id) => !listed.has(id)).map(evidence).filter((m): m is AppleMailMessage => m !== undefined).map((m) => structuredClone(m));
  for (const m of unavailable.values()) await run.fail(m);
  for (const id of run.gone) {
    // Deleted or moved upstream: nothing left to read, so nothing left to hold.
    const key = messageHoldKey(id);
    if (holds.holds.record(key)) { holds.shouldAttempt(key); holds.drop(key); run.cleared.add(key); }
  }
  // A thread whose every remembered message is gone upstream has nothing left to rebuild.
  for (const unit of plan.units) {
    if (unit.kind === 'thread' && unit.targets.every((t) => run.gone.has(t.id))) { holds.shouldAttempt(unit.key); holds.drop(unit.key); }
  }
  // Targets the helper could not resolve (batch failed, vanished) stay held and untouched; nothing is counted.
  return run;
}

/**
 * After the pages are written: a message read this run clears its record (and counts as a healthy attempt) only when its
 * thread's page landed, so a recovered message whose thread could not be imported stays held and visible. A held
 * message that is not due is left alone (neither counted nor reset).
 */
export function settleReadMessages(holds: ConnectorHoldSession, run: MailHoldRun, messages: readonly AppleMailMessage[], notLanded: ReadonlySet<string>): void {
  for (const m of messages) {
    const key = messageHoldKey(m.id);
    const record = holds.holds.record(key);
    if (record?.state === 'held' && !holds.holds.shouldAttempt(key)) continue;
    if (notLanded.has(m.threadId)) continue;
    if (record) { holds.shouldAttempt(key); run.cleared.add(key); }
    holds.succeed(key);
  }
}
