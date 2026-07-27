/**
 * v0.41 E6 (corrected per codex pass-2 #4 + pass-1 #11) — subagent
 * failure-mode self-fix.
 *
 * When a subagent job terminates with a classified-recoverable failure
 * AND chain depth < `minions.self_fix_max_depth` AND no prior self-fix
 * at the same fingerprint, submit a follow-up job with the failure
 * context as the user message. One layer of self-healing; capped so it
 * cannot infinite-loop.
 *
 * **Classifier scope (codex pass-2 #4 — narrowed):**
 *
 * Only three buckets qualify for self-fix:
 *
 *   prompt_too_long      — semantic-aware reduction can fix
 *   tool_schema_mismatch — surface schema error to model, retry with valid input
 *   malformed_json       — ask model to retry, response must be JSON
 *
 * EXPLICITLY NOT self-fixable:
 *   tool_crash           — likely a real bug; masking via retry is worse
 *   tool_unavailable     — registry config issue; retry won't help
 *   tool_permission      — capability decision; needs human intervention
 *
 * **prompt_too_long reduction (codex pass-1 #11):** generic truncation
 * deletes the actual task. Right strategy: walk the conversation, drop
 * tool_result blocks first (largest non-task content), summarize older
 * user/asst pairs via Haiku if still over, never delete the leaf user
 * task. v0.41 ships the foundation (the policy + dispatch); full
 * semantic reduction can land as a follow-up since the worst-case fix
 * — truncate-then-fail — is still safe.
 *
 * **Chain depth:** configurable, default 2 (D15). Hard cap = N from
 * config; chain-walk idempotency check prevents double self-fix at the
 * same fingerprint.
 *
 * **Budget:** self-fix children inherit the budget owner (NOT a copy
 * of remaining balance — codex pass-3 #5). Self-fix spend counts
 * against the same owner as the parent.
 *
 * **Default state:** ON for fresh install AND on upgrade (D9 + D15).
 * Off-switch: `gbrain config set minions.self_fix_enabled false`
 * (global) or `data.no_self_fix: true` (per-job).
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from './queue.ts';
import { classifyJobError, RECOVERABLE_CLUSTERS, type ErrorCluster } from './error-classify.ts';
import type { SubagentHandlerData } from './types.ts';
import { inheritBudgetOwner } from './budget-tracker.ts';

export interface SelfFixDecision {
  /** Should we self-fix this failure? */
  should_fix: boolean;
  /** When should_fix=true, the cluster that matched. */
  cluster?: ErrorCluster;
  /** Reason text (always present; explains the decision). */
  reason: string;
}

export interface SelfFixOpts {
  /** Hard cap on chain depth. Default 2 (D15). */
  max_depth?: number;
  /** Global on/off (from config). Default true. */
  enabled?: boolean;
}

const DEFAULT_OPTS: Required<SelfFixOpts> = {
  max_depth: 2,
  enabled: true,
};

/**
 * Compute the chain depth of a job. Walks `parent_job_id` chain looking
 * for ancestors with `data.is_self_fix_child = true`. Each such ancestor
 * adds 1 to the depth.
 */
export async function computeChainDepth(engine: BrainEngine, jobId: number): Promise<number> {
  let depth = 0;
  let cursor: number | null = jobId;
  while (cursor !== null && depth < 10 /* safety cap */) {
    const rows: Array<{ parent_job_id: number | null; data: unknown }> =
      await engine.executeRaw(
        `SELECT parent_job_id, data FROM minion_jobs WHERE id = $1`,
        [cursor],
      );
    if (rows.length === 0) break;
    const data = rows[0]!.data as Record<string, unknown> | null;
    if (data && data.is_self_fix_child === true) {
      depth += 1;
    }
    cursor = rows[0]!.parent_job_id;
  }
  return depth;
}

/**
 * Decide whether a job should self-fix. Pure-ish (one SQL for depth);
 * the decision logic itself is unit-testable in isolation.
 */
export async function decideSelfFix(
  engine: BrainEngine,
  jobId: number,
  jobData: SubagentHandlerData,
  lastError: string | null,
  opts: SelfFixOpts = {},
): Promise<SelfFixDecision> {
  const merged = { ...DEFAULT_OPTS, ...opts };
  if (!merged.enabled) {
    return { should_fix: false, reason: 'self_fix_disabled_globally' };
  }
  if (jobData.no_self_fix) {
    return { should_fix: false, reason: 'no_self_fix_flag_on_job' };
  }
  const cluster = classifyJobError(lastError);
  if (!RECOVERABLE_CLUSTERS.has(cluster)) {
    return { should_fix: false, cluster, reason: `cluster_not_recoverable:${cluster}` };
  }
  const depth = await computeChainDepth(engine, jobId);
  if (depth >= merged.max_depth) {
    return { should_fix: false, cluster, reason: `max_depth_reached:${depth}` };
  }
  return { should_fix: true, cluster, reason: `recoverable:${cluster}_at_depth_${depth}` };
}

