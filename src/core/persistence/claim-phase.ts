/**
 * #6176: which phase a running write request's claim is in, and how long it
 * has been there, so a stall names its phase instead of `cause_unknown`.
 *
 * The consumer keeps a `ClaimPhaseClock` per claim and every claim renewal
 * (claim-lease.ts cadence, 10 s) stores `claimPhaseStamp` in the request's
 * `claim_phase` column (v217): the phase, the claim start, the phase start and
 * the execution token, so a later claim of the same request never reads an
 * earlier claim's ages. Recording rides the renewal: no extra statement per write.
 *
 * #6278 adds the step: preparers call `enterClaimStep` at each await
 * boundary (authority, binding, git, raw hash, origin checks, import screen,
 * link resolution, adoption reads), which names the step, what the await
 * waits on (`git`, `fs`, `db`, `pool`; `unknown` when nothing observed it)
 * and checks the preparation's signal, so cancellation reaches a preparer
 * between its queries even when the query itself takes no signal. The stamp
 * also names the owner process (kind, pid, build), so writer status can tell
 * a sync CLI from a `gbrain serve` without raw SQL. The claim statements
 * stamp a single claim at claim time and a group stamps each wave's members
 * at dispatch, so a kill before the first renewal still shows a `preparing`
 * stamp of the current token (the expired-claim reclaim charges exactly
 * those, journal.ts).
 *
 * `claimStateOf` reads a request row back. A claim whose renewal cannot reach
 * its row (it lapsed while still `running`) is inside a transaction that holds
 * the row, or its owner is gone; `publication_started` means files were being
 * published and the recovery path finishes the request. `claimStall` is the
 * running-overdue verdict (`preparation_overdue`) writer status and doctor
 * attach as `claim.stall`; the terminal give-up is the `preparation_stalled`
 * receipt, so the two never share a name.
 */
import type { BrainEngine } from '../engine.ts';
import { VERSION } from '../../version.ts';

export type ClaimPhaseName = 'preparing' | 'publishing';
export const WAITING_ON = ['git', 'fs', 'db', 'pool', 'unknown'] as const;
export type WaitingOn = typeof WAITING_ON[number];
export interface ClaimPhaseClock {
  phase: ClaimPhaseName;
  claimedAt: number;
  since: number;
  /** The preparation step in flight (`enterClaimStep`), null before the first boundary. */
  step: string | null;
  stepSince: number;
  waitingOn: WaitingOn;
  /**
   * #6278: the preparation's cancellation. `enterClaimStep` checks it at every
   * boundary; a preparer passes it to a raw statement only when that statement
   * can block on a lock or a pool reservation and is not a shared memo read
   * (a signalled statement reserves its own connection and skips the memo).
   */
  signal?: AbortSignal;
  /**
   * #6278: when the preparation's budget runs out (`claimedAt` plus the
   * budget), so a read that can wait on a relation lock runs under a
   * transaction-local `statement_timeout` of the time left (`boundedReads`).
   * Absent with the deadlines switch off.
   */
  deadlineAt?: number;
}
/** The process that holds a claim, as the stamp records it. */
export interface ClaimOwner { kind: string; pid: number; version: string }

export function startClaimPhase(now = Date.now(), signal?: AbortSignal, budgetMs?: number): ClaimPhaseClock {
  return { phase: 'preparing', claimedAt: now, since: now, step: null, stepSince: now, waitingOn: 'unknown', ...(signal ? { signal } : {}),
    ...(budgetMs !== undefined ? { deadlineAt: now + budgetMs } : {}) };
}
export function enterClaimPhase(clock: ClaimPhaseClock, phase: ClaimPhaseName, now = Date.now()): void {
  if (clock.phase === phase) return;
  clock.phase = phase;
  clock.since = now;
  clock.step = null;
  clock.stepSince = now;
  clock.waitingOn = 'unknown';
}
/**
 * A preparer's step boundary: names the step and what its await waits on,
 * and throws the preparation's abort reason once the budget has cut it off
 * (`signal` defaults to the clock's). `clock` is absent for a preparation
 * outside the consumer (the sync's waiver and origin checks), which still
 * gets the cancellation check from its own signal.
 */
