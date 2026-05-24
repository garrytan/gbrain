/**
 * v0.41 D5 — `--budget-usd N` enforcement via reservation pattern (Eng D7 + D10).
 *
 * Closes the "wake up to a $300 Anthropic bill" failure mode all the way:
 * D4 (batch-projection) shows the cost UP FRONT; D5 enforces a hard
 * ceiling at runtime. Together they make "fire-and-forget batches" a
 * real promise, not honor system.
 *
 * Reservation pattern (Eng D7, eng-review pass 2 — codex caught CAS-only
 * could overspend across N parallel children of one budget owner):
 *
 *   1. Worker calls `reserveBudget(ownerId, expectedMaxTurnCostCents)`
 *      BEFORE each turn.
 *   2. SQL UPDATE with CAS: `WHERE budget_remaining_cents >= cost
 *      RETURNING balance`. On miss → BudgetExhausted thrown.
 *   3. On turn return → `refundBudget(ownerId, unspentCents)`.
 *
 * Even with N concurrent children, parallel CAS UPDATEs serialize at the
 * row level — the worst-case overspend is bounded by the per-turn
 * reservation amount (NOT N × turn-cost as CAS-only would be).
 *
 * Eng D10 NULL-bypass (codex pass-3 #3 + #4): jobs without a budget
 * owner skip reservation entirely. Disambiguation via the immutable
 * `budget_root_owner_id` denormalized column — when the FK
 * `budget_owner_job_id` is NULL but `budget_root_owner_id` is set, the
 * owner was DELETED (not "never had a budget"); throw `BudgetOwnerDeleted`
 * so the child halts cleanly.
 *
 * Recursive halt (codex pass-2 #3): when owner balance hits 0, the worker
 * walks `WHERE budget_owner_job_id = X AND status IN ('waiting','delayed')`
 * to flip the entire subtree to `dead` with reason `budget_exhausted`.
 *
 * Audit (Eng D8 / codex pass-3 #7): every reserve/refund/lost/halted
 * event writes one row to `minion_budget_log` with denormalized model +
 * owner context so post-prune forensic queries still work.
 */

import type { BrainEngine } from '../engine.ts';

/** Status of a reservation attempt. */
export type ReservationOutcome =
  | { kind: 'reserved'; new_balance_cents: number; reserved_cents: number }
  | { kind: 'exhausted'; balance_at_attempt: number; requested_cents: number }
  | { kind: 'no_budget' } // job has no owner; bypass entirely (Eng D10)
  | { kind: 'owner_deleted'; root_owner_id: number }; // pruned mid-batch

/** Throw to signal budget exhaustion to the worker / subagent handler. */
export class BudgetExhausted extends Error {
  constructor(public owner_id: number, public balance_at_attempt_cents: number) {
    super(`budget owner ${owner_id} exhausted: balance ${balance_at_attempt_cents} cents`);
    this.name = 'BudgetExhausted';
  }
}

/** Throw when the budget owner row was deleted mid-batch (Eng D10). */
export class BudgetOwnerDeleted extends Error {
  constructor(public root_owner_id: number) {
    super(`budget owner ${root_owner_id} was deleted; child cannot continue safely`);
    this.name = 'BudgetOwnerDeleted';
  }
}

/** What we learn about a job's budget ownership at reservation time. */
export interface BudgetOwnerInfo {
  job_id: number;
  budget_owner_job_id: number | null;
  budget_root_owner_id: number | null;
  budget_remaining_cents: number | null;
}

/**
 * Look up budget ownership for a job. Returns 'no_budget' when neither
 * the FK nor the denormalized root is set. Returns 'owner_deleted' when
 * the denormalized root is set but the FK is NULL (owner was pruned).
 */
export async function getBudgetOwner(
  engine: BrainEngine,
  jobId: number,
): Promise<BudgetOwnerInfo | null> {
  const rows = await engine.executeRaw<BudgetOwnerInfo>(
    `SELECT id AS job_id, budget_owner_job_id, budget_root_owner_id, budget_remaining_cents
       FROM minion_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0] ?? null;
}

/**
 * Set the budget on the OWNER job (the parent). Called when an operator
 * submits `gbrain agent run ... --budget-usd N`. Sets budget_remaining_cents
 * on the owner row AND populates budget_root_owner_id to its own id (self-
 * reference) so subsequent children inherit it.
 */
export async function setOwnerBudget(
  engine: BrainEngine,
  ownerJobId: number,
  budgetUsd: number,
): Promise<void> {
  const cents = Math.round(budgetUsd * 100);
  await engine.executeRaw(
    `UPDATE minion_jobs
       SET budget_remaining_cents = $2,
           budget_owner_job_id = $1,
           budget_root_owner_id = $1
       WHERE id = $1`,
    [ownerJobId, cents],
  );
}

/**
 * Inherit budget ownership at child-submit time. Call from the path
 * that submits a child of a budget-bearing parent (or grandparent). The
 * child's budget_owner_job_id + budget_root_owner_id mirror the parent's,
 * not the parent's own id. Same-row UPDATE; cheap.
 *
 * Children DO NOT copy budget_remaining_cents — only the owner row holds
 * spendable balance. Codex pass-3 #5 caught the contradiction in the
 * original plan that suggested copying balance.
 */
export async function inheritBudgetOwner(
  engine: BrainEngine,
  childJobId: number,
  parentJobId: number,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE minion_jobs SET
       budget_owner_job_id = (SELECT COALESCE(budget_owner_job_id, NULL) FROM minion_jobs WHERE id = $2),
       budget_root_owner_id = (SELECT COALESCE(budget_root_owner_id, NULL) FROM minion_jobs WHERE id = $2)
     WHERE id = $1`,
    [childJobId, parentJobId],
  );
}

