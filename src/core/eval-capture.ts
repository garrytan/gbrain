/**
 * Op-layer capture wrapper (v0.21.0).
 *
 * Catches MCP + CLI + subagent tool-bridge traffic from a single site —
 * the `query` and `search` op handlers in src/core/operations.ts decorate
 * themselves with `captureEvalCandidate` before they run. Post-codex O1+O2
 * design: the MCP server used to be the capture site, but subagent tool
 * calls dispatch straight to op.handler via brain-allowlist.ts and would
 * have been invisible. Moving the hook to the op layer covers every caller.
 *
 * Best-effort, not await'd by the caller. Every failure is routed through
 * `engine.logEvalCaptureFailure(reason)` so `gbrain doctor` can see drops
 * cross-process (in-process counters would be invisible from doctor's
 * separate process).
 *
 * Data-flow (happy path):
 *
 *   op.handler() ──▶ {results, meta}
 *                         │
 *                 (fire-and-forget from caller)
 *                         ▼
 *               outer try / inner .catch
 *                         │
 *                         ▼
 *                  scrubPii(query)
 *                         │
 *                         ▼
 *             buildEvalCandidateInput(...)
 *                         │
 *                         ▼
 *               engine.logEvalCandidate(input)
 *
 * Every error path — scrub throw, build throw, INSERT reject — lands at
 * `logEvalCaptureFailure(reason)` with the right reason tag.
 */

import type { BrainEngine } from './engine.ts';
import type {
  EvalCandidateInput,
  EvalCaptureFailureReason,
  EvalCaptureToolName,
  HybridSearchMeta,
  SearchResult,
} from './types.ts';
import type { GBrainConfig } from './config.ts';
import { scrubPii, scrubPiiObject } from './eval-capture-scrub.ts';

// HybridSearchMeta is canonical in src/core/types.ts and exported via the
// public `gbrain/types` subpath. Surfaced from hybridSearch via the
// optional onMeta callback in HybridSearchOpts (Lane 1C).
export type { HybridSearchMeta };

export interface CaptureContext {
  tool_name: 'query' | 'search';
  query: string;
  results: SearchResult[];
  meta: HybridSearchMeta;
  latency_ms: number;
  remote: boolean;
  expand_enabled: boolean | null;
  detail: 'low' | 'medium' | 'high' | null;
  job_id: number | null;
  subagent_id: number | null;
  mcp_token_name?: string | null;
}

export interface ReadAuditContext {
  tool_name: Exclude<EvalCaptureToolName, 'query' | 'search'>;
  query: string;
  params: Record<string, unknown>;
  retrieved_slugs: string[];
  retrieved_chunk_ids?: number[];
  source_ids?: string[];
  latency_ms: number;
  remote: boolean;
  job_id: number | null;
  subagent_id: number | null;
  mcp_token_name?: string | null;
}

/**
 * Build the insert row for `eval_candidates` from a capture context.
 *
 * Runs the PII scrubber on `query` unless `scrub_pii === false`. Pure
 * function: throws only if the scrubber throws (caller wraps in try/catch).
 *
 * Exported for testing and for CLI backfill paths; the hot-path caller is
 * `captureEvalCandidate` below.
 */
export function buildEvalCandidateInput(
  ctx: CaptureContext,
  opts: { scrub_pii?: boolean } = {},
): EvalCandidateInput {
  const shouldScrub = opts.scrub_pii !== false;
  const query = shouldScrub ? scrubPii(ctx.query) : ctx.query;

  // Deduplicate + preserve order for slug + source_id extraction.
  // Both arrays are small (hybridSearch clamps at 100 results) so the
  // O(n) Set-based dedup is fine.
  const slugsSet = new Set<string>();
  const sourceSet = new Set<string>();
  const chunkIds: number[] = [];
  for (const r of ctx.results) {
    slugsSet.add(r.slug);
    if (r.source_id) sourceSet.add(r.source_id);
    chunkIds.push(r.chunk_id);
  }

  return {
    tool_name: ctx.tool_name,
    query,
    params_jsonb: {},
    retrieved_slugs: [...slugsSet],
    retrieved_chunk_ids: chunkIds,
    source_ids: [...sourceSet],
    expand_enabled: ctx.expand_enabled,
    detail: ctx.detail,
    detail_resolved: ctx.meta.detail_resolved,
    vector_enabled: ctx.meta.vector_enabled,
    expansion_applied: ctx.meta.expansion_applied,
    latency_ms: ctx.latency_ms,
    remote: ctx.remote,
    job_id: ctx.job_id,
    subagent_id: ctx.subagent_id,
    mcp_token_name: ctx.mcp_token_name ?? null,
  };
}

export function buildReadAuditInput(
  ctx: ReadAuditContext,
  opts: { scrub_pii?: boolean } = {},
): EvalCandidateInput {
  const shouldScrub = opts.scrub_pii !== false;
  const query = shouldScrub ? scrubPii(ctx.query) : ctx.query;
  const params = shouldScrub
    ? (scrubPiiObject(ctx.params) as Record<string, unknown>)
    : ctx.params;
  const slugsSet = new Set<string>();
  for (const s of ctx.retrieved_slugs) slugsSet.add(s);
  return {
    tool_name: ctx.tool_name,
    query,
    params_jsonb: params,
    retrieved_slugs: [...slugsSet],
    retrieved_chunk_ids: ctx.retrieved_chunk_ids ?? [],
    source_ids: ctx.source_ids ?? [],
    expand_enabled: null,
    detail: null,
    detail_resolved: null,
    vector_enabled: false,
    expansion_applied: false,
    latency_ms: ctx.latency_ms,
    remote: ctx.remote,
    job_id: ctx.job_id,
    subagent_id: ctx.subagent_id,
    mcp_token_name: ctx.mcp_token_name ?? null,
  };
}

