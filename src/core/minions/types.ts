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

// --- Child-done inbox message (auto-posted on completeJob) ---

/** Posted into the parent's inbox when a child completes successfully. */
export interface ChildDoneMessage {
  type: 'child_done';
  child_id: number;
  job_name: string;
  result: unknown;
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