export function enterClaimStep(clock: ClaimPhaseClock | undefined, step: string, signal: AbortSignal | undefined = clock?.signal, waitingOn: WaitingOn = 'unknown', now = Date.now()): void {
  signal?.throwIfAborted();
  if (!clock) return;
  if (clock.step !== step) { clock.step = step; clock.stepSince = now; }
  clock.waitingOn = waitingOn;
}

const OWNER_COMMANDS = new Set(['sync', 'serve', 'jobs', 'autopilot', 'mcp', 'dream', 'cycle', 'sources', 'migrate-graduation', 'put', 'import']);
let ownerOverride: ClaimOwner | undefined;
/** The owning process for the stamp: the gbrain command this process runs (`cli` when none is recognisable), its pid and build. */
export function claimOwner(): ClaimOwner {
  if (ownerOverride) return ownerOverride;
  const command = process.argv.slice(2).find(arg => !arg.startsWith('-'));
  return { kind: command && OWNER_COMMANDS.has(command) ? command : 'cli', pid: process.pid, version: VERSION };
}
/** Test seam. */
export function setClaimOwnerForTest(owner: ClaimOwner | undefined): void { ownerOverride = owner; }

/** The `claim_phase` jsonb a renewal (or a claim, or a group's dispatch mark) stores for the claim holding `token`. */
export function claimPhaseStamp(clock: ClaimPhaseClock, token: string | null, owner: ClaimOwner = claimOwner()): string {
  return JSON.stringify({ phase: clock.phase, claimed_at: new Date(clock.claimedAt).toISOString(), since: new Date(clock.since).toISOString(), token,
    step: clock.step, step_since: new Date(clock.stepSince).toISOString(), waiting_on: clock.waitingOn, owner });
}

/**
 * #6278: the SQL that charges a reclaimed expired claim to its request's
 * `preparation_attempts`: only a claim whose owner stamped it `preparing`
 * under the token being reclaimed (a kill mid-preparation), never one that
 * was publishing, undispatched (no stamp of its token) or stamped by an
 * earlier claim.
 */
export const EXPIRED_PREPARING_CHARGE_SQL = (r: string) =>
  `CASE WHEN ${r}.claim_phase->>'phase'='preparing' AND ${r}.claim_phase->>'token'=${r}.execution_token::text THEN 1 ELSE 0 END`;

/** `persistence.max_claim_ms`: how long a write may hold its claim before doctor reports it as stalled. */
export const MAX_CLAIM_CONFIG_KEY = 'persistence.max_claim_ms';
export const MAX_CLAIM_DEFAULT_MS = 600_000;
const MAX_CLAIM_MIN_MS = 60_000;
const MAX_CLAIM_MAX_MS = 86_400_000;

export function parseMaxClaimMs(raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= MAX_CLAIM_MIN_MS && n <= MAX_CLAIM_MAX_MS ? n : null;
}
/** `config set` validation; the refusal text, or null when the value is valid (or the key is another one). */
export function validateMaxClaimConfigValue(key: string, value: string): string | null {
  if (key !== MAX_CLAIM_CONFIG_KEY || parseMaxClaimMs(value) !== null) return null;
  return `invalid_params: ${MAX_CLAIM_CONFIG_KEY} must be a whole number of milliseconds from ${MAX_CLAIM_MIN_MS} to ${MAX_CLAIM_MAX_MS} `
    + `(default ${MAX_CLAIM_DEFAULT_MS}, 10 minutes; for example gbrain config set ${MAX_CLAIM_CONFIG_KEY} 900000) (got '${value}'). Nothing was written.`;
}
export async function readMaxClaimMs(engine: Pick<BrainEngine, 'getConfig'>): Promise<number> {
  return parseMaxClaimMs(await engine.getConfig(MAX_CLAIM_CONFIG_KEY).catch(() => null)) ?? MAX_CLAIM_DEFAULT_MS;
}

/**
 * Where a running claim is: `preparing` or `publishing` (recorded by a live
 * renewal), `publication_transaction` (the claim lapsed while running and
 * nothing was published yet), `file_publication` (files were being published)
 * or `unrecorded` (no stamp of this claim yet, or an owner that predates v217).
 */
