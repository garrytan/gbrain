/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, enforceBoundClientOpAllowList } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERB_NAMES, MEMORY_VERBS_VERSION } from '../core/verbs.ts';
import { logVerbUsage } from '../core/verbs/usage-log.ts';
import { sourceGuardBlocksWrite } from '../core/source-resolver.ts';
import { suggestNearest } from '../core/levenshtein.ts';
import {
  normalizeOptionalParams,
  validateParams,
  findUnknownParams,
  buildUnknownParamWarnBlock,
  resolveStrictParamsMode,
} from './validate-params.ts';

// WP3: normalization + validation moved to validate-params.ts (direct unit
// surface). Re-exported here so existing imports/tests keep working.
export { normalizeOptionalParams, validateParams } from './validate-params.ts';

const VERB_NAME_SET: ReadonlySet<string> = new Set(VERB_NAMES);

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Existing clients ignore unknown `_meta` fields; capable clients (Claude
   * Code, Claude Desktop) read it. NOT a wrapper around the result body —
   * `content` stays the same shape it always had. Best-effort: any error in
   * the meta hook is absorbed and the tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Defaults to true (remote/untrusted). Local CLI callers (`gbrain call`) pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
  /**
   * #1061: transport marker for auth-less remote surfaces. The stdio MCP
   * server passes 'stdio' so identity ops (whoami) can report the transport
   * instead of throwing unknown_transport. Never used for TRUST decisions
   * (that is `remote`), but it IS the transport-LOCALITY axis: localOnly
   * ops dispatch only when this is 'stdio' (WP1/D7) — HTTP transports pass
   * 'http', and an unset marker is treated as non-local, fail-closed.
   */
  transport?: OperationContext['transport'];
  /**
   * v0.28: per-token allow-list for the takes.holder field. Threaded by
   * the HTTP/stdio transport from `access_tokens.permissions.takes_holders`.
   * When set, takes_list / takes_search / query (when it returns takes)
   * MUST filter `WHERE holder = ANY($takesHoldersAllowList)`. Local CLI
   * callers leave this unset (no filter — they own the brain).
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.31 (eD4): tenancy axis for facts hot memory ops (extract_facts,
   * recall, forget_fact). When set, the OperationContext receives a
   * matching `sourceId`. CLI dispatch resolves this from --source flag /
   * GBRAIN_SOURCE / .gbrain-source / 'default'; HTTP MCP transport
   * resolves it from the per-token allow-list (eE3).
   */
  sourceId?: string;
  /**
   * #3242: federated read set for callers with NO explicit source scope
   * (stdio without GBRAIN_SOURCE; legacy HTTP tokens without an operator-set
   * `permissions.source_id` grant). Transport-computed, never derived from
   * caller params. See OperationContext.localFederatedSourceIds.
   */
  localFederatedSourceIds?: string[];
  /**
   * `gbrain serve --source-guard` (plugin lanes): when set, write/admin ops
   * are blocked unless the source resolution tier proves the binding is
   * deliberate or unambiguous (see WRITE_SAFE_SOURCE_TIERS in
   * source-resolver.ts). The transport passes the tier that WON the
   * resolution for this call; unset means the guard is off (default —
   * existing serves are untouched). Reads always pass.
   */
  sourceGuardTier?: import('../core/source-resolver.ts').SourceTier;
  /**
   * CX2-11: opaque session identity resolved by the transport (e.g. from the
   * MCP request-level `_meta.session_id`). Clamped to 256 chars before it
   * reaches OperationContext. When unset, buildOperationContext falls back to
   * a `_meta.session_id` carried INSIDE the tool arguments (some clients put
   * it there). Cache/telemetry identity only — never a trust surface.
   */
  sessionId?: string;
  /**
   * v0.31 (eD3): hook called by the dispatcher AFTER op.handler succeeds
   * to compute `_meta.brain_hot_memory` for the response. Wrapped in its
   * own try/catch (eE4) so a DB blip in the helper degrades to no _meta
   * rather than flipping the whole tool call to error.
   *
   * Returning undefined means "no _meta to inject"; the dispatcher
   * preserves the existing response shape.
   */
  metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * OAuth auth info threaded through from the HTTP MCP transport. Set so
   * the whoami op (and any future scope-aware op handlers) can introspect
   * the calling identity. Without this, every whoami call from HTTP
   * transports throws unknown_transport — the v0.31 D12 / eE1 refactor
   * silently dropped this field when the inlined OperationContext literal
   * was replaced by dispatchToolCall.
   */
  auth?: AuthInfo;
  /**
   * MEMORY_VERBS v1 surface enforcement [c2]. When set, a tool name outside
   * the set returns the unknown_tool envelope BEFORE resolution — fail-closed
   * at the SHARED layer, so a hidden op stays uncallable on every transport
   * even when only the tool LIST was filtered. Unset = full catalog
   * (pre-existing behavior, all current callers).
   */
  allowedOps?: ReadonlySet<string>;
  /**
   * Which surface this transport is serving — recorded on the verb usage
   * sidecar so adoption stats can split quickstart installs from full
   * surfaces. Defaults to 'full'. On the OAuth HTTP transport this is the
   * per-request EFFECTIVE surface (D2 ceiling resolution, recomputed per
   * request — amendment 20).
   */
  surface?: 'verbs' | 'starter' | 'full';
  /**
   * WP4 (D2): the SERVER surface ceiling for this transport (force-clamped),
   * threaded into `OperationContext.surfaceCeiling` for the request_tools
   * meta-op — its catalog never names ops above the ceiling and its persist
   * branch rejects widening past it. Unset (local CLI / direct dispatch) is
   * treated as 'full'.
   */
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
}

