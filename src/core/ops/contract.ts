/**
 * Foundation contract for the operations layer (pure move from
 * src/core/operations.ts): the error envelope (ErrorCode / OperationError /
 * verbError), the shared param/logger/auth/context types, and the Operation
 * interface that every op declaration conforms to. operations.ts re-exports
 * this entire surface, so existing importers are unchanged.
 */

import type { WriteInference } from './write-inference.ts';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';
import { publicWriteReceipt, type WriteErrorCode, type WriteReceipt } from '../persistence/types.ts';
// Type-only: this module sits in the PGLite snapshot-schema import closure
// (via persistence/digest.ts), so it must not pull agent-output's runtime
// graph (version.ts, the DB classifier) in. agent-output registers the wire
// renderer below when it loads.
import type { Action, Notice } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import type { StdioSurfaceState } from '../../mcp/surface.ts';

/** Agent contract v1: the wire renderer for `fix`/`notices` in toJSON(), registered by agent-output.ts on load. */
interface OperationErrorWireRenderer { fix(a: Action): unknown; notice(n: Notice): unknown }
let wireRenderer: OperationErrorWireRenderer | null = null;
/** @internal agent-output.ts only. Unregistered (agent-output never loaded) → the stored Action is emitted as-is. */
export function __registerOperationErrorRenderer(r: OperationErrorWireRenderer): void { wireRenderer = r; }

// --- Types ---

/**
 * v0.31 (eD6 / eE7): ErrorCode is now an OPEN union via the
 * `(string & {})` autocomplete-friendly hack. Downstream consumers (e.g.
 * gbrain-evals) get autocomplete on the named codes AND remain TS-forward-
 * compatible when gbrain adds new codes in future releases. This shape is
 * the standard Anthropic-API/OpenAI-API pattern.
 *
 * v0.31 added: 'rate_limited', 'extraction_failed', 'fact_not_found'.
 */
export type ErrorCode =
  | WriteErrorCode
  | 'page_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'bucket_not_found'
  | 'database_error'
  | 'permission_denied'
  | 'unknown_transport' // v0.28.1: whoami fail-closed for ambiguous transport
  | 'rate_limited'      // v0.31: gateway rate-limit upstream
  | 'extraction_failed' // v0.31: facts extractor failed (refusal, parse, abort)
  | 'fact_not_found'    // v0.31: forget_fact / recall on unknown id
  // MEMORY_VERBS v1 protocol codes (frozen — docs/protocol/MEMORY_VERBS_v1.md).
  // Coarse on purpose: codes are for branching (configure/retry vs caller bug
  // vs server bug); the freeform `detail` field carries specifics.
  | 'not_found'            // unknown resource. Verb-level (forget: unknown fact id) AND
                           // get_agent_job's uniform foreign-or-missing envelope (anti-enumeration:
                           // a caller cannot distinguish another client's job from a nonexistent id)
  | 'scope_denied'         // verb-level: OAuth scope / trust-boundary refusal
  | 'provenance_required'  // remember: provenance missing or empty
  | 'unavailable'          // a required dependency cannot serve (no API key, gateway down, model refusal)
  | 'budget_unsatisfiable' // RESERVED in v1 — schema-listed, never returned
  | 'embedding_budget_below_worst_case' // #5680: migration cap below its worst-case authorization; refused before any change
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});      // OPEN union for forward-compat (eE7 / D13)

export class OperationError extends Error {
  /**
   * MEMORY_VERBS v1: verb handlers set `protocolVersion` (=1) and may set
   * `detail` (freeform specifics, e.g. which dependency failed). Both are
   * additive — non-verb ops never set them and their envelopes are unchanged
   * (undefined keys drop out of JSON.stringify).
   */
  public detail?: string;
  public protocolVersion?: number;
  public writeRequest?: WriteReceipt;
  public writeError?: WriteErrorCode;
  /** Agent contract v1 (A1): which cause, when one code covers several. */
  public reason?: string;
  /** Agent contract v1: why it happened, for the agent to explain and weigh. */
  public why?: string;
  /** Agent contract v1: the one next step. Rendered (`next`, `command`) only at serialization. */
  public fix?: Action;
  /** Site-level override of the code's class-derived `retryable` (#6278: `owner_unavailable` / `host_mismatch` is never worth a retry). */
  public retryable?: boolean;
  /** Agent contract v1: advice that rides the error (rendered into the envelope's `notices`). */
  public notices?: Notice[];
  /** #6188 (D16, D18): a fence refusal's location and its blocking issues; location and class only, never a cell value. */
  public fence?: Record<string, unknown>;
  public fenceIssues?: Array<Record<string, unknown>>;
  /** Set to 1 by opError(); toJSON() emits `contract_version` only when set. */
  public contractVersion?: 1;
  /**
   * Canonical registry code when this site keeps a frozen legacy `error`
   * value (A1 frozen pairs, e.g. `error: invalid_params`, `code: not_found`).
   */
  public canonical?: RegistryCode;
  /**
   * Agent contract v1 (B4): the journal row's own fields on a write-receipt
   * error, never serialized. toAgentError fills the registry's fix template
   * from them and picks the principal-correct receipt channel.
   */
  public receiptFields?: { operation: string; source_id: string; slug: string | null; principal_kind: string; principal_id: string };

  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  /**
   * The canonical registry code (`code` on the wire); `this.code` stays the
   * frozen `error` value. Registry-wide legacy aliases are applied by
   * toAgentError / the thin client (canonicalCodeFor), not here.
   */
  get canonicalCode(): string {
    return this.canonical ?? this.code;
  }

