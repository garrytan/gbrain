/**
 * AgentRunner — pluggable contract for invoking external agents (openclaw,
 * hermes, codex, …) inside the claw-test harness. v1 ships a single
 * implementation (openclaw); the interface stays narrow and concrete so
 * adding a second runner in v1.1 is a ~50-line file.
 *
 * The harness wraps spawn/timeout/transcript-capture; runners only have to
 * answer "where's your binary?" and "how do I invoke it with this prompt?".
 *
 *  ┌────────────────────┐
 *  │ harness            │
 *  │  ─ resolve(name) ─▶│  registry → AgentRunner instance
 *  │  ─ detect()       ─▶│  runner reports binary path/availability
 *  │  ─ invoke(...)    ─▶│  runner spawns child, harness captures via TranscriptSink
 *  └────────────────────┘
 */

export interface AgentRunner {
  /** Stable agent name used by --agent flag and friction `agent` field. */
  readonly name: string;

  /**
   * Locate the agent binary and confirm it is executable. Pure check; never
   * spawns. `binPath` is always an absolute path on success. `available=false`
   * with a `reason` if not found / not executable.
   */
  detect(): Promise<DetectResult>;

  /**
   * Invoke the agent with the given prompt. The runner is responsible for
   * the per-agent argv shape. The harness owns timeouts, signals, and
   * transcript capture (via `transcriptSink`).
   */
  invoke(opts: InvokeOpts): Promise<InvokeResult>;

  /** Optional per-agent post-install hook (e.g., routing-file fixup). */
  postInstallHook?(opts: { workspaceDir: string }): Promise<void>;
}

export interface DetectResult {
  available: boolean;
  reason?: string;
  binPath?: string;
}

export interface InvokeOpts {
  /** Workspace dir the agent runs in. */
  cwd: string;
  /** The prompt content. The runner decides whether to write a temp file or pass via argv. */
  brief: string;
  /** Env to merge with the runner's defaults. Caller already restricted to allow-listed keys. */
  env: Record<string, string>;
  /** Wall-clock kill switch in ms. Harness handles SIGTERM → 5s grace → SIGKILL. */
  timeoutMs: number;
  /**
   * Per-channel byte sink. The runner pipes child stdin/stdout/stderr into this
   * instead of inheriting the parent's. Async-drain backpressure is handled
   * inside the sink (D17), so the runner can call `write()` without awaiting.
   */
  transcriptSink: TranscriptSink;
  /** Optional override for which sub-agent the runner targets. */
  agentName?: string;
}

export interface InvokeResult {
  exitCode: number;
  durationMs: number;
}

/** Async-drain sink. The harness owns the underlying file stream. */
export interface TranscriptSink {
  write(event: TranscriptEvent): void;
  /** Returns the byte offset that the next written event would have. */
  nextOffset(): number;
  /** Flush + close. Idempotent. */
  close(): Promise<void>;
}

export interface TranscriptEvent {
  ts: number;
  channel: 'stdin' | 'stdout' | 'stderr';
  bytes: Buffer;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type AgentRunnerFactory = () => AgentRunner;

const registry = new Map<string, AgentRunnerFactory>();

export function registerAgentRunner(name: string, factory: AgentRunnerFactory): void {
  registry.set(name, factory);
}

export function resolveAgentRunner(name: string): AgentRunner {
  const factory = registry.get(name);
  if (!factory) {
    const known = [...registry.keys()].sort().join(', ') || '(none registered)';
    throw new Error(`unknown agent ${JSON.stringify(name)}; registered: ${known}`);
  }
  return factory();
}

export function listRegisteredAgents(): string[] {
  return [...registry.keys()].sort();
}

/** Reset registry — testing only. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