/**
 * Build the user-message text for the self-fix child. Per-cluster prep:
 *
 *   prompt_too_long      — truncate-then-prepend (v0.41 ships truncate;
 *                          semantic reduction follow-up in v0.42)
 *   tool_schema_mismatch — surface schema error verbatim; ask for retry
 *                          with valid arguments
 *   malformed_json       — instruct model to respond with JSON only
 */
export function buildSelfFixPrompt(
  originalPrompt: string,
  cluster: ErrorCluster,
  lastError: string,
): string {
  switch (cluster) {
    case 'prompt_too_long': {
      // Truncation strategy: keep first 1000 chars + last 2000 chars of
      // the original prompt so the leaf task survives. Honest scope — v0.42
      // will replace with semantic reduction (drop tool_results first,
      // then Haiku-summarize older pairs).
      const first = originalPrompt.slice(0, 1000);
      const last = originalPrompt.length > 3000
        ? '\n\n... (middle truncated) ...\n\n' + originalPrompt.slice(-2000)
        : '';
      return [
        `[self-fix retry] Your previous attempt failed because the prompt was too long.`,
        `Original task (truncated to fit context):`,
        '',
        first + last,
        '',
        `Provide your answer based on the truncated task. If critical context is missing, say so.`,
      ].join('\n');
    }
    case 'tool_schema_mismatch':
      return [
        `[self-fix retry] Your previous attempt failed because a tool call had invalid arguments.`,
        `Error: ${lastError}`,
        '',
        `Original task:`,
        originalPrompt,
        '',
        `Retry the task. Double-check tool arguments against each tool's input_schema before calling.`,
      ].join('\n');
    case 'malformed_json':
      return [
        `[self-fix retry] Your previous attempt failed because the response was not valid JSON.`,
        `Error: ${lastError}`,
        '',
        `Original task:`,
        originalPrompt,
        '',
        `Retry. Your final response MUST be valid JSON — no prose, no markdown fences, no commentary.`,
      ].join('\n');
    default:
      return `[self-fix retry] ${originalPrompt}`;
  }
}

/**
 * Submit a self-fix child job. Returns the submitted child or null on
 * failure (audit row written either way). Caller has already decided
 * via decideSelfFix; this just does the submission.
 *
 * Child inherits budget owner from parent (Eng D7 + D10).
 */
export async function submitSelfFixChild(
  engine: BrainEngine,
  queue: MinionQueue,
  parent: {
    id: number;
    data: SubagentHandlerData;
    last_error: string;
  },
  cluster: ErrorCluster,
): Promise<{ child_id: number } | null> {
  try {
    const childPrompt = buildSelfFixPrompt(parent.data.prompt, cluster, parent.last_error);
    const childData: SubagentHandlerData & { is_self_fix_child: true; self_fix_cluster: ErrorCluster } = {
      ...parent.data,
      prompt: childPrompt,
      is_self_fix_child: true,
      self_fix_cluster: cluster,
    };
    const child = await queue.add(
      'subagent',
      childData as unknown as Record<string, unknown>,
      { parent_job_id: parent.id, max_attempts: 1 }, // single attempt; if self-fix fails, that's terminal
      { allowProtectedSubmit: true },
    );
    // Inherit budget owner if parent has one.
    await inheritBudgetOwner(engine, child.id, parent.id);
    // Audit row.
    await logSelfFixEvent(engine, {
      parent_id: parent.id,
      child_id: child.id,
      classifier_bucket: cluster,
      chain_depth: 1, // depth from parent's perspective — refined at next-tier check
      policy_applied: `buildSelfFixPrompt:${cluster}`,
      outcome: 'submitted',
    });
    return { child_id: child.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[self-fix] WARN: child submit failed for parent ${parent.id}: ${msg}\n`);
    await logSelfFixEvent(engine, {
      parent_id: parent.id,
      child_id: 0, // sentinel — submit failed; no child exists
      classifier_bucket: cluster,
      chain_depth: 1,
      policy_applied: `buildSelfFixPrompt:${cluster}`,
      outcome: `failed_to_submit:${msg.slice(0, 200)}`,
    });
    return null;
  }
}

export interface SelfFixEventRecord {
  parent_id: number;
  child_id: number;
  classifier_bucket: string;
  chain_depth: number;
  policy_applied?: string;
  outcome: string;
}

/** Best-effort write to minion_self_fix_log (audit table from migration v94). */
export async function logSelfFixEvent(
  engine: BrainEngine,
  record: SelfFixEventRecord,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO minion_self_fix_log
         (parent_id, child_id, classifier_bucket, chain_depth, policy_applied, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.parent_id,
        record.child_id || null, // 0 → NULL (submit failed)
        record.classifier_bucket,
        record.chain_depth,
        record.policy_applied ?? null,
        record.outcome,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[self-fix-audit] WARN: write failed for parent ${record.parent_id}: ${msg}\n`,
    );
  }
}