  /**
   * The explicit escape from opError()'s required suggestion: a refusal whose
   * next step genuinely cannot be named at the throw site. `reason` is
   * required so the registry default fix can still be selected.
   */
  static bare(code: RegistryCode, message: string, reason: string): OperationError {
    const e = new OperationError(code, message);
    e.reason = reason;
    e.contractVersion = 1;
    return e;
  }

  toJSON() {
    return {
      error: this.code,
      code: this.canonicalCode,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
      detail: this.detail,
      protocol_version: this.protocolVersion,
      ...(this.writeRequest ? { write_request: publicWriteReceipt(this.writeRequest) } : {}),
      ...(this.writeError ? { write_error: this.writeError } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      ...(this.why !== undefined ? { why: this.why } : {}),
      ...(this.fix ? { fix: wireRenderer ? wireRenderer.fix(this.fix) : this.fix } : {}),
      ...(this.notices?.length ? { notices: this.notices.map(n => wireRenderer ? wireRenderer.notice(n) : n) } : {}),
      ...(this.fence ? { fence: this.fence } : {}),
      ...(this.fenceIssues?.length ? { fence_issues: this.fenceIssues } : {}),
      ...(this.contractVersion !== undefined ? { contract_version: this.contractVersion } : {}),
    };
  }
}

export interface OpErrorOpts {
  reason?: string;
  why?: string;
  fix?: Action;
  docs?: string;
  detail?: string;
  /** Overrides the class-derived `retryable` on the envelope for this site. */
  retryable?: boolean;
  /**
   * The frozen v1 `error` wire value when this site historically threw a
   * different code (A1 frozen pairs). `error` keeps this value; `code` is the
   * canonical registry code passed to opError().
   */
  legacy_error?: string;
}

/**
 * Agent contract v1 error constructor (mirrors verbError): `suggestion` is
 * positional and required. Use `OperationError.bare()` only when no next step
 * can be named at the throw site.
 */
export function opError(code: RegistryCode, message: string, suggestion: string, opts: OpErrorOpts = {}): OperationError {
  const e = new OperationError(opts.legacy_error ?? code, message, suggestion, opts.docs);
  if (opts.legacy_error !== undefined) e.canonical = code;
  if (opts.reason !== undefined) e.reason = opts.reason;
  if (opts.why !== undefined) e.why = opts.why;
  if (opts.fix !== undefined) e.fix = opts.fix;
  if (opts.detail !== undefined) e.detail = opts.detail;
  if (opts.retryable !== undefined) e.retryable = opts.retryable;
  e.contractVersion = 1;
  return e;
}

/**
 * CLI→MCP gap-closure wave (ENG-E2) — shared relation-missing guard for the
 * telemetry ops (get_job_stats, cache_stats, search_stats, search_tune).
 * Older brains that predate a feature's tables raw-error with Postgres 42P01
 * ("relation … does not exist") / PGLite's equivalent; every telemetry op
 * must degrade to the SAME actionable 'unavailable' envelope instead — one
 * helper, never four inline copies.
 */
export async function withRelationGuard<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist|no such table/i.test(msg)) {
      // The cause is not knowable here (pending migrations, or a dropped table), so the fix is the
      // registry's diagnostic read (doctor on the brain host); the prose names no other command and the
      // envelope appends the rendered fix, so suggestion and fix always agree.
      throw opError(
        'unavailable',
        `${what} is unavailable on this brain: a required table is missing.`,
        'The brain is missing a table this gbrain expects (usually pending schema migrations). Doctor on the brain host reports what is missing and the command that repairs it.',
        { reason: 'schema_missing' },
      );
    }
    throw err;
  }
}

