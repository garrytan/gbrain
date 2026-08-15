/**
 * v0.36 Phase 2 (D23-#6) — per-OAuth-client paid-API spend tracking.
 *
 * Legacy spend-log readers/writers retained for existing accounting callers.
 * Paid `search_by_image` requests use the atomic reserve/settle primitive in
 * `minions/budget-meter.ts`; a read-then-call check cannot enforce a cap under
 * concurrency.
 *
 * Config: `search.image_query.daily_budget_usd_per_client` (default $5).
 *
 * Scope: ONLY fires when `ctx.remote === true`. Local CLI callers have
 * direct billing visibility through their own credentials and don't need
 * the gate. The gate exists to prevent a misbehaving OAuth client from
 * burning the brain operator's Voyage account.
 */

import type { BrainEngine } from './engine.ts';
import { sqlQueryForEngine } from './sql-query.ts';

/** Per-call Voyage multimodal-3 spend estimate (per image), in cents. */
export const VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS = 0.12;

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED' as const;
  readonly spentCents: number;
  readonly capCents: number;
  constructor(message: string, spentCents: number, capCents: number) {
    super(message);
    this.name = 'BudgetExceededError';
    this.spentCents = spentCents;
    this.capCents = capCents;
  }
}

/**
 * Sum today's recorded spend for a client. Returns 0 if the row count
 * is zero (new client) OR if the table doesn't exist (pre-v0.36 brain).
 */
export async function getTodaySpendCents(
  engine: BrainEngine,
  clientId: string,
): Promise<number> {
  try {
    const sql = sqlQueryForEngine(engine);
    const rows = await sql`
      SELECT COALESCE(SUM(spend_cents), 0)::text AS total
      FROM mcp_spend_log
      WHERE client_id = ${clientId}
        AND created_at >= ${todayStartIso()}
    `;
    const total = parseFloat(String(rows[0]?.total ?? '0'));
    return Number.isFinite(total) ? total : 0;
  } catch {
    // Table doesn't exist (pre-v0.36 brain) or DB hiccup — fail-open to 0.
    // The check sees "no spend recorded" and lets the call through. A real
    // production brain will have the table once migrations apply.
    return 0;
  }
}

/**
 * Pre-flight budget gate.
 *
 * @deprecated Non-atomic under concurrent paid calls. New OAuth/MCP spend
 * callers must use `reserve()` / `settle()` from `gbrain/budget/mcp`.
 *
 * Throws `BudgetExceededError` when the client has already spent at or above
 * the configured daily cap. Returns silently when there's room.
 *
 * @param dailyBudgetCents resolved from `search.image_query.daily_budget_usd_per_client`
 *   × 100 (converted to cents). Operator config; default 500 cents = $5.
 */
export async function checkBudget(
  engine: BrainEngine,
  clientId: string,
  dailyBudgetCents: number,
): Promise<void> {
  if (!clientId) return; // local CLI callers (no client_id) bypass the gate
  if (dailyBudgetCents <= 0) return; // 0 = "no cap" sentinel
  const spent = await getTodaySpendCents(engine, clientId);
  if (spent >= dailyBudgetCents) {
    throw new BudgetExceededError(
      `Daily Voyage spend cap reached: $${(spent / 100).toFixed(2)} >= $${(dailyBudgetCents / 100).toFixed(2)}. ` +
      `Reset at midnight UTC.`,
      spent,
      dailyBudgetCents,
    );
  }
}

/**
 * Record a successful paid call.
 *
 * Best-effort: writes failures (e.g., table not yet migrated) are swallowed
 * with a stderr warning. The search itself succeeded — we don't want to
 * fail the user's call because spend telemetry hiccupped.
 */
export async function recordSpend(
  engine: BrainEngine,
  entry: {
    clientId?: string | null;
    tokenName?: string | null;
    operation: string;
    spendCents: number;
    provider?: string;
    model?: string;
  },
): Promise<void> {
  try {
    const sql = sqlQueryForEngine(engine);
    await sql`
      INSERT INTO mcp_spend_log (client_id, token_name, operation, spend_cents, provider, model)
      VALUES (${entry.clientId ?? null}, ${entry.tokenName ?? null}, ${entry.operation}, ${entry.spendCents}, ${entry.provider ?? null}, ${entry.model ?? null})
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[spend-log] failed to record spend: ${msg}`);
  }
}

function todayStartIso(): string {
  const now = new Date();
  // UTC day-start so the cap rolls over deterministically regardless of
  // server timezone. Operators reading dashboards see UTC days.
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return utcMidnight.toISOString();
}
