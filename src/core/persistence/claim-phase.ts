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
 * `claimStateOf` reads a request row back. A claim whose renewal cannot reach
 * its row (it lapsed while still `running`) is inside a transaction that holds
 * the row, or its owner is gone; `publication_started` means files were being
 * published and the recovery path finishes the request.
 */
import type { BrainEngine } from '../engine.ts';

export type ClaimPhaseName = 'preparing' | 'publishing';
export interface ClaimPhaseClock { phase: ClaimPhaseName; claimedAt: number; since: number }

export function startClaimPhase(now = Date.now()): ClaimPhaseClock {
  return { phase: 'preparing', claimedAt: now, since: now };
}
export function enterClaimPhase(clock: ClaimPhaseClock, phase: ClaimPhaseName, now = Date.now()): void {
  if (clock.phase === phase) return;
  clock.phase = phase;
  clock.since = now;
}
/** The `claim_phase` jsonb a renewal stores for the claim holding `token`. */
export function claimPhaseStamp(clock: ClaimPhaseClock, token: string | null): string {
  return JSON.stringify({ phase: clock.phase, claimed_at: new Date(clock.claimedAt).toISOString(), since: new Date(clock.since).toISOString(), token });
}

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

export function claimStateOf(row: ClaimRow, now = Date.now()): ClaimState | null {
  if (row.state !== 'running') return null;
  const raw = typeof row.claim_phase === 'string' ? safeJson(row.claim_phase) : row.claim_phase;
  const stamp = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const own = !!stamp && !!row.execution_token && stamp.token === row.execution_token;
  const claimAge = own ? age(stamp!.claimed_at, now) : null;
  if (row.publication_started) return { phase: 'file_publication', claim_age_ms: claimAge, phase_age_ms: null, resumes_on_its_own: false,
    why: 'Its files were being published; the publication recovery path restores or finishes them when the owning process scans its roots again (after a restart if it hung).' };
  if (row.claim_lapsed) return { phase: 'publication_transaction', claim_age_ms: claimAge, phase_age_ms: null, resumes_on_its_own: true,
    why: 'Its claim lapsed while it was still running and nothing was published: a transaction holds the request row (renewals cannot reach it) or its owner is gone. It is requeued once that transaction ends or the owner process exits.' };
  if (!own) return { phase: 'unrecorded', claim_age_ms: null, phase_age_ms: null, resumes_on_its_own: false,
    why: 'The owner has not recorded this claim\'s phase (a claim younger than one renewal, or an owner that predates phase recording).' };
  const phase = stamp!.phase === 'publishing' ? 'publishing' : 'preparing';
  return { phase, claim_age_ms: claimAge, phase_age_ms: age(stamp!.since, now), resumes_on_its_own: false,
    why: `Its owner is still renewing the claim while it is ${phase === 'preparing' ? 'preparing the write' : 'publishing the write'}, so the lease never lapses and nothing else on its root runs until that work settles or the owner restarts.` };
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
