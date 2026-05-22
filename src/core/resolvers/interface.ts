/**
 * Resolver SDK — typed interface for external lookups.
 *
 * A Resolver takes a structured input, hits some backend (X API, Perplexity,
 * URL HEAD check, local brain lookup, LLM extraction), and returns a
 * ResolverResult with confidence + provenance.
 *
 * Design rules enforced by the type system:
 *   - Every result carries confidence (0.0-1.0) and source attribution.
 *   - LLM-backed resolvers return confidence < 1.0 by convention; deterministic
 *     backends (brain-local, direct API match) return 1.0.
 *   - `raw` preserves the full upstream response for put_raw_data sidecars.
 *
 * Sync-by-default. ScheduledResolver (later PR) layers cron/idempotency/retry
 * on top via Minions. Read-only lookups do not pay queue latency.
 */

import type { BrainEngine } from '../engine.ts';
import type { StorageBackend } from '../storage.ts';

// ---------------------------------------------------------------------------
// Cost tiers
// ---------------------------------------------------------------------------

export type ResolverCost = 'free' | 'rate-limited' | 'paid';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ResolverResult<O> {
  value: O;
  /**
   * 0.0-1.0. 1.0 = deterministic ground truth (direct API response, brain-local
   * slug lookup). <1.0 = inferred (LLM extraction, fuzzy match, heuristic).
   * Callers use this to gate auto-writes (e.g., gbrain integrity --auto only
   * applies confidence >= threshold).
   */
  confidence: number;
  /** Stable identifier for the backend, e.g. "x-api-v2", "brain-local", "head-check". */
  source: string;
  fetchedAt: Date;
  /** Estimated dollar cost of this call. 0 for free/rate-limited backends. */
  costEstimate?: number;
  /** Full upstream response, for put_raw_data sidecar preservation. Unused if empty. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Context — flows through every resolve() call
// ---------------------------------------------------------------------------

export interface ResolverLogger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Propagated through every Resolver.resolve() call. Most fields are optional
 * in Phase 1; they get wired in as later PRs land (budget from PR 4, metrics
 * from PR 0 addenda, scheduler from PR 5).
 */
export interface ResolverContext {
  /** Optional: resolvers that read the brain (slug-lookup, completeness) need this. */
  engine?: BrainEngine;
  /** Optional: resolvers that read/write files need this. */
  storage?: StorageBackend;
  /** Key-value config passed through gbrain config + env. Resolvers read what they need. */
  config: Record<string, unknown>;
  logger: ResolverLogger;
  /** Unique id per top-level caller, propagated into raw logs for audit. */
  requestId: string;
  /**
   * Trust boundary. True = untrusted caller (MCP, HTTP). Resolvers that write
   * or enumerate sensitive paths MUST tighten behavior when remote=true.
   * This mirrors OperationContext.remote and feeds into every security gate
   * (SSRF, path traversal, auto-link skip).
   */
  remote: boolean;
  /** Hard deadline for the whole resolve chain. Resolvers should respect it. */
  deadline?: Date;
  /**
   * Abort token. Propagates through FailImproveLoop into fetch() / DB calls.
   * Aborting mid-resolve throws ResolverError with code='aborted'.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ResolverRequest<I> {
  input: I;
  context: ResolverContext;
  /** Per-call timeout override. Falls back to ctx.deadline, then resolver default. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Resolver interface
// ---------------------------------------------------------------------------

/**
 * A Resolver maps typed input to a ResolverResult. Implementations live under
 * src/core/resolvers/builtin/ (embedded) or are registered at runtime via the
 * plugin contract (later PR).
 */
export interface Resolver<I, O> {
  /** Stable id, slug-cased. e.g. "x_handle_to_tweet", "url_reachable". Used for registry + metrics. */
  readonly id: string;
  readonly cost: ResolverCost;
  /** Backend label — "x-api-v2", "perplexity", "brain-local", "head-check", etc. */
  readonly backend: string;
  /** Optional description for `gbrain resolvers list`. */
  readonly description?: string;
  /** Optional JSON Schema (loose Record) for input validation. Caller may inspect. */
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;

  /**
   * Can this resolver run in the given context? Typically checks env vars,
   * DB connectivity, or config flags. Registry.resolve() calls this before
   * invoking resolve() — an unavailable resolver throws ResolverUnavailable.
   */
  available(ctx: ResolverContext): Promise<boolean>;

  resolve(req: ResolverRequest<I>): Promise<ResolverResult<O>>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResolverErrorCode =
  | 'not_found'       // registry.get on unknown id
  | 'already_registered'
  | 'unavailable'     // available() returned false
  | 'timeout'
  | 'rate_limited'
  | 'auth'            // API rejected credentials
  | 'schema'          // malformed response / schema validation failed
  | 'aborted'         // AbortSignal fired
  | 'upstream';       // generic upstream failure (network, 5xx)

export class ResolverError extends Error {
  constructor(
    public code: ResolverErrorCode,
    message: string,
    public resolverId?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'ResolverError';
  }
}