/**
 * Build a privacy-safe summary of MCP request params for logging + the admin
 * SSE feed.
 *
 * The previous default of `JSON.stringify(params)` wrote raw payloads —
 * page bodies, search queries, file paths — into `mcp_request_log` and
 * broadcast them to every connected admin browser. For a personal-knowledge
 * brain those payloads include private notes about real people / deals /
 * companies, retained indefinitely.
 *
 * The redactor returns the SHAPE of the request (what op was called, which
 * declared params were passed, approximate size) without any of the values.
 *
 * Hardening note (codex C8): a naive "dump all submitted keys" summary still
 * leaks via attacker-controlled key names — a caller can submit
 * `put_page {"wiki/people/sensitive_name": "..."}` and the key becomes a
 * persistent log entry. To prevent this, we intersect submitted keys
 * against the operation's declared `params` allow-list (the same definition
 * `validateParams` reads). Anything outside the allow-list is counted but
 * not named.
 *
 * Operators who want full payloads for debugging set `--log-full-params` on
 * `gbrain serve --http`; that path bypasses this helper and writes the raw
 * JSON, with a loud startup warning.
 */
export interface ParamSummary {
  redacted: true;
  kind: 'array' | 'object' | string;
  declared_keys?: string[];
  unknown_key_count?: number;
  length?: number;
  approx_bytes?: number;
}

/**
 * Round a byte count UP to the nearest 1KB so the redacted summary keeps a
 * coarse size signal without enabling a size-based side channel.
 *
 * Why bucketing matters: the previous shape published `approx_bytes` as the
 * exact JSON.stringify(params).length. An attacker who can submit
 * `put_page` with a known prefix and observe the resulting log entry
 * could binary-search the byte length of secret content (the body the
 * legitimate user just wrote) via repeated probes. Bucketing to 1KB
 * resolution destroys that channel while preserving the operator-useful
 * "roughly how large was the request" signal.
 */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