/**
 * MEMORY_VERBS v1 error constructor. Every verb error carries a populated
 * `suggestion` (problem + cause + fix — agents read it and self-correct;
 * conformance asserts non-empty) and `protocol_version: 1`.
 */
export function verbError(
  code: ErrorCode,
  message: string,
  suggestion: string,
  detail?: string,
): OperationError {
  const e = new OperationError(code, message, suggestion);
  e.protocolVersion = MEMORY_VERBS_VERSION;
  if (detail !== undefined) e.detail = detail;
  return e;
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: ParamDef;
  /** Object members (O-DX-3); a member with `required: true` lands in the schema's `required`. */
  properties?: Record<string, ParamDef>;
  /** Advertised on the full MCP surface only (keeps the starter tool list inside its size budget). */
  fullSurfaceOnly?: boolean;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  /** Durable, verifier-derived identity. Never infer this from a display name or request data. */
  principal?: { kind: 'oauth_client' | 'legacy_token'; id: string };
  /**
   * Human-readable agent name resolved at token-verification time.
   * For OAuth clients this is `oauth_clients.client_name`; for legacy
   * bearer tokens it is `access_tokens.name`. Threading this through
   * AuthInfo eliminates a per-request DB roundtrip in the /mcp handler
   * (was: SELECT client_name FROM oauth_clients WHERE client_id = ?
   * on every request — see PR #586 review note D14=B).
   */
  clientName?: string;
  scopes: string[];
  /** Operator-approved operation snapshot; NULL/undefined keeps legacy grants. */
  allowedOperations?: string[] | null;
  issuedScopes?: string[];
  sourceActive?: boolean;
  boundTools?: string[] | null;
  boundSourceId?: string | null;
  boundBrainId?: string | null;
  delegatedNamespace?: 'prefixes' | 'job';
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string | null;
  grantRevision?: number;
  grantProfile?: string | null;
  grantRepairReasons?: string[];
  /** The client's stored access-token lifetime override (`oauth_clients.token_ttl`); null = server default. */
  tokenTtlSeconds?: number | null;
  delegatedSlugPrefixes?: string[] | null;
  /** Missing grant projection on a profile client is fail-closed. */
  grantProjectionDegraded?: boolean;
  expiresAt?: number;
  /**
   * v0.34.1 (#861, D2): the source the calling OAuth client is scoped
   * to (write authority). Sourced from `oauth_clients.source_id` at
   * token-verification time. The HTTP transport ALSO threads this
   * value into `OperationContext.sourceId` at the same site so op
   * handlers can consume it via the canonical `ctx.sourceId` (D2
   * dual-write decision — identity surface symmetric with
   * `allowedSources` below).
   *
   * Undefined for legacy bearer tokens that predate v0.34.1 and for
   * clients that haven't been scoped yet. Migration v60 backfills
   * NULL → 'default' for pre-existing rows so this field is populated
   * on the upgrade path; brand-new public-client registrations may
   * still leave it null until an operator explicitly scopes via
   * `gbrain auth scope-client`.
   */
  sourceId?: string;
  /**
   * #3242 (serve --http parity): distinguishes an operator-set source scope
   * from the historical no-grant 'default' floor. `false` ONLY for a legacy
   * bearer token whose `access_tokens.permissions.source_id` is absent —
   * the one case whose unqualified reads may widen to the federated set.
   * `true` (or undefined, e.g. OAuth clients) never widens. Mirrors
   * `AuthResult.hasSourceGrant` in `src/mcp/http-transport.ts`.
   */
  hasSourceGrant?: boolean;
  /**
   * v0.34.1 (#876): array of source ids this OAuth client may READ
   * from (federation). Sourced from `oauth_clients.federated_read`.
   * Independent of `sourceId` (write authority): a "WeCare L3 dept"
   * client can write to `source_id='dept-x'` while reading the union
   * of `['dept-x', 'wecare-parent', 'shared']`.
   *
   * Empty array `[]` means "no federated reads beyond `sourceId`".
   * Undefined means "the post-v60 backfill hasn't populated this row
   * yet" — engines fall back to scalar `sourceId` filtering in that
   * case (back-compat).
   */
  allowedSources?: string[];
  /**
   * Per-token allow-list for the holder field on `takes`, populated at
   * token-verification time from `access_tokens.permissions.takes_holders`
   * for legacy bearer tokens (via `parseTakesHoldersAllowList` in
   * `src/core/legacy-token-scope.ts`). The HTTP transport threads this into
   * `OperationContext.takesHoldersAllowList` (documented below).
   *
   * `[]` is an explicit deny-all grant and is PRESERVED (never collapsed).
   * `undefined` means the token row carries no array grant — OAuth clients
   * have no per-client storage yet (see TODOS.md) — and consumers apply the
   * fail-closed `['world']` default at the dispatch site.
   *
   * Rides the same `as CoreAuthInfo as SdkAuthInfo` cast as `sourceId` /
   * `allowedSources` above.
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.42.72.0: slug-prefix WRITE binding from
   * `oauth_clients.bound_slug_prefixes`, threaded at token-verification
   * time (same JOIN as sourceId/allowedSources — no per-op roundtrip).
   * When present, every direct slug-mutating write op is fenced to slugs
   * under one of these prefixes via `enforceClientSlugFence` — the same
   * plain-startsWith semantics (and the same fail-closed empty-array
   * posture) as submit_agent's bound_slug_prefixes check, so one column
   * means one thing everywhere it's read. Closes the write-side half of
   * shared-source isolation: reads were SQL-fenced via `allowedSources`,
   * but same-source writes were folder-convention-only.
   *
   * Undefined = client has no binding, or the brain predates the
   * bound_slug_prefixes column → no fence (unbound clients keep
   * full-source write authority, back-compat).
   */
  boundSlugPrefixes?: string[];
  /**
   * Set when token verification could not read `bound_slug_prefixes` (the
   * projection degraded on a brain missing an OAuth column). The fence can't
   * distinguish "no binding" from "binding unknown" otherwise, so writes are
   * refused rather than silently unfenced. Read/auth degradation is
   * unaffected — this axis alone fails closed.
   */
  fenceProjectionDegraded?: boolean;
  /**
   * WP4 (D2): per-client tool surface from `oauth_clients.surface`, threaded
   * at token-verification time (same JOIN as sourceId/allowedSources). The
   * serve-http transport resolves the request's effective surface as
   * `min(server ceiling, this ?? config default)` — the row can narrow, never
   * widen. Value space is OPEN (amendment 18: future client tiers write tier
   * names into the same column); unrecognized values are ignored at
   * resolution with a warn-log once per client. Undefined = column NULL,
   * projection degraded, or the brain predates migration v127.
   */
  surface?: string;
  /** Current transport ceiling applied to this authenticated request. */
  effectiveSurface?: 'verbs' | 'starter' | 'full';
  /**
   * WP4 (amendment 19) — who set `surface`: 'operator' (rescope CLI/admin
   * endpoint; request_tools persist may NOT override it), 'self'
   * (request_tools persist), or 'dcr_default'. Undefined when surface is
   * unset or the projection degraded.
   */
  surfaceSetBy?: string;
}

