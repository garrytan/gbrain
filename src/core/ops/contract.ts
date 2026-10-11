/**
 * Foundation contract for the operations layer (types extracted from
 * src/core/operations.ts so domain modules under ops/ can declare ops
 * without a cycle). operations.ts re-exports this entire surface.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
export { OperationError } from '../operation-error.ts';
export type { ErrorCode } from '../operation-error.ts';

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
  /** OAuth-bound MCP tool surface and provenance (Schema 121). */
  surface?: 'verbs' | 'starter' | 'full' | string;
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
   * Transport-LOCALITY axis for localOnly ops: dispatch on 'stdio' (local pipe)
   * and deny on 'http'. Trust decisions MUST NOT key off this field — only
   * `ctx.remote === false` grants trust. Unset is treated as non-local.
   * stdio MCP sets remote:true with transport:'stdio'; localOnly handlers may
   * allow that pair because dispatch already refused HTTP.
   */
  transport?: 'stdio' | 'http';
  /** Effective caller surface and hard transport ceiling. */
  surface?: 'verbs' | 'starter' | 'full';
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
   * Skills directory for a protected subagent job. Dream entity capture sets
   * this so list_skills and get_skill read the packaged skill files without
   * changing the caller's mcp.skills_dir or the remote publication gate.
   */
  skillsDir?: string;
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
   * `takes_list`, `takes_search`, proposal-review operations,
   * `takes_scorecard`, `takes_calibration`,
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
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  scope?: 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin';
  localOnly?: boolean;
  /** MEMORY_VERBS v1: first-class memory protocol surface. */
  verb?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
}
