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
 *
 * #6317 adds the process identity and the last statement: the owner is
 * `{kind, pid, nonce, pid_ns, version}` (a per-process nonce, because
 * containers sharing one home reuse pids; `isOwnerThisProcess` compares the
 * nonce whenever the stamp has one), and `recordClaimSql` keeps the label of
 * the last raw statement a preparer issued (first keyword plus table, never
 * text or parameters; `boundedReads` records it), stamped as `last_sql` so
 * writer status, the drain's stall line and the consumer's log lines
 * (`claimTripleText`) name the same step / waiting_on / last_sql triple.
 */
import type { BrainEngine } from '../engine.ts';
import { VERSION } from '../../version.ts';
import { consumerIdentity, sameProcess } from './consumer-heartbeat.ts';

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
  /** #6317: the last raw statement the preparation issued (label only) and when. */
  lastSql?: { label: string; at: number };
}
/**
 * The process that holds a claim, as the stamp records it. #6317: `nonce` (random per process) and `pid_ns` (the pid
 * namespace where readable) tell a reused pid or another container's pid from this process; an older owner stamps neither.
 */
export interface ClaimOwner { kind: string; pid: number; version: string; nonce?: string; pid_ns?: string | null }
/** #6317: the step / waiting_on / last_sql triple of a claim, as stamped and as read back. */
export interface ClaimLastSql { label: string; age_ms: number | null }

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
/** #6317: the label of a raw statement for the stamp: its first keyword and the first table it names; never text or parameters. */
export function sqlLabel(sql: string): string {
  const text = sql.replace(/\s+/g, ' ').trim();
  const keyword = /^[A-Za-z]+/.exec(text)?.[0]?.toUpperCase() ?? 'SQL';
  const table = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:ONLY\s+)?("?[A-Za-z_][\w.]*"?)/i.exec(text)?.[1]?.replaceAll('"', '');
  return table ? `${keyword} ${table}` : keyword;
}
/** #6317: records the statement a preparer is about to issue on its clock (`boundedReads` calls it at every raw read). */
export function recordClaimSql(clock: ClaimPhaseClock | undefined, sql: string, now = Date.now()): void {
  if (clock) clock.lastSql = { label: sqlLabel(sql), at: now };
}
/** #6317: the ` step=… waiting_on=… last_sql=…` text every `[persistence]` cut-off and hold line carries (C3). */
export function claimTripleText(clock: Pick<ClaimPhaseClock, 'step' | 'waitingOn' | 'lastSql'> | undefined, now = Date.now()): string {
  if (!clock) return ' step=none waiting_on=unknown last_sql=none';
  const last = clock.lastSql ? `${clock.lastSql.label.replaceAll(' ', '_')}@${Math.round((now - clock.lastSql.at) / 1000)}s` : 'none';
  return ` step=${clock.step ?? 'none'} waiting_on=${clock.waitingOn} last_sql=${last}`;
}
/** #6317: whether a stamped owner is this process: the pid, and the nonce when the stamp carries one (a reused pid is another process). */
export function isOwnerThisProcess(owner: Pick<ClaimOwner, 'pid' | 'nonce'> | null | undefined): boolean {
  return claimOwnerIsThisProcess(owner);
}

const OWNER_COMMANDS = new Set(['sync', 'serve', 'jobs', 'autopilot', 'mcp', 'dream', 'cycle', 'sources', 'migrate-graduation', 'put', 'import']);
let ownerOverride: ClaimOwner | undefined;
/** The gbrain command this process runs (`cli` when none is recognisable). */
export function claimOwnerKind(): string {
  if (ownerOverride) return ownerOverride.kind;
  const command = process.argv.slice(2).find(arg => !arg.startsWith('-'));
  return command && OWNER_COMMANDS.has(command) ? command : 'cli';
}
/** The owning process for the stamp: the gbrain command this process runs (`cli` when none is recognisable), its pid, nonce, pid namespace and build. */
export function claimOwner(): ClaimOwner {
  if (ownerOverride) return ownerOverride;
  const { pid, nonce, pid_ns } = consumerIdentity();
  return { kind: claimOwnerKind(), pid, version: VERSION, nonce, pid_ns };
}
/** Whether a stamped owner is this process: the pid and, when the stamp carries one, the nonce (#6317: `owner_pid === process.pid` alone is not enough). */
export function claimOwnerIsThisProcess(owner: Pick<ClaimOwner, 'pid' | 'nonce'> | null | undefined): boolean {
  return sameProcess(owner);
}
/** Test seam. */
export function setClaimOwnerForTest(owner: ClaimOwner | undefined): void { ownerOverride = owner; }

/** The `claim_phase` jsonb a renewal (or a claim, or a group's dispatch mark) stores for the claim holding `token`. */
export function claimPhaseStamp(clock: ClaimPhaseClock, token: string | null, owner: ClaimOwner = claimOwner()): string {
  return JSON.stringify({ phase: clock.phase, claimed_at: new Date(clock.claimedAt).toISOString(), since: new Date(clock.since).toISOString(), token,
    step: clock.step, step_since: new Date(clock.stepSince).toISOString(), waiting_on: clock.waitingOn, owner,
    last_sql: clock.lastSql ? { label: clock.lastSql.label, at: new Date(clock.lastSql.at).toISOString() } : null });
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
  /** #6317: the last raw statement the owner's preparation issued (label and age), null when none was recorded. */
  last_sql: ClaimLastSql | null;
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
  return { kind: owner.kind, pid: owner.pid, version: owner.version, ...(typeof owner.nonce === 'string' ? { nonce: owner.nonce } : {}),
    ...(typeof owner.pid_ns === 'string' || owner.pid_ns === null ? { pid_ns: owner.pid_ns } : {}) };
}
/** #6317: the stamp's `last_sql` read back with its age; null when the stamp has none (an owner older than #6317 included). */
export function stampLastSql(raw: unknown, now: number): ClaimLastSql | null {
  const last = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  return last && typeof last.label === 'string' ? { label: last.label, age_ms: age(last.at, now) } : null;
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
    owner: own ? stampOwner(stamp!.owner) : null, last_sql: own ? stampLastSql(stamp!.last_sql, now) : null };
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