/**
 * Reserve `expected_max_turn_cost_cents` from the budget owner BEFORE
 * the turn runs. CAS guarantees no overspend: parallel reservations
 * serialize at the row level.
 *
 * Eng D10 NULL-bypass: jobs without an owner return 'no_budget' and
 * the worker SHOULD proceed without budget gating.
 *
 * Eng D10 deleted-owner disambiguation: when FK is NULL but the
 * denormalized root is set, return 'owner_deleted' and the worker
 * SHOULD halt cleanly.
 */
export async function reserveBudget(
  engine: BrainEngine,
  childJobId: number,
  expectedMaxTurnCostCents: number,
): Promise<ReservationOutcome> {
  const info = await getBudgetOwner(engine, childJobId);
  if (!info) {
    // Job row vanished — shouldn't happen mid-claim but defensive.
    return { kind: 'no_budget' };
  }

  // Eng D10 disambiguation.
  if (info.budget_owner_job_id === null) {
    if (info.budget_root_owner_id !== null) {
      return { kind: 'owner_deleted', root_owner_id: info.budget_root_owner_id };
    }
    return { kind: 'no_budget' };
  }

  const rows = await engine.executeRaw<{ budget_remaining_cents: number }>(
    `UPDATE minion_jobs
       SET budget_remaining_cents = budget_remaining_cents - $2
       WHERE id = $1 AND budget_remaining_cents >= $2
       RETURNING budget_remaining_cents`,
    [info.budget_owner_job_id, expectedMaxTurnCostCents],
  );
  if (rows.length === 0) {
    // CAS miss — owner exhausted. Read current balance for the audit row.
    const peek = await engine.executeRaw<{ budget_remaining_cents: number }>(
      `SELECT budget_remaining_cents FROM minion_jobs WHERE id = $1`,
      [info.budget_owner_job_id],
    );
    const balance = peek[0]?.budget_remaining_cents ?? 0;
    await logBudgetEvent(engine, {
      job_id: childJobId,
      owner_id: info.budget_owner_job_id,
      event_type: 'halted',
      cents_delta: 0,
    });
    return { kind: 'exhausted', balance_at_attempt: balance, requested_cents: expectedMaxTurnCostCents };
  }

  await logBudgetEvent(engine, {
    job_id: childJobId,
    owner_id: info.budget_owner_job_id,
    event_type: 'reserved',
    cents_delta: -expectedMaxTurnCostCents,
  });
  return { kind: 'reserved', new_balance_cents: rows[0]!.budget_remaining_cents, reserved_cents: expectedMaxTurnCostCents };
}

/**
 * Refund unspent cents AFTER the turn returns. Pass the unspent amount
 * (reserved - actual). Defensive: caller can pass 0 with no harm.
 */
export async function refundBudget(
  engine: BrainEngine,
  childJobId: number,
  ownerJobId: number,
  refundCents: number,
): Promise<void> {
  if (refundCents <= 0) return;
  await engine.executeRaw(
    `UPDATE minion_jobs SET budget_remaining_cents = budget_remaining_cents + $2
       WHERE id = $1`,
    [ownerJobId, refundCents],
  );
  await logBudgetEvent(engine, {
    job_id: childJobId,
    owner_id: ownerJobId,
    event_type: 'refunded',
    cents_delta: refundCents,
  });
}

/**
 * Recursive halt sweep — codex pass-2 #3. When the owner is exhausted,
 * walk `budget_owner_job_id = X` and flip every waiting/delayed
 * descendant to dead. Active jobs DO NOT get flipped here; their
 * turn-boundary reserveBudget call will throw BudgetExhausted on the
 * next turn (or, if mid-tool-dispatch, they complete the current turn
 * cleanly and the next reservation fails).
 *
 * Returns the count of jobs halted.
 */
export async function haltBudgetSubtree(
  engine: BrainEngine,
  ownerJobId: number,
  reason: 'budget_exhausted' | 'owner_deleted',
): Promise<number> {
  // Exclude the owner row itself — setOwnerBudget sets the owner's
  // budget_owner_job_id to its own id (self-referencing so children can
  // inherit via parent.budget_owner_job_id), which means the owner row
  // would match its own subtree filter. The owner has its own state
  // machine independent of budget halt; we just halt its DESCENDANTS.
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE minion_jobs SET
       status = 'dead',
       error_text = $2,
       finished_at = now(),
       updated_at = now()
     WHERE budget_owner_job_id = $1
       AND id != $1
       AND status IN ('waiting', 'delayed')
     RETURNING id`,
    [ownerJobId, `${reason}: parent ${ownerJobId} hit cap or was deleted`],
  );
  return rows.length;
}

/** Audit table row shape. Mirrors the columns from migration v93. */
export interface BudgetEventRecord {
  job_id: number;
  owner_id: number;
  event_type: 'reserved' | 'refunded' | 'spent' | 'lost' | 'halted' | 'owner_deleted';
  cents_delta: number;
  turn_index?: number;
  model?: string;
}

/** Best-effort write to minion_budget_log. Mirror of lease-pressure-audit. */
export async function logBudgetEvent(
  engine: BrainEngine,
  record: BudgetEventRecord,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO minion_budget_log
         (job_id, owner_id, event_type, cents_delta, turn_index, model)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.job_id,
        record.owner_id,
        record.event_type,
        record.cents_delta,
        record.turn_index ?? null,
        record.model ?? null,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[budget-tracker] WARN: audit write failed for job ${record.job_id}: ${msg}\n`,
    );
  }
}