/**
 * Transport a verified caller authenticated through. The verifier-set
 * `principal` is authoritative; the `gbrain_cl_` client-id prefix is only a
 * fallback for AuthInfo built without one.
 */
export function authTransport(auth: AuthInfo): 'oauth' | 'legacy' {
  if (auth.principal) return auth.principal.kind === 'oauth_client' ? 'oauth' : 'legacy';
  return auth.clientId.startsWith('gbrain_cl_') ? 'oauth' : 'legacy';
}

export interface OperationContext {
  engine: BrainEngine;
  config: GBrainConfig;
  logger: Logger;
  dryRun: boolean;
  /**
   * OAuth auth info (v0.8+). Present when the caller authenticated via OAuth 2.1
   * through `gbrain serve --http`, or a remote-owned delegated worker tool.
   * Worker auth carries the current read grant; explicit tool bindings grant
   * delegated operations independently of the parent's direct read/write scopes.
   */
  auth?: AuthInfo;
  /**
   * True when the caller is remote/untrusted (MCP over stdio/HTTP, or any agent-facing entry point).
   * False for local CLI invocations by the owner of the machine.
   *
   * Security-sensitive operations (e.g., file_upload) tighten their filesystem
   * confinement when remote=true and allow unrestricted local-filesystem access
   * when remote=false.
   *
   * REQUIRED as of the F7b hardening — the type system is the first line of defense.
   * Every transport (CLI / stdio MCP / HTTP MCP / subagent dispatcher) sets this
   * explicitly. Consumers still treat anything that isn't strictly `false` as
   * remote/untrusted (defense in depth in case the type is bypassed via cast).
   */
  remote: boolean;
  /**
   * Transport marker for auth-less remote surfaces (#1061). The stdio MCP
   * dispatch sets 'stdio' — it is deliberately `remote: true` (agent-facing,
   * untrusted) but has no per-token auth (local pipe), so identity ops like
   * whoami need a way to distinguish "known auth-less transport" from "a
   * transport bug forgot to thread ctx.auth". Trust decisions MUST NOT key
   * off this field — only `ctx.remote === false` grants trust. It IS the
   * transport-LOCALITY axis: localOnly ops dispatch on 'stdio' (a local
   * pipe with the operator's own filesystem) and are denied on 'http'
   * (network transports), independent of the remote trust flag.
   */
  transport?: 'stdio' | 'http';
  /**
   * WP2/D3: response-meta side channel. Handlers that compute out-of-band
   * result metadata (retrieval degradation, strict-mode warnings) publish it
   * here under a namespaced top-level key; the MCP dispatch layer merges the
   * collected keys into `ToolResult._meta` (one producer per key — see
   * docs/protocol/MCP_META_CHANNELS.md). Unset on CLI/local dispatch paths,
   * which render the same meta directly; emissions are always optional-chained.
   */
  emitResponseMeta?: (key: string, value: unknown) => void;
  /**
   * Agent contract v1 (A6): model-visible advice. MCP dispatch renders each
   * notice as a prefixed extra text block plus `_meta.gbrain_notices` on
   * success, and into the error envelope's `notices` key on failure. Unset
   * on callers that have no notice channel; producers call it optionally.
   */
  emitNotice?: (n: Notice) => void;
  /**
   * WP4 (D2): the SERVER surface ceiling for this transport (force-clamped),
   * threaded by the MCP dispatch layer. Consumed by `request_tools`: the
   * catalog never names ops above the ceiling, and the persist branch
   * rejects widening past it with a machine-readable denial
   * (`detail: "ceiling=<surface>"`). Unset (local CLI / direct dispatch) is
   * treated as 'full'.
   */
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
  /** The stdio session's surface (stdio MCP only): `request_tools` widens it for this session, `whoami` reports it. */
  stdioSurface?: StdioSurfaceState;
  /**
   * Set by transports that can widen a session's listed tools (stdio): when
   * `request_tools` returns schemas, the named tools join this session's
   * tools/list and the client is notified (tools/list_changed).
   */
  revealTools?: (names: string[]) => void;
  /**
   * Subagent runtime context (v0.16+). Set by the subagent tool dispatcher when
   * dispatching an op as a tool call from an LLM loop. Used to enforce per-op
   * agent policy (e.g. put_page namespace rule).
   *
   * `viaSubagent` is the FAIL-CLOSED flag: when true, agent-facing policy MUST
   * be enforced even if `subagentId` happens to be undefined (a bug in the
   * dispatcher must not bypass the guard). `subagentId` is the owning subagent
   * job id; `jobId` is the current Minion job id (aggregator or subagent).
   */
  jobId?: number;
  subagentId?: number;
  viaSubagent?: boolean;
  /**
   * Trusted-workspace allow-list (v0.23 dream cycle). When the cycle's
   * synthesize/patterns phases dispatch a subagent, they thread an
   * explicit list of slug-prefix globs (e.g. "wiki/personal/reflections/*")
   * through this field. put_page enforces it BEFORE the legacy
   * `wiki/agents/<id>/...` namespace check.
   *
   * Local jobs receive these from the trusted submitter. Remote-owned jobs
   * receive intersected grant prefixes and auth; prefixes alone grant no trust.
   * Every subagent tool call has `remote=true` for auto-link safety,
   * so basing trust on `remote` is incoherent (would always reject).
   *
   * Empty / unset → fall back to the legacy namespace check (existing
   * v0.15 behavior; pure addition, no regression).
   */
  allowedSlugPrefixes?: string[];
  /**
   * #5994: the stored authority of a failed write that `gbrain repair
   * failed-writes` replays. Set only by that trusted local repair lane; no
   * transport, dispatcher or job hydrates it. Admission reuses it as the
   * write's authority ceiling (principal, delegation, source incarnation,
   * autoLinkTrusted), re-authorized against the live grant, instead of
   * deriving local authority from the replay context. The subagent fence
   * accepts a missing `subagentId` only with this marker and a non-empty
   * allow-list equal to the stored delegated prefixes.
   */
  replayAuthority?: WriteAuthority;
  /**
   * #4216 — defer chunk embeddings on put_page writes: importFromContent runs
   * noEmbed and the standing embed machinery (embed phase / phase-end
   * backfill / the stale-embed sweep) picks the chunks up via the
   * `embedding IS NULL` partial index. Set ONLY by server-side dispatchers
   * (the oneshot runner's programmatic writes); never hydrated from any wire
   * payload, so remote callers cannot toggle it. (Flag spelled without dashes
   * here on purpose — the flag-registry generator harvests bare dash-dash
   * tokens from comments.)
   */
  deferEmbeds?: boolean;
  /**
   * #5232: how long a coordinated write waits for its commit before returning
   * `write_pending` with its receipt. Unset keeps the agent default (5 s);
   * CLI entry points and the resident owner's CLI lane set it
   * (persistence/write-wait.ts).
   */
  writeWaitMs?: number;
  /**
   * Row shape for `search`/`query` results in content[0]. Set by the MCP
   * transports: 'full' for gbrain's own thin client (X-Gbrain-Client header)
   * and for hosts with `mcp.result_rows: full`, otherwise 'lean'. Unset means
   * 'lean' for remote callers; trusted local callers (`remote === false`)
   * always get full rows. A per-call `fields: "full"` overrides 'lean'.
   * Shape only, never authority: nothing security-relevant reads it.
   */
  resultRows?: 'lean' | 'full';
  /**
   * Resolved global CLI options (--quiet / --progress-json / --progress-interval).
   * CLI callers populate this from `getCliOptions()`. MCP / library callers
   * may leave it undefined — consumers default to quiet/no-progress for
   * background work.
   */
  cliOpts?: { quiet: boolean; progressJson: boolean; progressInterval: number };
  /**
   * v0.28: per-token allow-list for the holder field on `takes`. Threaded
   * by the MCP HTTP/stdio dispatch layer from `access_tokens.permissions.takes_holders`.
   *
   * When set (i.e., this OperationContext came from an MCP-bound token),
   * `takes_list`, `takes_search`, `takes_scorecard`, `takes_calibration`,
   * and `query` (when it returns takes) MUST apply `WHERE holder = ANY($takesHoldersAllowList)`.
   * This is the server-side filter that backs the v0.28+ visibility model.
   *
   * v0.30.0: aggregate ops (`takes_scorecard`, `takes_calibration`) require
   * the allow-list as a TS-required engine method param (fail-closed by
   * compiler). Hidden-holder rows contribute zero to aggregates. The CLI
   * callers (local + trusted) leave it undefined.
   *
   * Default behavior when unset: local CLI callers see all holders. v0.28
   * MCP dispatch sets it to `['world']` for tokens with no permissions row
   * (default-deny on private hunches).
   */
  takesHoldersAllowList?: string[];
  /**
   * Connected-gbrains brain id (v0.19+ / v0.26 mounts). Identifies which brain
   * this op is targeting. 'host' for the default brain configured in
   * ~/.gbrain/config.json; otherwise a mount id registered in ~/.gbrain/mounts.json.
   *
   * `ctx.engine` is the resolved BrainEngine for this id (populated by
   * BrainRegistry at dispatch time). `brainId` exists alongside for:
   * - audit logging (mount-ops JSONL carries the id)
   * - subagent inheritance (child jobs receive the parent's brainId)
   * - cross-brain citation prefixes in agent output
   *
   * Orthogonal to v0.18.0's source_id, which scopes per-repo WITHIN a brain.
   * See docs/architecture/brains-and-sources.md for the mental model.
   *
   * Omitted = 'host' (pre-v0.19 callers + single-brain deployments keep
   * working without change).
   */
  brainId?: string;
  /**
   * v0.31 (eD4 / eE2): the in-DB tenancy axis for facts hot memory.
   * `sources.id` is TEXT (not INTEGER) — keep this as a string.
   *
   * Resolved once in the dispatcher from CLI flag (--source) / env
   * (GBRAIN_SOURCE) / `.gbrain-source` dotfile / per-token sources scope
   * (HTTP). Defaults to 'default' when nothing else applies.
   *
   * Every facts read/write filter starts with `WHERE source_id = $X`
   * so the trust boundary is part of the index path, not a callback.
   *
   * v0.34 D4 — REQUIRED at the TypeScript level. Mirrors v0.26.9 `remote`
   * REQUIRED pattern that closed the HTTP RCE class. Every transport
   * (CLI / stdio MCP / HTTP MCP / subagent dispatcher) MUST populate
   * this field; `buildOperationContext` auto-fills 'default' for callers
   * who don't pass an explicit sourceId, so the type contract is
   * satisfied even on single-source brains.
   */
  sourceId: string;
  /**
   * CX2-11 — opaque per-session identity, set from MCP `_meta.session_id`
   * (clamped to 256 chars at the dispatch boundary). Cache/telemetry identity
   * ONLY — never an auth or trust surface. The hot-memory meta hook keys its
   * cache on (sourceId, sessionId, allowlist-hash); before this typed field
   * existed every caller collapsed onto the null-session cache key.
   */
  sessionId?: string;
  /**
   * #2561 / #3242 — federated read scope for UNQUALIFIED reads.
   *
   * Set ONLY by trusted server-side context builders — never from caller
   * params — and only when the caller carries no explicit source scope:
   *   - local CLI (src/cli.ts makeContext) when the source resolved via a
   *     non-explicit tier (local_path / brain_default / sole_non_default /
   *     seed_default — NOT --source, NOT GBRAIN_SOURCE, NOT a dotfile);
   *   - stdio MCP (src/mcp/server.ts) when GBRAIN_SOURCE is unset;
   *   - HTTP MCP (src/mcp/http-transport.ts) for legacy bearer tokens with
   *     NO operator-set `permissions.source_id` grant (the historical
   *     'default' floor). Tokens WITH an explicit grant never widen.
   *
   * Contains the resolved source first, then every other
   * `config.federated = true` source, so an unqualified read/search spans
   * federated sources as docs/guides/multi-source-brains.md promises.
   *
   * Consumed exclusively by `federatedSearchScope` and the graph-four
   * re-route `routeCodeIntelScope` (#4011). Fail-closed remains:
   * a grant (`ctx.auth.allowedSources`) or a per-call `source_id` always
   * wins, and a context without this field never widens.
   */
  localFederatedSourceIds?: string[];
  /**
   * N2-2 — true when the trusted local CLI (src/cli.ts makeContext) resolved
   * `sourceId` from a non-explicit tier (local_path / brain_default /
   * sole_non_default / seed_default, or the pre-init 'default' fallback), i.e.
   * the operator did not select a source. Lets ops whose data has no source
   * axis (find_contradictions' brain-wide stored reports) answer the bare
   * command. Ignored unless `remote === false`; a grant always wins.
   */
  localSourceImplicit?: boolean;
  /**
   * #5081 — explicit-read admission for a stdio connection bound by an
   * explicit tier (`GBRAIN_SOURCE` or a `.gbrain-source` pin). Set ONLY by
   * the stdio transport (src/mcp/server.ts), never from caller params and
   * never for an HTTP token. Unlike `localFederatedSourceIds` it never widens
   * an unqualified read; `federatedSearchScope` only uses it to admit an
   * explicit per-call `source_id` inside `sourceIds`.
   */
  explicitReadBinding?: ExplicitReadBinding;
}

