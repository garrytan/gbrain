/**
 * Minions — BullMQ-inspired Postgres-native job queue for GBrain.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *
 *   const worker = new MinionWorker(engine);
 *   worker.register('sync', async (job) => {
 *     await runSync(engine, job.data);
 *     return { pages_synced: 42 };
 *   });
 *   await worker.start();
 */

// --- Status & Type Unions ---

export type MinionJobStatus =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'dead'
  | 'cancelled'
  | 'waiting-children'
  | 'paused';

export type BackoffType = 'fixed' | 'exponential';

export type ChildFailPolicy = 'fail_parent' | 'remove_dep' | 'ignore' | 'continue';

// --- Job Record ---

export interface MinionJob {
  id: number;
  name: string;
  queue: string;
  status: MinionJobStatus;
  priority: number;
  data: Record<string, unknown>;

  // Retry
  max_attempts: number;
  attempts_made: number;
  attempts_started: number;
  backoff_type: BackoffType;
  backoff_delay: number;
  backoff_jitter: number;

  // Stall detection
  stalled_counter: number;
  max_stalled: number;
  lock_token: string | null;
  lock_until: Date | null;

  // Scheduling
  delay_until: Date | null;

  // Dependencies
  parent_job_id: number | null;
  on_child_fail: ChildFailPolicy;

  // Token accounting
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;

  // v7: subagent + parity
  depth: number;
  max_children: number | null;
  timeout_ms: number | null;
  timeout_at: Date | null;
  remove_on_complete: boolean;
  remove_on_fail: boolean;
  idempotency_key: string | null;

  // v12: scheduler polish — quiet-hours gate + deterministic stagger
  quiet_hours: Record<string, unknown> | null;
  stagger_key: string | null;

  // Results
  result: Record<string, unknown> | null;
  progress: unknown | null;
  error_text: string | null;
  stacktrace: string[];

  // Timestamps
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

// --- Input Types ---

export interface MinionJobInput {
  name: string;
  data?: Record<string, unknown>;
  queue?: string;
  priority?: number;
  max_attempts?: number;
  backoff_type?: BackoffType;
  backoff_delay?: number;
  backoff_jitter?: number;
  /**
   * Per-job override for how many stall windows are tolerated before the
   * queue dead-letters the job. When omitted, the schema column DEFAULT
   * applies (bumped 1 → 3 in v0.14, now 5 as of v0.13.1's audit). Clamped
   * to [1, 100] on insert. For long-running handlers (LLM loops etc.) that
   * should survive a worker kill mid-run, set max_stalled: 3+.
   */
  max_stalled?: number;
  delay?: number; // ms delay before eligible
  parent_job_id?: number;
  on_child_fail?: ChildFailPolicy;

  // v7: subagent + parity
  /** Cap on live (non-terminal) children of THIS job. NULL/undefined = unlimited. */
  max_children?: number;
  /** Wall-clock per-job deadline in ms. Set on claim → timeout_at. Terminal on expire (no retry). */
  timeout_ms?: number;
  /** DELETE row on successful completion (after token rollup + child_done insert). */
  remove_on_complete?: boolean;
  /** DELETE row on terminal failure (after parent failure hook). */
  remove_on_fail?: boolean;
  /** Override the queue's maxSpawnDepth for THIS submission only. */
  max_spawn_depth?: number;
  /** Global dedup key. Same key returns the existing job, no second row created. */
  idempotency_key?: string;
  /** Submission backpressure: cap waiting jobs with this name before inserting a new row. */
  maxWaiting?: number;

