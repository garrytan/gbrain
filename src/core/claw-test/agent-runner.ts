/**
 * AgentRunner — pluggable contract for invoking external agents (openclaw,
 * hermes, grok, …) inside the claw-test harness. Three implementations ship
 * (openclaw, hermes, grok); the interface stays narrow and concrete — with
 * the shared detect/env helpers below, adding another runner is a ~50-line
 * file plus one registerAgentRunner line.
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

import { execFileSync } from 'child_process';
import { statSync } from 'fs';

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
// Shared runner helpers
// ---------------------------------------------------------------------------

/**
 * Env keys every runner forwards to its agent subprocess. Runners compose
 * `[...BASE_ENV_ALLOWLIST, ...delta]` instead of duplicating the list — the
 * allowlist (not a denylist) is the leak barrier: anything not named here
 * never reaches the agent.
 *
 * GBRAIN_DATABASE_URL is deliberately ABSENT (removed in the hermes-harness
 * wave's adversarial review): live mode's staging + success oracle operate on
 * the hermetic PGLite under GBRAIN_HOME=tempdir, and an inherited
 * GBRAIN_DATABASE_URL would flip only the AGENT's gbrain children to the
 * operator's real Postgres — polluting the real brain while the oracle probes
 * the untouched PGLite and fails with a misleading verdict.
 */
export const BASE_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LANG', 'TZ', 'NODE_ENV',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GBRAIN_HOME', 'GBRAIN_FRICTION_RUN_ID',
  // Proxy plumbing (both spellings — Node reads upper, Python/curl read
  // lower): an operator behind a corporate proxy runs their agent through
  // these, and dropping them turns live mode into a misleading network
  // failure blamed on the agent.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
] as const;

/**
 * Validate a *_BIN env override: must be absolute, free of `..` segments, and
 * free of shell-active characters. The value is interpolated into generated
 * sh shim scripts (single-quoted), so quotes/backslashes/dollar/backtick or a
 * newline would break out of the quoting and become code — reject them
 * outright rather than trying to escape. Spaces are fine (quoted).
 * Returns an error string (naming the env var) or null when valid.
 */
export function validateBinPathEnv(envName: string, p: string): string | null {
  if (!p.startsWith('/')) return `${envName} must be absolute; got ${p}`;
  if (p.split('/').includes('..')) return `${envName} must not contain '..' segments; got ${p}`;
  if (/['"`$\\\n\r]/.test(p)) return `${envName} must not contain quotes, backslashes, dollar signs, backticks, or newlines; got ${p}`;
  return null;
}

/**
 * Shared binary resolution for runners: `$<envName>` (validated) > `which
 * <binName>` > unavailable, then a regular-file + executable-bit stat. The
 * three runners previously carried byte-identical copies of this body; the
 * extraction is behavior-preserving (same reason strings, same ordering).
 */
export function detectBinary(envName: string, binName: string): DetectResult {
  const fromEnv = process.env[envName]?.trim();
  let binPath: string | undefined;

  if (fromEnv) {
    const validation = validateBinPathEnv(envName, fromEnv);
    if (validation) return { available: false, reason: validation };
    binPath = fromEnv;
  } else {
    try {
      // execFileSync, not a shell string: binName comes from callers today
      // (constants), but this helper is exported — interpolating it into a
      // shell would make a future metachar-bearing name become code.
      const out = execFileSync('which', [binName], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const found = out.trim();
      if (!found || !found.startsWith('/')) {
        return { available: false, reason: `${binName} not on PATH` };
      }
      binPath = found;
    } catch {
      return { available: false, reason: `${binName} not on PATH` };
    }
  }

  if (!binPath) return { available: false, reason: 'no binary resolved' };

  try {
    const s = statSync(binPath);
    if (!s.isFile()) return { available: false, reason: `not a regular file: ${binPath}` };
    // eslint-disable-next-line no-bitwise
    if (!(s.mode & 0o111)) return { available: false, reason: `not executable: ${binPath}` };
  } catch (e) {
    return { available: false, reason: `stat failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  return { available: true, binPath };
}

/**
 * Build the child env for a runner spawn: process.env filtered to the
 * runner's allowlist, then caller overrides merged on top (overrides win —
 * the live lane's PATH-shim prepend depends on this precedence).
 */
export function filterAllowlistEnv(
  allowlist: readonly string[],
  overrides: Record<string, string>,
): Record<string, string> {
  const baseEnv: Record<string, string> = {};
  for (const key of allowlist) {
    const v = process.env[key];
    if (typeof v === 'string') baseEnv[key] = v;
  }
  return { ...baseEnv, ...overrides };
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
