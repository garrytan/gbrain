/**
 * apple mail-recovery — bounded persistent staging for the by-id recovery of held Mail threads.
 *
 * Why it exists: a slow Mail.app produces only a few bodies per helper call (3 were observed), and the helper hands back
 * the OLDEST requested ones. A held thread of 40 messages therefore cannot be read whole inside one run, however the
 * batches are cut. The recovered messages are accumulated here, by message id, across runs; the thread is rendered and its
 * hold cleared only when every remembered message is accounted for (read, proven unreadable this run or gone upstream),
 * exactly as before. Nothing here decides a verdict: it only keeps evidence that was really read.
 *
 * It is part of the recoverable cursor, not a second quarantine: it lives in the one Apple cursor state (`mail_recovery`),
 * so it is saved by the same canonical checkpoint write as the item holds it belongs to (managed: `saveState` / the
 * deferred `publishHolds`; unmanaged: the 0600 state file), and it is dropped with them.
 *
 * Bounds (all hard):
 *  - at most STAGE_MAX_MESSAGES staged messages and STAGE_MAX_BYTES staged bytes in TOTAL, across every hold (the hold cap
 *    is 100 per source), not per thread;
 *  - a thread is admitted to staging only while the targets of every admitted thread fit under STAGE_MAX_MESSAGES, so a
 *    partly staged thread can always be finished; one that is not admitted is read within the run only (the previous
 *    behavior) and nothing is lost: it is admitted when room frees up;
 *  - an entry older than STAGE_TTL_MS is dropped (private text is not kept for ever), and so is a reservation that has made no
 *    progress for that long; a hold that is gone drops its staging.
 * Overflow therefore refuses to stage (the message is simply read again later); it never evicts progress and never fails
 * a run. Mail text is never logged and never sent to a model.
 */
import type { AppleMailMessage, AppleMailRecoveryState, AppleMailTarget, AppleSourceState } from './types.ts';

/** Messages per targeted helper call (one batch). */
export const APPLE_MAIL_TARGET_MAX = 25;
/** One full-size thread (APPLE_THREAD_REF_MAX = 100 messages) at most; the byte bound is that many messages at the 20 000-character body cap, with slack. */
export const STAGE_MAX_MESSAGES = 100;
export const STAGE_MAX_BYTES = 2.5 * 1024 * 1024;
export const STAGE_TTL_MS = 14 * 86_400_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
const validIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export const emptyRecovery = (): AppleMailRecoveryState => ({ version: 1, turn: 0, units: {}, staged: {}, gone: {} });

function stagedMessage(v: unknown): AppleMailMessage | null {
  if (!isRecord(v)) return null;
  const to = strings(v.to);
  const cc = strings(v.cc);
  if (typeof v.id !== 'string' || !v.id || typeof v.threadId !== 'string' || typeof v.mailbox !== 'string' || typeof v.subject !== 'string'
    || typeof v.from !== 'string' || !to || !cc || !validIso(v.date) || typeof v.body !== 'string' || typeof v.read !== 'boolean') return null;
  return { id: v.id, threadId: v.threadId, mailbox: v.mailbox, subject: v.subject, from: v.from, to, cc, date: v.date, body: v.body, read: v.read,
    ...(typeof v.automated === 'boolean' ? { automated: v.automated } : {}), ...(typeof v.bulk === 'boolean' ? { bulk: v.bulk } : {}) };
}

/** Nothing staged or reserved: nothing worth keeping (the batch-size hint and the turn restart with the next recovery). */
export const isEmptyRecovery = (rec: AppleMailRecoveryState): boolean =>
  Object.keys(rec.units).length === 0 && Object.keys(rec.staged).length === 0 && Object.keys(rec.gone).length === 0;

/**
 * A stored staging read back. A malformed or over-bound value is dropped whole (evidence is lost, safety is not: the holds
 * it served stay and the evidence is read again).
 */
