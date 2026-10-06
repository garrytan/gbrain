/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import { affectsRecall } from '../core/types.ts';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, enforceBoundClientOpAllowList, opError } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { VERB_NAMES, MEMORY_VERBS_VERSION } from '../core/verbs.ts';
import { cliRenderContext, orderNotices, redactForTransport, renderNotice, toAgentError, toolErrorResult, toolResultWithNotices, type Notice, type RenderContext } from '../core/agent-output.ts';
import { cliOnlyRefusal, isCallable } from '../core/ops/callable.ts';
import { hostFix, scopeDeniedError } from '../core/ops/op-fix.ts';
import { mutedNoticeCodes, processNoticeLedger, __resetProcessNoticeLedgerForTests, type NoticeLedger } from '../core/notice-ledger.ts';
import { logVerbUsage } from '../core/verbs/usage-log.ts';
import { localTranscriptsNotice, recallInteropNotices, wantsTranscriptHint } from '../core/interop-notices.ts';
import { hiddenToolHint } from './hidden-tool-hint.ts';
import { takePostUpgradeMcpNotice } from '../core/post-upgrade-notice.ts';
import { takeHttpBehaviorNotice, takeLocalBehaviorNotice } from '../core/behavior-change-notice.ts';
import { takeChatFallbackHopNotices } from '../core/ai/fallback-hop-queue.ts';
import { mcpOnboardingNotices } from '../core/onboard/mcp-onboarding.ts';
import { takeFactsDrainNotice } from '../core/facts/drain.ts';
import { sourceGuardBlocksWrite } from '../core/source-resolver.ts';
import { suggestNearest } from '../core/levenshtein.ts';
import {
  normalizeOptionalParams,
  findInvalidParam,
  schemaInvalidParams,
  findUnknownParams,
  buildUnknownParamWarnBlock,
  resolveStrictParamsMode,
} from './validate-params.ts';
import { backupCheckDisabled, backupNagGate, backupNoticeText, loadBackupStatus } from '../core/backup/status-file.ts';
import { maybeRefreshBackupStatusInProcess } from '../core/backup/coverage.ts';
import { operationScopesAllowed } from '../core/scope.ts';
import { invalidateHotMemoryForEngine } from '../core/facts/meta-hook.ts';
import { admittedPendingReceipt, type WriteReceipt } from '../core/persistence/types.ts';
import { currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter, withVerifiedLocalRegistration } from '../core/persistence/identity.ts';

// WP3: normalization + validation moved to validate-params.ts (direct unit
// surface). Re-exported here so existing imports/tests keep working.
export { normalizeOptionalParams, validateParams } from './validate-params.ts';

// db-availability loop: the classifier only needs the CONFIGURED url as
// context (supabase enrichment; fix derivation) plus the resolved brain id
// (a MOUNT's failure must never read as a host failure — the id rides into
// the marker). Read once per process — the uncaught-error path must not add
// disk reads per failure, and serve's routing is fixed for its lifetime.
let cachedClassifyUrl: string | null | undefined;
function configuredDbUrlForClassify(): string | null {
  if (cachedClassifyUrl === undefined) {
    try {
      cachedClassifyUrl = loadConfig()?.database_url ?? null;
    } catch {
      cachedClassifyUrl = null;
    }
  }
  return cachedClassifyUrl;
}
/** The brain this process serves: `serve --brain` / GBRAIN_BRAIN_ID / .gbrain-mount / host. */
function servedBrainId(): string | undefined {
  try {
    return resolveBrainId(getCliOptions().brain);
  } catch {
    return undefined;
  }
}
let cachedClassifyBrainId: string | null | undefined;
function brainIdForClassify(): string | undefined {
  if (cachedClassifyBrainId === undefined) {
    try {
      cachedClassifyBrainId = resolveBrainId(null);
    } catch {
      cachedClassifyBrainId = null;
    }
  }
  return cachedClassifyBrainId ?? undefined;
}