/**
 * #5081 — the bound source, how it was bound, the sources an explicit
 * `source_id` read may name (the bound source first, then every non-archived
 * `config.federated === true` source; just the bound source when it opted out
 * with `config.federated === false`), and the sources that opted out, which
 * only shape the denial hint.
 */
export interface ExplicitReadBinding {
  sourceId: string;
  via: 'GBRAIN_SOURCE' | '.gbrain-source';
  sourceIds: string[];
  optedOut: string[];
}

/**
 * How an op's response is treated before it reaches any caller. `operations.ts`
 * wraps the handler of every `'retrieval'` op once at registration, so the CLI,
 * both MCP transports, subagent tools and `gbrain call` all get the same pass:
 * `redactRetrievalOutput` (canonical scanner, assignment rule on, uncapped)
 * over the whole response, early returns included.
 * - `{ retrieval: { localVerbatim } }`: same pass, but the named top-level keys
 *   are returned unscanned to the trusted local CLI owner (`ctx.remote === false`).
 * - `{ exempt }`: returns stored text deliberately raw; the reason is required.
 * - `'no_stored_text'`: returns no page, chunk, fact, take or transcript text.
 */
export type OutputRedactionPolicy =
  | 'retrieval'
  | { retrieval: { localVerbatim: readonly string[] } }
  | { exempt: string }
  | 'no_stored_text';

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  outputRedaction: OutputRedactionPolicy;
  mutating?: boolean;
  /**
   * What model work this write may do and when (`src/core/ops/write-inference.ts`).
   * Unset resolves through OP_WRITE_INFERENCE, then to `'none'`.
   */
  writeInference?: WriteInference;
  /**
   * Agent contract v1 (A2): repeating the call with the same arguments (and,
   * for journaled writes, the same request identity) has the same effect as
   * calling it once. Drives `idempotentHint` and whether an unknown-outcome
   * failure may say `retryable: true`.
   */
  idempotent?: boolean;
  /**
   * Capability scope required to invoke this op over an authenticated
   * transport. v0.28 added `sources_admin` (manage federated sources) and
   * `users_admin` (reserved). The hierarchy lives in src/core/scope.ts —
   * `admin` implies all, `write` implies `read`, the two `*_admin` scopes
   * are siblings (different axes; neither implies the other). `agent` is
   * also a sibling NOT implied by admin (v0.38 D13): admin tokens must be
   * explicitly re-registered with bindings to touch the agent lane.
   *
   * Local CLI callers (ctx.remote === false) bypass scope enforcement
   * because the trust boundary there is the OS, not OAuth scopes.
   */
  scope?: 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin' | 'agent';
  requiredScopes?: readonly string[];
  localOnly?: boolean;
  /**
   * Agent contract v1 (F5): the handler refuses every agent-facing caller,
   * stdio included; only the trusted local CLI runs it. `isCallable` never
   * lists it on MCP, and a call returns `cli_only` whose fix is this exact
   * command (`<name>` tokens are inputs the agent fills from its call).
   */
  cliOnly?: { argv: readonly string[] };
  /**
   * WP1 honest catalog: the op is callable by remote callers only when this
   * config gate resolves true (dual-plane, DB > file > absent=false). Network
   * transports hide the op from tools/list while the gate is off — a listed
   * tool that always denies reads as broken, not private. The in-handler
   * gate (assertPublishEnabled / the advisor inline check) stays as the
   * fail-closed call-time backstop; stdio (local pipe) bypasses publish
   * gates entirely. Resolution lives in src/mcp/publish-gates.ts.
   */
  publishGateKey?: 'mcp.publish_skills' | 'mcp.publish_advisor';
  /**
   * MEMORY_VERBS v1: marks the seven frozen protocol verbs (recall, remember,
   * entity, synthesize, forget, context_pack, delta). `gbrain serve --surface
   * verbs` exposes EXACTLY the ops with `verb: true`; 'starter' (the ~20-op
   * daily-driver tier) sits between verbs and `full` (default), which exposes
   * everything.
   */
  verb?: boolean;
  /**
   * WP4 (amendment 22) — coarse grouping label consumed by the
   * `request_tools` catalog and the generated tool-catalog doc. Area NAMES
   * ARE NON-CONTRACTUAL: they exist so an agent can scan ~20 groups instead
   * of ~100 flat names; renaming/regrouping is never a breaking change.
   * Required (by the CI walker in test/mcp-tool-defs.test.ts) on every
   * non-localOnly op; populated centrally via OP_AREAS at the bottom of
   * this file.
   */
  area?: string;
  /**
   * WP4 (FOV-4) — marks a discovery meta-op callable by the `agent` scope
   * IN ADDITION to its declared scope. `agent` deliberately implies only
   * itself (v0.38 D13), which would strand agent-only tokens with zero
   * discovery; the MCP scope checks (serve-http tools/list + tools/call)
   * add a one-line carve-out for ops with this flag. Currently only
   * `request_tools`.
   */
  agentCallable?: true;
  /**
   * MCP ToolAnnotations passthrough (SDK 1.29+). Emitted by buildToolDefs
   * ONLY when set — existing tools keep byte-identical definitions.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  cliHints?: {
    name?: string;
    /**
     * Alternate CLI command names that dispatch to this same op (v114 / #1941).
     * e.g. `link-add` aliasing `link`. Registered in `cli.ts`'s `cliAliases`
     * map; collisions with primary names or CLI_ONLY commands throw at startup.
     */
    aliases?: string[];
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
}

/**
 * An op that declares its own `source` param (timeline-add, ontology-add,
 * takes add/update/supersede, raw data) takes `--source` as that param, e.g.
 * provenance. Every CLI route (direct, delegated to a resident serve, thin
 * client) then leaves it out of source scoping and passes it to the handler.
 */
export function opOwnsSource(op: Pick<Operation, 'params'>): boolean {
  return 'source' in op.params;
}