  // v12: scheduler polish
  /**
   * Quiet-hours window evaluated at claim time. Jobs whose current wall-clock
   * falls inside the window are deferred (delay +15m) or skipped per policy.
   * Example: `{start:22,end:7,tz:"America/Los_Angeles",policy:"defer"}`.
   */
  quiet_hours?: { start: number; end: number; tz: string; policy?: 'skip' | 'defer' };
  /**
   * Deterministic stagger key. When multiple jobs share a key (same cron fire),
   * their claim order is decorrelated by hash-based minute-offset. Optional.
   */
  stagger_key?: string;
}

/** Constructor options for MinionQueue (v7). */
export interface MinionQueueOpts {
  /** Max parent→child→grandchild depth. Default 5. Enforced on add() with parent_job_id. */
  maxSpawnDepth?: number;
  /** Max attachment size in bytes. Default 5 MiB. */
  maxAttachmentBytes?: number;
}

export interface MinionWorkerOpts {
  queue?: string;
  concurrency?: number; // default 1
  lockDuration?: number; // ms, default 30000
  stalledInterval?: number; // ms, default 30000
  maxStalledCount?: number; // default 1
  pollInterval?: number; // ms, default 5000 (for PGLite fallback)
  /** RSS threshold in MB. When exceeded, worker triggers graceful shutdown
   *  so a supervisor can respawn it. 0 or undefined = disabled. */
  maxRssMb?: number;
  /** Optional injection point for RSS readback. Defaults to
   *  `() => process.memoryUsage().rss`. Tests inject deterministic sequences. */
  getRss?: () => number;
  /** Periodic RSS check interval in ms, default 60000. Catches the freeze
   *  case where all concurrency slots are wedged with zero job completions
   *  so the per-job check never fires. */
  rssCheckInterval?: number;
}

// --- Job Context (passed to handlers) ---

export interface MinionJobContext {
  id: number;
  name: string;
  data: Record<string, unknown>;
  attempts_made: number;
  /** AbortSignal for cooperative cancellation (fires on timeout, cancel, pause, or lock loss). */
  signal: AbortSignal;
  /** AbortSignal that fires only on worker process SIGTERM/SIGINT. Handlers sensitive
   *  to deploy restarts (e.g. the shell handler, which must run a SIGTERM → 5s → SIGKILL
   *  sequence on its child) listen to this in addition to `signal`. Most handlers can
   *  ignore it — workers give them the full 30s cleanup race to finish naturally. */
  shutdownSignal: AbortSignal;
  /** Update structured progress (not just 0-100). */
  updateProgress(progress: unknown): Promise<void>;
  /** Accumulate token usage for this job. */
  updateTokens(tokens: TokenUpdate): Promise<void>;
  /** Append a log message or transcript entry to the job's stacktrace array. */
  log(message: string | TranscriptEntry): Promise<void>;
  /** Check if the lock is still held (for long-running jobs). */
  isActive(): Promise<boolean>;
  /** Read unread inbox messages (marks as read). */
  readInbox(): Promise<InboxMessage[]>;
}

export type MinionHandler = (job: MinionJobContext) => Promise<unknown>;

// --- Inbox Message ---

export interface InboxMessage {
  id: number;
  job_id: number;
  sender: string;
  payload: unknown;
  sent_at: Date;
  read_at: Date | null;
}

export function rowToInboxMessage(row: Record<string, unknown>): InboxMessage {
  return {
    id: row.id as number,
    job_id: row.job_id as number,
    sender: row.sender as string,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    sent_at: new Date(row.sent_at as string),
    read_at: row.read_at ? new Date(row.read_at as string) : null,
  };
}

// --- Child-done inbox message (auto-posted on every terminal transition) ---

/**
 * Posted into the parent's inbox when a child reaches a terminal state.
 *
 * Pre-v0.15: only success paths (completeJob) emitted this. Failed/dead/
 * cancelled children produced no payload, which stranded aggregator-style
 * parents that needed to wait for N children regardless of outcome.
 *
 * v0.15: failJob, cancelJob, and handleTimeouts also emit child_done with
 * the appropriate `outcome`, so the aggregator handler can count "N children
 * resolved" without worrying about which rail each one took.
 *
 * Backwards compatible: old ChildDoneMessage consumers only read child_id,
 * job_name, and result (non-null on success). Outcome and error are additive.
 */
export type ChildOutcome = 'complete' | 'failed' | 'dead' | 'cancelled' | 'timeout';

export interface ChildDoneMessage {
  type: 'child_done';
  child_id: number;
  job_name: string;
  result: unknown;
  /**
   * Terminal outcome. When absent (from a pre-v0.15 writer that didn't set
   * it), consumers should treat the message as 'complete' — the legacy writer
   * only emitted on success paths.
   */
  outcome?: ChildOutcome;
  /** Set when outcome !== 'complete'. Mirrors minion_jobs.error_text. */
  error?: string | null;
}

// --- Attachments (v7) ---

/** Caller-supplied attachment payload. content is base64-encoded bytes. */
export interface AttachmentInput {
  filename: string;
  content_type: string;
  /** Base64-encoded file bytes. Validated server-side. */
  content_base64: string;
}

/** Persisted attachment row (without inline bytes; use getAttachment to fetch). */
export interface Attachment {
  id: number;
  job_id: number;
  filename: string;
  content_type: string;
  storage_uri: string | null;
  size_bytes: number;
  sha256: string;
  created_at: Date;
}

export function rowToAttachment(row: Record<string, unknown>): Attachment {
  return {
    id: row.id as number,
    job_id: row.job_id as number,
    filename: row.filename as string,
    content_type: row.content_type as string,
    storage_uri: (row.storage_uri as string) || null,
    size_bytes: row.size_bytes as number,
    sha256: row.sha256 as string,
    created_at: new Date(row.created_at as string),
  };
}

// --- Token Update ---

export interface TokenUpdate {
  input?: number;
  output?: number;
  cache_read?: number;
}

// --- Structured Progress (convention, not enforced) ---

export interface AgentProgress {
  step: number;
  total: number;
  message: string;
  tokens_in: number;
  tokens_out: number;
  last_tool: string;
  started_at: string;
}

// --- Transcript Entry ---

export type TranscriptEntry =
  | { type: 'log'; message: string; ts: string }
  | { type: 'tool_call'; tool: string; args_size: number; result_size: number; ts: string }
  | { type: 'llm_turn'; model: string; tokens_in: number; tokens_out: number; ts: string }
  | { type: 'error'; message: string; stack?: string; ts: string };

// --- Errors ---

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

// --- Row Mapping ---

export function rowToMinionJob(row: Record<string, unknown>): MinionJob {
  return {
    id: row.id as number,
    name: row.name as string,
    queue: row.queue as string,
    status: row.status as MinionJobStatus,
    priority: row.priority as number,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data ?? {}) as Record<string, unknown>,
    max_attempts: row.max_attempts as number,
    attempts_made: row.attempts_made as number,
    attempts_started: row.attempts_started as number,
    backoff_type: row.backoff_type as BackoffType,
    backoff_delay: row.backoff_delay as number,
    backoff_jitter: row.backoff_jitter as number,
    stalled_counter: row.stalled_counter as number,
    max_stalled: row.max_stalled as number,
    lock_token: (row.lock_token as string) || null,
    lock_until: row.lock_until ? new Date(row.lock_until as string) : null,
    delay_until: row.delay_until ? new Date(row.delay_until as string) : null,
    parent_job_id: (row.parent_job_id as number | null) ?? null,
    on_child_fail: row.on_child_fail as ChildFailPolicy,
    tokens_input: (row.tokens_input as number) ?? 0,
    tokens_output: (row.tokens_output as number) ?? 0,
    tokens_cache_read: (row.tokens_cache_read as number) ?? 0,
    depth: (row.depth as number) ?? 0,
    max_children: (row.max_children as number) ?? null,
    timeout_ms: (row.timeout_ms as number) ?? null,
    timeout_at: row.timeout_at ? new Date(row.timeout_at as string) : null,
    remove_on_complete: row.remove_on_complete === true,
    remove_on_fail: row.remove_on_fail === true,
    idempotency_key: (row.idempotency_key as string) || null,
    quiet_hours: row.quiet_hours ? (typeof row.quiet_hours === 'string' ? JSON.parse(row.quiet_hours) : row.quiet_hours) as Record<string, unknown> : null,
    stagger_key: (row.stagger_key as string) || null,
    result: row.result ? (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as Record<string, unknown> : null,
    progress: row.progress ? (typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress) : null,
    error_text: (row.error_text as string) || null,
    stacktrace: row.stacktrace ? (typeof row.stacktrace === 'string' ? JSON.parse(row.stacktrace) : row.stacktrace) as string[] : [],
    created_at: new Date(row.created_at as string),
    started_at: row.started_at ? new Date(row.started_at as string) : null,
    finished_at: row.finished_at ? new Date(row.finished_at as string) : null,
    updated_at: new Date(row.updated_at as string),
  };
}

// ---------------------------------------------------------------------------
// Subagent runtime (v0.15+)
// ---------------------------------------------------------------------------

/**
 * Input payload for the 'subagent' handler. Shape is intentionally narrow —
 * tool registry and provider config resolve via handler-side defaults + env,
 * not per-job data, so restart/replay uses the same behavior.
 */
export interface SubagentHandlerData {
  /** Top-level user turn kicking off the loop. */
  prompt: string;
  /** Optional subagent definition path (skills/subagents/*.md or plugin). */
  subagent_def?: string;
  /** LLM model id. Defaults to the smart-tier model at handler resolution time. */
  model?: string;
  /** Max assistant turns before the loop fails with stop_reason='max_turns'. */
  max_turns?: number;
  /**
   * Whitelist of tool names the agent may call. MUST be a subset of the
   * derived registry names — invalid entries are rejected at tool-dispatch
   * time, not silently ignored. Empty array = no tools.
   */
  allowed_tools?: string[];
  /** System prompt override. When omitted, the handler builds one. */
  system?: string;
  /** Template variables for subagent_def. Arbitrary JSON-serializable. */
  input_vars?: Record<string, unknown>;
  /** Override the LLM provider for this job (e.g., 'anthropic', 'openai', 'deepseek'). */
  provider?: string;
  /** Override the base URL for the LLM provider (e.g. for custom OpenAI-compatible endpoints). */
  base_url?: string;
  /** Override the model tier for this job ('smart' or 'fast'). */
  tier?: 'smart' | 'fast';
}

/**
 * Input for the 'subagent_aggregator' handler. Claims AFTER all children
 * resolve and aggregates their results into a brain page.
 */
export interface AggregatorHandlerData {
  /** The subagent child job ids this aggregator is waiting on. */
  children_ids: number[];
  /**
   * Optional template for the synthesis prompt. When omitted, the handler
   * uses a generic "summarize these N results" prompt.
   */
  aggregate_prompt_template?: string;
  /**
   * Target slug for the aggregated brain page. When present, a trusted-CLI
   * put_page (viaSubagent=false) writes the final aggregation there.
   */
  output_slug?: string;
}

/** Tool execution context passed to every ToolDef.execute. */
export interface ToolCtx {
  /** Engine for DB-backed tools (brain_query, put_page, etc.). */
  engine: import('../engine.ts').BrainEngine;
  /** The subagent job id (used for audit + put_page namespace enforcement). */
  jobId: number;
  /** Always true for LLM-invoked tools — matches MCP trust boundary. */
  remote: true;
  /** Fired on cooperative abort (timeout, lock loss, cancel, SIGTERM). */
  signal?: AbortSignal;
}

/**
 * A tool the subagent can call. Names match Anthropic's constraint
 * `^[a-zA-Z0-9_-]{1,64}$` — no dots. The input_schema is the JSONSchema
 * shipped to the Anthropic Messages API verbatim; ToolDef is the single
 * Anthropic-compatible envelope, not an MCP McpToolDef (those have a
 * different shape — ".inputSchema" vs ".input_schema").
 *
 * `idempotent: true` is required for the two-phase replay path: on resume,
 * a 'pending' row can be re-executed. Non-idempotent tools need a separate
 * resume policy and are not supported in v0.15.
 */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  idempotent: boolean;
  execute(input: unknown, ctx: ToolCtx): Promise<unknown>;
}

/**
 * Anthropic content-block subset we persist in subagent_messages.content_blocks.
 * This is structural — we don't gatekeep on unknown block types (future SDK
 * additions pass through). Use the string-literal discriminant on 'type'.
 */
export type ContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Stop reason reported to the caller when the subagent loop terminates. */
export type SubagentStopReason =
  | 'end_turn'    // Anthropic says end_turn and last message has no tool_use
  | 'max_turns'   // hit max_turns budget before end_turn
  | 'refusal'     // detected via stop_reason + content shape
  | 'error';      // unrecoverable (empty response retry exhausted, etc.)

/** Terminal result payload emitted by the subagent handler. */
export interface SubagentResult {
  /** Concatenated text from the final assistant message. */
  result: string;
  /** Number of assistant turns consumed. */
  turns_count: number;
  /** Why the loop stopped. */
  stop_reason: SubagentStopReason;
  /** Rollup of tokens across all turns. */
  tokens: {
    in: number;
    out: number;
    cache_read: number;
    cache_create: number;
  };
}