export function normalizeMailRecovery(v: unknown): AppleMailRecoveryState | undefined {
  if (!isRecord(v) || v.version !== 1) return undefined;
  const rec = emptyRecovery();
  rec.turn = typeof v.turn === 'number' && Number.isFinite(v.turn) && v.turn >= 0 ? Math.floor(v.turn) : 0;
  if (typeof v.capacity === 'number' && Number.isFinite(v.capacity) && v.capacity >= 1) rec.capacity = Math.min(APPLE_MAIL_TARGET_MAX, Math.floor(v.capacity));
  if (isRecord(v.units)) {
    for (const [key, u] of Object.entries(v.units)) {
      if (isRecord(u) && typeof u.turn === 'number' && Number.isFinite(u.turn) && typeof u.n === 'number' && Number.isFinite(u.n) && u.n >= 0) rec.units[key] = { turn: Math.floor(u.turn), n: Math.floor(u.n), ...(validIso(u.at) ? { at: u.at } : {}) };
    }
  }
  if (isRecord(v.staged)) {
    for (const [id, e] of Object.entries(v.staged)) {
      const m = isRecord(e) && validIso(e.at) ? stagedMessage(e.m) : null;
      if (m && m.id === id) rec.staged[id] = { at: (e as { at: string }).at, m };
    }
  }
  if (isRecord(v.gone)) for (const [id, at] of Object.entries(v.gone)) if (validIso(at)) rec.gone[id] = at;
  if (Object.keys(rec.staged).length > STAGE_MAX_MESSAGES || stagedBytes(rec) > STAGE_MAX_BYTES) return undefined;
  return isEmptyRecovery(rec) ? undefined : rec;
}

const messageBytes = (m: AppleMailMessage): number => Buffer.byteLength(JSON.stringify(m));
export const stagedBytes = (rec: AppleMailRecoveryState): number => Object.values(rec.staged).reduce((sum, e) => sum + messageBytes(e.m), 0);
export const reservedTargets = (rec: AppleMailRecoveryState): number => Object.values(rec.units).reduce((sum, u) => sum + u.n, 0);

/** Reserves room for a whole thread (its targets) or refuses; an already admitted thread keeps its reservation. */
export function admit(rec: AppleMailRecoveryState, key: string, targets: number, nowIso: string): boolean {
  if (rec.units[key]) return true;
  if (reservedTargets(rec) + targets > STAGE_MAX_MESSAGES) return false;
  rec.units[key] = { turn: 0, n: targets, at: nowIso };
  return true;
}

/** Stages one message read by id; false (and nothing stored) when it would exceed a bound, or its thread is not admitted. */
export function stage(rec: AppleMailRecoveryState, m: AppleMailMessage, nowIso: string): boolean {
  const known = rec.staged[m.id];
  if (!known && Object.keys(rec.staged).length >= STAGE_MAX_MESSAGES) return false;
  if (stagedBytes(rec) - (known ? messageBytes(known.m) : 0) + messageBytes(m) > STAGE_MAX_BYTES) return false;
  rec.staged[m.id] = { at: nowIso, m: structuredClone(m) };
  return true;
}

/**
 * Brings the staging in line with the holds that exist: `retained` maps the hold key of every Mail thread hold whose
 * remembered messages can be read by id to those targets. What belongs to no such hold (cleared, dropped, grown into a
 * walk) is dropped; so is what has expired. Run at the start of a run (before it reads) and again after the holds are
 * merged (before the state is saved), so a cleared hold never leaves its mail text behind.
 */
export function reconcileRecovery(state: AppleSourceState, retained: ReadonlyMap<string, readonly AppleMailTarget[]>, nowMs: number): void {
  const rec = state.mail_recovery;
  if (!rec) return;
  const needed = new Set<string>();
  for (const [key, unit] of Object.entries(rec.units)) {
    const targets = retained.get(key);
    // A reservation that has made no progress for the whole TTL is released, so a unit that cannot finish never blocks the others.
    if (!targets || nowMs - Date.parse(unit.at ?? new Date(nowMs).toISOString()) > STAGE_TTL_MS) { delete rec.units[key]; continue; }
    unit.at ??= new Date(nowMs).toISOString();
    unit.n = Math.max(unit.n, targets.length);
    for (const t of targets) needed.add(t.id);
  }
  for (const [id, e] of Object.entries(rec.staged)) {
    if (!needed.has(id) || nowMs - Date.parse(e.at) > STAGE_TTL_MS) delete rec.staged[id];
  }
  for (const [id, at] of Object.entries(rec.gone)) if (!needed.has(id) || nowMs - Date.parse(at) > STAGE_TTL_MS) delete rec.gone[id];
  if (isEmptyRecovery(rec)) delete state.mail_recovery;
}