const VERB_NAME_SET: ReadonlySet<string> = new Set(VERB_NAMES);

// ── monthly backup-coverage notice (once per process, agent-facing only) ────

let backupNoticeShown = false;
let backupNoticeCheckedMs = 0;

/** Test seam: re-arm the once-per-process backup notice. */
export function __resetBackupNoticeForTests(): void {
  backupNoticeShown = false;
  backupNoticeCheckedMs = 0;
  __resetProcessNoticeLedgerForTests();
}

/**
 * Attach the aggregate backup warning as an extra content block. Fail-open:
 * a notice bug must never break a tool call.
 *
 * STDIO transport only: the notice targets local-harness installs (Claude
 * Code/Codex/OpenClaw/plugin serves are all stdio). HTTP callers are remote
 * thin clients — the host's backup posture is operational metadata their
 * token scope doesn't grant (the mcp.publish_advisor discipline), and a
 * remote-triggered record() must not spend the LOCAL notice budget. Local CLI
 * callers (`gbrain call`, opts.remote === false) are excluded too — the
 * cli.ts startup rail owns that surface. The hourly recheck latch keeps the
 * healthy steady state at zero file reads per tool call.
 */
function maybeBackupNotice(notices: Notice[], opts: DispatchOpts): void {
  try {
    if (backupNoticeShown || opts.remote === false || opts.transport !== 'stdio') return;
    const now = Date.now();
    if (now - backupNoticeCheckedMs < 60 * 60 * 1000) return;
    backupNoticeCheckedMs = now;
    if (backupCheckDisabled()) return;
    const s = loadBackupStatus();
    if (!s || s.overall !== 'warn') return;
    const gate = backupNagGate('mcp', s);
    if (!gate.show) return;
    const text = backupNoticeText(s, 'aggregate');
    if (!text) return;
    notices.push({
      code: 'backup_coverage', kind: 'coaching', why: text,
      fix: { argv: ['gbrain', 'backup', 'status'], consent: [], actor: 'user', why: 'Lists each asset without a git remote and its fix command.', requires_exclusive: false },
    });
    backupNoticeShown = true;
    gate.record();
  } catch {
    /* never break dispatch over a notice */
  }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Structured data for programmatic consumers only: MCP hosts generally do
   * NOT show `_meta` to the model, so anything the agent must act on also
   * rides a model-visible channel (the notice blocks; agent contract v1).
   * NOT a wrapper around the result body — `content` stays the same shape it
   * always had. Best-effort: any error in the meta hook is absorbed and the
   * tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Configuration selected by the resident transport, never populated from wire params. */
  config?: OperationContext['config'];
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
   * #5081: explicit-read admission for a stdio connection bound by
   * GBRAIN_SOURCE or a .gbrain-source pin. Stdio transport only; see
   * OperationContext.explicitReadBinding.
   */
  explicitReadBinding?: OperationContext['explicitReadBinding'];
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
  /** Agent contract v1 (A6): HTTP's per-server notice ledger (ServeHttpContext); stdio uses the process ledger. */
  noticeLedger?: NoticeLedger;
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
  /** The stdio session surface (OperationContext.stdioSurface); its allow-set is the one `allowedOps` mirrors. */
  stdioSurface?: OperationContext['stdioSurface'];
  /** Threaded into OperationContext.revealTools (stdio session tool reveal). */
  revealTools?: (names: string[]) => void;
  /** #5232: commit wait for coordinated writes (OperationContext.writeWaitMs); unset = agent default. */
  writeWaitMs?: number;
  /** C1: search/query row shape chosen by the transport (OperationContext.resultRows); unset = lean for remote callers. */
  resultRows?: OperationContext['resultRows'];
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
 * Model-visible notices the search/query ops attach to `_meta.retrieval`: the
 * D8 empty-retrieval diagnosis, a reconciled type filter, other names declared in the evidence, and saved
 * facts that match the query. Each rides as its own text block after the
 * results (content[0] stays the bare result array for thin clients).
 */
export function retrievalNoticeBlocks(result: unknown, retrieval: unknown): string[] {
  if (retrieval === null || typeof retrieval !== 'object') return [];
  const empty = Array.isArray(result) && result.length === 0 ? buildEmptyRetrievalBlock(retrieval) : null;
  const r = retrieval as {
    type_filter_notice?: unknown;
    other_names?: Array<{ name: string; alias: string; slug: string }>;
    saved_facts?: Array<{ fact: string; entity_slug: string | null; valid_from: string; source: string }>;
  };
  const blocks: string[] = empty ? [empty] : [];
  if (typeof r.type_filter_notice === 'string') blocks.push(r.type_filter_notice);
  if (r.other_names?.length) {
    const { text, more } = wholeItemsWithin('Other names in these results (documents may use either; search the one you have not tried): ',
      r.other_names.map(n => `${n.alias} = ${n.name} (declared in ${n.slug})`), '; ', OTHER_NAMES_NOTICE_MAX_CHARS);
    blocks.push(`${text}${more ? ` (+${more} more)` : ''}.`);
  }
  if (r.saved_facts?.length) {
    const { text, more } = wholeItemsWithin('Saved facts (remember) matching this query, newest first; recall returns more:\n',
      r.saved_facts.map(f => `- ${f.fact} [entity: ${f.entity_slug ?? 'none'}; saved ${String(f.valid_from).slice(0, 10)}; provenance: ${f.source}]`),
      '\n', SAVED_FACTS_NOTICE_MAX_CHARS);
    blocks.push(more ? `${text}\n(+${more} more; recall returns them)` : text);
  }
  return blocks;
}

/** C4: character ceilings for the model-visible notice blocks (header included). */
export const SAVED_FACTS_NOTICE_MAX_CHARS = 1_500;
export const OTHER_NAMES_NOTICE_MAX_CHARS = 400;

/**
 * Whole items after `head` while the block stays within `max` characters;
 * an item is never cut, so its provenance stays intact. The first item is
 * always shown, even alone over the ceiling. `more` counts the items left out.
 */
function wholeItemsWithin(head: string, items: string[], sep: string, max: number): { text: string; more: number } {
  let text = head + items[0];
  let shown = 1;
  while (shown < items.length && text.length + sep.length + items[shown].length <= max) text += sep + items[shown++];
  return { text, more: items.length - shown };
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
  // Ranking-only stages (a skipped reranker) cannot cause a miss — the model
  // must not be told recall was impaired when only ordering was.
  const stages = (r.degraded ?? [])
    .filter(affectsRecall)
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
export type RequestLogStatus = 'success' | 'success_with_warnings' | 'accepted_pending' | 'denied_after_list' | 'error';

/** #5249: the receipt of a write the dispatcher returned as accepted but not yet committed. */
export function acceptedPendingReceipt(result: ToolResult): WriteReceipt | null {
  if (!result.isError) return null;
  try { return admittedPendingReceipt(JSON.parse(result.content[0]?.text ?? '{}')); }
  catch { return null; }
}

/**
 * The ONE `mcp_request_log.status` decision for a dispatched tool result
 * (serve-http's tools/call persistence + SSE broadcast both consume this):
 *   - errors whose envelope is a list-level denial (isListLevelDenialEnvelope
 *     above) → 'denied_after_list' (amendment 33 / D10 trend-to-zero metric);
 *   - `write_pending` carrying a non-terminal receipt → 'accepted_pending'
 *     (#5249: admitted work still in flight, not a failure);
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
      if (admittedPendingReceipt(parsed)) return 'accepted_pending';
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
export function unknownToolEnvelope(name: string, opts: DispatchOpts, legacyError?: 'unknown_operation'): ToolResult {
  const allowedOps = opts.allowedOps;
  const candidates = operations
    .filter(op => !op.localOnly && !op.publishGateKey && (allowedOps ? allowedOps.has(op.name) : true))
    .map(op => op.name);
  const nearest = suggestNearest(name, candidates);
  const hint = hiddenToolHint(operations.find(o => o.name === name), opts, dispatchRenderContext(opts).isCallable('request_tools') && opts.stdioSurface?.widenAllowed !== false); // F6: owner's stdio pipe only
  const suggestion = hint?.suggestion ?? (nearest
    ? `Did you mean "${nearest}"?`
    : 'List the tools this connection can call (tools/list) and use one of those names.');
  return errorResult(opError('unknown_tool', legacyError ? `Unknown: ${name}` : `Unknown tool: ${name}`, suggestion,
    { ...(legacyError ? { legacy_error: legacyError } : {}), ...(hint ? { fix: hint.fix } : {}) }), opts);
}

/**
 * Agent contract v1 render context for a dispatch caller: a fix names an MCP
 * tool only when the same predicate behind tools/list says this caller can
 * call it. Preapprovals never apply over MCP (they are a CLI consent path).
 */
export function dispatchRenderContext(opts: DispatchOpts): RenderContext {
  const transport = opts.transport === 'stdio' ? 'stdio' : opts.remote === false ? 'cli' : 'http';
  const surface = opts.surface ?? 'full';
  const byName = new Map(operations.map(op => [op.name, op]));
  // A1: CLI fixes name the served brain and the request's source (ids only; the HTTP pass strips paths).
  const brain = servedBrainId();
  const routing = { ...(brain ? { brain } : {}), ...(opts.sourceId ? { source: opts.sourceId } : {}) };
  return {
    routing,
    transport,
    surface,
    isCallable: (opName: string) => {
      const op = byName.get(opName);
      return !!op && isCallable(op, {
        transport, surface, scopes: opts.auth?.scopes ?? [], publishGates: {}, allowedOps: opts.allowedOps,
      });
    },
    preapproved: () => false,
    ...(opts.auth?.clientId ? { principal: opts.auth.clientId } : {}),
  };
}

/** `gbrain call`'s failure envelope: same normaliser, CLI render context, the op's own effect tags. */
export function localCallErrorEnvelope(tool: string, e: unknown) {
  const op = operations.find(o => o.name === tool);
  return toAgentError(e, {
    transport: 'cli', op: tool, mutating: op?.mutating === true, idempotent: op?.idempotent === true,
    outcome: op?.mutating ? 'unknown' : 'failed', render: cliRenderContext(),
    db: { url: configuredDbUrlForClassify(), brainId: brainIdForClassify() },
  });
}

/**
 * A6 dedupe/budget/mute: the stdio ledger is per process; HTTP passes its
 * ServeHttpContext ledger. Session identity is the transport-resolved id only.
 * Fail-open: a ledger fault delivers every notice.
 */
function admitNotices(notices: Notice[], opts: DispatchOpts): Notice[] {
  if (notices.length === 0) return notices;
  try {
    const principal = opts.auth?.clientId;
    const transport = opts.transport === 'stdio' ? 'stdio' : opts.remote === false ? 'cli' : 'http';
    return (opts.noticeLedger ?? processNoticeLedger()).admit(notices,
      { transport, principal, sessionId: opts.sessionId }, mutedNoticeCodes(principal ?? (transport === 'stdio' ? 'stdio' : undefined)));
  } catch {
    return notices;
  }
}

/**
 * The one-time `behavior_changes` disclosure (stdio: once per brain; HTTP:
 * once per authenticated client, remote view) and the first
 * `chat_fallback_hop` of this process (stdio only: it names models). Rides
 * success and failure results alike. Never throws.
 */
async function sessionSafetyNotices(engine: BrainEngine, opts: DispatchOpts, config: OperationContext['config']): Promise<Notice[]> {
  const out: Notice[] = [];
  try {
    if (opts.transport === 'stdio' && opts.remote !== false) {
      const behavior = await takeLocalBehaviorNotice(engine, 'stdio', { cfg: config ?? null });
      if (behavior) out.push(behavior);
      out.push(...takeChatFallbackHopNotices());
    } else if (opts.transport === 'http') {
      const behavior = await takeHttpBehaviorNotice(engine, opts.auth?.clientId, { cfg: config ?? null });
      if (behavior) out.push(behavior);
    }
  } catch { /* a notice never breaks a tool call */ }
  return out;
}

/** The one error result path: toAgentError → exactly one content block. */
export function errorResult(e: unknown, opts: DispatchOpts, extra: { op?: string; mutating?: boolean; idempotent?: boolean; notices?: Notice[] } = {}): ToolResult {
  const carried = !!extra.notices?.length && e instanceof OperationError;
  if (carried) e.notices = [...(e.notices ?? []), ...extra.notices!];
  const render = dispatchRenderContext(opts);
  const envelope = toAgentError(e, {
    transport: render.transport, op: extra.op, mutating: extra.mutating, idempotent: extra.idempotent,
    outcome: extra.mutating ? 'unknown' : 'failed', render,
    db: { url: configuredDbUrlForClassify(), brainId: brainIdForClassify() },
  });
  if (!extra.notices?.length || carried) return toolErrorResult(envelope);
  // Any other throw (a plain Error, a DB fault) still carries the notices the call collected (A6: one block, `notices` key).
  const { contract_version, ...rest } = envelope;
  const added = extra.notices.map(n => redactForTransport(renderNotice(n, render), render.transport));
  return toolErrorResult({ ...rest, notices: orderNotices([...(envelope.notices ?? []), ...added]), contract_version });
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
    config: opts.config ?? loadConfig() ?? { engine: 'postgres' },
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
    ...(opts.explicitReadBinding ? { explicitReadBinding: opts.explicitReadBinding } : {}),
    ...(opts.surfaceCeiling ? { surfaceCeiling: opts.surfaceCeiling } : {}),
    ...(opts.stdioSurface ? { stdioSurface: opts.stdioSurface } : {}),
    ...(opts.revealTools ? { revealTools: opts.revealTools } : {}),
    ...(opts.writeWaitMs !== undefined ? { writeWaitMs: opts.writeWaitMs } : {}),
    ...(opts.resultRows ? { resultRows: opts.resultRows } : {}),
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
  const logVerb = (ok: boolean, extra?: { budget_dropped?: number; entity_found?: boolean; remember_status?: string }) => {
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
    return unknownToolEnvelope(name, opts);
  }

  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    return unknownToolEnvelope(name, opts);
  }

  // localOnly backstop at the SHARED layer (WP1/D7): localOnly ops reach the
  // operator's filesystem, so they dispatch only on the local stdio pipe.
  // Any non-stdio transport — both HTTP servers, and any future caller that
  // forgets to mark its transport — is denied fail-closed. Same envelope as
  // a nonexistent op so the catalog doesn't leak which names exist. The
  // serve-http path also filters these at list time; the legacy bearer
  // transport at surface 'full' had no gate at all before this line.
  if (op.localOnly && opts.transport !== 'stdio') {
    return unknownToolEnvelope(name, opts);
  }
  // F5: an owner-only op is never listed on MCP; a call gets the exact CLI command.
  if (op.cliOnly && opts.remote !== false) return errorResult(cliOnlyRefusal(op), opts, { op: name });

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
      const refusal = opError('source_binding_required', sentinelWrite
          ? 'GBRAIN_SOURCE=__all__ is a read-span sentinel, not a write target — a write cannot resolve to "all sources". ' +
            'Set GBRAIN_SOURCE to a concrete source id for writes.'
          : 'This brain has more than one source to choose from and the MCP server runs with --source-guard: ' +
          `write/admin operations need an explicit source binding so they cannot land in the wrong source (resolution tier: ${opts.sourceGuardTier}).`,
        'Set GBRAIN_SOURCE=<source-id> in the environment that launches this MCP server ' +
          '(plugin installs pass it through — the user-global stdio serve binds the source from the env, not a flag). ' +
          'List sources with `gbrain sources list`. Reads are unaffected.',
        { fix: { argv: ['gbrain', 'sources', 'list'], consent: [], actor: 'user', why: 'Names the source id to bind with GBRAIN_SOURCE.', requires_exclusive: false } });
      if (isVerb) refusal.protocolVersion = MEMORY_VERBS_VERSION;
      return errorResult(refusal, opts, { op: name });
    }
  }

  const safeParams = normalizeOptionalParams(op, params || {});
  const validationFailure = findInvalidParam(op, safeParams);
  if (validationFailure) {
    logVerb(false);
    // [c7] verb validation errors speak the protocol envelope (protocol_version);
    // B3: every op's suggestion names the param's type, choices and an example.
    const invalid = schemaInvalidParams(op, validationFailure, { remote: opts.remote, transport: dispatchRenderContext(opts).transport === 'http' ? 'http' : 'stdio' }, safeParams);
    if (isVerb) invalid.protocolVersion = MEMORY_VERBS_VERSION;
    return errorResult(invalid, opts, { op: name });
  }

  // WP3 strict/warn unknown-argument validation. Runs on the NORMALIZED
  // object (a null/'' optional idiom is never an unknown key). `_meta` and
  // `dry_run` are allowlisted inside findUnknownParams. The mode resolves
  // dual-plane (DB > file > 'warn') once per dispatch, and only when an
  // unknown key actually exists — the all-declared common case pays no
  // config read.
  const unknownParamWarnings = findUnknownParams(op, safeParams);
  if (unknownParamWarnings.length > 0) {
    const strictMode = await resolveStrictParamsMode(engine, opts.config ?? loadConfig());
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
      const strict = new OperationError('invalid_params',
        `${n} unknown parameter${n === 1 ? '' : 's'} not declared in the ${name} tool schema (mcp.strict_params=reject). See suggestion for the submitted name${n === 1 ? '' : 's'}.`,
        suggestion);
      if (isVerb) strict.protocolVersion = MEMORY_VERBS_VERSION;
      return errorResult(strict, opts, { op: name });
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
    const viaClient = opts.transport !== 'stdio' && !!opts.auth?.clientId;
    return errorResult(opError('missing_source_scope',
      `Remote tool call '${name}' carries no resolved sourceId; refusing the shared 'default' source fallback. Pass an explicit sourceId resolved from the caller's grant.`,
      viaClient
        ? `This connection has no source grant. The brain host operator binds one to this client (gbrain auth rescope-client ${opts.auth!.clientId} --source <source-id>), then the call works.`
        : 'This MCP server resolved no source. Set GBRAIN_SOURCE to a registered source id in the environment that launches it, then restart it.',
      { fix: hostFix({ remote: true, transport: viaClient ? 'http' : 'stdio' },
        viaClient ? ['gbrain', 'auth', 'clients', '--json'] : ['gbrain', 'sources', 'list'],
        viaClient ? 'Shows each OAuth client\'s write source; the operator binds this client to one with `gbrain auth rescope-client`.'
          : 'Lists the source ids GBRAIN_SOURCE can name.') }), opts, { op: name });
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

  // Agent contract v1 (A6): the model-visible notice channel. Producers call
  // ctx.emitNotice; success renders prefixed extra blocks + _meta.gbrain_notices,
  // failure renders the envelope's `notices` key (one block).
  const notices: Notice[] = [];
  ctx.emitNotice = (n) => { if (n) notices.push(n); };

  try {
    if (ctx.remote !== false && op.requiredScopes?.length) {
      let scopes = ctx.auth?.scopes;
      if (!scopes && ctx.transport === 'stdio') {
        const verified = currentVerifiedLocalWriter() ?? await verifyLocalWriter(engine, await readLocalWriter(engine, 'stdio'));
        scopes = verified.remote ? verified.grant.scopes : [];
      }
      if (!operationScopesAllowed(scopes ?? [], op)) {
        throw scopeDeniedError({ op: name, required: op.requiredScopes, auth: ctx.auth ? { ...ctx.auth, scopes: scopes ?? [] } : { clientId: '', scopes: scopes ?? [] },
          transport: ctx.transport === 'stdio' ? 'stdio' : 'http', message: 'This operation requires an explicit shared-skills grant.', legacy_error: 'permission_denied' });
      }
    }
    // Fail-closed gate for slug-bound OAuth clients, applied here because
    // this is the one path both MCP transports share. Per-op fences still
    // run inside the handlers; this stops an unfenced write op from being
    // a silent hole. See CLIENT_FENCED_WRITE_OPS in operations.ts.
    enforceBoundClientOpAllowList(ctx.auth, op);
    const sharedStdio = ctx.transport === 'stdio' && !ctx.auth &&
      (op.requiredScopes?.length || ['list_skills', 'get_skill', 'get_skill_asset', 'list_brain_skillpack'].includes(name));
    let registration: Awaited<ReturnType<typeof readLocalWriter>> | undefined;
    if (sharedStdio) {
      try { registration = await readLocalWriter(engine, 'stdio'); }
      catch (error) {
        if (!(error instanceof OperationError) || error.code !== 'writer_registration_required' || op.requiredScopes?.length) throw error;
      }
    }
    const result = registration
      ? await withVerifiedLocalRegistration(engine, registration, async verified => {
        if (!verified.remote) throw opError('permission_denied', 'This registration is not an agent-facing connection.',
          `${name} on this stdio connection needs the agent-facing stdio writer registration, which only the user can create in a terminal on the brain host.`,
          { fix: hostFix(ctx, ['gbrain', 'auth', 'local-writer', 'register', 'stdio', '--dry-run', '--json'],
            'Previews the agent-facing stdio registration; the user reruns it without --dry-run (with --replace and the complete grant when a registration exists).') });
        return op.handler(ctx, safeParams);
      })
      : await op.handler(ctx, safeParams);
    // Hot memory built before a write (forget, remember, …) is never served after it, on every transport.
    if (op.mutating) invalidateHotMemoryForEngine(engine);
    // [E4] verb success metrics: budget drops + entity hit/miss when present.
    {
      const r = result as { dropped_count?: number; found?: boolean; status?: string } | null;
      logVerb(true, {
        ...(typeof r?.dropped_count === 'number' ? { budget_dropped: r.dropped_count } : {}),
        ...(name === 'entity' && typeof r?.found === 'boolean' ? { entity_found: r.found } : {}),
        // remember's frozen status enum (inserted|duplicate|superseded) —
        // the memory_writeback doctor counters read this (all-MCP-callers
        // semantics, labeled honestly there; OV-A11).
        ...(name === 'remember' && typeof r?.status === 'string' ? { remember_status: r.status } : {}),
      });
    }
    // D8: model-visible loudness for empty retrievals. The body stays a bare
    // array (D3 — deployed thin-clients parse content[0] only); the diagnosis
    // rides the notice channel (its text kept as the `why:` line). Structured
    // consumers read the same facts from _meta.retrieval below.
    const emptyBlock = Array.isArray(result) && result.length === 0 && responseMeta.retrieval
      ? buildEmptyRetrievalBlock(responseMeta.retrieval) : null;
    if (emptyBlock) notices.push({ code: 'empty_retrieval', kind: emptyBlock.includes('degraded:') ? 'degraded' : 'info', why: emptyBlock });
    // Cat 40 (#5932) evidence blocks (type-filter notice, other names, saved facts) are retrieval
    // data, not advice: they stay plain extra text blocks right after content[0], as measured.
    const evidenceBlocks = retrievalNoticeBlocks(result, responseMeta.retrieval).slice(emptyBlock ? 1 : 0);
    // WP3/D8: warn-mode unknown-param notices ride the same channel, so the
    // grace period actually corrects clients (old thin-clients read content[0]
    // only — skew-safe). One notice per ignored parameter.
    for (const w of unknownParamWarnings) {
      notices.push({ code: 'unknown_param', kind: 'info', why: buildUnknownParamWarnBlock([w]) });
    }
    // Lane F (F3): degraded recall and a source binding that narrowed an empty read.
    notices.push(...recallInteropNotices(name, result, responseMeta, safeParams,
      { config: ctx.config, transport: dispatchRenderContext(opts).transport, binding: ctx.explicitReadBinding }));
    // Monthly backup-coverage: one AGGREGATE notice per process (counts only —
    // never a local path or source id). The refresher runs on the stdio
    // transport ONLY — the WP1/D7 locality axis localOnly ops use; 'http' or
    // an UNSET marker never probes (fail-closed).
    // F5 follow-up: local transcripts exist but their reader is not callable on this stdio connection.
    if (opts.transport === 'stdio' && opts.remote !== false && !dispatchRenderContext(opts).isCallable('get_recent_transcripts')
      && wantsTranscriptHint(name, safeParams, result)) {
      try {
        const { recentTranscriptPresence } = await import('../core/transcripts.ts');
        const hint = localTranscriptsNotice(await recentTranscriptPresence(engine));
        if (hint) notices.push(hint);
      } catch { /* a pointer, never a failure */ }
    }
    maybeBackupNotice(notices, opts);
    if (opts.transport === 'stdio' && opts.remote !== false) { const up = takePostUpgradeMcpNotice(); if (up) notices.push(up); } // F7
    if (opts.transport === 'stdio' && opts.remote !== false) notices.push(...await mcpOnboardingNotices({ engine, op: name, result, meta: responseMeta, config: ctx.config, render: dispatchRenderContext(opts) }));
    if (opts.transport === 'stdio' && opts.remote !== false) { const drain = takeFactsDrainNotice(); if (drain) notices.push(drain); } // Lane D facts drain
    notices.push(...await sessionSafetyNotices(engine, opts, ctx.config));
    const out: ToolResult = toolResultWithNotices(result, admitNotices(notices, opts), dispatchRenderContext(opts));
    if (evidenceBlocks.length > 0) out.content.splice(1, 0, ...evidenceBlocks.map(text => ({ type: 'text' as const, text })));
    if (opts.transport === 'stdio') {
      maybeRefreshBackupStatusInProcess(engine);
    }
    // _meta assembly (WP2 amendment 9): one producer per top-level key,
    // each isolated — handler-emitted keys (retrieval, warnings) attach
    // BEFORE and independently of the metaHook, so a hot-memory hook
    // failure can never drop the retrieval channel. Per-key merge, never
    // wholesale assignment. See docs/protocol/MCP_META_CHANNELS.md.
    if (Object.keys(responseMeta).length > 0) {
      out._meta = { ...(out._meta ?? {}), ...responseMeta };
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
    if (op.mutating) invalidateHotMemoryForEngine(engine); // a failed write may have committed part of its work
    // Agent contract v1 (A1): every failure — OperationError, classified DB
    // access errors, uncaught throws — goes through the one total normaliser,
    // which redacts raw messages, keeps verbs on their frozen v1 codes, and
    // never tells a mutating op with an unknown outcome to retry.
    notices.push(...await sessionSafetyNotices(engine, opts, ctx.config));
    return errorResult(e, opts, { op: name, mutating: op.mutating === true, idempotent: op.idempotent === true, notices: admitNotices(notices, opts) });
  }
}