/**
 * Map a caught error to an `EvalCaptureFailureReason` so doctor can
 * group failures by cause (DB down vs RLS reject vs CHECK violation).
 *
 * Narrow by Postgres SQLSTATE where we can (postgres-js + PGLite both
 * surface `.code`), fall back to 'other'.
 */
export function classifyCaptureFailure(err: unknown): EvalCaptureFailureReason {
  if (err && typeof err === 'object') {
    const code = (err as { code?: string }).code;
    if (code === '23514') return 'check_violation'; // CHECK constraint violation
    if (code === '42501') return 'rls_reject';      // insufficient_privilege
    if (code === '42P01') return 'db_down';          // undefined_table (pre-v25)
    if (code === '53300' || code === '08006' || code === '08003') return 'db_down';
    const name = (err as { name?: string }).name;
    if (name === 'RegExpMatchError' || name === 'SyntaxError') {
      return 'scrubber_exception';
    }
  }
  return 'other';
}

/**
 * Fire-and-forget capture side-effect. Never throws: every failure is
 * swallowed, classified, and routed through `engine.logEvalCaptureFailure`
 * (itself wrapped — failure-of-failure is logged to stderr and dropped).
 *
 * Callers invoke as `void captureEvalCandidate(...)` — we explicitly do
 * NOT await so the op response latency is unaffected.
 */
export async function captureEvalCandidate(
  engine: BrainEngine,
  ctx: CaptureContext,
  opts: { scrub_pii?: boolean } = {},
): Promise<void> {
  try {
    const input = buildEvalCandidateInput(ctx, opts);
    await engine.logEvalCandidate(input);
  } catch (err) {
    const reason = classifyCaptureFailure(err);
    try {
      await engine.logEvalCaptureFailure(reason);
    } catch (failureErr) {
      // eslint-disable-next-line no-console
      console.warn('[eval-capture] secondary failure logging also failed:', failureErr);
    }
  }
}

export async function captureReadAudit(
  engine: BrainEngine,
  ctx: ReadAuditContext,
  opts: { scrub_pii?: boolean } = {},
): Promise<void> {
  try {
    const input = buildReadAuditInput(ctx, opts);
    await engine.logEvalCandidate(input);
  } catch (err) {
    const reason = classifyCaptureFailure(err);
    try {
      await engine.logEvalCaptureFailure(reason);
    } catch (failureErr) {
      // eslint-disable-next-line no-console
      console.warn('[eval-capture] secondary failure logging also failed:', failureErr);
    }
  }
}

/**
 * Check whether capture is enabled for this process.
 *
 * Resolution order:
 *   1. `config.eval.capture === true`  → on (explicit user opt-in wins)
 *   2. `config.eval.capture === false` → off (explicit user opt-out wins)
 *   3. `process.env.GBRAIN_CONTRIBUTOR_MODE === '1'` → on (contributor opt-in)
 *   4. otherwise → off (default-off, privacy-positive for end users)
 *
 * The default flipped in v0.25.0 from "on for everyone" to "off unless you
 * opt in." Capturing every query a real user runs without their consent is
 * a footgun even with PII scrubbing; tying capture to CONTRIBUTOR_MODE makes
 * the developer-skill nature of the feature explicit. Production users get
 * a quiet brain; contributors get the BrainBench-Real replay loop with one
 * shell rc line. See docs/eval-bench.md and CONTRIBUTING.md.
 *
 * Takes the already-loaded config so callers control the loadConfig()
 * lifecycle (MCP server loads once at boot, CLI commands load per-invocation).
 */
export function isEvalCaptureEnabled(config: GBrainConfig | null | undefined): boolean {
  if (config?.eval?.capture === true) return true;
  if (config?.eval?.capture === false) return false;
  return process.env.GBRAIN_CONTRIBUTOR_MODE === '1';
}

export function isReadAuditEnabled(config: GBrainConfig | null | undefined): boolean {
  if (config?.audit?.reads === true) return true;
  if (config?.audit?.reads === false) return false;
  if (process.env.GBRAIN_AUDIT_READS === '1') return true;
  if (process.env.GBRAIN_AUDIT_READS === '0') return false;
  return false;
}

/**
 * PII scrubbing enabled? Defaults to true; explicit `false` opts out.
 *
 * Independent of `isEvalCaptureEnabled` — scrubbing only matters when capture
 * is actually running, but the gate stays separate so CONTRIBUTOR_MODE
 * doesn't accidentally turn off scrubbing on a brain that happens to also
 * have explicit `capture: true`.
 */
export function isEvalScrubEnabled(config: GBrainConfig | null | undefined): boolean {
  return config?.eval?.scrub_pii !== false;
}
