/**
 * Subagent transcript + tool-execution persistence (peeled from subagent.ts).
 *
 * One module owns every read/write of `subagent_messages` and
 * `subagent_tool_executions` used by the subagent handler's loops and the
 * crash-replay reconciliation. JSONB discipline throughout: values are
 * pre-serialized to a JSON string and bound through `$N::text::jsonb` — never
 * JSON.stringify into a bare `::jsonb` cast (#2339 class; PGLite hides it).
 */

import type { BrainEngine } from '../../engine.ts';
import type { ContentBlock, SubagentResult } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import { putPageRejection } from '../tools/put-page-result.ts';

export interface PersistedMessage {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

export interface PersistedToolExec {
  message_idx: number;
  /** D11 stable ordinal (per-turn tool-call position). NULL on legacy rows. */
  ordinal: number | null;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

export interface PriorToolV2Row {
  stableKey: string;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/**
 * Load prior tool executions keyed by a stable key.
 *
 *   - v2 rows: gbrain_tool_use_id is the stable key (set at first observation
 *     by onToolCallStart).
 *   - v1 legacy rows: D5 shim synthesizes a stable key from
 *     (job_id, message_idx, ordinal-position-by-array-index, tool_name).
 *
 * Both forms resolve to the same Map<stableKey, outcome> the gateway loop
 * consults during replay.
 */
export async function loadPriorToolsV2(engine: BrainEngine, jobId: number): Promise<PriorToolV2Row[]> {
  const rows = await engine.listSubagentToolExecutions(jobId, 'replay');
  return rows.map(r => {
    const gbrainId = r.gbrain_tool_use_id;
    const stableKey = gbrainId
      ? gbrainId
      // D5 legacy shim: derive a stable key from (job, msg_idx, tool_name, tool_use_id).
      // Pre-v81 rows don't have ordinal; the provider tool_use_id is stable
      // within a single Anthropic turn so it's safe as a fallback hash input.
      : `legacy:${jobId}:${r.message_idx}:${r.tool_use_id}:${r.tool_name}`;
    return {
      stableKey,
      status: r.status,
      output: r.output,
      error: r.error ?? null,
    };
  });
}

export async function loadPriorMessages(engine: BrainEngine, jobId: number): Promise<PersistedMessage[]> {
  const rows = await engine.listSubagentMessages(jobId);
  return rows.map(r => ({
    message_idx: r.message_idx,
    role: r.role,
    content_blocks: (typeof r.content_blocks === 'string'
      ? JSON.parse(r.content_blocks as string)
      : r.content_blocks) as ContentBlock[],
    tokens_in: r.tokens_in ?? null,
    tokens_out: r.tokens_out ?? null,
    tokens_cache_read: r.tokens_cache_read ?? null,
    tokens_cache_create: r.tokens_cache_create ?? null,
    model: r.model ?? null,
  }));
}

export async function loadPriorTools(engine: BrainEngine, jobId: number): Promise<PersistedToolExec[]> {
  const rows = await engine.listSubagentToolExecutions(jobId, 'replay');
  return rows.map(r => ({
    message_idx: r.message_idx,
    ordinal: r.ordinal ?? null,
    tool_use_id: r.tool_use_id,
    tool_name: r.tool_name,
    input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input,
    status: r.status,
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output) : r.output),
    error: r.error ?? null,
  }));
}

export async function persistMessage(engine: BrainEngine, jobId: number, msg: PersistedMessage): Promise<void> {
  await engine.insertSubagentMessage(jobId, {
    message_idx: msg.message_idx,
    role: msg.role,
    content_blocks: JSON.stringify(msg.content_blocks),
    tokens_in: msg.tokens_in,
    tokens_out: msg.tokens_out,
    tokens_cache_read: msg.tokens_cache_read,
    tokens_cache_create: msg.tokens_cache_create,
    model: msg.model,
  });
}

export async function persistToolExecPending(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  /** 0-based tool_use block position within the turn — the D11 ordinal. */
  ordinal: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  // Serialize to a JSON string, then bind through $5::text::jsonb. The value is
  // ALWAYS a string here (pre-serialized input, or JSON.stringify) — binding a
  // string to a bare $5::jsonb double-encodes it into a jsonb scalar string under
  // postgres.js .unsafe() (#2339 class; PGLite hides it). The ::text cast makes
  // the text→jsonb parse produce a real jsonb object.
  const jsonStr = typeof input === 'string' ? input : JSON.stringify(input);
  // Two guards replace the former job-wide ON CONFLICT (job_id, tool_use_id)
  // DO NOTHING (that constraint was dropped in migration v131, #4155 — raw
  // provider ids may repeat across turns):
  //   1. NOT EXISTS, restricted to LEGACY ordinal=NULL rows, preserves the
  //      DO NOTHING semantics against rows that predate ordinal stamping
  //      (they never trip a conflict target). Stamped rows are governed by
  //      guard 2 alone, so two distinct same-turn calls that share a raw id
  //      each keep their own row.
  //   2. ON CONFLICT on the stable-id constraint (job_id, message_idx,
  //      ordinal) is the constraint-backed backstop for the residual race —
  //      a lease bounds honest workers to one owner per job, but an expired
  //      job can be reclaimed while a partitioned old worker still writes.
  await engine.recordSubagentToolExecutions(
    jobId,
    [{ message_idx: messageIdx, ordinal, tool_use_id: toolUseId, tool_name: toolName, input: jsonStr, status: 'pending' }],
    { legacyGuard: true },
  );
}

export async function persistToolExecComplete(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  /** 0-based tool_use block position within the turn — the D11 ordinal. */
  ordinal: number,
  toolUseId: string,
  output: unknown,
): Promise<void> {
  // Scoped by message_idx: raw provider tool_use_ids may repeat across turns
  // (#4155), so (job_id, tool_use_id) alone could also update a sibling
  // turn's row. Targets exactly ONE row: the call's own ordinal first, then a
  // legacy ordinal=NULL row — never an already-COMPLETE row (the ordinal IS
  // NULL disjunct would otherwise let a legacy settled sibling's output be
  // silently overwritten), and never a same-id SIBLING at another ordinal: a
  // call's own row is always reachable via its ordinal (persistToolExecPending
  // stamps the same value) or via the legacy NULL, so a broader status-based
  // disjunct could only ever capture a sibling's row.
  await engine.completeSubagentToolExecution(
    { jobId, messageIdx, ordinal, toolUseId },
    typeof output === 'string' ? output : JSON.stringify(output),
  );
}

/**
 * #4217 — structural write accounting. A subagent job's status used to reflect
 * only "the agent turn finished"; 22 consecutive jobs once reported
 * `completed` while every put_page failed (embedding-dimension mismatch) and
 * the dream cycle silently produced nothing for 9 hours.
 *
 * Counts are derived from the job's own tool-execution ledger and merged into
 * the result for EVERY subagent job. Predicate discipline (OV-2): `attempted`
 * counts settled rows only — complete + failed; pending rows (crash-orphaned
 * dispatches that never settled) count toward NEITHER side.
 *
 * When the submitter set `require_writes` (dream synthesize / patterns
 * fan-out — jobs whose entire purpose is writing pages), zero successes
 * throws UnrecoverableError: retrying is provably futile (the
 * replay path short-circuits to the persisted terminal turn and can never
 * re-run the failed tools), so the job routes straight to dead and the
 * idempotency key releases for the next cycle. The one exception is a
 * legitimate zero-write answer (`isLegitimateZeroWrite`): dead-lettering it
 * released the key and withheld the cooldown, so every cycle re-paid for the
 * same input (#5590, #5540).
 *
 * `scopeToolUseIdPrefix` narrows the ledger scan (the oneshot runner scopes to
 * its own invocation's rows so a prior invocation's outcome can't distort the
 * verdict); agentic jobs scan job-wide.
 */
export async function finalizeWriteAccounting(
  engine: BrainEngine,
  jobId: number,
  result: SubagentResult,
  opts: { requireWrites: boolean; allowCleanZeroWrites?: boolean; scopeToolUseIdPrefix?: string },
): Promise<SubagentResult> {
  let rows: Array<{ status: string; error: string | null; output: unknown }>;
  try {
    rows = await engine.listSubagentWriteOutcomes(jobId, opts.scopeToolUseIdPrefix);
  } catch (e) {
    if (opts.requireWrites) {
      // Fail CLOSED for write-required jobs: returning the result unchanged
      // here would complete an all-writes-failed job on the exact pool
      // failure this accounting exists to survive. The rethrow is retryable
      // — replay short-circuits the model call and re-runs this read on a
      // healthy pool; exhausted attempts dead-letter, which releases the
      // idempotency key so the next nightly re-synthesizes.
      throw e instanceof Error ? e : new Error(String(e));
    }
    // Open-ended agent jobs keep fail-open: accounting is supplemental
    // there, and a transient read error must not crash a finished job.
    process.stderr.write(`[subagent] write accounting read failed for job ${jobId}: ${e instanceof Error ? e.message : String(e)}\n`);
    return result;
  }
  const settled = rows.filter(r => r.status === 'complete' || r.status === 'failed').map(row => {
    const rejection = row.status === 'complete' ? putPageRejection(row.output) : null;
    return rejection ? { ...row, status: 'failed', error: rejection } : row;
  });
  const written = settled.filter(r => r.status === 'complete').length;
  const failed = settled.filter(r => r.status === 'failed').length;
  const attempted = written + failed;
  const accounted: SubagentResult = {
    ...result,
    pages_attempted: attempted,
    pages_written: written,
    pages_failed: failed,
  };
  if (opts.requireWrites && attempted > 0 && written === 0) {
    const firstError = settled.find(r => r.status === 'failed' && r.error)?.error ?? 'unknown write error';
    throw new UnrecoverableError(
      `all ${failed} put_page write(s) failed — job produced zero pages (first error: ${firstError})`,
    );
  }
  if (opts.requireWrites && attempted === 0 && !(await isLegitimateZeroWrite(engine, jobId, result, opts))) {
    throw new UnrecoverableError(
      result.stop_reason === 'end_turn'
        ? 'job produced zero required put_page writes — a clean model finish does not satisfy require_writes'
        : `job produced zero put_page writes and did not finish cleanly (stop_reason: ${result.stop_reason}) — not a legitimate skip`,
    );
  }
  return accounted;
}

/**
 * A zero-attempt, clean (`end_turn`) finish is a legitimate answer in exactly
 * two shapes: the oneshot model's explicit skip contract
 * (`{"pages":[],"skipped":true}`), or — when the submitter opted in with
 * `allow_clean_zero_writes` — a run whose ledger holds at least one completed
 * tool execution, proving the child examined evidence before naming nothing.
 * A prose-only finish, a dirty stop, or a run whose only tools failed stays a
 * real failure. The ledger read throws on error, failing the job closed.
 */
async function isLegitimateZeroWrite(
  engine: BrainEngine,
  jobId: number,
  result: SubagentResult,
  opts: { allowCleanZeroWrites?: boolean; scopeToolUseIdPrefix?: string },
): Promise<boolean> {
  if (result.stop_reason !== 'end_turn') return false;
  if (result.synth_mode_used === 'oneshot' && result.oneshot_skipped === true) return true;
  if (!opts.allowCleanZeroWrites) return false;
  return engine.hasSubagentToolExecution(jobId, { status: 'complete', toolUseIdPrefix: opts.scopeToolUseIdPrefix });
}

export async function persistToolExecFailed(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  /** 0-based tool_use block position within the turn — the D11 ordinal. */
  ordinal: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  error: string,
): Promise<void> {
  // INSERT-or-UPDATE to failed — covers both "no pending row yet" (tool
  // rejected upfront) and "pending row exists" (tool threw mid-execute).
  // UPDATE-then-INSERT replaces the former ON CONFLICT (job_id, tool_use_id)
  // upsert (that job-wide unique was dropped in migration v131, #4155).
  // The UPDATE targets exactly ONE row (own ordinal first, then legacy
  // ordinal=NULL) and NEVER a row that already settled complete — without the
  // status guard the ordinal IS NULL disjunct would let a late failure
  // downgrade a legacy settled row, corrupting the ledger replay trusts. No
  // status-based disjunct: a call's own row is always reachable via its
  // ordinal or the legacy NULL, so an `OR status = 'pending'` arm could only
  // ever capture a same-id SIBLING's pending row at another ordinal (e.g. an
  // unregistered-tool failure with no own row stealing the sibling's slot).
  // The INSERT leg carries the stable-id ON CONFLICT backstop for the
  // residual zombie-worker race, mirroring persistToolExecPending; its
  // conflict update is predicated on the SAME tool_use_id and a non-complete
  // row for the same reason.
  await engine.failSubagentToolExecution(
    { jobId, messageIdx, ordinal, toolUseId },
    error,
    { tool_name: toolName, input: typeof input === 'string' ? input : JSON.stringify(input) },
  );
}
