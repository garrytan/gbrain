/**
 * Foundation contract for the operations layer (pure move from
 * src/core/operations.ts): the error envelope (ErrorCode / OperationError /
 * verbError), the shared param/logger/auth/context types, and the Operation
 * interface that every op declaration conforms to. operations.ts re-exports
 * this entire surface, so existing importers are unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';

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

  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
      detail: this.detail,
      protocol_version: this.protocolVersion,
    };
  }
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
      throw new OperationError(
        'unavailable',
        `${what} is unavailable on this brain: a required table is missing.`,
        'Run gbrain apply-migrations on the brain host, then retry.',
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
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AuthInfo {
  token: string;
  clientId: string;
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
  /**
   * WP4 (amendment 19) — who set `surface`: 'operator' (rescope CLI/admin
   * endpoint; request_tools persist may NOT override it), 'self'
   * (request_tools persist), or 'dcr_default'. Undefined when surface is
   * unset or the projection degraded.
   */
  surfaceSetBy?: string;
}

export interface OperationContext {
  engine: BrainEngine;
  config: GBrainConfig;
  logger: Logger;
  dryRun: boolean;
  /**
   * OAuth auth info (v0.8+). Present when the caller authenticated via OAuth 2.1
   * through `gbrain serve --http`. Contains clientId and granted scopes for
   * per-operation scope enforcement.
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
   * WP4 (D2): the SERVER surface ceiling for this transport (force-clamped),
   * threaded by the MCP dispatch layer. Consumed by `request_tools`: the
   * catalog never names ops above the ceiling, and the persist branch
   * rejects widening past it with a machine-readable denial
   * (`detail: "ceiling=<surface>"`). Unset (local CLI / direct dispatch) is
   * treated as 'full'.
   */
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
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
   * Trust comes from the SUBMITTER (subagent jobs are gated by
   * PROTECTED_JOB_NAMES — MCP cannot submit them), not from `remote`.
   * Every subagent tool call has `remote=true` for auto-link safety,
   * so basing trust on `remote` is incoherent (would always reject).
   *
   * Empty / unset → fall back to the legacy namespace check (existing
   * v0.15 behavior; pure addition, no regression).
   */
  allowedSlugPrefixes?: string[];
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
   * Consumed exclusively by `federatedSearchScope`. Fail-closed remains:
   * a grant (`ctx.auth.allowedSources`) or a per-call `source_id` always
   * wins, and a context without this field never widens.
   */
  localFederatedSourceIds?: string[];
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
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
  localOnly?: boolean;
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
