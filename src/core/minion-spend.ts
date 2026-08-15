// src/core/minion-spend.ts
// v0.41.18.0 (A7 + A23, codex finding #4).
//
// Generic Minion handlers (embed-catch-up, extract-ner,
// extract-timeline-from-meetings, extract-takes-from-pages) need to
// settle their LLM/API spend against the originating OAuth client's
// mcp_spend_log row when submitted via the MCP run_onboard op
// (admin scope). Pre-fix, only subagent loops via budget-meter.ts
// recorded spend; generic handlers wrote to the gateway without any
// per-client attribution.
//
// Convention chosen for v0.42.0: the originating client_id is stored on
// job.data.client_id when run_onboard submits. The schema column for
// minion_jobs.client_id is deferred to v0.42.1 (would require a v101
// migration + index). For now: handlers that spend LLM/embedding budget
// call recordMinionJobSpend(engine, job, ...) which reads job.data.client_id
// and writes to mcp_spend_log with the right attribution.
//
// Best-effort throughout: spend telemetry MUST NOT fail the user's call.

import type { BrainEngine } from './engine.ts';
import { recordSpend } from './spend-log.ts';

export interface MinionJobLike {
  id: number;
  data?: Record<string, unknown> | unknown;
}

/**
 * Read the OAuth client_id (if any) that submitted this Minion job.
 * Returns undefined for jobs submitted locally (CLI, autopilot tick) —
 * those bypass the per-client spend cap.
 */
export function getJobClientId(job: MinionJobLike): string | undefined {
  if (!job.data || typeof job.data !== 'object') return undefined;
  const data = job.data as Record<string, unknown>;
  const cid = data.client_id;
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined;
}

/**
 * Record spend for a Minion job. Handler-side; called after each LLM /
 * embedding API call settles. Threads the originating MCP client_id
 * (when present) into mcp_spend_log so per-client caps are enforced
 * across the parent run_onboard → child handler chain.
 *
 * Local handler runs (no client_id) record with clientId=null —
 * the row still lands for global accounting but doesn't count against
 * any specific OAuth client's daily cap.
 */
export async function recordMinionJobSpend(
  engine: BrainEngine,
  job: MinionJobLike,
  entry: {
    operation: string;
    spendCents: number;
    provider?: string;
    model?: string;
    tokenName?: string;
  },
): Promise<void> {
  const clientId = getJobClientId(job);
  await recordSpend(engine, {
    clientId: clientId ?? null,
    tokenName: entry.tokenName ?? null,
    operation: entry.operation,
    spendCents: entry.spendCents,
    provider: entry.provider,
    model: entry.model,
  });
}