export function summarizeMcpParams(opName: string, params: unknown): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try { approxBytes = bucketBytes(JSON.stringify(params).length); } catch { approxBytes = undefined; }

  if (Array.isArray(params)) {
    return {
      redacted: true,
      kind: 'array',
      length: params.length,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  if (typeof params === 'object') {
    const submittedKeys = Object.keys(params as Record<string, unknown>);
    const op = operations.find(o => o.name === opName);
    const allowList = op ? new Set(Object.keys(op.params)) : new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of submittedKeys) {
      if (allowList.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: 'object',
      declared_keys: declared,
      unknown_key_count: unknown,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  return {
    redacted: true,
    kind: typeof params,
    ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
  };
}

/**
 * D8: render the second (model-visible) content block for an empty retrieval
 * result from the handler-emitted `retrieval` meta. Returns null when the
 * meta doesn't carry the expected shape — the block is best-effort loudness,
 * never a failure source. Reason codes come from the closed degradation
 * vocabulary (D6); raw exception text never reaches this string.
 */
export function buildEmptyRetrievalBlock(retrieval: unknown): string | null {
  if (retrieval === null || typeof retrieval !== 'object') return null;
  const r = retrieval as {
    retrieved_count?: number;
    degraded?: Array<{ stage?: string; reason?: string }>;
    hint?: string;
  };
  const parts: string[] = ['0 results.'];
  if (typeof r.retrieved_count === 'number') parts.push(`retrieved ${r.retrieved_count} before trimming.`);
  const stages = (r.degraded ?? [])
    .map(d => d?.stage)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  parts.push(stages.length > 0
    ? `degraded: ${[...new Set(stages)].join(', ')}.`
    : 'no retrieval degradation — this is a clean miss.');
  if (typeof r.hint === 'string' && r.hint.length > 0) parts.push(`hint: ${r.hint}`);
  return parts.join(' ');
}

/**
 * Amendment 33 / D10 — honest-catalog metric classifier. True when a parsed
 * error envelope is an OP-LEVEL denial the tools/list filter SHOULD have
 * prevented (the same predicates gate list and call time, so in a correct
 * world these trend to zero):
 *   - publish-gate call-time backstop (`detail: 'config_key=...'` — WP1's
 *     machine-readable denial grammar)
 *   - bound-client fence OP-level deny (`detail: 'fence=op'` —
 *     enforceBoundClientOpAllowList; the tools/list filter consumes the
 *     identical predicate, ENG-3)
 *
 * Argument-level fence denials (slug-prefix rejections inside handlers) are
 * legitimate for a LISTED op and deliberately excluded (D10) — they carry no
 * marker. serve-http logs matching rows with status='denied_after_list' so
 * `SELECT count(*) FROM mcp_request_log WHERE status='denied_after_list'`
 * is the wave's trend-to-zero working metric (the scope-deny path in
 * serve-http is the third list-level class; it logs the status directly).
 */
export function isListLevelDenialEnvelope(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') return false;
  const p = parsed as { error?: unknown; detail?: unknown };
  if (p.error !== 'permission_denied') return false;
  if (typeof p.detail !== 'string') return false;
  return p.detail.startsWith('config_key=') || p.detail === 'fence=op';
}

/** The mcp_request_log status classes a dispatched tool result maps onto. */
export type RequestLogStatus = 'success' | 'success_with_warnings' | 'denied_after_list' | 'error';

/**
 * The ONE `mcp_request_log.status` decision for a dispatched tool result
 * (serve-http's tools/call persistence + SSE broadcast both consume this):
 *   - errors whose envelope is a list-level denial (isListLevelDenialEnvelope
 *     above) → 'denied_after_list' (amendment 33 / D10 trend-to-zero metric);
 *     other errors (including unparseable content) → 'error';
 *   - successes whose `_meta.warnings` is a non-empty array →
 *     'success_with_warnings' (WP3 amendment 13 warn-mode observability;
 *     warn CONTENTS are never logged); otherwise → 'success'.
 * The scope-deny and unknown-op paths in serve-http log their statuses
 * directly — they never produce a ToolResult through the dispatcher.
 */
export function requestLogStatusForResult(result: ToolResult): RequestLogStatus {
  if (result.isError) {
    try {
      const parsed: unknown = JSON.parse(result.content[0]?.text ?? '{}');
      if (isListLevelDenialEnvelope(parsed)) return 'denied_after_list';
    } catch { /* unparseable error content stays plain 'error' */ }
    return 'error';
  }
  const warnings = result._meta?.warnings;
  return Array.isArray(warnings) && warnings.length > 0 ? 'success_with_warnings' : 'success';
}

/**
 * WP3: the ONE unknown_tool envelope builder, shared by all three deny paths
 * (surface-hidden via allowedOps, nonexistent op, localOnly over a network
 * transport) so they stay byte-identical for the same input name — a hidden
 * op must remain indistinguishable from a nonexistent one.
 *
 * The did-you-mean candidates are the caller's VISIBLE surface only
 * (amendment 11): (allowedOps if set, else the full catalog) MINUS localOnly
 * ops MINUS publish-gated ops. Gated names are excluded unconditionally —
 * gate state is unknown here, and a suggestion naming a hidden/gated op
 * would be the exact existence oracle this envelope exists to prevent.
 */
function unknownToolEnvelope(name: string, allowedOps?: ReadonlySet<string>): ToolResult {
  const candidates = operations
    .filter(op => !op.localOnly && !op.publishGateKey && (allowedOps ? allowedOps.has(op.name) : true))
    .map(op => op.name);
  const nearest = suggestNearest(name, candidates);
  const envelope = {
    error: 'unknown_tool',
    message: `Unknown tool: ${name}`,
    ...(nearest ? { suggestion: `Did you mean "${nearest}"?` } : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

/** CX2-11: clamp an opaque session id to 256 chars (cache-key hygiene). */
const SESSION_ID_MAX_CHARS = 256;

/**
 * Read `_meta.session_id` out of the tool arguments when present. The MCP
 * spec carries `_meta` as a sibling of `arguments`, but several clients (and
 * proxies) fold it into the arguments object — this is the dispatch-level
 * fallback for those. Non-string / empty values are ignored.
 */
function metaSessionIdFrom(params: Record<string, unknown>): string | undefined {
  const meta = params._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const sid = (meta as Record<string, unknown>).session_id;
    if (typeof sid === 'string' && sid.length > 0) return sid.slice(0, SESSION_ID_MAX_CHARS);
  }
  return undefined;
}

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  // CX2-11: transport-resolved session id wins; arguments-level _meta is the
  // fallback. Both clamped. Typed field — the meta-hook cache key reads it.
  const sessionId =
    (typeof opts.sessionId === 'string' && opts.sessionId.length > 0
      ? opts.sessionId.slice(0, SESSION_ID_MAX_CHARS)
      : undefined) ?? metaSessionIdFrom(params);
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote: opts.remote ?? true,
    transport: opts.transport,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    // v0.34 D4: sourceId is REQUIRED at the type level. Auto-fill 'default'
    // for single-source brains and any caller who didn't resolve a sourceId.
    // CLI / HTTP / stdio transports SHOULD pass an explicit sourceId via opts;
    // this fallback covers code paths that historically passed undefined.
    sourceId: opts.sourceId ?? 'default',
    ...(sessionId ? { sessionId } : {}),
    ...(opts.localFederatedSourceIds ? { localFederatedSourceIds: opts.localFederatedSourceIds } : {}),
    ...(opts.surfaceCeiling ? { surfaceCeiling: opts.surfaceCeiling } : {}),
    auth: opts.auth,
  };
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const startedMs = Date.now();
  const isVerb = VERB_NAME_SET.has(name);
  // [c11] dispatch-layer usage sidecar for the five verbs — counts validation
  // failures too. Fire-and-forget; never awaited, never throws.
  const logVerb = (ok: boolean, extra?: { budget_dropped?: number; entity_found?: boolean }) => {
    if (!isVerb) return;
    logVerbUsage({
      verb: name,
      surface: opts.surface ?? 'full',
      remote: opts.remote ?? true,
      ok,
      latency_ms: Date.now() - startedMs,
      source_id: opts.sourceId ?? 'default',
      ...(extra ?? {}),
    });
  };

  // [c2] surface enforcement at the SHARED layer: a hidden op is uncallable
  // on every transport, not just unlisted. Same envelope as unknown ops so
  // the surface doesn't leak which names exist.
  if (opts.allowedOps && !opts.allowedOps.has(name)) {
    return unknownToolEnvelope(name, opts.allowedOps);
  }

  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    return unknownToolEnvelope(name, opts.allowedOps);
  }

  // localOnly backstop at the SHARED layer (WP1/D7): localOnly ops reach the
  // operator's filesystem, so they dispatch only on the local stdio pipe.
  // Any non-stdio transport — both HTTP servers, and any future caller that
  // forgets to mark its transport — is denied fail-closed. Same envelope as
  // a nonexistent op so the catalog doesn't leak which names exist. The
  // serve-http path also filters these at list time; the legacy bearer
  // transport at surface 'full' had no gate at all before this line.
  if (op.localOnly && opts.transport !== 'stdio') {
    return unknownToolEnvelope(name, opts.allowedOps);
  }

  // --source-guard (plugin lanes): fail-closed write routing. A user-global
  // plugin serve has no per-workspace source binding, so an ambient-tier
  // resolution must not be allowed to WRITE into whatever source it happened
  // to fall through to. Enforced before validation so a blocked caller
  // learns the routing rule, not the op's parameter shape.
  if (opts.sourceGuardTier && op.scope !== 'read') {
    // The `__all__` read-span sentinel can never be a valid WRITE target (no
    // source has that id — the write would die downstream on the FK). Under
    // the guard, block it with a sentinel-specific hint rather than the
    // generic ambiguity copy. This is independent of the tier probe below.
    const sentinelWrite = opts.sourceId === '__all__';
    if (sentinelWrite || (await sourceGuardBlocksWrite(engine, opts.sourceGuardTier))) {
      logVerb(false);
      const envelope = {
        error: 'source_binding_required',
        message: sentinelWrite
          ? 'GBRAIN_SOURCE=__all__ is a read-span sentinel, not a write target — a write cannot resolve to "all sources". ' +
            'Set GBRAIN_SOURCE to a concrete source id for writes.'
          : 'This brain has more than one source to choose from and the MCP server runs with --source-guard: ' +
          `write/admin operations need an explicit source binding so they cannot land in the wrong source (resolution tier: ${opts.sourceGuardTier}).`,
        suggestion:
          'Set GBRAIN_SOURCE=<source-id> in the environment that launches this MCP server ' +
          '(plugin installs pass it through — the user-global stdio serve binds the source from the env, not a flag). ' +
          'List sources with `gbrain sources list`. Reads are unaffected.',
        ...(isVerb ? { protocol_version: MEMORY_VERBS_VERSION } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        isError: true,
      };
    }
  }

  const safeParams = normalizeOptionalParams(op, params || {});
  const validationError = validateParams(op, safeParams);
  if (validationError) {
    logVerb(false);
    // [c7] verb validation errors speak the protocol envelope (suggestion +
    // protocol_version); non-verb ops keep the pre-existing shape untouched.
    const envelope = isVerb
      ? {
          error: 'invalid_params',
          message: validationError,
          suggestion: 'Check the tool schema — required params and types are declared there.',
          protocol_version: MEMORY_VERBS_VERSION,
        }
      : { error: 'invalid_params', message: validationError };
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      isError: true,
    };
  }

  // WP3 strict/warn unknown-argument validation. Runs on the NORMALIZED
  // object (a null/'' optional idiom is never an unknown key). `_meta` and
  // `dry_run` are allowlisted inside findUnknownParams. The mode resolves
  // dual-plane (DB > file > 'warn') once per dispatch, and only when an
  // unknown key actually exists — the all-declared common case pays no
  // config read.
  const unknownParamWarnings = findUnknownParams(op, safeParams);
  if (unknownParamWarnings.length > 0) {
    const strictMode = await resolveStrictParamsMode(engine, loadConfig());
    if (strictMode === 'reject') {
      logVerb(false);
      // Privacy (amendment 11): the raw unknown key rides `suggestion` ONLY.
      // serve-http persists the envelope's `message` into
      // mcp_request_log.error_message — the message therefore counts, never
      // names (same posture as the redacted params summarizer).
      const n = unknownParamWarnings.length;
      const suggestion = unknownParamWarnings
        .map(w => w.suggestion
          ? `Unknown parameter "${w.param}" — did you mean "${w.suggestion}"?`
          : `Unknown parameter "${w.param}".`)
        .join(' ');
      const envelope = {
        error: 'invalid_params',
        message: `${n} unknown parameter${n === 1 ? '' : 's'} not declared in the ${name} tool schema (mcp.strict_params=reject). See suggestion for the submitted name${n === 1 ? '' : 's'}.`,
        suggestion,
        ...(isVerb ? { protocol_version: MEMORY_VERBS_VERSION } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        isError: true,
      };
    }
  }

  // Remote callers must arrive with a resolved source scope. Every shipped
  // transport passes sourceId explicitly (serve-http from the OAuth client
  // row, http-transport from the legacy token grant, stdio from
  // GBRAIN_SOURCE); a remote call reaching the 'default' fallback means a
  // programmatic caller skipped scope resolution, and silently landing in
  // the shared 'default' source is the cross-source leak class behind
  // #1924 / #1371. Trusted local callers (remote === false) keep the
  // historical fallback via buildOperationContext.
  if ((opts.remote ?? true) && !opts.sourceId) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'missing_source_scope', message: `Remote tool call '${name}' carries no resolved sourceId; refusing the shared 'default' source fallback. Pass an explicit sourceId resolved from the caller's grant.` }, null, 2) }],
      isError: true,
    };
  }

  const ctx = buildOperationContext(engine, safeParams, opts);

  // WP2/D3: response-meta side channel. Handlers publish namespaced
  // out-of-band metadata (retrieval degradation, strict-mode warnings) here;
  // the success path below merges the collected keys into ToolResult._meta.
  // Last write per key wins within one call; the collector never throws.
  const responseMeta: Record<string, unknown> = {};
  ctx.emitResponseMeta = (key, value) => {
    if (value !== undefined) responseMeta[key] = value;
  };

  // WP3 warn mode: unknown keys were accepted above — surface them on the
  // structured channel (`_meta.warnings`, amendment 13 shape) so operators
  // and capable clients see the grace-period signal per call.
  if (unknownParamWarnings.length > 0) {
    ctx.emitResponseMeta('warnings', unknownParamWarnings);
  }

  try {
    // Fail-closed gate for slug-bound OAuth clients, applied here because
    // this is the one path both MCP transports share. Per-op fences still
    // run inside the handlers; this stops an unfenced write op from being
    // a silent hole. See CLIENT_FENCED_WRITE_OPS in operations.ts.
    enforceBoundClientOpAllowList(ctx.auth, op);
    const result = await op.handler(ctx, safeParams);
    // [E4] verb success metrics: budget drops + entity hit/miss when present.
    {
      const r = result as { dropped_count?: number; found?: boolean } | null;
      logVerb(true, {
        ...(typeof r?.dropped_count === 'number' ? { budget_dropped: r.dropped_count } : {}),
        ...(name === 'entity' && typeof r?.found === 'boolean' ? { entity_found: r.found } : {}),
      });
    }
    const out: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    // D8: model-visible loudness for empty retrievals. The body stays a bare
    // array (D3 — deployed thin-clients parse content[0] only), and a SECOND
    // text block carries the diagnosis the model actually sees. Structured
    // consumers read the same facts from _meta.retrieval below.
    if (Array.isArray(result) && result.length === 0 && responseMeta.retrieval) {
      const block = buildEmptyRetrievalBlock(responseMeta.retrieval);
      if (block) out.content.push({ type: 'text', text: block });
    }
    // WP3/D8: warn-mode unknown-param notices ride the same model-visible
    // extra-block mechanism, so the grace period actually corrects clients
    // (old thin-clients read content[0] only — skew-safe).
    if (unknownParamWarnings.length > 0) {
      out.content.push({ type: 'text', text: buildUnknownParamWarnBlock(unknownParamWarnings) });
    }
    // _meta assembly (WP2 amendment 9): one producer per top-level key,
    // each isolated — handler-emitted keys (retrieval, warnings) attach
    // BEFORE and independently of the metaHook, so a hot-memory hook
    // failure can never drop the retrieval channel. Per-key merge, never
    // wholesale assignment. See docs/protocol/MCP_META_CHANNELS.md.
    if (Object.keys(responseMeta).length > 0) {
      out._meta = { ...responseMeta };
    }
    // v0.31 (eD3 + eE4): best-effort _meta.brain_hot_memory injection.
    // The hook is wrapped in its own try/catch — any DB blip / cache miss /
    // helper crash degrades to no hook keys rather than flipping the whole
    // tool call to error.
    if (opts.metaHook) {
      try {
        const meta = await opts.metaHook(name, ctx);
        if (meta && Object.keys(meta).length > 0) out._meta = { ...(out._meta ?? {}), ...meta };
      } catch (metaErr) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        ctx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no hook keys`);
      }
    }
    return out;
  } catch (e: unknown) {
    logVerb(false);
    if (e instanceof OperationError) {
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    const msg = e instanceof Error ? e.message : String(e);
    // [c7] verbs speak the protocol envelope even for uncaught throws.
    const envelope = isVerb
      ? {
          error: 'internal',
          message: msg,
          suggestion: 'This is a server-side failure, not a caller mistake. Retry once; if it persists, run `gbrain doctor`.',
          protocol_version: MEMORY_VERBS_VERSION,
        }
      : { error: 'internal_error', message: msg };
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      isError: true,
    };
  }
}