export type ClaimStatePhase = ClaimPhaseName | 'publication_transaction' | 'file_publication' | 'unrecorded';
export interface ClaimState {
  phase: ClaimStatePhase;
  claim_age_ms: number | null;
  phase_age_ms: number | null;
  /** The preparation step the owner last recorded; null before the first boundary or on a stamp from an older owner. */
  step: string | null;
  step_age_ms: number | null;
  /** What the recorded step waits on; `unknown` when nothing observed it (older stamps included), never inferred. */
  waiting_on: WaitingOn;
  /** The process holding the claim, when its stamp recorded one. */
  owner: ClaimOwner | null;
  /** Whether the same request continues without anyone acting (after its lease lapses or its transaction ends). */
  resumes_on_its_own: boolean;
  why: string;
}
export interface ClaimRow {
  state: string;
  claim_phase?: unknown;
  execution_token?: string | null;
  /** `claim_expires_at < now()`, read on the database clock. */
  claim_lapsed?: boolean | null;
  publication_started?: boolean | null;
}

const age = (at: unknown, now: number): number | null => {
  const ms = typeof at === 'string' || at instanceof Date ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.floor(now - ms)) : null;
};
function stampOwner(raw: unknown): ClaimOwner | null {
  const owner = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!owner || typeof owner.kind !== 'string' || typeof owner.pid !== 'number' || typeof owner.version !== 'string') return null;
  return { kind: owner.kind, pid: owner.pid, version: owner.version };
}

export function claimStateOf(row: ClaimRow, now = Date.now()): ClaimState | null {
  if (row.state !== 'running') return null;
  const raw = typeof row.claim_phase === 'string' ? safeJson(row.claim_phase) : row.claim_phase;
  const stamp = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const own = !!stamp && !!row.execution_token && stamp.token === row.execution_token;
  const claimAge = own ? age(stamp!.claimed_at, now) : null;
  const step = own && typeof stamp!.step === 'string' ? stamp!.step : null;
  const detail = { step, step_age_ms: step ? age(stamp!.step_since, now) : null,
    waiting_on: own && (WAITING_ON as readonly unknown[]).includes(stamp!.waiting_on) ? stamp!.waiting_on as WaitingOn : 'unknown' as const,
    owner: own ? stampOwner(stamp!.owner) : null };
  if (row.publication_started) return { phase: 'file_publication', claim_age_ms: claimAge, phase_age_ms: null, ...detail, resumes_on_its_own: false,
    why: 'Its files were being published; the publication recovery path restores or finishes them when the owning process scans its roots again (after a restart if it hung).' };
  if (row.claim_lapsed) return { phase: 'publication_transaction', claim_age_ms: claimAge, phase_age_ms: null, ...detail, resumes_on_its_own: true,
    why: 'Its claim lapsed while it was still running and nothing was published: a transaction holds the request row (renewals cannot reach it) or its owner is gone. It is requeued once that transaction ends or the owner process exits.' };
  if (!own) return { phase: 'unrecorded', claim_age_ms: null, phase_age_ms: null, ...detail, resumes_on_its_own: false,
    why: 'The owner has not recorded this claim\'s phase (a claim younger than one renewal, or an owner that predates phase recording).' };
  const phase = stamp!.phase === 'publishing' ? 'publishing' : 'preparing';
  return { phase, claim_age_ms: claimAge, phase_age_ms: age(stamp!.since, now), ...detail, resumes_on_its_own: false,
    why: `Its owner is still renewing the claim while it is ${phase === 'preparing' ? 'preparing the write' : 'publishing the write'}${step ? ` (step ${step}, waiting on ${detail.waiting_on})` : ''}, so the lease never lapses and nothing else on its root runs until that work settles or the owner restarts.` };
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** The running-overdue verdict: a `preparing` claim older than its budget. */
export interface ClaimStall { reason: 'preparation_overdue'; step: string | null; step_age_ms: number | null; waiting_on: WaitingOn; budget_ms: number }
export function claimStall(claim: ClaimState | null, budgetMs: number): ClaimStall | null {
  if (!claim || claim.phase !== 'preparing' || claim.phase_age_ms === null || claim.phase_age_ms < budgetMs) return null;
  return { reason: 'preparation_overdue', step: claim.step, step_age_ms: claim.step_age_ms, waiting_on: claim.waiting_on, budget_ms: budgetMs };
}
