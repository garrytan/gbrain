/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import { lstatSync, realpathSync } from 'fs';
import { resolve, relative, sep } from 'path';
import type { BrainEngine } from './engine.ts';
import { clampSearchLimit } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import type { PageType } from './types.ts';
import { importFromContent } from './import-file.ts';
import { writePageThrough } from './write-through.ts';
import { hybridSearch, hybridSearchCached, stampContentFlags } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { dedupResults } from './search/dedup.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from './eval-capture.ts';
import type { HybridSearchMeta } from './types.ts';
import { extractPageLinks, isAutoLinkEnabled, isAutoTimelineEnabled, isGlobalBasenameEnabled, parseTimelineEntries, makeResolver, type UnresolvedFrontmatterRef } from './link-extraction.ts';
import { isFactsBackstopEligible } from './facts/eligibility.ts';
import { stripTakesFence } from './takes-fence.ts';
import { stripFactsFence } from './facts-fence.ts';
import { getContentFlag } from './quarantine.ts';
import { bumpLastRetrievedAt } from './last-retrieved.ts';
import { isSearchMode } from './search/mode.ts';
import { stampEvidence } from './search/evidence.ts';
import type { SearchResult } from './types.ts';
import { CJK_SLUG_CHARS } from './cjk.ts';
import * as db from './db.ts';
import { VERSION } from '../version.ts';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
  FIND_EXPERTS_DESCRIPTION,
  GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  LIST_PAGES_DESCRIPTION,
  QUERY_DESCRIPTION,
  SEARCH_DESCRIPTION,
  FIND_CONTRADICTIONS_DESCRIPTION,
  FIND_TRAJECTORY_DESCRIPTION,
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
  LIST_SKILLS_DESCRIPTION,
  GET_SKILL_DESCRIPTION,
} from './operations-descriptions.ts';

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
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});      // OPEN union for forward-compat (eE7 / D13)

export class OperationError extends Error {
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
    };
  }
}

// --- Upload validators (Fix 1 / B5 / H5 / M4) ---

/**
 * Validate an upload path. Two modes:
 *   - strict (remote=true): confines the resolved path to `root` and rejects symlinks.
 *     Used when the caller is untrusted (MCP over stdio/HTTP, agent-facing).
 *   - loose (remote=false): only verifies the file exists and is not a symlink whose
 *     target escapes the filesystem (no path traversal protection). Used for local CLI
 *     where the user owns the filesystem.
 *
 * Either way: symlinks in the final component are always rejected (prevents
 * transparent redirection to a different file than the user typed).
 *
 * @param filePath caller-supplied path
 * @param root confinement root (only used when strict=true)
 * @param strict true → enforce cwd confinement (B5 + H1). false → allow any accessible path.
 * @throws OperationError(invalid_params) on symlink escape, traversal, or missing file
 */
export function validateUploadPath(filePath: string, root: string, strict = true): string {
  let real: string;
  try {
    real = realpathSync(resolve(filePath));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      throw new OperationError('invalid_params', `File not found: ${filePath}`);
    }
    throw new OperationError('invalid_params', `Cannot resolve path: ${filePath}`);
  }
  // Always reject final-component symlinks (basic safety for both modes).
  try {
    if (lstatSync(resolve(filePath)).isSymbolicLink()) {
      throw new OperationError('invalid_params', `Symlinks are not allowed for upload: ${filePath}`);
    }
  } catch (e) {
    if (e instanceof OperationError) throw e;
    // lstat race with unlink — pass if realpath already succeeded.
  }

  if (!strict) return real;

  // Strict mode: confine to root via realpath + path.relative (catches parent-dir symlinks per B5).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new OperationError('invalid_params', `Confinement root not accessible: ${root}`);
  }
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== real) {
    throw new OperationError('invalid_params', `Upload path must be within the working directory: ${filePath}`);
  }
  return real;
}

/**
 * Allowlist validator for page slugs. Rejects URL-encoded traversal, backslashes,
 * control chars, RTL overrides, Unicode lookalikes — anything outside the allowlist.
 * Format: lowercase alphanumeric + hyphen segments separated by single forward slashes.
 */
export function validatePageSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new OperationError('invalid_params', 'page_slug must be a non-empty string');
  }
  if (slug.length > 255) {
    throw new OperationError('invalid_params', 'page_slug exceeds 255 characters');
  }
  // v0.32.7: CJK ranges (Han / Hiragana / Katakana / Hangul Syllables) allowed
  // in segments. ASCII shape rules (lead char, hyphen continuation) preserved.
  const PAGE_SLUG_SEG = `[a-z0-9${CJK_SLUG_CHARS}][a-z0-9${CJK_SLUG_CHARS}\\-]*`;
  if (!new RegExp(`^${PAGE_SLUG_SEG}(\\/${PAGE_SLUG_SEG})*$`, 'i').test(slug)) {
    throw new OperationError('invalid_params', `Invalid page_slug: ${slug} (allowed: alphanumeric, CJK, hyphens, forward-slash separated segments)`);
  }
}

/**
 * Match a slug against a list of allow-list prefix globs.
 *
 * Glob form: `<prefix>/*` matches any slug starting with `<prefix>/` and
 * having at least one more segment (single or multi). Bare `<prefix>` (no
 * trailing `/*`) matches that exact slug only. The `*` is intentionally
 * permissive — depth is unbounded, so `wiki/originals/*` matches both
 * `wiki/originals/idea-x` and `wiki/originals/ideas/2026-04-25-idea-y`.
 *
 * Used by the v0.23 dream-cycle trusted-workspace path. Order doesn't
 * matter; the first match wins (returns true on any match).
 */
export function matchesSlugAllowList(slug: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (p.endsWith('/*')) {
      const base = p.slice(0, -2);
      if (slug === base) continue;
      if (slug.startsWith(base + '/')) return true;
    } else if (p === slug) {
      return true;
    }
  }
  return false;
}

/**
 * Allowlist validator for uploaded file basenames. Rejects control chars, backslashes,
 * RTL overrides (\u202E), leading dot (hidden files) and leading dash (CLI flag confusion).
 * Allows extension dots and underscores. Max 255 chars.
 */
export function validateFilename(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new OperationError('invalid_params', 'Filename must be a non-empty string');
  }
  if (name.length > 255) {
    throw new OperationError('invalid_params', 'Filename exceeds 255 characters');
  }
  // v0.32.7: CJK ranges (Han / Hiragana / Katakana / Hangul) allowed in filenames.
  // Leading-dot / leading-dash rejection preserved.
  const FILENAME_RE = new RegExp(`^[a-zA-Z0-9${CJK_SLUG_CHARS}][a-zA-Z0-9${CJK_SLUG_CHARS}._\\-]*$`);
  if (!FILENAME_RE.test(name)) {
    throw new OperationError('invalid_params', `Invalid filename: ${name} (allowed: alphanumeric, CJK, dot, underscore, hyphen — no leading dot/dash, no control chars or backslash)`);
  }
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
}

/**
 * v0.34.1 (#861, D9 — P0 leak seal): resolve the source-scope filter for a
 * read-side op handler. Returns an opts fragment ready to spread into the
 * engine call.
 *
 * Precedence:
 *  1. `ctx.auth?.allowedSources` (federated read, #876) → emits
 *     `{sourceIds: [...]}`. Federated semantics subsume the scalar case.
 *  2. `ctx.sourceId` (scalar) → emits `{sourceId: '...'}`.
 *  3. Neither set → emits `{}`. Local CLI callers (and tests that don't
 *     populate ctx) keep the pre-v0.34 unscoped behavior.
 *
 * Both fields default to the engine's "no filter" behavior individually,
 * so unset values are safe — the engine sees the same shape it did
 * pre-v0.34. The leak this guards against is an authenticated MCP client
 * whose ctx.sourceId IS set but whose engine call was constructed without
 * threading it (operations.ts:968/1076/1092/935/1469/1471/2241 pre-fix).
 *
 * Helper rather than inline so every read-side handler routes through the
 * same precedence ladder — drift between sites is the bug class.
 */
export function sourceScopeOpts(ctx: OperationContext): { sourceId?: string; sourceIds?: string[] } {
  const allowed = ctx.auth?.allowedSources;
  // Treat an empty `allowedSources: []` as "no federated read scope" — the
  // op-handler defers to scalar `ctx.sourceId` below. An attacker-controlled
  // value of `[]` MUST NOT widen scope to "all sources" by being interpreted
  // as "no filter."
  if (allowed && allowed.length > 0) return { sourceIds: allowed };
  if (ctx.sourceId) return { sourceId: ctx.sourceId };
  return {};
}

/**
 * #2200: source scope for the LINK read ops (get_links / get_backlinks). A link
 * row references three pages (from, to, origin); the engine's federated
 * (`sourceIds[]`) branch scopes ALL THREE, but its scalar (`sourceId`) branch
 * scopes only the near endpoint — by design, because trusted internal callers
 * (reconcileLinks, back-link validators, enrich) call the engine directly with a
 * scalar scope and need the cross-source view.
 *
 * An UNTRUSTED remote caller carrying only a scalar scope (a legacy bearer token
 * or a pre-`federated_read` OAuth client) would otherwise hit that scalar branch
 * and have a foreign far/origin slug disclosed. So for remote callers we promote a
 * scalar scope to a single-element `sourceIds:[id]`, routing them through the
 * all-endpoint branch. Trusted local CLI (`ctx.remote === false`) keeps the scalar
 * cross-source view, and a federated array passes through unchanged.
 */
export function linkReadScopeOpts(ctx: OperationContext): { sourceId?: string; sourceIds?: string[] } {
  const scope = sourceScopeOpts(ctx);
  if (ctx.remote !== false && scope.sourceId && !scope.sourceIds) {
    return { sourceIds: [scope.sourceId] };
  }
  return scope;
}

/**
 * Resolve a per-call requested source scope against the caller's trust + grant.
 * FAIL-CLOSED: anything not strictly `ctx.remote === false` is untrusted.
 *
 * This is the SINGLE resolver for every read op that accepts a per-call
 * `source_id` / `all_sources` parameter (query, code_callers, code_callees,
 * get_page, search_by_image, code_blast, code_flow). Inlining the `__all__`
 * branch per handler is the bug class that leaked cross-source reads (#1924,
 * #1371): a remote client could pass `source_id: '__all__'` to opt out of its
 * grant, or pass an explicit out-of-grant `source_id` that was never checked.
 *
 *   - `__all__` / `all_sources`:
 *       trusted local (remote === false) → `{}` (spans the whole brain)
 *       remote                           → the caller's grant (sourceScopeOpts)
 *   - explicit `source_id`:
 *       remote + federated grant that doesn't include it → permission_denied
 *       otherwise                                        → `{ sourceId }`
 *   - neither → the caller's grant (sourceScopeOpts).
 *
 * `code_traversal_cache_clear` is intentionally NOT a caller — it is localOnly
 * and carries its own destructive D8 all_sources guard.
 */
export function resolveRequestedScope(
  ctx: OperationContext,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
): { sourceId?: string; sourceIds?: string[] } {
  const wantsAll = allSourcesParam || sourceIdParam === '__all__';
  if (wantsAll) {
    return ctx.remote === false ? {} : sourceScopeOpts(ctx);
  }
  if (sourceIdParam !== undefined) {
    const allowed = ctx.auth?.allowedSources;
    if (ctx.remote !== false && allowed && allowed.length > 0 && !allowed.includes(sourceIdParam)) {
      throw new OperationError(
        'permission_denied',
        `source '${sourceIdParam}' is outside your granted sources`,
        'Request access to this source, or omit source_id to search within your grant.',
      );
    }
    return { sourceId: sourceIdParam };
  }
  return sourceScopeOpts(ctx);
}

/**
 * Code-intel adapter for `resolveRequestedScope`. Graph traversal
 * (code_callers/code_callees/code_blast/code_flow) is single-source by design —
 * the engine APIs and the traversal cache key take ONE `sourceId` string, not a
 * federated array. So this collapses the resolver's output to `{allSources,
 * sourceId}`, fail-closed:
 *
 *   - resolver → one source (scalar or single-element grant) → that source
 *   - resolver → multi-source grant (federated remote client) → reject: ask the
 *     caller to specify which granted source (we must not silently span all)
 *   - resolver → empty scope → `allSources` ONLY for trusted local callers; a
 *     remote caller with no source in scope is denied, never widened to all.
 */
export function resolveCodeIntelScope(
  ctx: OperationContext,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
): { allSources: boolean; sourceId?: string } {
  const scope = resolveRequestedScope(ctx, sourceIdParam, allSourcesParam);
  if (scope.sourceId) return { allSources: false, sourceId: scope.sourceId };
  if (scope.sourceIds && scope.sourceIds.length === 1) {
    return { allSources: false, sourceId: scope.sourceIds[0] };
  }
  if (scope.sourceIds && scope.sourceIds.length > 1) {
    throw new OperationError(
      'invalid_params',
      'Code traversal runs against a single source. Specify source_id (one of your granted sources).',
      'Pass source_id=<one of your sources>.',
    );
  }
  // Empty scope: span everything only for trusted local callers; a remote caller
  // that reached here has no source in scope and must NOT get cross-source results.
  if (ctx.remote === false) return { allSources: true, sourceId: undefined };
  throw new OperationError(
    'permission_denied',
    'No source in scope for this request.',
    'Specify source_id, or check your granted sources.',
  );
}

/**
 * T4/D5 — resolve a per-call search-mode override. Honored ONLY for trusted/
 * local callers (ctx.remote === false) so a remote OAuth client can't escalate
 * to the costly tokenmax bundle. Local + unknown mode → loud reject; remote +
 * mode → silently ignored (server-configured mode wins). Returns undefined to
 * mean "use the configured mode".
 */
export function resolvePerCallMode(ctx: OperationContext, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (ctx.remote !== false) return undefined; // remote can't select mode
  if (!isSearchMode(raw)) {
    throw new OperationError(
      'invalid_params',
      `Unknown search mode '${raw}'. Valid: conservative, balanced, tokenmax.`,
      `gbrain search "<query>" --mode balanced`,
    );
  }
  return raw;
}

/** T4 — stamp evidence/create_safety on a result set, fail-soft. */
function stampEvidenceSafe(results: SearchResult[]): void {
  try { stampEvidence(results); } catch { /* non-fatal */ }
}

/** T4 — shared eval-capture for the `search` op (keyword-only + cheap-hybrid paths). */
function maybeCaptureSearch(
  ctx: OperationContext,
  queryText: string,
  results: SearchResult[],
  latency_ms: number,
  vectorEnabled: boolean,
  meta?: HybridSearchMeta | null,
): void {
  if (!isEvalCaptureEnabled(ctx.config)) return;
  void captureEvalCandidate(
    ctx.engine,
    {
      tool_name: 'search',
      query: queryText,
      results,
      meta: meta ?? { vector_enabled: vectorEnabled, detail_resolved: null, expansion_applied: false },
      latency_ms,
      remote: ctx.remote ?? false,
      expand_enabled: false,
      detail: null,
      job_id: ctx.jobId ?? null,
      subagent_id: ctx.subagentId ?? null,
    },
    { scrub_pii: isEvalScrubEnabled(ctx.config) },
  );
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
   * are siblings (different axes; neither implies the other).
   *
   * Local CLI callers (ctx.remote === false) bypass scope enforcement
   * because the trust boundary there is the OS, not OAuth scopes.
   */
  scope?: 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin';
  localOnly?: boolean;
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

// --- Page CRUD ---

const get_page: Operation = {
  name: 'get_page',
  description: 'Read a page by slug (supports optional fuzzy matching). Soft-deleted pages are hidden by default; pass include_deleted: true to surface them with deleted_at populated (see v0.26.5 recovery window).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
    include_deleted: { type: 'boolean', description: 'v0.26.5: surface soft-deleted pages with deleted_at populated (default: false). Used by restore workflows.' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;
    const includeDeleted = (p.include_deleted as boolean) === true;
    // #1393: route BOTH the exact-match read and the fuzzy resolveSlugs through
    // the canonical precedence ladder (federated array > scalar > nothing). The
    // exact path previously used scalar `ctx.sourceId` only, so a remote client
    // with a federated `allowedSources` grant (and no single ctx.sourceId) got
    // an UNSCOPED exact lookup — a cross-source read of any page by slug. getPage
    // now honors sourceIds[] (both engines), so the same scope closes both paths.
    const sourceOpts = sourceScopeOpts(ctx);
    const fuzzyScope = sourceOpts;

    let page = await ctx.engine.getPage(slug, { includeDeleted, ...sourceOpts });
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug, fuzzyScope);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0], { includeDeleted, ...sourceOpts });
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, includeDeleted ? 'Check the slug or use fuzzy: true' : 'Page may be soft-deleted; pass include_deleted: true to verify');
    }

    // v0.37.0 (D11): op-layer write-back for the `last_retrieved_at` stale
    // signal. Fire-and-forget — caller does NOT await. Internal callers
    // (sync, migrations, dream cycle) bypass this op handler so the signal
    // stays clean. Throttled to ~1 write / 5 min per page via the SQL clause
    // inside bumpLastRetrievedAt (D2).
    bumpLastRetrievedAt(ctx.engine, [page.id]);

    // #2200: resolve tags against the concrete page's source. `sourceOpts` may
    // be { sourceIds:[...] } (federated) with no scalar sourceId, which getTags
    // would otherwise fall back to 'default' for — the wrong source for a
    // non-default page. We already hold the resolved page, so its source is
    // unambiguous.
    const tags = await ctx.engine.getTags(page.slug, { sourceId: page.source_id });
    // Privacy boundary for the per-token allow-list (v0.28.6 for takes,
    // v0.32.2 for facts).
    //
    // takes_list / takes_search / think.gather filter rows by holder at
    // the SQL layer, but takes AND facts are also rendered as markdown
    // tables inside the page body between fence markers. A read-only
    // remote MCP caller could otherwise call `get_page <slug>` and
    // recover every fence row verbatim.
    //
    // v0.32.2 (Codex R2-#5): the strip trigger is now `ctx.remote === true`
    // rather than the takes-holders-allow-list flag (which subagent paths
    // didn't set, leaving a pre-existing privacy hole). Subagent + remote
    // MCP + scope-restricted-token callers all get the strip; local CLI
    // (`ctx.remote === false`) sees the full fence. Closes the
    // pre-existing takes hole as a bonus.
    //
    // Both fences are stripped:
    //  - stripTakesFence: drops the entire takes table for untrusted
    //    readers (per-token holder allow-list is the row-level surface
    //    for trusted callers).
    //  - stripFactsFence({keepVisibility: ['world']}): keeps world rows,
    //    drops private. World facts are public knowledge by definition;
    //    untrusted readers see them. Private facts never cross the boundary.
    const isUntrustedReader = ctx.remote === true;
    const visibleBody = isUntrustedReader
      ? {
          ...page,
          compiled_truth: stripFactsFence(
            stripTakesFence(page.compiled_truth),
            { keepVisibility: ['world'] },
          ),
        }
      : page;
    // v0.42 (#1699) agent-warning channel: surface the page's content_flag
    // marker as a top-level field (parallel to SearchResult.content_flag) so
    // an agent reading a page directly gets the same "this looks odd, examine
    // it" signal it would get from search. The marker is also in frontmatter;
    // this is the clean, documented accessor.
    const content_flag = getContentFlag(page.frontmatter as Record<string, unknown> | null);
    return {
      ...visibleBody,
      tags,
      ...(resolved_slug ? { resolved_slug } : {}),
      ...(content_flag ? { content_flag } : {}),
    };
  },
  scope: 'read',
  cliHints: { name: 'get', positional: ['slug'] },
};

const put_page: Operation = {
  name: 'put_page',
  description: 'Write/update a page (markdown with frontmatter). Chunks, embeds, reconciles tags, and (when auto_link/auto_timeline are enabled) extracts + reconciles graph links and timeline entries. For large content on Windows (pipe-buffer limit ~45KB) or any file-as-input workflow, use `gbrain capture --file PATH --slug SLUG` — capture reads the file as a Buffer with a binary-NUL guard and adds provenance write-through (v0.39.3.0).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },
    // v0.39.3.0 provenance write-through (WARN-8 + A1 + CV6). Optional fields
    // for trusted local callers (capture CLI, autopilot, dream cycle). Remote
    // MCP callers (ctx.remote !== false) have their values OVERRIDDEN with
    // server stamps below; the params are accepted on the wire only so the
    // op schema stays uniform across transports. Audit-trail spoofing is
    // closed structurally — clients cannot poison source_kind labels.
    source_kind: { type: 'string', required: false, description: 'Ingestion channel taxonomy (capture-cli | put_page | webhook | …). Remote callers: SERVER-STAMPED, client value ignored.' },
    source_uri: { type: 'string', required: false, description: 'Original URI/path/message-id the event carried. Remote callers: SERVER-STAMPED null.' },
    ingested_via: { type: 'string', required: false, description: 'Richer label paired with source_kind. Remote callers: SERVER-STAMPED.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;

    // v0.39.3.0 CV6 trust gate for provenance write-through (WARN-8).
    // Only trusted LOCAL callers (ctx.remote === false — capture CLI,
    // autopilot, dream cycle, file watcher) may populate source_kind /
    // source_uri / ingested_via from their own state. Anything else
    // (HTTP MCP, stdio MCP, subagent) gets the server-stamped
    // `mcp:put_page` regardless of what was passed.
    //
    // Closes the spoofing surface CV6 identified: pre-fix a write-scope
    // OAuth token could send `source_kind: 'capture-cli'` to poison the
    // audit trail. Fail-closed: `ctx.remote === false` is the ONLY truthy
    // condition that admits client-supplied provenance.
    let provenanceKind: string | null;
    let provenanceUri: string | null;
    let provenanceVia: string | null;
    if (ctx.remote === false) {
      // Trusted local caller: honor the client params (may be null/undefined
      // for legacy local callers that don't set them).
      provenanceKind = (p.source_kind as string | undefined) ?? null;
      provenanceUri = (p.source_uri as string | undefined) ?? null;
      provenanceVia = (p.ingested_via as string | undefined) ?? null;
    } else {
      // Remote caller or unset trust: server stamps. Mirrors the existing
      // write-through stamping at the file-side (~:637).
      provenanceKind = 'mcp:put_page';
      provenanceUri = null;
      provenanceVia = 'mcp:put_page';
    }

    // Subagent namespace enforcement (v0.15+). Runs BEFORE the dry-run
    // short-circuit so preview calls surface the same rejection. Confines
    // LLM-driven writes to wiki/agents/<subagentId>/... — no leading slash
    // (slug grammar rejects that), anchored, slash-boundary to defeat prefix
    // collisions like `wiki/agents/12evil/*` impersonating subagent 12.
    //
    // FAIL-CLOSED: `viaSubagent=true` enforces the check even if the
    // dispatcher forgot to populate `subagentId`. Agent-originated writes
    // without an owning subagent id are rejected outright.
    if (ctx.viaSubagent === true) {
      if (typeof ctx.subagentId !== 'number' || Number.isNaN(ctx.subagentId)) {
        throw new OperationError('permission_denied', 'put_page via subagent requires ctx.subagentId');
      }
      const allowList = ctx.allowedSlugPrefixes;
      if (allowList && allowList.length > 0) {
        // Trusted-workspace path: explicit allow-list bounds writes.
        // Set only by cycle.ts (synthesize/patterns) which submits subagent
        // jobs under PROTECTED_JOB_NAMES — MCP cannot reach this branch.
        if (!matchesSlugAllowList(slug, allowList)) {
          throw new OperationError(
            'permission_denied',
            `put_page slug '${slug}' is not within the trusted-workspace allow-list (${allowList.join(', ')})`
          );
        }
      } else {
        // Legacy default: agent-namespace confinement.
        const prefix = `wiki/agents/${ctx.subagentId}/`;
        if (!slug.startsWith(prefix) || slug.length === prefix.length) {
          throw new OperationError('permission_denied', `put_page via subagent must write under '${prefix}...'`);
        }
      }
    }

    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug: p.slug };
    // Skip embedding when the AI gateway has no embedding provider configured.
    // Checks all auth env vars for the resolved provider, not just OPENAI_API_KEY,
    // so Gemini / Ollama / Voyage brains don't silently drop embeddings (Codex C2).
    const { isAvailable } = await import('./ai/gateway.ts');
    const noEmbed = !isAvailable('embedding');
    // v0.31.8 (D7 / codex OV-1): thread ctx.sourceId so put_page on a
    // multi-source brain lands in the intended source instead of the
    // default-source clobber path. importFromContent already accepts
    // opts.sourceId (PR #707/#757 engine work); previously the op handler
    // just didn't pass it.
    // v0.39 T1.5: load active pack ONCE per put_page invocation; thread to
    // parseMarkdown via importFromContent so type inference honors user-defined
    // page_types. Best-effort: pack load failure falls back to legacy inferType
    // (parity gate preserved). Federated-read closure correction is T19's scope.
    let activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
    try {
      const { loadActivePack } = await import('./schema-pack/load-active.ts');
      const { loadConfig } = await import('./config.ts');
      const resolved = await loadActivePack({
        cfg: loadConfig(),
        remote: ctx.remote === false ? false : true,
        sourceId: ctx.sourceId,
      });
      activePack = { page_types: resolved.manifest.page_types };
    } catch {
      // Pack load failed; fall through to legacy inferType behavior.
      activePack = undefined;
    }
    const result = await importFromContent(ctx.engine, slug, p.content as string, {
      noEmbed,
      // v0.42 (#1699): untrusted callers can't smuggle gate-owned frontmatter
      // markers (quarantine/content_flag/embed_skip). Fail-closed — anything
      // not strictly local is remote (matches CV6 / v0.26.9 F7b posture).
      remote: ctx.remote !== false,
      ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
      // v0.39.0.0 T1.5: pack-aware type inference (loaded above; legacy
      // inferType behavior when undefined).
      ...(activePack ? { activePack } : {}),
      // v0.39.3.0 provenance write-through (WARN-8). Trust-filtered values
      // computed above; ingested_at is server-stamped at the engine layer.
      // Null-valued fields signal "no provenance write this call" and the
      // engine's COALESCE-preserve UPDATE keeps the prior first-write
      // record intact (CV12 audit-trail survival).
      source_kind: provenanceKind,
      source_uri: provenanceUri,
      ingested_via: provenanceVia,
    });

    // v0.39 T13 — auto-prompt on first unknown-type write.
    //
    // Contract (codex finding #8 honored — 7 cases covered):
    //   - TTY callers: stderr prompt fires once per unique unknown type;
    //     subsequent writes with the same type silently append to
    //     candidate audit.
    //   - Non-TTY callers: ALWAYS succeed; silently append to candidate
    //     audit. NEVER block. Critical regression test:
    //     test/put-page-unknown-type-prompt.test.ts pins this.
    //   - Subagent / MCP / claw-test / autopilot all go through here;
    //     non-TTY contract preserves their semantics.
    //   - Pack-load failures (activePack undefined) skip the gate entirely
    //     since "unknown" has no meaning without a pack reference.
    if (activePack && result.status === 'imported') {
      try {
        const pageType = (result as { page?: { type?: string } }).page?.type ?? null;
        const knownTypes = new Set(activePack.page_types.map((t) => t.name));
        if (pageType && !knownTypes.has(pageType)) {
          const { logSchemaEvent } = await import('./schema-events.ts');
          logSchemaEvent({
            verb: 'put_page:unknown_type',
            outcome: 'success',
            flags: [`type=${pageType.slice(0, 32)}`, `slug=${slug.slice(0, 64)}`],
          });
          if (process.stderr.isTTY && ctx.remote === false) {
            console.error(
              `[schema] put_page wrote type=\`${pageType}\` which isn't in active pack \`${activePack.page_types.length ? '<configured>' : 'gbrain-base'}\`. ` +
              `Run \`gbrain schema review-candidates\` to promote or ignore.`,
            );
          }
        }
      } catch {
        // best-effort; never block put_page
      }
    }

    // v0.38 put_page write-through (ingestion cathedral):
    // After importFromContent succeeds, if `sync.repo_path` resolves to a
    // real directory, persist the markdown file to disk alongside the DB
    // row. Failures non-fatal — DB write is durable; subsequent sync
    // reconciles drift.
    //
    // Trust gating:
    //   - Subagent sandbox (viaSubagent without allowedSlugPrefixes) → DB-only.
    //   - All other writes → write-through.
    let writeThrough: { written: boolean; path?: string; skipped?: string; error?: string } | undefined;
    const isSandboxSubagent = ctx.viaSubagent === true
      && !(Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0);
    if (!ctx.dryRun && result.status !== 'error' && !isSandboxSubagent) {
      const sourceId = ctx.sourceId ?? 'default';
      const provenanceVia = ctx.remote === false ? 'put_page' : 'mcp:put_page';
      // Shared canonical write-through (also used by `gbrain brainstorm/lsd
      // --save`). Renders the file from the saved DB row and writes it
      // atomically; never throws (failures land in skipped/error).
      writeThrough = await writePageThrough(ctx.engine, result.slug, {
        sourceId,
        frontmatterOverrides: {
          ingested_via: provenanceVia,
          ingested_at: new Date().toISOString(),
          source_kind: provenanceVia,
        },
        logger: ctx.logger,
      });
    } else if (isSandboxSubagent) {
      writeThrough = { written: false, skipped: 'subagent_sandbox' };
    } else if (ctx.dryRun) {
      writeThrough = { written: false, skipped: 'dry_run' };
    }

    // Auto-link post-hook: runs AFTER importFromContent (which is its own
    // transaction). Runs even on status='skipped' so reconciliation catches drift
    // between the page text and the links table. Failures are non-blocking.
    //
    // SECURITY: skipped for remote (MCP) callers. Auto-link's bare-slug regex
    // matches `people/X` etc. anywhere in page text, including code fences,
    // quoted strings, and prompt-injected content. An untrusted page can plant
    // arbitrary outbound links by including `see meetings/board-q1` in its body.
    // Combined with the backlink boost in hybridSearch, attacker-placed targets
    // would surface higher in search. Local CLI users (ctx.remote=false) opt
    // into this behavior; MCP/remote writes do not.
    let autoLinks:
      | { created: number; removed: number; errors: number; unresolved: UnresolvedFrontmatterRef[] }
      | { error: string }
      | { skipped: 'remote' }
      | undefined;
    let autoTimeline: { created: number } | { error: string } | { skipped: 'remote' } | undefined;
    // Trusted-workspace path (v0.23 dream cycle) re-enables auto-link/timeline
    // even though ctx.remote=true, because the allow-list bounds the slug and
    // the synthesis prompt is itself the trusted dispatcher. Without this,
    // the cycle's `extract` phase would have to recompute every edge, and
    // patterns (which runs after extract) would still see the right graph
    // but auto_timeline would never fire on synth output.
    const trustedWorkspace = ctx.viaSubagent === true
      && Array.isArray(ctx.allowedSlugPrefixes)
      && ctx.allowedSlugPrefixes.length > 0;
    if (ctx.remote !== false && !trustedWorkspace) {
      autoLinks = { skipped: 'remote' };
      autoTimeline = { skipped: 'remote' };
    } else if (result.parsedPage) {
      try {
        const enabled = await isAutoLinkEnabled(ctx.engine);
        if (enabled) {
          autoLinks = await runAutoLink(ctx.engine, slug, result.parsedPage, ctx.sourceId ? { sourceId: ctx.sourceId } : undefined);
        }
      } catch (e) {
        autoLinks = { error: e instanceof Error ? e.message : String(e) };
      }
      // Timeline extraction mirrors auto-link: runs post-write, best-effort,
      // never blocks the write. ON CONFLICT DO NOTHING in
      // addTimelineEntriesBatch keeps it idempotent across re-writes, so a
      // page that's edited and re-written won't duplicate its own timeline.
      try {
        const enabled = await isAutoTimelineEnabled(ctx.engine);
        if (enabled) {
          const fullContent = result.parsedPage.compiled_truth + '\n' + result.parsedPage.timeline;
          const entries = parseTimelineEntries(fullContent);
          if (entries.length > 0) {
            const batch = entries.map(e => ({
              slug,
              date: e.date,
              summary: e.summary,
              detail: e.detail || '',
            }));
            // v0.41.18.0: engine self-retries on Supavisor circuit-breaker
            // recovery. auditSite label routes the audit JSONL emission so
            // operators can attribute losses to the agent-write path.
            const created = await ctx.engine.addTimelineEntriesBatch(batch, { auditSite: 'mcp.put_page.autolink' });
            autoTimeline = { created };
          } else {
            autoTimeline = { created: 0 };
          }
        }
      } catch (e) {
        autoTimeline = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // v0.31 (D23): facts compliance backstop. When an agent writes a page
    // on a conversation-shape slug AND the body has substantive prose, fire
    // a fact-extraction job into the bounded queue. Skipped on dry-run,
    // dream-generated content (anti-loop), and non-eligible kinds (sync,
    // ingest, file uploads, code pages). Never blocks the put_page response.
    // v0.31.2: routed through runFactsBackstop (PR1 commit 6) so put_page
    // and sync share the same eligibility/extract/dedup/insert pipeline.
    // Queue mode preserves the prior fire-and-forget shape (caller's
    // put_page response stays fast). Default 'all' notability filter
    // (MEDIUM facts wait for the dream cycle but DO land via put_page,
    // matching the pre-fix behavior on this surface).
    let factsQueued: { queued: boolean } | { skipped: string } | undefined;
    try {
      const { runFactsBackstop } = await import('./facts/backstop.ts');
      const r = await runFactsBackstop(
        {
          slug,
          type: result.parsedPage!.type,
          compiled_truth: result.parsedPage!.compiled_truth,
          frontmatter: result.parsedPage!.frontmatter,
        },
        {
          engine: ctx.engine,
          sourceId: ctx.sourceId ?? 'default',
          sessionId: (ctx as { source_session?: string }).source_session ?? null,
          source: 'mcp:put_page',
          mode: 'queue',
        },
      );
      if (r.mode === 'queue' && r.enqueued) {
        factsQueued = { queued: true };
      } else if (r.mode === 'queue' && r.skipped) {
        // Preserve the pre-v0.31.2 response shape for MCP clients:
        // 'kind:guide' / 'too_short' / 'subagent_namespace' / 'dream_generated'
        // (bare reasons), not the helper's namespaced 'eligibility_failed:...'
        // discriminator. Map back here.
        const bare = r.skipped.startsWith('eligibility_failed:')
          ? r.skipped.slice('eligibility_failed:'.length)
          : r.skipped;
        factsQueued = { skipped: bare };
      }
    } catch {
      factsQueued = { skipped: 'backstop_error' };
    }

    // v0.42.x (#2390): Life Chronicle backstop. ONLY on a real import
    // (status==='imported' — a skipped/unchanged rewrite still carries
    // parsedPage, so gating on parsedPage alone would re-enqueue forever),
    // behind the SAME trust gate as auto-link/timeline + the auto_chronicle
    // flag. Enqueues a chronicle_extract job; never blocks the write.
    let chronicleQueued: { queued: boolean } | { skipped: string } | undefined;
    if (result.status !== 'imported') {
      chronicleQueued = { skipped: 'not_imported' };
    } else if (ctx.remote !== false && !trustedWorkspace) {
      chronicleQueued = { skipped: 'remote' };
    } else if (result.parsedPage) {
      try {
        const { runChronicleBackstop } = await import('./chronicle/backstop.ts');
        const r = await runChronicleBackstop(
          {
            slug,
            type: result.parsedPage.type,
            compiled_truth: result.parsedPage.compiled_truth,
            frontmatter: result.parsedPage.frontmatter,
          },
          { engine: ctx.engine, sourceId: ctx.sourceId ?? 'default' },
        );
        chronicleQueued = r.enqueued ? { queued: true } : { skipped: r.skipped ?? 'skipped' };
      } catch {
        chronicleQueued = { skipped: 'backstop_error' };
      }
    }

    // Post-write validator lint (PR 2.5): feature-flag-gated, non-blocking.
    // When `writer.lint_on_put_page` is enabled, runs the BrainWriter's
    // validators on the freshly-written page and logs findings to
    // ingest_log + ~/.gbrain/validator-lint.jsonl. Does NOT reject the
    // write — that's the deferred strict-mode flip after the 7-day soak.
    let writerLint: { error_count: number; warning_count: number } | { skipped: string } | undefined;
    try {
      const { runPostWriteLint } = await import('./output/post-write.ts');
      const lint = await runPostWriteLint(ctx.engine, result.slug);
      if (lint.ran) {
        writerLint = {
          error_count: lint.findings.filter(f => f.severity === 'error').length,
          warning_count: lint.findings.filter(f => f.severity === 'warning').length,
        };
      } else if (lint.skippedReason) {
        writerLint = { skipped: lint.skippedReason };
      }
    } catch {
      // Non-fatal; never blocks put_page.
    }

    return {
      slug: result.slug,
      status: result.status === 'imported' ? 'created_or_updated' : result.status,
      chunks: result.chunks,
      ...(autoLinks ? { auto_links: autoLinks } : {}),
      ...(autoTimeline ? { auto_timeline: autoTimeline } : {}),
      ...(writerLint ? { writer_lint: writerLint } : {}),
      ...(factsQueued ? { facts_backstop: factsQueued } : {}),
      ...(chronicleQueued ? { chronicle_backstop: chronicleQueued } : {}),
      ...(writeThrough ? { write_through: writeThrough } : {}),
    };
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

// v0.31.2: isFactsBackstopEligible moved to src/core/facts/eligibility.ts
// so sync.ts, file_upload, code_import, and runFactsBackstop all share one
// predicate. Imported above.

/**
 * Extract entity refs from a freshly-written page, sync the links table to match.
 * Creates new links via addLink, removes stale ones (links present in DB but no
 * longer referenced in content) via removeLink. Returns counts.
 *
 * Runs OUTSIDE importFromContent's transaction so it doesn't block the page write
 * or get rolled back if a single link operation fails. Per-link failures are
 * counted; the overall function never throws (catch in put_page handler covers
 * extraction errors).
 */
async function runAutoLink(
  engine: BrainEngine,
  slug: string,
  parsed: { type: PageType; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> },
  opts?: { sourceId?: string },
): Promise<{ created: number; removed: number; errors: number; unresolved: UnresolvedFrontmatterRef[] }> {
  const fullContent = parsed.compiled_truth + '\n' + parsed.timeline;
  // v0.31.8 (codex OV-2): thread sourceId through every read + write inside
  // reconcileLinks. Without this the FS walker reads cross-source links/slugs
  // but writes scoped to one source — phantom stale-deletions and duplicate
  // inserts. opts.sourceId is set when caller knows the source (put_page from
  // a multi-source-aware handler); when omitted, every read returns the
  // pre-v0.31.8 cross-source view (back-compat for any existing caller).
  const sourceOpts = opts?.sourceId ? { sourceId: opts.sourceId } : {};
  const linkSourceOpts = opts?.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId, originSourceId: opts.sourceId }
    : {};
  const removeSourceOpts = opts?.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId }
    : {};

  // Live-mode resolver: per-put throwaway cache, pg_trgm + optional search.
  // Issue #972 (codex [P1]): pass sourceId so basename resolution stays
  // within this page's source — no cross-source basename edges.
  const resolver = makeResolver(engine, { mode: 'live', sourceId: opts?.sourceId });
  // Issue #972: opt-in bare-wikilink basename resolution. Off by default.
  const globalBasename = await isGlobalBasenameEnabled(engine);
  const { candidates, unresolved } = await extractPageLinks(
    slug, fullContent, parsed.frontmatter, parsed.type, resolver,
    { globalBasename },
  );

  // Resolve which targets exist (skip refs to non-existent pages to avoid FK
  // violation churn in addLink). One getAllSlugs call upfront, O(1) lookup.
  // v0.31.8 (D12): scoped to the source when opts.sourceId is set so wikilink
  // resolution doesn't span unrelated sources.
  const allSlugs = await engine.getAllSlugs(sourceOpts);
  const valid = candidates.filter(c =>
    allSlugs.has(c.targetSlug) && (!c.fromSlug || allSlugs.has(c.fromSlug))
  );

  // Split candidates by direction. Outgoing (fromSlug === slug or unset) are
  // this page's own edges, reconciled against getLinks(slug). Incoming
  // (fromSlug !== slug — frontmatter with `direction: incoming`) are edges
  // where this page is the TO side; reconciled against getBacklinks(slug)
  // but SCOPED to the frontmatter edges this page authored via
  // (link_source='frontmatter' AND origin_slug = slug). We never touch
  // frontmatter edges authored by OTHER pages.
  const out = valid.filter(c => !c.fromSlug || c.fromSlug === slug);
  const inc = valid.filter(c => c.fromSlug && c.fromSlug !== slug);

  // Run getLinks + addLink/removeLink loops inside a single transaction so that
  // concurrent put_page calls on the same slug can't race the reconciliation:
  // without this, two simultaneous writes both read stale `existingKeys` and
  // re-create links the other side just removed (lost-update).
  //
  // Row-level locks alone aren't enough: both writers can read the same
  // `existingKeys` set BEFORE either mutates a row, so the union-of-writes
  // race survives. A transaction-scoped advisory lock keyed on the slug
  // hash serializes the entire reconciliation across processes. Falls
  // through on engines that don't support pg_advisory_xact_lock (PGLite is
  // single-process so there's no cross-process concern there anyway).
  const result = await engine.transaction(async (tx) => {
    try {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`auto_link:${slug}`]);
    } catch {
      // engine doesn't support advisory locks — fall through
    }
    const existingOut = await tx.getLinks(slug, sourceOpts);
    // Incoming: we only look at frontmatter edges WE authored (origin_slug=slug).
    // Non-frontmatter and other-page frontmatter edges survive untouched.
    const existingInRaw = await tx.getBacklinks(slug, sourceOpts);
    const existingIn = existingInRaw.filter(
      l => l.link_source === 'frontmatter' && l.origin_slug === slug,
    );

    // Reconcilable outgoing edges: markdown + our own frontmatter edges +
    // basename-resolved wikilinks (issue #972). Manual edges
    // (link_source='manual') are NEVER touched by reconciliation.
    // 'wikilink-resolved' MUST be reconcilable (codex outside-voice [P1]):
    // auto-link writes these; if it weren't here, a basename edge would
    // survive after the wikilink is deleted from the page OR the
    // link_resolution.global_basename flag is turned off (out no longer
    // includes it, so the stale-removal loop below must be allowed to drop it).
    const reconcilableOut = existingOut.filter(
      l => l.link_source === 'markdown' || l.link_source == null ||
           l.link_source === 'wikilink-resolved' ||
           (l.link_source === 'frontmatter' && l.origin_slug === slug),
    );

    const outKeys = new Set(out.map(c =>
      `${c.targetSlug}\u0000${c.linkType}\u0000${c.linkSource ?? 'markdown'}`
    ));
    const incKeys = new Set(inc.map(c =>
      `${c.fromSlug}\u0000${c.linkType}`
    ));

    let created = 0, removed = 0, errors = 0;

    // Add outgoing edges.
    for (const c of out) {
      try {
        await tx.addLink(
          slug, c.targetSlug, c.context, c.linkType,
          c.linkSource, c.originSlug, c.originField,
          linkSourceOpts,
        );
        const existKey = `${c.targetSlug}\u0000${c.linkType}\u0000${c.linkSource ?? 'markdown'}`;
        const exists = reconcilableOut.some(l =>
          `${l.to_slug}\u0000${l.link_type}\u0000${l.link_source ?? 'markdown'}` === existKey
        );
        if (!exists) created++;
      } catch {
        errors++;
      }
    }

    // Add incoming edges (other page → slug).
    for (const c of inc) {
      try {
        await tx.addLink(
          c.fromSlug!, c.targetSlug, c.context, c.linkType,
          'frontmatter', c.originSlug, c.originField,
          linkSourceOpts,
        );
        const existKey = `${c.fromSlug}\u0000${c.linkType}`;
        const exists = existingIn.some(l =>
          `${l.from_slug}\u0000${l.link_type}` === existKey
        );
        if (!exists) created++;
      } catch {
        errors++;
      }
    }

    // Remove stale outgoing (markdown or our-frontmatter, not in desired set).
    for (const l of reconcilableOut) {
      const key = `${l.to_slug}\u0000${l.link_type}\u0000${l.link_source ?? 'markdown'}`;
      if (!outKeys.has(key)) {
        try {
          await tx.removeLink(slug, l.to_slug, l.link_type, l.link_source ?? undefined, removeSourceOpts);
          removed++;
        } catch {
          errors++;
        }
      }
    }

    // Remove stale incoming (our frontmatter → slug, not in desired set).
    for (const l of existingIn) {
      const key = `${l.from_slug}\u0000${l.link_type}`;
      if (!incKeys.has(key)) {
        try {
          await tx.removeLink(l.from_slug, slug, l.link_type, 'frontmatter', removeSourceOpts);
          removed++;
        } catch {
          errors++;
        }
      }
    }

    return { created, removed, errors };
  });

  return { ...result, unresolved };
}

const delete_page: Operation = {
  name: 'delete_page',
  description: 'Soft-delete a page. The row is hidden from search and from get_page/list_pages, but is recoverable via restore_page within 72h. The autopilot purge phase hard-deletes after the recovery window. Pass include_deleted: true to get_page to verify the soft-delete landed.',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    if (ctx.dryRun) return { dry_run: true, action: 'soft_delete_page', slug };
    // v0.31.8 (D7): thread ctx.sourceId so multi-source brains soft-delete the
    // intended row instead of always targeting (default, slug).
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    // v0.26.5: rewired from hard-delete to soft-delete. The hard-delete primitive
    // (engine.deletePage) is now reserved for purgeDeletedPages and explicit
    // tests. softDeletePage returns null when the slug is unknown OR already
    // soft-deleted (idempotent-as-null) — preserve that as a clean no-op shape.
    const result = await ctx.engine.softDeletePage(slug, sourceOpts);
    if (result === null) {
      // Distinguish "not found" from "already soft-deleted" so the agent gets a
      // clear signal. Probe once with include_deleted to disambiguate.
      const existing = await ctx.engine.getPage(slug, { includeDeleted: true, ...sourceOpts });
      if (!existing) {
        throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug.');
      }
      return { status: 'already_soft_deleted', slug, deleted_at: existing.deleted_at };
    }
    return { status: 'soft_deleted', slug, recoverable_until: 'now + 72h via restore_page' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const restore_page: Operation = {
  name: 'restore_page',
  description: 'v0.26.5 — restore a soft-deleted page (clear deleted_at). Returns success only if the page was actually soft-deleted. After this op, the page reappears in search and in get_page/list_pages without the include_deleted flag.',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    if (ctx.dryRun) return { dry_run: true, action: 'restore_page', slug };
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    const ok = await ctx.engine.restorePage(slug, sourceOpts);
    if (!ok) {
      // Distinguish "not found" from "already active" (idempotent-as-false).
      const existing = await ctx.engine.getPage(slug, { includeDeleted: true, ...sourceOpts });
      if (!existing) {
        throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug.');
      }
      return { status: 'already_active', slug };
    }
    return { status: 'restored', slug };
  },
  cliHints: { name: 'restore', positional: ['slug'] },
};

const purge_deleted_pages: Operation = {
  name: 'purge_deleted_pages',
  description: 'v0.26.5 — admin-only. Hard-deletes pages whose deleted_at is older than older_than_hours (default 72). Cascades through content_chunks, page_links, chunk_relations. Local CLI only (not exposed over HTTP MCP). Manual escape hatch alongside the autopilot purge phase.',
  params: {
    older_than_hours: { type: 'number', description: 'Age cutoff in hours. Default 72.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const olderThanHours = (p.older_than_hours as number | undefined) ?? 72;
    if (ctx.dryRun) return { dry_run: true, action: 'purge_deleted_pages', older_than_hours: olderThanHours };
    const result = await ctx.engine.purgeDeletedPages(olderThanHours);
    return { status: 'purged', count: result.count, slugs: result.slugs };
  },
  cliHints: { name: 'purge-deleted' },
};

const LIST_PAGES_SORT_VALUES = ['updated_desc', 'updated_asc', 'created_desc', 'slug'] as const;
type ListPagesSort = typeof LIST_PAGES_SORT_VALUES[number];

const list_pages: Operation = {
  name: 'list_pages',
  description: LIST_PAGES_DESCRIPTION,
  params: {
    type: { type: 'string', description: 'Filter by page type' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 50)' },
    // v0.29 — surface filter that already exists on PageFilters.
    updated_after: {
      type: 'string',
      description: 'ISO date (YYYY-MM-DD) or full timestamp. Returns pages with updated_at > value.',
    },
    sort: {
      type: 'string',
      enum: [...LIST_PAGES_SORT_VALUES],
      description: 'Sort order. Default updated_desc (matches pre-v0.29). Options: updated_desc, updated_asc, created_desc, slug.',
    },
    include_deleted: { type: 'boolean', description: 'v0.26.5: include soft-deleted pages (default: false). Used by restore workflows and operator diagnostics.' },
  },
  handler: async (ctx, p) => {
    // Whitelist the sort enum at the handler before passing to the engine.
    // Engines also whitelist via PAGE_SORT_SQL but defending here keeps
    // unsupported strings from reaching the SQL layer.
    const rawSort = p.sort as string | undefined;
    const sort = rawSort && (LIST_PAGES_SORT_VALUES as readonly string[]).includes(rawSort)
      ? (rawSort as ListPagesSort)
      : undefined;
    // v0.34.1 (#861 — P0 leak seal): thread the auth'd client's source scope
    // into the listPages filter so an OAuth client scoped to src-A cannot
    // enumerate src-B pages. Pre-fix, ctx.sourceId / ctx.auth?.allowedSources
    // were ignored at this op handler and the engine returned every source's
    // pages indiscriminately.
    const scope = sourceScopeOpts(ctx);
    const pages = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: clampSearchLimit(p.limit as number | undefined, 50, 100),
      includeDeleted: (p.include_deleted as boolean) === true,
      updated_after: typeof p.updated_after === 'string' ? p.updated_after : undefined,
      sort,
      ...scope,
    });
    return pages.map(pg => ({
      slug: pg.slug,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
      ...(pg.deleted_at ? { deleted_at: pg.deleted_at } : {}),
    }));
  },
  scope: 'read',
  cliHints: { name: 'list' },
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: SEARCH_DESCRIPTION,
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    mode: { type: 'string', description: 'Search mode (conservative|balanced|tokenmax). Local callers only.' },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const queryText = p.query as string;
    const limit = (p.limit as number) || 20;
    const offset = (p.offset as number) || 0;
    const scope = sourceScopeOpts(ctx);

    // T4/D5 — per-call mode honored ONLY for trusted/local callers so a remote
    // OAuth client can't escalate to the costly tokenmax bundle. Local + unknown
    // mode → loud reject; remote + mode set → silently ignored (uses config).
    const perCallMode = resolvePerCallMode(ctx, p.mode);

    // T4/D17 — escape hatch: keyword-only when the operator opts out of the
    // hybrid `search` contract (privacy/cost: no query text to an embedding
    // provider). Defaults to cheap-hybrid (D4/D15).
    const keywordOnly = (await ctx.engine.getConfig('search.mcp_keyword_only')) === 'true';

    if (keywordOnly) {
      const raw = await ctx.engine.searchKeyword(queryText, { limit, offset, ...scope });
      const results = dedupResults(raw);
      stampEvidenceSafe(results);
      // #1699: the keyword-only opt-out must STILL surface the content_flag
      // agent-warning channel (hybridSearch stamps it; this branch bypasses
      // hybridSearch, so stamp explicitly). Fail-open inside the helper.
      await stampContentFlags(ctx.engine, results);
      bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
      maybeCaptureSearch(ctx, queryText, results, Date.now() - startedAt, false);
      return results;
    }

    // Cheap-hybrid (D4/D15): full vector+keyword+RRF+pool+title+alias, but
    // expansion OFF (no per-call LLM cost). `query` op is the full-control variant.
    let capturedMeta: HybridSearchMeta | null = null;
    const results = await hybridSearchCached(ctx.engine, queryText, {
      limit,
      offset,
      expansion: false,
      ...scope,
      ...(perCallMode ? { mode: perCallMode } : {}),
      onMeta: (m) => { capturedMeta = m; },
    });
    const latency_ms = Date.now() - startedAt;
    bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));
    maybeCaptureSearch(ctx, queryText, results, latency_ms, true, capturedMeta);
    return results;
  },
  scope: 'read',
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description: QUERY_DESCRIPTION,
  params: {
    // v0.27.1: `query` is no longer strictly required — `--image <path>`
    // is the alternative entry point for image-similarity search. The CLI
    // validator at src/cli.ts honors `cliHints.altRequired` and admits the
    // image-only invocation. MCP / programmatic callers must still pass
    // `query` OR `image` (handler refuses if both are absent).
    query: { type: 'string', required: false },
    /** v0.27.1: image-similarity search. Path resolved on the CLI side
     *  before the op fires (the op receives raw bytes neither side; the
     *  CLI loads the file, base64-encodes, and passes through `image`). */
    image: { type: 'string', description: 'Base64-encoded image bytes for image-similarity search (CLI: --image <path>).' },
    image_mime: { type: 'string', description: 'MIME type for the image bytes (auto-derived from path on CLI; required when calling op directly).' },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    expand: { type: 'boolean', description: 'Enable multi-query expansion (default: true)' },
    detail: { type: 'string', description: 'Result detail level: low (compiled truth only), medium (default, all with dedup), high (all chunks)' },
    mode: { type: 'string', description: 'Search mode (conservative|balanced|tokenmax). Local callers only; remote uses configured mode.' },
    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    lang: { type: 'string', description: 'Filter to chunks where content_chunks.language matches (e.g., typescript, python, ruby)' },
    symbol_kind: { type: 'string', description: 'Filter to chunks where content_chunks.symbol_type matches (e.g., function, class, method, type, interface)' },
    // v0.20.0 Cathedral II Layer 7 (A2) / Layer 10 C3: two-pass structural expansion.
    near_symbol: { type: 'string', description: 'Anchor retrieval at this qualified symbol name (e.g., BrainEngine.searchKeyword). Enables A2 two-pass.' },
    walk_depth: { type: 'number', description: 'Structural walk depth 1-2. Default 0 (off). Expands anchors through code_edges with 1/(1+hop) decay.' },
    // v0.29.1 — orthogonal recency + salience axes. YOU (the agent) decide.
    salience: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "v0.29.1 salience boost — emotional_weight + take_count, NO time component.\n" +
        "  'off' — default for entity / canonical / definitional queries\n" +
        "  'on'  — surface emotionally-weighted + take-rich pages\n" +
        "  'strong' — aggressive mattering tilt\n" +
        "Omit and gbrain auto-detects from query text. Independent of `recency`.",
    },
    recency: {
      type: 'string',
      enum: ['off', 'on', 'strong'],
      description:
        "v0.29.1 recency boost — per-prefix age decay, NO mattering signal.\n" +
        "  'off' — default for canonical truth\n" +
        "  'on'  — daily/, media/x/, chat/ decay aggressively; concepts/, originals/, writing/ stay evergreen\n" +
        "  'strong' — multiplies the recency factor by 1.5 (use for 'today' / 'right now')\n" +
        "Omit and gbrain auto-detects. Independent of `salience` (orthogonal axes).",
    },
    since: {
      type: 'string',
      description:
        "v0.29.1 — filter to pages whose effective_date is >= this. ISO-8601 (YYYY-MM-DD or full timestamp) OR relative ('7d', '2w', '1y'). Replaces deprecated `afterDate`.",
    },
    until: {
      type: 'string',
      description:
        "v0.29.1 — filter to effective_date <= this. Same format as `since`. Replaces deprecated `beforeDate`. YYYY-MM-DD lands at end-of-day.",
    },
    source_id: {
      type: 'string',
      description:
        "v0.34: scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile). Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
    },
    cross_modal: {
      type: 'string',
      enum: ['text', 'image', 'both', 'auto'],
      description:
        "v0.36 cross-modal search routing.\n" +
        "  'text' (default for non-image-intent queries) — text-only path, no behavior change vs v0.35.\n" +
        "  'image' — route the query through Voyage multimodal-3 + the embedding_image column. Best for 'show me photos of...' phrasings.\n" +
        "  'both' — run text AND image searches in parallel; merge via weighted RRF.\n" +
        "  'auto' — same effect as omitting the field; intent classifier decides based on query phrasing.",
    },
    embedding_column: {
      type: 'string',
      description:
        "v0.36: route vector search through a non-default embedding column. Defaults to 'embedding' (OpenAI 1536d) unless `search_embedding_column` config sets a different default. Per-call override for A/B benchmarking across providers (e.g. 'embedding_voyage', 'embedding_zeroentropy'). Column MUST be declared in the `embedding_columns` config registry — unknown names throw with a paste-ready hint listing valid columns.",
    },
    adaptive_return: {
      type: 'boolean',
      description:
        "v0.41.33 — return a TIGHT, intent-sized result set instead of the full top-K. YOU (the agent) set this per query to serve the user well:\n" +
        "  TRUE when the user's question has a small, specific answer — a lookup ('what is X', 'who is Y', 'what's my <thing>', 'what did Z decide'), a single-fact recall, or when you'll route the result into a precise downstream step (a classifier, a decision, an exact citation). The user gets the answer, not a wall of loosely-related pages, and you spend fewer tokens reading noise.\n" +
        "  Omit / FALSE for breadth — 'everything about X', 'list all', 'what do I know about Y', exploration, brainstorming, or any time you'd rather see more candidates and judge for yourself. Recall matters more there, so take the full top-K.\n" +
        "Safe by construction: it NEVER returns empty when there are matches (you always get at least the top hit), and it only applies to the first page (omit when paginating). Caps come from config (search.adaptive_return_entity_max / _other_max; default 2 / 6) — pass `limit` 1 alongside this for a hard single-answer cap.",
    },
    autocut: {
      type: 'boolean',
      description:
        "v0.42.3.0 — autocut is the SMART DEFAULT (already ON when the reranker runs, which it does in the default search mode). It returns only the confident cluster by cutting where the relevance score drops off a cliff, so an obvious single answer comes back as 1 result and a genuine handful comes back as that handful — not a fixed wall of 20+.\n" +
        "  You almost never set this. Pass FALSE only to FORCE the full top-K when you deliberately want breadth — broad exploration, 'show me everything about X', enumeration where you'd rather over-collect and judge for yourself, or when you suspect the top hit is wrong and want to see the alternatives.\n" +
        "  TRUE is redundant in default mode (it's already on); it only matters to override a brain whose config turned autocut off.\n" +
        "Safe by construction: never returns empty when there are matches, only applies to the first page (omit when paginating), and is a no-op when no reranker scored the results (so it can't cut on an untrustworthy signal). Distinct from `adaptive_return`: autocut cuts on the score cliff; adaptive_return caps by question intent. Leave both unset for the smart default.",
    },
    relational: {
      type: 'boolean',
      description:
        "v0.43 — relational recall arm. SMART DEFAULT (on in balanced/tokenmax). When the question is about a RELATIONSHIP ('who invested in widget-co', 'who introduced me to alice', 'what connects fund-a and fund-b'), the brain resolves the named entity and walks its typed-edge graph (invested_in, works_at, founded, …), surfacing the answer even when no passage mentions both sides. Pure no-op for non-relational questions. Pass FALSE to force lexical/vector-only retrieval (e.g. debugging why a graph answer appeared). You almost never set this.",
    },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    const queryText = p.query as string | undefined;
    const imageData = p.image as string | undefined;
    const imageMime = (p.image_mime as string) || 'image/jpeg';
    const embeddingColumnParam =
      typeof p.embedding_column === 'string' && p.embedding_column.length > 0
        ? (p.embedding_column as string)
        : undefined;
    // Explicit per-call source_id must win over ctx.sourceId. `__all__` spans
    // every source for trusted local callers, but only the caller's granted
    // sources for remote callers (resolveRequestedScope is the single
    // trust+grant resolver shared by every source-scoped read op). This scope
    // is spread into BOTH the image-similarity searchVector path and the text
    // hybridSearch path below, so both honor the same grant.
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const querySourceScope = resolveRequestedScope(ctx, sourceIdParam);

    // v0.27.1: image-similarity branch. Bypasses hybridSearch (which is
    // text-only); embeds the image via embedMultimodal and runs a direct
    // vector search against the embedding_image column.
    if (imageData) {
      const { embedMultimodal } = await import('./ai/gateway.ts');
      const [vec] = await embedMultimodal([
        { kind: 'image_base64', data: imageData, mime: imageMime },
      ]);
      // v0.34.1 (#861 F2 — 6th leak surface): the image path bypasses
      // hybridSearch and calls searchVector directly, so it needs its
      // own thread of the source scope. Pre-fix, this branch leaked
      // image pages across sources independent of the text path's fix.
      const results = await ctx.engine.searchVector(vec, {
        limit: (p.limit as number) || 20,
        offset: (p.offset as number) || 0,
        embeddingColumn: 'embedding_image',
        ...querySourceScope,
      });
      return results;
    }

    if (!queryText) {
      throw new Error('query requires either `query` (text) or `image` (base64 bytes).');
    }

    // v0.25.0 — capture meta side-channel. hybridSearch's return contract
    // stays SearchResult[] (Cathedral II callers depend on that); meta
    // arrives via callback so eval capture can record what actually ran.
    //
    // v0.34 (Codex finding #2): thread ctx.sourceId so multi-source brains
    // get source-scoped retrieval. Explicit `source_id` param wins over
    // ctx.sourceId for callers that want to override (per-call multi-source
    // search). When the param is the literal '__all__', force-allow
    // cross-source mode (matches SearchOpts.sourceId contract).
    let capturedMeta: HybridSearchMeta | null = null;
    // v0.32.x search-lite: route the query op through hybridSearchCached so
    // semantic cache + token budget + intent weighting fire automatically.
    // Plain hybridSearch remains the bare API for callers that opt out.
    const results = await hybridSearchCached(ctx.engine, queryText, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
      // T4/D5 — per-call mode (local/trusted only; remote ignored).
      ...((): { mode?: string } => { const m = resolvePerCallMode(ctx, p.mode); return m ? { mode: m } : {}; })(),
      detail,
      language: (p.lang as string) || undefined,
      symbolKind: (p.symbol_kind as string) || undefined,
      nearSymbol: (p.near_symbol as string) || undefined,
      walkDepth: typeof p.walk_depth === 'number' ? (p.walk_depth as number) : undefined,
      ...querySourceScope,
      // v0.29.1 — agent-explicit recency + salience. Omitted = heuristic defaults.
      salience: p.salience as 'off' | 'on' | 'strong' | undefined,
      recency: p.recency as 'off' | 'on' | 'strong' | undefined,
      since: typeof p.since === 'string' ? p.since : undefined,
      until: typeof p.until === 'string' ? p.until : undefined,
      // v0.32.x search-lite: token budget + cache opt-outs.
      tokenBudget: typeof p.token_budget === 'number' ? (p.token_budget as number) : undefined,
      useCache: typeof p.use_cache === 'boolean' ? (p.use_cache as boolean) : undefined,
      intentWeighting: typeof p.intent_weighting === 'boolean' ? (p.intent_weighting as boolean) : undefined,
      // v0.36 cross-modal routing param.
      crossModal: p.cross_modal as 'text' | 'image' | 'both' | 'auto' | undefined,
      onMeta: (m) => { capturedMeta = m; },
      // v0.36 (D15): per-call embedding column override. Resolver rejects
      // unknown names at hybrid entry with EmbeddingColumnNotRegisteredError;
      // the error surfaces back to the agent as the op error envelope.
      // Source scope is already threaded via ...querySourceScope above
      // (master's #1182 cleanup of the duplicate sourceScopeOpts spread).
      embeddingColumn: embeddingColumnParam,
      // v0.41.33 — agent-explicit adaptive return-sizing. Omitted = off
      // (config default applies). hybridSearchCached skips the cache when on.
      adaptiveReturn: typeof p.adaptive_return === 'boolean' ? (p.adaptive_return as boolean) : undefined,
      // v0.42.3.0 — autocut ceiling override. Omitted = smart default (ON in
      // reranked modes). `false` forces the full top-K.
      autocut: typeof p.autocut === 'boolean' ? (p.autocut as boolean) : undefined,
      // v0.43 — relational recall override. Omitted = smart default (mode bundle).
      relationalRetrieval: typeof p.relational === 'boolean' ? (p.relational as boolean) : undefined,
    });
    const latency_ms = Date.now() - startedAt;

    // v0.37.0 (D11): op-layer last_retrieved_at write-back. Same shape as the
    // search handler — fire-and-forget, internal callers bypass this path.
    bumpLastRetrievedAt(ctx.engine, results.map((r) => r.page_id));

    // Op-layer capture (v0.25.0). Fire-and-forget. meta tells gbrain-evals
    // what hybridSearch *actually* did so replay can distinguish "with API
    // key" from "keyword-only fallback" and "expansion fired" from
    // "expansion requested + silently fell back."
    if (isEvalCaptureEnabled(ctx.config)) {
      const meta: HybridSearchMeta = capturedMeta ?? {
        vector_enabled: false, detail_resolved: detail ?? null, expansion_applied: false,
      };
      void captureEvalCandidate(
        ctx.engine,
        {
          tool_name: 'query',
          query: queryText,
          results,
          meta,
          latency_ms,
          remote: ctx.remote ?? false,
          expand_enabled: expand,
          detail: detail ?? null,
          job_id: ctx.jobId ?? null,
          subagent_id: ctx.subagentId ?? null,
        },
        { scrub_pii: isEvalScrubEnabled(ctx.config) },
      );
    }

    return results;
  },
  scope: 'read',
  cliHints: { name: 'query', positional: ['query'] },
};

// --- v0.28: Takes ---

const takes_list: Operation = {
  name: 'takes_list',
  description: 'List takes (typed/weighted/attributed claims) filtered by holder/kind/active/etc.',
  scope: 'read',
  params: {
    page_slug: { type: 'string', description: 'Filter to this page' },
    holder: { type: 'string', description: 'Filter to this holder (world|garry|brain|<slug>)' },
    kind: { type: 'string', description: 'Filter to this kind (fact|take|bet|hunch)' },
    active: { type: 'boolean', description: 'Active rows only (default true)' },
    resolved: { type: 'boolean', description: 'true → only resolved bets; false → only unresolved' },
    sort_by: { type: 'string', description: 'weight | since_date | created_at (default created_at)' },
    limit: { type: 'number', description: 'Max rows (default 100, cap 500)' },
    offset: { type: 'number', description: 'Skip first N rows' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listTakes({
      page_slug: p.page_slug as string | undefined,
      holder: p.holder as string | undefined,
      kind: p.kind as never,
      active: p.active as boolean | undefined,
      resolved: p.resolved as boolean | undefined,
      sortBy: p.sort_by as never,
      limit: p.limit as number | undefined,
      offset: p.offset as number | undefined,
      // Per-token allow-list — server-side filter for MCP-bound calls.
      // Local CLI callers leave takesHoldersAllowList unset and see all holders.
      takesHoldersAllowList: ctx.takesHoldersAllowList,
    });
  },
  cliHints: { name: 'takes-list' },
};

const takes_search: Operation = {
  name: 'takes_search',
  description: 'Keyword search across takes (pg_trgm similarity over claim text)',
  scope: 'read',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 30, cap 100)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.searchTakes(p.query as string, {
      limit: p.limit as number | undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
    });
  },
  cliHints: { name: 'takes-search', positional: ['query'] },
};

/**
 * v0.30.0 (Slice A1): aggregate calibration scorecard. Pure SQL aggregation.
 *
 * Privacy (D4 fail-closed): the engine method REQUIRES the takesHoldersAllowList
 * param. The handler threads it from the OperationContext so MCP-bound callers
 * see only their permitted holders' aggregate counts. Local CLI callers
 * (ctx.takesHoldersAllowList=undefined) get the full scorecard.
 */
const takes_scorecard: Operation = {
  name: 'takes_scorecard',
  description: 'Calibration scorecard for resolved bets: counts, accuracy, Brier (correct ∨ incorrect only), partial_rate.',
  scope: 'read',
  params: {
    holder: { type: 'string', description: 'Filter to this holder (world|garry|brain|<slug>)' },
    domain_prefix: { type: 'string', description: 'Slug prefix (e.g. companies/) to scope the scorecard' },
    since: { type: 'string', description: 'Window start (YYYY-MM-DD)' },
    until: { type: 'string', description: 'Window end (YYYY-MM-DD)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getScorecard(
      {
        holder: p.holder as string | undefined,
        domainPrefix: p.domain_prefix as string | undefined,
        since: p.since as string | undefined,
        until: p.until as string | undefined,
      },
      ctx.takesHoldersAllowList,
    );
  },
  cliHints: { name: 'takes-scorecard' },
};

/**
 * v0.30.0 (Slice A1): calibration curve binned by stated weight. Pure SQL.
 * Same allow-list contract as takes_scorecard.
 */
const takes_calibration: Operation = {
  name: 'takes_calibration',
  description: 'Calibration curve: resolved correct/incorrect bets binned by stated weight; observed vs predicted per bucket.',
  scope: 'read',
  params: {
    holder: { type: 'string', description: 'Filter to this holder' },
    bucket_size: { type: 'number', description: 'Bucket width in (0,1]; default 0.1' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getCalibrationCurve(
      {
        holder: p.holder as string | undefined,
        bucketSize: p.bucket_size as number | undefined,
      },
      ctx.takesHoldersAllowList,
    );
  },
  cliHints: { name: 'takes-calibration' },
};

const think: Operation = {
  name: 'think',
  description: 'Multi-hop synthesis across pages + takes + graph. Pulls relevant evidence and produces a cited answer with conflict + gap analysis.',
  scope: 'write',
  params: {
    question: { type: 'string', required: true, description: 'The question to think about' },
    anchor: { type: 'string', description: 'Pull the entity subgraph around this slug' },
    rounds: { type: 'number', description: 'Multi-pass: 1 (default). Round-loop scaffolding is in place; gap-driven retrieval ships in v0.29.' },
    save: { type: 'boolean', description: 'Persist a synthesis page (local-CLI only; ignored for MCP)' },
    take: { type: 'boolean', description: 'Append a take row to the anchor page (requires anchor)' },
    model: { type: 'string', description: 'Model override (alias or full id). Falls through models.think → models.default → GBRAIN_MODEL → opus.' },
    since: { type: 'string', description: 'Start of temporal window (YYYY-MM-DD or YYYY-MM)' },
    until: { type: 'string', description: 'End of temporal window' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const remote = ctx.remote ?? true;
    // Codex P1 #7 + privacy: remote callers cannot persist via MCP.
    const safeSave = remote ? false : Boolean(p.save);
    const safeTake = remote ? false : Boolean(p.take);
    // v0.40.2.0: thread source-scope scalars + remote flag for trajectory
    // injection. `sourceScopeOpts(ctx)` returns the federated array (when
    // present) OR the scalar; we pass both through to runThink which
    // forwards to findTrajectory. CLI callers don't go through this op
    // and get default scope + remote=false from runThink's CLI path.
    const scope = sourceScopeOpts(ctx);
    const { runThink, persistSynthesis } = await import('./think/index.ts');
    const result = await runThink(ctx.engine, {
      question: String(p.question),
      anchor: p.anchor ? String(p.anchor) : undefined,
      rounds: typeof p.rounds === 'number' ? (p.rounds as number) : undefined,
      save: safeSave,
      take: safeTake,
      model: p.model ? String(p.model) : undefined,
      // #1698 (C3): a remote caller that explicitly supplies a model gets the same
      // hard-error-on-unresolvable behavior as the CLI (loud op error envelope),
      // instead of silently degrading to a no-LLM stub answer. No model param →
      // false → configured/default model keeps its graceful path.
      modelExplicit: !!p.model,
      since: p.since ? String(p.since) : undefined,
      until: p.until ? String(p.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
      ...(scope.sourceId !== undefined ? { sourceId: scope.sourceId } : {}),
      ...(scope.sourceIds !== undefined ? { allowedSources: scope.sourceIds } : {}),
      remote: ctx.remote === true,
    });

    // Persist if --save was passed locally
    let savedSlug: string | undefined;
    let evidenceInserted = 0;
    if (safeSave) {
      const persisted = await persistSynthesis(ctx.engine, result);
      savedSlug = persisted.slug;
      evidenceInserted = persisted.evidenceInserted;
      for (const w of persisted.warnings) result.warnings.push(w);
    }

    return {
      ...result,
      // #1698 (#10): the persist-skip signal returns slug '' — map it (and any
      // falsy) to null so callers never see an empty-string "slug".
      saved_slug: savedSlug || null,
      evidence_inserted: evidenceInserted,
      remote_persisted_blocked: remote && (Boolean(p.save) || Boolean(p.take)),
    };
  },
  cliHints: { name: 'think', positional: ['question'] },
};

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.addTag(p.slug as string, p.tag as string, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.removeTag(p.slug as string, p.tag as string, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // #2200: route through sourceScopeOpts so a federated read grant
    // (ctx.auth.allowedSources) reaches the engine, not just scalar ctx.sourceId.
    // Was `ctx.sourceId ? {sourceId} : {}` — a federated client got '{}' →
    // engine fell back to 'default' (functionality gap + cross-source leak).
    const sourceOpts = sourceScopeOpts(ctx);
    return ctx.engine.getTags(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

/**
 * v114 (#1941): reconciliation-managed provenances a CALLER must not forge via
 * the add_link op. Internal writers (import-file frontmatter reconciliation,
 * extract --by-mention, wikilink resolution) write these straight through the
 * engine — they're excluded here, not at the DB CHECK. A hand-created edge
 * tagged 'frontmatter' with no origin_page_id would be a phantom that put_page
 * reconciliation (link_source='frontmatter' AND origin_page_id=written_page)
 * never cleans (see src/schema.sql). `manual` is intentionally absent — it IS
 * the user-facing provenance and the default for omitted link_source.
 */
export const MANAGED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved'];

const add_link: Operation = {
  name: 'add_link',
  description: 'Create link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at)' },
    context: { type: 'string', description: 'Context for the link' },
    link_source: { type: 'string', description: "Provenance tag (kebab-case, e.g. 'citation-graph'). Defaults to 'manual'. Reconciliation-managed built-ins (markdown/frontmatter/mentions/wikilink-resolved) are rejected." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    // v114 (#1941): default omitted provenance to 'manual' (NOT the engine's
    // 'markdown' default) so hand/tool-created CLI edges are honestly manual,
    // and forbid forging the reconciliation-managed built-ins.
    const linkSource = ((p.link_source as string) || 'manual').trim();
    if (MANAGED_LINK_SOURCES.includes(linkSource)) {
      throw new Error(
        `link_source '${linkSource}' is reconciliation-managed and cannot be set manually; ` +
        `use 'manual' (the default) or a custom kebab tag like 'citation-graph'`,
      );
    }
    // v0.31.8 (D7): single ctx.sourceId scopes both endpoints + origin. Cross-
    // source link creation is out of scope for this wave; use the engine API
    // directly for that edge case.
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId, originSourceId: ctx.sourceId }
      : undefined;
    await ctx.engine.addLink( // gbrain-allow-direct-insert: add_link MCP op is the explicit canonical surface for manual link creation; auto-link reconciliation runs separately via auto_link post-hook
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
      linkSource, undefined, undefined,
      linkOpts,
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'link', aliases: ['link-add'], positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Only remove edges of this link type (omit = all types)' },
    link_source: { type: 'string', description: 'Only remove edges of this provenance (e.g. citation-graph); omit = any provenance' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId }
      : undefined;
    await ctx.engine.removeLink(
      p.from as string, p.to as string,
      (p.link_type as string) || undefined,
      (p.link_source as string) || undefined,
      linkOpts,
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', aliases: ['link-rm'], positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // #2200: linkReadScopeOpts so a federated grant — and an untrusted remote
    // scalar scope (promoted to sourceIds[]) — reaches the engine's all-endpoint
    // branch. Trusted local/internal callers keep the scalar cross-source view.
    const sourceOpts = linkReadScopeOpts(ctx);
    return ctx.engine.getLinks(p.slug as string, sourceOpts);
  },
  scope: 'read',
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // #2200: linkReadScopeOpts — federated grant + untrusted remote scalar
    // (promoted to sourceIds[]) reach the engine's all-endpoint branch.
    const sourceOpts = linkReadScopeOpts(ctx);
    return ctx.engine.getBacklinks(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const list_link_sources: Operation = {
  name: 'list_link_sources',
  // v114 (#1941): the read-side counterpart to link-add/link-rm. Since
  // link_source is now an open kebab provenance (no allowlist), this is how an
  // agent discovers which provenances a brain actually carries.
  description: 'List distinct link_source provenances in the brain with edge counts (e.g. citation-graph, manual, markdown)',
  params: {},
  handler: async (ctx) => {
    // Route through sourceScopeOpts so the read honors both scalar ctx.sourceId
    // and federated ctx.auth.allowedSources (no cross-source provenance leak).
    return ctx.engine.listLinkSources(sourceScopeOpts(ctx));
  },
  scope: 'read',
  cliHints: { name: 'link-sources' },
};

/**
 * Hard cap on traverse_graph depth from MCP callers. Each recursive CTE iteration
 * grows a `visited` array per path; in `direction=both` the join is `OR`-based and
 * fans out exponentially. Without a cap, a remote MCP caller can pass depth=1e6
 * and burn memory/CPU on the database. 10 hops is well beyond any realistic
 * relationship query (your OpenClaw's "people who attended meetings with Alice"
 * is 2 hops; the deepest meaningful chain in our test data is 4).
 */
const TRAVERSE_DEPTH_CAP = 10;

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: 'Traverse link graph from a page. With link_type/direction, returns edges (GraphPath[]) instead of nodes.',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number', description: `Max traversal depth (default 5, capped at ${TRAVERSE_DEPTH_CAP})` },
    link_type: { type: 'string', description: 'Filter to one link type (per-edge filter, traversal only follows matching edges)' },
    direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'Traversal direction (default out)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const requestedDepth = (p.depth as number) || 5;
    if (requestedDepth > TRAVERSE_DEPTH_CAP) {
      ctx.logger.warn(`[gbrain] traverse_graph depth clamped from ${requestedDepth} to ${TRAVERSE_DEPTH_CAP}`);
    }
    const depth = Math.max(1, Math.min(requestedDepth, TRAVERSE_DEPTH_CAP));
    const linkType = p.link_type as string | undefined;
    const direction = p.direction as 'in' | 'out' | 'both' | undefined;
    // v0.34.1 (#861 — P0 leak seal): thread caller's source scope so graph
    // walks stay within the auth'd client's accessible sources. Pre-fix,
    // traverseGraph / traversePaths happily followed edges into pages from
    // foreign sources, leaking topology + page metadata via the graph op.
    const scope = sourceScopeOpts(ctx);
    // Backward compat: when neither link_type nor direction is provided, return
    // the legacy GraphNode[] shape. Once either is set, switch to GraphPath[].
    if (linkType === undefined && direction === undefined) {
      return ctx.engine.traverseGraph(slug, depth, scope);
    }
    return ctx.engine.traversePaths(slug, { depth, linkType, direction, ...scope });
  },
  scope: 'read',
  cliHints: { name: 'graph', positional: ['slug'] },
};

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  description: 'Add timeline entry to a page',
  params: {
    slug: { type: 'string', required: true },
    date: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string' },
    source: { type: 'string' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_timeline_entry', slug: p.slug };
    const date = p.date as string;
    // Reject anything that isn't a strict YYYY-MM-DD with year 1900-2199 and
    // a real calendar day. PG DATE accepts year 5874897 silently — that's a
    // semantic bug nobody actually wants.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format "${date}" (expected YYYY-MM-DD)`);
    }
    const [y, m, d] = date.split('-').map(Number);
    if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) {
      throw new Error(`Invalid date "${date}" (year 1900-2199, month 1-12, day 1-31)`);
    }
    // Round-trip through Date to catch e.g. Feb 30.
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid calendar date "${date}"`);
    }
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.addTimelineEntry(p.slug as string, { // gbrain-allow-direct-insert: add_timeline_entry MCP op is the explicit canonical surface for manual timeline entries
      date,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    }, sourceOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
  description: 'Get timeline entries for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // #2200: route through sourceScopeOpts so a federated grant reaches the
    // engine via TimelineOpts.sourceIds; scalar/unset unchanged.
    return ctx.engine.getTimeline(p.slug as string, sourceScopeOpts(ctx));
  },
  scope: 'read',
  cliHints: { name: 'timeline', positional: ['slug'] },
};

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  scope: 'admin',
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
  },
  scope: 'admin',
  cliHints: { name: 'health' },
};

/**
 * v0.31.1 (Issue #734): lightweight identity packet for the thin-client
 * banner. Read-scope so any authenticated client can surface "thin-client →
 * <host> · brain: 102k pages, 265k chunks · v0.31.1" without needing admin.
 *
 * Reuses engine.getStats() for counters (banner cache TTL bounds frequency
 * to ≤1/60s per CLI process; well below the Fly.io health-check cadence
 * that motivated the `getStats` cost warning in CLAUDE.md).
 *
 * No CLI surface (no cliHints) — this op exists only for thin-client banner
 * data. `last_sync_iso` deferred (no canonical source field today; would
 * need autopilot cycle to write a config key — TODO in v0.31.x).
 */
const get_brain_identity: Operation = {
  name: 'get_brain_identity',
  description: 'Brain identity + counters for thin-client banner. Returns version, engine kind, and page/chunk counts. Read-scope.',
  params: {},
  handler: async (ctx) => {
    const stats = await ctx.engine.getStats();
    // v0.42 self-upgrade: surface a pending update on the thin-client banner
    // (bonus channel; the CLI stderr marker + `gbrain self-upgrade` are the
    // load-bearing surface). Cache-read-only, no network, fail-open.
    let update_available = false;
    let latest_version: string | null = null;
    try {
      const su = await import('./self-upgrade.ts');
      const entry = su.readUpdateCache();
      if (entry && su.isCacheFresh(entry, Date.now()) && entry.marker.kind === 'upgrade_available') {
        update_available = true;
        latest_version = entry.marker.latest ?? null;
      }
    } catch {
      /* never let the banner break the op */
    }
    return {
      version: VERSION,
      engine: ctx.engine.kind,
      page_count: stats.page_count,
      chunk_count: stats.chunk_count,
      last_sync_iso: null as string | null,
      update_available,
      latest_version,
    };
  },
  scope: 'read',
  // intentionally no cliHints — banner-only op
};

// --- PR1: skill catalog over MCP (host-repo skills for thin clients) ---
// Both ops dynamically import ./skill-catalog.ts to avoid an import cycle
// (skill-catalog statically imports the `operations` array for D7 tool honesty).
// Read-scope, non-localOnly: a thin client (Codex/Perplexity/Cowork) reaches
// these over HTTP. The host-filesystem read is gated by mcp.publish_skills +
// path confinement — see the trust-boundary memo in skill-catalog.ts.

const list_skills: Operation = {
  name: 'list_skills',
  description: LIST_SKILLS_DESCRIPTION,
  params: {
    section: {
      type: 'string',
      description: 'Optional: only skills whose routing section matches this exactly.',
    },
  },
  handler: async (ctx, p) => {
    const sc = await import('./skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    const override = await sc.readMcpSkillsDir(ctx);
    const { dir, source } = sc.resolveSkillsDir(ctx, override);
    const section = typeof p.section === 'string' ? p.section : undefined;
    return sc.buildSkillCatalog(ctx, dir, source, { section });
  },
  scope: 'read',
  cliHints: { name: 'skills', positional: [] },
};

const get_skill: Operation = {
  name: 'get_skill',
  description: GET_SKILL_DESCRIPTION,
  params: {
    name: {
      type: 'string',
      required: true,
      description: 'Skill name exactly as returned by list_skills (or the brain-pack skill slug when source_id is set).',
    },
    source_id: {
      type: 'string',
      description:
        'Optional: fetch a brain-resident pack skill from this source instead of the host catalog. ' +
        'Disambiguates a slug that exists on more than one source (see list_brain_skillpack).',
    },
  },
  handler: async (ctx, p) => {
    const sc = await import('./skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    // Brain-resident path: when source_id is supplied, fetch the per-source pack
    // skill (confined to that source's pack root) rather than the host catalog.
    if (typeof p.source_id === 'string' && p.source_id.length > 0) {
      const brl = await import('./skillpack/brain-resident-locate.ts');
      const slug = typeof p.name === 'string' ? p.name : '';
      return brl.getResidentSkillDetail(ctx, p.source_id, slug);
    }
    const override = await sc.readMcpSkillsDir(ctx);
    const { dir } = sc.resolveSkillsDir(ctx, override);
    const name = typeof p.name === 'string' ? p.name : '';
    return sc.getSkillDetail(ctx, dir, name);
  },
  scope: 'read',
  cliHints: { name: 'skill', positional: ['name'] },
};

const list_brain_skillpack: Operation = {
  name: 'list_brain_skillpack',
  description:
    'List brain-resident skillpacks this brain ships (per-source). Returns each pack\'s skills, ' +
    'one-line descriptions, the schema pack it targets + whether that matches this brain, and a ' +
    'git scaffold spec. Read-only; gated by mcp.publish_skills. After orienting, call this and ' +
    'ask the user whether to install any pack the brain offers (gbrain skillpack scaffold <spec>).',
  params: {},
  handler: async (ctx) => {
    const sc = await import('./skill-catalog.ts');
    const publish = await sc.readMcpPublishSkills(ctx);
    sc.assertPublishEnabled(ctx, publish);
    const brl = await import('./skillpack/brain-resident-locate.ts');
    return brl.loadResidentPacksForServer(ctx);
  },
  scope: 'read',
  cliHints: { name: 'brain-skillpack', positional: [] },
};

const advisor: Operation = {
  name: 'advisor',
  description:
    'Ranked, read-only "what to do next" for this brain: version drift, pending migrations, ' +
    'schema-pack issues, stalled jobs, usage-shape gaps, and setup smells. Each finding has a ' +
    'severity, why-it-matters, and the exact fix command. Never mutates. Tell the user; ask ' +
    'before running any fix. Gated by mcp.publish_advisor (separate from mcp.publish_skills ' +
    'because diagnostics are not prose skills).',
  params: {},
  handler: async (ctx) => {
    // Publish gate: a remote caller needs mcp.publish_advisor=true. Local
    // (ctx.remote === false) callers bypass — the trust boundary is the OS.
    if (ctx.remote !== false) {
      let enabled = false;
      try {
        const dbVal = await ctx.engine.getConfig('mcp.publish_advisor');
        enabled = dbVal != null ? dbVal === 'true' : ctx.config?.mcp?.publish_advisor === true;
      } catch {
        enabled = ctx.config?.mcp?.publish_advisor === true;
      }
      if (!enabled) {
        throw new OperationError(
          'permission_denied',
          'The advisor is not published over MCP by the brain owner.',
          'The owner can enable it with `gbrain config set mcp.publish_advisor true`.',
        );
      }
    }
    const { runAdvisor } = await import('./advisor/run.ts');
    const { VERSION } = await import('../version.ts');
    // Over MCP there is no agent workspace on the server side: remote=true makes
    // runAdvisor drop workspace-dependent collectors (A1). The op never writes
    // history or nag state — it is strictly read-only.
    const report = await runAdvisor({
      engine: ctx.engine,
      config: ctx.config,
      version: VERSION,
      workspace: null,
      skillsDir: null,
      now: new Date(),
      remote: ctx.remote !== false,
    });
    return report;
  },
  scope: 'read',
  // NOT localOnly — exposed over MCP (E1) behind mcp.publish_advisor.
  // No cliHints: the CLI surface is the richer `gbrain advisor` command
  // (commands/advisor.ts) which adds --json exit codes + --apply.
  cliHints: { name: 'advisor', hidden: true },
};

/**
 * v0.41.19.0 — `gbrain status` thin-client surface.
 *
 * Returns a snapshot of sync freshness + last cycle state for thin-client
 * `gbrain status` callers. Per D2/D10 in the plan:
 *
 *   - Scope: admin (NOT localOnly). The op exposes operational state
 *     including sync timestamps and cycle metadata. Locking it to admin
 *     matches the `run_doctor` posture and prevents future feature creep
 *     (adding locks/workers/queue counters) from quietly leaking ops state
 *     to read-scoped clients.
 *
 *   - Payload: `{schema_version: 1, sync, cycle}` ONLY. Locks, Workers,
 *     Queue, and Autopilot sections are deliberately omitted from the
 *     remote payload — they are local-host concerns that thin-client
 *     callers shouldn't see at all (and the local `gbrain status` renders
 *     them as "N/A on remote brain" instead of pretending they exist).
 *
 *   - The local CLI composes the same data plus the local-only sections
 *     directly (no MCP round-trip when running against ~/.gbrain).
 */
const get_status_snapshot: Operation = {
  name: 'get_status_snapshot',
  description: 'Snapshot for `gbrain status` thin-client mode: sync freshness + last cycle. Admin-scope.',
  params: {},
  handler: async (ctx) => {
    const { buildSyncStatusReport } = await import('../commands/sync.ts');
    const { buildCycleSnapshot } = await import('../commands/status.ts');
    // Pull sources first (handles brains with zero declared sources too).
    let sources: Array<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }> = [];
    try {
      const rows = await ctx.engine.executeRaw<{
        id: string;
        name: string;
        local_path: string | null;
        config: Record<string, unknown> | null;
      }>(
        `SELECT id, name, local_path, config FROM sources WHERE COALESCE(archived, FALSE) = FALSE ORDER BY id`,
      );
      sources = rows.map((r) => ({
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        config: r.config ?? {},
      }));
    } catch {
      // Pre-v0.26.5 brains may lack the `archived` column; degrade to all rows.
      const rows = await ctx.engine.executeRaw<{
        id: string;
        name: string;
        local_path: string | null;
        config: Record<string, unknown> | null;
      }>(`SELECT id, name, local_path, config FROM sources ORDER BY id`);
      sources = rows.map((r) => ({
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        config: r.config ?? {},
      }));
    }
    const sync = await buildSyncStatusReport(ctx.engine, sources);
    const cycle = await buildCycleSnapshot(ctx.engine);
    // #1984: report the brain server's version so a thin-client `gbrain status`
    // can surface remote_version alongside its own local CLI version.
    const { VERSION } = await import('../version.ts');
    return { schema_version: 1 as const, version: VERSION, sync, cycle };
  },
  scope: 'admin',
  localOnly: false,
};

/**
 * Multi-topology v1 (Tier B): structured doctor report for remote callers.
 *
 * First read-only diagnostic op exposed over HTTP MCP. Wraps the focused
 * thin-client check set in `src/commands/doctor.ts:doctorReportRemote()` and
 * returns the structured `DoctorReport` JSON verbatim. The matching client-
 * side renderer lives in `src/commands/remote.ts` (used by `gbrain remote
 * doctor`). Local doctor is unchanged — operators on the host still get the
 * full check set.
 *
 * scope=admin because some checks expose system-state (queue depth, schema
 * version) that read-only consumers don't need. localOnly=false so HTTP
 * callers can invoke it. No mutation; safe to call repeatedly.
 *
 * Precedent: doctor only. Generalizing to lint/integrity/orphans is filed as
 * follow-up work pending demand.
 */
const run_doctor: Operation = {
  name: 'run_doctor',
  description: 'Run brain health checks and return a structured DoctorReport (thin-client doctor surface).',
  params: {},
  handler: async (ctx) => {
    const { doctorReportRemote } = await import('../commands/doctor.ts');
    return doctorReportRemote(ctx.engine);
  },
  scope: 'admin',
  localOnly: false,
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // v0.31.8 (D20): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    const versions = await ctx.engine.getVersions(p.slug as string, sourceOpts);
    // Same takes-allow-list privacy boundary as get_page. Snapshots persist
    // historical compiled_truth verbatim, including the takes fence, so
    // a remote token bypassing get_page via /history would re-introduce
    // the same leak across every prior version.
    if (!ctx.takesHoldersAllowList) return versions;
    return versions.map(v => ({ ...v, compiled_truth: stripTakesFence(v.compiled_truth) }));
  },
  scope: 'read',
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true },
    version_id: { type: 'number', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    // v0.31.8 (D7): thread ctx.sourceId so multi-source brains revert the
    // intended page row instead of whichever same-slug row Postgres returns
    // first.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.createVersion(p.slug as string, sourceOpts);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number, sourceOpts);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../commands/sync.ts');
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
    });
  },
  cliHints: { name: 'sync', hidden: true },
};

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', required: true, description: 'Data source (e.g., crustdata, happenstance)' },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug: p.slug, source: p.source };
    // v0.31.8 (D7 + D21): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object, sourceOpts);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    // v0.31.8 (D20 + D21): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined, sourceOpts);
  },
  scope: 'read',
};

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.resolveSlugs(p.partial as string);
  },
  scope: 'read',
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // v0.31.8 (D20): thread ctx.sourceId.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    return ctx.engine.getChunks(p.slug as string, sourceOpts);
  },
  scope: 'read',
};

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true },
    source_ref: { type: 'string', required: true },
    pages_updated: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getIngestLog({ limit: clampSearchLimit(p.limit as number | undefined, 20, 50) });
  },
  scope: 'read',
};

// --- File Operations ---

// Both branches need a LIMIT. Without one, the slug-filtered branch materializes
// every file for that slug — an MCP caller can force unbounded memory consumption
// by targeting a page with many attachments.
const FILE_LIST_LIMIT = 100;

const file_list: Operation = {
  name: 'file_list',
  description: 'List stored files',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (_ctx, p) => {
    const sql = db.getConnection();
    const slug = p.slug as string | undefined;
    if (slug) {
      return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files WHERE page_slug = ${slug} ORDER BY filename LIMIT ${FILE_LIST_LIMIT}`;
    }
    return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files ORDER BY page_slug, filename LIMIT ${FILE_LIST_LIMIT}`;
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  description: 'Upload a file to storage',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { readFileSync, statSync } = await import('fs');
    const { basename, extname } = await import('path');
    const { createHash } = await import('crypto');

    const filePath = p.path as string;
    const pageSlug = (p.page_slug as string) || null;

    // Fix 1 / B5 / H5 / M4: validate path, slug, filename before any filesystem read.
    // Remote callers (MCP, agent) are confined to cwd (strict). Local CLI callers
    // can upload from anywhere on the filesystem (loose) — the user owns the machine.
    // Default is strict when ctx.remote is undefined (defense-in-depth).
    const strict = ctx.remote !== false;
    validateUploadPath(filePath, process.cwd(), strict);
    if (pageSlug) validatePageSlug(pageSlug);
    const filename = basename(filePath);
    validateFilename(filename);

    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const MIME_TYPES: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    };
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] || null;

    const sql = db.getConnection();
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      return { status: 'already_exists', storage_path: storagePath };
    }

    // Upload to storage backend if configured
    if (ctx.config.storage) {
      const { createStorage } = await import('./storage.ts');
      const storage = await createStorage(ctx.config.storage as any);
      try {
        await storage.upload(storagePath, content, mimeType || undefined);
      } catch (uploadErr) {
        throw new OperationError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
      }
    }

    try {
      await sql`
        INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
        VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
        ON CONFLICT (storage_path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          size_bytes = EXCLUDED.size_bytes,
          mime_type = EXCLUDED.mime_type
      `;
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      if (ctx.config.storage) {
        try {
          const { createStorage } = await import('./storage.ts');
          const storage = await createStorage(ctx.config.storage as any);
          await storage.delete(storagePath);
        } catch { /* best effort cleanup */ }
      }
      throw dbErr;
    }

    return { status: 'uploaded', storage_path: storagePath, size_bytes: stat.size };
  },
};

const file_url: Operation = {
  name: 'file_url',
  description: 'Get a URL for a stored file',
  params: {
    storage_path: { type: 'string', required: true },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (_ctx, p) => {
    const sql = db.getConnection();
    const rows = await sql`SELECT storage_path, mime_type, size_bytes FROM files WHERE storage_path = ${p.storage_path as string}`;
    if (rows.length === 0) {
      throw new OperationError('storage_error', `File not found: ${p.storage_path}`);
    }
    // TODO: generate signed URL from Supabase Storage
    return { storage_path: rows[0].storage_path, url: `gbrain:files/${rows[0].storage_path}` };
  },
};

// --- Jobs (Minions) ---

const submit_job: Operation = {
  name: 'submit_job',
  description: 'Submit a background job to the Minions queue. Built-in types: sync, embed, lint, import, extract, backlinks, autopilot-cycle. The `shell` type is CLI-only and rejected over MCP.',
  params: {
    name: { type: 'string', required: true, description: 'Job type (sync, embed, lint, import, extract, backlinks, autopilot-cycle; shell is CLI-only)' },
    data: { type: 'object', description: 'Job payload (JSON)' },
    queue: { type: 'string', description: 'Queue name (default: "default")' },
    priority: { type: 'number', description: 'Priority (0 = highest, default: 0)' },
    max_attempts: { type: 'number', description: 'Max retry attempts (default: 3)' },
    delay: { type: 'number', description: 'Delay in ms before eligible' },
    timeout_ms: { type: 'number', description: 'Per-job wall-clock timeout in ms; aborted job goes to dead' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (ctx.dryRun) return { dry_run: true, action: 'submit_job', name };

    // Submit-side MCP guard: reject protected job names from untrusted callers
    // BEFORE we touch the DB. This is the first of the two security layers
    // (the second is MinionQueue.add's check). Independent of the worker-side
    // GBRAIN_ALLOW_SHELL_JOBS env flag — even if that flag is on, MCP callers
    // cannot submit protected-type jobs.
    const { isProtectedJobName } = await import('./minions/protected-names.ts');
    // F7b fail-closed: anything that is not strictly false (i.e., remote=true OR
    // the field somehow leaks in undefined despite the required type) rejects
    // protected job submissions. Closes the HTTP MCP shell-job RCE that surfaced
    // when the HTTP transport's OperationContext literal forgot to set remote.
    if (ctx.remote !== false && isProtectedJobName(name)) {
      throw new OperationError('permission_denied', `'${name}' jobs cannot be submitted over MCP (CLI-only for security)`);
    }

    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    // Trusted flag fires ONLY for an explicit local CLI submission of a protected
    // name. Strict `=== false` so an untyped/cast context can't escalate.
    const trusted = ctx.remote === false && isProtectedJobName(name) ? { allowProtectedSubmit: true } : undefined;

    const jobData = (p.data as Record<string, unknown>) || {};

    // v0.35.8.0: pre-enqueue shell-job validation, parity with the CLI submit
    // path. Closes the bug class where shell.ts handler-time validation ran
    // AFTER queue.add() persisted the row (codex F-CDX-1). Note: this branch
    // only fires for trusted local submitters (`ctx.remote === false` AND
    // protected-name allowlist), so remote MCP callers never reach it — but
    // it stays here as defense-in-depth in case a future code path widens
    // the trust gate above.
    if (name === 'shell' && trusted) {
      const { validateShellJobParams } = await import('./minions/handlers/shell-validate.ts');
      validateShellJobParams(jobData);
    }

    const job = await queue.add(name, jobData, {
      queue: (p.queue as string) || 'default',
      priority: (p.priority as number) || 0,
      max_attempts: (p.max_attempts as number) || 3,
      delay: (p.delay as number) || undefined,
      timeout_ms: (p.timeout_ms as number) || undefined,
    }, trusted);

    // v0.35.8.0: submit_job audit-log parity with the CLI path (codex F-CDX-4).
    // Pre-v0.35.8.0 the op handler bypassed the shell-audit JSONL writer
    // entirely. Lift the call here so both submit surfaces produce one
    // operational-trace line per shell submission. Best-effort; audit
    // failures never block submission.
    if (name === 'shell' && trusted) {
      try {
        const { logShellSubmission } = await import('./minions/handlers/shell-audit.ts');
        const inheritNames = Array.isArray(jobData.inherit)
          ? (jobData.inherit as unknown[]).filter((s): s is string => typeof s === 'string')
          : undefined;
        logShellSubmission({
          caller: 'mcp',
          // Gated on `trusted` (which requires ctx.remote === false), so
          // we know this path is a local trusted submitter — log it that way.
          remote: false,
          job_id: job.id,
          cwd: typeof jobData.cwd === 'string' ? jobData.cwd : '',
          cmd_display: typeof jobData.cmd === 'string' ? (jobData.cmd as string).slice(0, 80) : undefined,
          argv_display: Array.isArray(jobData.argv)
            ? (jobData.argv as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80))
            : undefined,
          inherit: inheritNames && inheritNames.length > 0 ? inheritNames : undefined,
        });
      } catch { /* audit failures never block submission */ }
    }

    return job;
  },
};

// v0.38 Slice 3 — D13 — remote-callable submit_agent with registration-time
// binding enforcement. Distinct from `submit_job` because:
//   1. It's the FIRST op that lets remote MCP callers spawn paid LLM work
//      (cost concerns + audit trail differ from generic submit_job).
//   2. The trust boundary lives in oauth_clients.bound_* fields, not in the
//      protected-name guard. Bindings are enforced PER-OP, not per-name.
//   3. The dispatcher is the subagent handler with the gateway-native loop
//      (agent.use_gateway_loop is auto-on for submit_agent jobs).
const submit_agent: Operation = {
  name: 'submit_agent',
  description: 'Submit an LLM agent job that the worker dispatches via the gateway-native tool loop. Requires the `agent` OAuth scope. Tools, source, slug prefixes, max concurrency, and daily budget are bound at OAuth client registration time.',
  params: {
    prompt: { type: 'string', required: true, description: 'User prompt for the agent' },
    model: { type: 'string', description: 'provider:model string (defaults to models.tier.subagent)' },
    allowed_tools: { type: 'array', description: 'Subset of bound_tools the agent may invoke', items: { type: 'string' } },
    allowed_slug_prefixes: { type: 'array', description: 'Subset of bound_slug_prefixes for put_page writes', items: { type: 'string' } },
    max_turns: { type: 'number', description: 'Max LLM turns (default 20, hard cap 100)' },
    queue: { type: 'string', description: 'Queue name (default "default")' },
  },
  mutating: true,
  scope: 'agent' as any,
  handler: async (ctx, p) => {
    // Remote-callable but only when the OAuth client has scope=agent AND
    // a binding row. Local CLI callers (ctx.remote === false) skip the
    // binding check — `gbrain agent run` already runs through subagent.ts
    // directly without going through this op.
    if (ctx.remote === false) {
      throw new OperationError('invalid_request', 'submit_agent over the local CLI: use `gbrain agent run` instead.');
    }

    const clientId = (ctx as { auth?: { clientId?: string } }).auth?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new OperationError('permission_denied', 'submit_agent requires an OAuth client with the `agent` scope.');
    }

    // Load the binding row.
    const { sqlQueryForEngine } = await import('./sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    let bindingRows: Array<Record<string, unknown>>;
    try {
      bindingRows = await sql`
        SELECT bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
               bound_max_concurrent, budget_usd_per_day::text AS budget_cap
          FROM oauth_clients
         WHERE client_id = ${clientId}
      `;
    } catch (err) {
      throw new OperationError(
        'internal',
        `submit_agent: could not load OAuth client binding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (bindingRows.length === 0) {
      throw new OperationError('permission_denied', `submit_agent: client_id ${clientId} not found.`);
    }
    const binding = bindingRows[0];
    const boundTools = (binding.bound_tools as string[] | null) ?? null;
    const boundSource = (binding.bound_source_id as string | null) ?? null;
    const boundSlugPrefixes = (binding.bound_slug_prefixes as string[] | null) ?? null;
    const boundMaxConcurrent = Number(binding.bound_max_concurrent ?? 1);
    const budgetCapText = (binding.budget_cap as string | null) ?? null;

    if (boundTools === null) {
      throw new OperationError(
        'permission_denied',
        `submit_agent: client ${clientId} has the agent scope but no bindings. Re-register with --bound-tools, --bound-source, --bound-slug-prefixes, --bound-max-concurrent, --budget-usd-per-day.`,
      );
    }

    // Validate each param against the binding.
    const requestedTools = (p.allowed_tools as string[] | undefined) ?? boundTools;
    for (const t of requestedTools) {
      if (!boundTools.includes(t)) {
        throw new OperationError(
          'permission_denied',
          `submit_agent: tool "${t}" is not in client ${clientId}'s bound_tools (${boundTools.join(', ')}).`,
        );
      }
    }
    const requestedSlugPrefixes = (p.allowed_slug_prefixes as string[] | undefined) ?? boundSlugPrefixes ?? [];
    if (boundSlugPrefixes !== null) {
      for (const sp of requestedSlugPrefixes) {
        if (!boundSlugPrefixes.some(bp => sp.startsWith(bp) || bp === sp)) {
          throw new OperationError(
            'permission_denied',
            `submit_agent: slug_prefix "${sp}" is not under any of client ${clientId}'s bound_slug_prefixes.`,
          );
        }
      }
    }

    // Concurrency cap: count active+waiting agent jobs for this client.
    const inflight = await sql`
      SELECT COUNT(*)::int AS n
        FROM minion_jobs j
       WHERE j.name = 'subagent'
         AND j.status IN ('waiting', 'active', 'waiting-children')
         AND j.data->>'__owner_client_id' = ${clientId}
    `;
    const inflightCount = Number((inflight[0]?.n as number | string | undefined) ?? 0);
    if (inflightCount >= boundMaxConcurrent) {
      throw new OperationError(
        'rate_limited',
        `submit_agent: client ${clientId} at concurrency cap (${inflightCount}/${boundMaxConcurrent}).`,
      );
    }

    // Dry-run echo.
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'submit_agent',
        client_id: clientId,
        bound_tools: boundTools,
        bound_source: boundSource,
        bound_max_concurrent: boundMaxConcurrent,
      };
    }

    // Submit via MinionQueue with allowProtectedSubmit (the agent op is
    // remote-callable but the underlying job name 'subagent' is protected;
    // the OAuth scope check above stands in for the protected-name guard).
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);

    const jobData: Record<string, unknown> = {
      prompt: p.prompt as string,
      max_turns: Math.min((p.max_turns as number) ?? 20, 100),
      allowed_tools: requestedTools,
      allowed_slug_prefixes: requestedSlugPrefixes,
      __owner_client_id: clientId,
    };
    if (typeof p.model === 'string') jobData.model = p.model;
    if (boundSource) jobData.source_id = boundSource;
    const job = await queue.add(
      'subagent',
      jobData,
      { queue: (p.queue as string) || 'default' },
      { allowProtectedSubmit: true },
    );

    // Audit trail (D4) — best-effort JSONL.
    try {
      const { logAgentSubmission } = await import('./minions/agent-audit.ts');
      const budgetCapCents = budgetCapText ? Math.round(parseFloat(budgetCapText) * 100) : null;
      const promptText = typeof p.prompt === 'string' ? p.prompt : '';
      logAgentSubmission({
        client_id: clientId,
        job_id: job.id,
        model: typeof p.model === 'string' ? p.model : '<default>',
        bound_tools: requestedTools,
        bound_source: boundSource,
        slug_prefixes: requestedSlugPrefixes,
        max_concurrent: boundMaxConcurrent,
        budget_remaining_cents: budgetCapCents,
        prompt_byte_count: Buffer.byteLength(promptText, 'utf8'),
        outcome: 'submitted',
      });
    } catch { /* never block submission */ }

    return { id: job.id, name: 'subagent', client_id: clientId };
  },
};

const get_job: Operation = {
  name: 'get_job',
  description: 'Get job status and details by ID',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found: ${p.id}`);
    return job;
  },
};

const list_jobs: Operation = {
  name: 'list_jobs',
  description: 'List jobs with optional filters',
  params: {
    status: { type: 'string', description: 'Filter by status (waiting, active, completed, failed, delayed, dead, cancelled)' },
    queue: { type: 'string', description: 'Filter by queue name' },
    name: { type: 'string', description: 'Filter by job type' },
    limit: { type: 'number', description: 'Max results (default: 50)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    return queue.getJobs({
      status: p.status as string | undefined,
      queue: p.queue as string | undefined,
      name: p.name as string | undefined,
      limit: (p.limit as number) || 50,
    } as Parameters<typeof queue.getJobs>[0]);
  },
};

const cancel_job: Operation = {
  name: 'cancel_job',
  description: 'Cancel a waiting, active, or delayed job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'cancel_job', id: p.id };
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const cancelled = await queue.cancelJob(p.id as number);
    if (!cancelled) throw new OperationError('invalid_params', `Cannot cancel job ${p.id} (may already be in terminal status)`);
    return cancelled;
  },
};

const retry_job: Operation = {
  name: 'retry_job',
  description: 'Re-queue a failed or dead job for retry',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'retry_job', id: p.id };
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const retried = await queue.retryJob(p.id as number);
    if (!retried) throw new OperationError('invalid_params', `Cannot retry job ${p.id} (must be failed or dead)`);
    return retried;
  },
};

const get_job_progress: Operation = {
  name: 'get_job_progress',
  description: 'Get structured progress for a running job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found: ${p.id}`);
    return { id: job.id, name: job.name, status: job.status, progress: job.progress };
  },
};

const pause_job: Operation = {
  name: 'pause_job',
  description: 'Pause a waiting, active, or delayed job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.pauseJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found or not pausable: ${p.id}`);
    return { id: job.id, status: job.status };
  },
};

const resume_job: Operation = {
  name: 'resume_job',
  description: 'Resume a paused job back to waiting',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.resumeJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found or not paused: ${p.id}`);
    return { id: job.id, status: job.status };
  },
};

const replay_job: Operation = {
  name: 'replay_job',
  description: 'Replay a completed/failed/dead job, optionally with modified data',
  params: {
    id: { type: 'number', required: true, description: 'Source job ID to replay' },
    data_overrides: { type: 'object', required: false, description: 'Data fields to override (merged with original)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'replay_job', id: p.id };
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.replayJob(p.id as number, p.data_overrides as Record<string, unknown> | undefined);
    if (!job) throw new OperationError('invalid_params', `Job not found or not in terminal state: ${p.id}`);
    return { id: job.id, name: job.name, status: job.status, source_id: p.id };
  },
};

const send_job_message: Operation = {
  name: 'send_job_message',
  description: 'Send a sidechannel message to a running job\'s inbox',
  params: {
    id: { type: 'number', required: true, description: 'Job ID to message' },
    payload: { type: 'object', required: true, description: 'Message payload (arbitrary JSON)' },
    sender: { type: 'string', required: false, description: 'Sender identity (default: admin)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'send_job_message', id: p.id };
    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const msg = await queue.sendMessage(p.id as number, p.payload, (p.sender as string) ?? 'admin');
    if (!msg) throw new OperationError('invalid_params', `Job not found, not messageable, or sender unauthorized: ${p.id}`);
    return { sent: true, message_id: msg.id, job_id: p.id };
  },
};

// --- Orphans ---

const find_orphans: Operation = {
  name: 'find_orphans',
  description: 'Find pages with no inbound wikilinks. Essential for content enrichment cycles.',
  params: {
    include_pseudo: {
      type: 'boolean',
      description: 'Include auto-generated and pseudo pages (default: false)',
    },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findOrphans } = await import('../commands/orphans.ts');
    // v0.41.29.0 (Codex F8): scope by the caller's source (ctx.sourceId /
    // ctx.auth.allowedSources) via the canonical sourceScopeOpts ladder.
    // Pre-fix, find_orphans returned brain-wide orphans regardless of a
    // source-bound OAuth client's scope — a read leak in the v0.34.1
    // source-isolation class. Local CLI callers route through `gbrain
    // orphans --source` instead (ctx.remote === false → empty scope here).
    return findOrphans(ctx.engine, {
      includePseudo: (p.include_pseudo as boolean) || false,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'orphans', hidden: true },
};

// --- v0.36.1.0 (T7): calibration profile read op ---

const get_calibration_profile: Operation = {
  name: 'get_calibration_profile',
  description:
    'Read the active calibration profile for a holder. Returns the latest row from calibration_profiles ' +
    '(per-source, per-holder) including Brier score, accuracy, pattern statements, and active bias tags. ' +
    'Source-scoped via sourceScopeOpts — federated_read scopes see the union of allowed sources, ' +
    'scalar source-bound clients see only their source. Returns null when no profile exists yet ' +
    '(cold-brain branch: builds after 5+ resolved takes + a calibration_profile phase run).',
  scope: 'read',
  params: {
    holder: {
      type: 'string',
      description:
        "Holder slug, e.g. 'garry' or 'people/charlie-example'. Defaults to 'garry' when omitted.",
    },
  },
  handler: async (ctx, p) => {
    const { getCalibrationProfileOp } = await import('../commands/calibration.ts');
    return getCalibrationProfileOp(ctx, {
      ...(typeof p.holder === 'string' ? { holder: p.holder } : {}),
    });
  },
};

// --- v0.29: Salience + Anomaly Detection ---

const get_recent_salience: Operation = {
  name: 'get_recent_salience',
  description: GET_RECENT_SALIENCE_DESCRIPTION,
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Window in days. Default 14.' },
    limit: { type: 'number', description: 'Max results (default 20, capped at 100).' },
    slugPrefix: {
      type: 'string',
      description: "Optional slug-prefix filter, e.g. 'personal' or 'wiki/people'.",
    },
    recency_bias: {
      type: 'string',
      enum: ['flat', 'on'],
      description:
        "v0.29.1: how to weight recency in the salience score.\n" +
        "  'flat' (DEFAULT) — v0.29.0 behavior. Every page gets 1/(1+days_old).\n" +
        "                     Stable, predictable; what most callers want.\n" +
        "  'on'             — Per-prefix decay map. concepts/originals/writing/\n" +
        "                     become evergreen (recency component = 0); daily/,\n" +
        "                     media/x/, chat/ decay aggressively. Use when the\n" +
        "                     user explicitly biases for recency-aware salience\n" +
        "                     ('what's been salient lately' vs 'what matters\n" +
        "                     in this brain regardless of when').",
    },
  },
  handler: async (ctx, p) => {
    const recencyBias = p.recency_bias === 'on' ? 'on' : 'flat';
    return ctx.engine.getRecentSalience({
      days: typeof p.days === 'number' ? p.days : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slugPrefix: typeof p.slugPrefix === 'string' ? p.slugPrefix : undefined,
      recency_bias: recencyBias,
    });
  },
  cliHints: { name: 'salience' },
};

// --- v0.43 (#2095): push-based context — the brain volunteers pages ---

const volunteer_context: Operation = {
  name: 'volunteer_context',
  description:
    'Push-based context: volunteer brain pages relevant to a rolling conversation window ' +
    'WITHOUT being asked. Zero-LLM, confidence-gated (alias 0.9 / exact-title 0.8 / ' +
    'slug-suffix 0.6, +0.05 for multi-turn or newest-turn mentions; default gate 0.7), ' +
    'capped at 3 pages (max 5). Returns pointers with one-line rationales + synopses — ' +
    'open the page (get_page) before relying on details. Pass stats: true for the ' +
    'approximate volunteered-vs-used precision summary (the feedback loop).',
  scope: 'read',
  params: {
    window: {
      type: 'string',
      description:
        "Recent conversation turns, oldest → newest, as 'user:' / 'assistant:' prefixed " +
        'lines (unprefixed text = one user turn). Required unless stats: true. ' +
        'CLI: piped stdin fills this.',
    },
    prior_context: {
      type: 'string',
      description:
        'Already-surfaced context (pointer blocks / opened page bodies). Pages whose slug ' +
        'appears here are not re-volunteered.',
    },
    max_pages: { type: 'number', description: 'Max pages to volunteer (default 3, hard cap 5).' },
    min_confidence: {
      type: 'number',
      description:
        'Confidence gate 0..1 (default 0.7 — slug-suffix matches need an explicit lower gate).',
    },
    session_id: { type: 'string', description: 'Optional caller session id, logged for attribution.' },
    turn: { type: 'number', description: 'Optional caller turn number, logged for attribution.' },
    stats: {
      type: 'boolean',
      description:
        'Return the volunteered-vs-used precision summary instead of volunteering. ' +
        'APPROXIMATE: "used" = pages.last_retrieved_at > volunteered_at.',
    },
    days: { type: 'number', description: 'Stats window in days (default 30; stats mode only).' },
  },
  handler: async (ctx, p) => {
    const { parseWindow, volunteerContext, volunteerUsageStats } = await import('./context/volunteer.ts');
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : ['default']);

    if (p.stats === true) {
      return volunteerUsageStats(ctx.engine, sourceIds, typeof p.days === 'number' ? p.days : undefined);
    }

    if (typeof p.window !== 'string' || !p.window.trim()) {
      throw new OperationError(
        'invalid_params',
        'window is required unless stats: true',
        'Pass the recent turns as a string (CLI: pipe them on stdin), or use --stats.',
      );
    }
    const turns = parseWindow(p.window);
    const pages = await volunteerContext(ctx.engine, turns, {
      sourceIds,
      priorContext: typeof p.prior_context === 'string' ? p.prior_context : undefined,
      maxPages: typeof p.max_pages === 'number' ? p.max_pages : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
    });

    // Feedback-loop logging: fire-and-forget batched INSERT through the
    // volunteer-events sink (drained at exit). Never fails the op.
    if (pages.length) {
      try {
        const { logVolunteerEventsFireAndForget, volunteerEventRowsFrom } = await import('./context/volunteer-events.ts');
        // Trust-boundary clamps (remote MCP callers): cap session_id length so
        // a read-scoped token can't bank unbounded TEXT per request, and only
        // log integer turns — a non-integer would throw inside the single
        // multi-row INSERT and silently drop the whole batch.
        const sessionId = typeof p.session_id === 'string' ? p.session_id.slice(0, 256) : null;
        const turn =
          typeof p.turn === 'number' && Number.isInteger(p.turn) && Math.abs(p.turn) <= 2_147_483_647
            ? p.turn
            : null;
        logVolunteerEventsFireAndForget(
          ctx.engine,
          volunteerEventRowsFrom(pages, { channel: 'op', session_id: sessionId, turn }),
        );
      } catch {
        /* telemetry only */
      }
    }
    return { pages, count: pages.length, window_turns: turns.length };
  },
  cliHints: { name: 'volunteer-context', stdin: 'window' },
};

const find_anomalies: Operation = {
  name: 'find_anomalies',
  description: FIND_ANOMALIES_DESCRIPTION,
  scope: 'read',
  params: {
    since: {
      type: 'string',
      description: 'ISO date YYYY-MM-DD. Default = today (UTC).',
    },
    lookback_days: {
      type: 'number',
      description: 'Days of history for the baseline. Default 30.',
    },
    sigma: {
      type: 'number',
      description: 'Sigma threshold. Default 3.0.',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.findAnomalies({
      since: typeof p.since === 'string' ? p.since : undefined,
      lookback_days: typeof p.lookback_days === 'number' ? p.lookback_days : undefined,
      sigma: typeof p.sigma === 'number' ? p.sigma : undefined,
    });
  },
  cliHints: { name: 'anomalies' },
};

// v0.33: expertise + relationship-proximity routing. CLI: gbrain whoknows.
const find_experts: Operation = {
  name: 'find_experts',
  description: FIND_EXPERTS_DESCRIPTION,
  scope: 'read',
  params: {
    topic: {
      type: 'string',
      description: 'The topic to route. Free-form natural language.',
    },
    limit: {
      type: 'number',
      description: 'Max results (default 5).',
    },
    explain: {
      type: 'boolean',
      description: 'Include factor breakdown per result (expertise, recency, salience).',
    },
  },
  handler: async (ctx, p) => {
    const { findExperts } = await import('../commands/whoknows.ts');
    const topic = typeof p.topic === 'string' ? p.topic : '';
    if (!topic.trim()) {
      throw new OperationError('invalid_params', '`topic` is required and must be a non-empty string.');
    }
    // v0.34.1 (#861, D3 — 5th leak surface): find_experts (whoknows) was
    // authored against v0.33 after PR #861 was drafted, so the source-scope
    // thread was missing entirely. The op calls findExperts → hybridSearch
    // internally; without the thread an auth'd src-A whoknows query would
    // surface src-B people in the rankings.
    // v0.40.6.0 T1.5 wiring (D4): consult the active pack for expert
    // types; pack-load failure → empty filter (NOT hardcoded defaults
    // per the silent-violation bug class Finding 1.3 closed).
    const { loadActivePackBestEffort, expertTypesFromPack } = await import('./schema-pack/index.ts');
    const pack = await loadActivePackBestEffort(ctx);
    const types = pack ? expertTypesFromPack(pack.manifest) : [];
    return findExperts(ctx.engine, {
      topic,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      explain: p.explain === true,
      types: types as never,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'whoknows', positional: ['topic'] },
};

// v0.32.6: contradiction probe MCP surface (M3)
const find_contradictions: Operation = {
  name: 'find_contradictions',
  description: FIND_CONTRADICTIONS_DESCRIPTION,
  scope: 'read',
  // Reads eval_contradictions_runs.report_json for the latest run, then
  // filters in-memory by slug and severity. No new probe is triggered;
  // the agent surfaces what's already on disk.
  params: {
    slug: {
      type: 'string',
      description: 'Optional slug filter; matches either side of a pair (substring match on slug).',
    },
    severity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Optional severity filter.',
    },
    limit: {
      type: 'number',
      description: 'Max findings to return. Default 20.',
    },
  },
  handler: async (ctx, p) => {
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.min(p.limit, 100) : 20;
    const slugFilter = typeof p.slug === 'string' ? p.slug.toLowerCase() : null;
    const sevFilter = (p.severity === 'low' || p.severity === 'medium' || p.severity === 'high')
      ? p.severity
      : null;
    const rows = await ctx.engine.loadContradictionsTrend(30);
    if (rows.length === 0) {
      return { contradictions: [], note: 'No probe runs in the last 30 days; run `gbrain eval suspected-contradictions` first.' };
    }
    const latest = rows[0];
    const report = latest.report_json as Record<string, unknown> | null;
    const perQuery = (report?.per_query as Array<{
      contradictions: Array<{
        kind: string;
        severity: 'low' | 'medium' | 'high';
        axis: string;
        confidence: number;
        a: { slug: string; chunk_id: number | null; take_id: number | null };
        b: { slug: string; chunk_id: number | null; take_id: number | null };
        resolution_kind: string;
        resolution_command: string;
      }>;
    }> | undefined) ?? [];
    const findings = perQuery.flatMap((q) => q.contradictions);
    const filtered = findings.filter((f) => {
      if (sevFilter && f.severity !== sevFilter) return false;
      if (slugFilter) {
        const sA = f.a.slug.toLowerCase();
        const sB = f.b.slug.toLowerCase();
        if (!sA.includes(slugFilter) && !sB.includes(slugFilter)) return false;
      }
      return true;
    });
    return {
      run_id: latest.run_id,
      ran_at: latest.ran_at,
      contradictions: filtered.slice(0, limit),
      total_in_run: findings.length,
    };
  },
  cliHints: { name: 'find-contradictions' },
};

const find_trajectory: Operation = {
  name: 'find_trajectory',
  description: FIND_TRAJECTORY_DESCRIPTION,
  scope: 'read',
  // localOnly intentionally NOT set — federated OAuth clients should be
  // able to query trajectories for entities in their scope. Visibility
  // filtering (D-CDX-1) inside the engine restricts remote callers to
  // visibility='world' facts.
  params: {
    entity_slug: {
      type: 'string',
      description: 'Required. Entity slug to chart (e.g. "companies/acme-example", "people/alice-example").',
    },
    metric: {
      type: 'string',
      description: 'Optional. Filter to a single canonical metric (e.g. "mrr", "arr", "team_size"). When omitted, all metrics return.',
    },
    kind: {
      type: 'string',
      enum: ['metric', 'event', 'all'],
      description: 'Optional. Filter by row shape: "metric" (typed-claim rows only), "event" (event_type rows only), or "all" (default). v0.40.2.0+.',
    },
    since: {
      type: 'string',
      description: 'Optional lower bound on valid_from (YYYY-MM-DD or ISO).',
    },
    until: {
      type: 'string',
      description: 'Optional upper bound on valid_from (YYYY-MM-DD or ISO).',
    },
    limit: {
      type: 'number',
      description: 'Max points returned. Default 100, max 500.',
    },
  },
  handler: async (ctx, p) => {
    if (typeof p.entity_slug !== 'string' || !p.entity_slug.trim()) {
      throw new Error('find_trajectory requires entity_slug (string)');
    }
    const metric = typeof p.metric === 'string' ? p.metric : undefined;
    const kind = (p.kind === 'metric' || p.kind === 'event' || p.kind === 'all')
      ? (p.kind as 'metric' | 'event' | 'all')
      : undefined;
    const since  = typeof p.since  === 'string' ? p.since  : undefined;
    const until  = typeof p.until  === 'string' ? p.until  : undefined;
    const limit  = typeof p.limit  === 'number' ? p.limit  : undefined;
    const scope = sourceScopeOpts(ctx);

    // D-CDX-1: thread ctx.remote into the engine so visibility filtering
    // happens at SQL level. Mirrors recall's posture for untrusted callers.
    const points = await ctx.engine.findTrajectory({
      entitySlug: p.entity_slug,
      ...scope,
      remote: ctx.remote === true,
      metric,
      kind,
      since,
      until,
      limit,
    });

    const { computeTrajectoryStats, TRAJECTORY_SCHEMA_VERSION } = await import('./trajectory.ts');
    const { regressions, drift_score } = computeTrajectoryStats(points);

    // Engine result includes raw embeddings (Float32Array); strip those
    // before sending over MCP — they're bulky binary noise that consumers
    // never need at this layer.
    // v0.40.2.0: event_type surfaces on the wire so remote callers (thin-
    // client think, founder-scorecard) see the event-shaped rows.
    const wirePoints = points.map(pt => ({
      fact_id: pt.fact_id,
      valid_from: pt.valid_from.toISOString().slice(0, 10),
      metric: pt.metric,
      value: pt.value,
      unit: pt.unit,
      period: pt.period,
      event_type: pt.event_type,
      text: pt.text,
      source_session: pt.source_session,
      source_markdown_slug: pt.source_markdown_slug,
    }));

    return {
      points: wirePoints,
      regressions,
      drift_score,
      schema_version: TRAJECTORY_SCHEMA_VERSION,
    };
  },
  cliHints: { name: 'find-trajectory' },
};

const get_recent_transcripts: Operation = {
  name: 'get_recent_transcripts',
  description: GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  scope: 'read',
  // Local-only: rejects HTTP-borne MCP traffic at tool-list time
  // (serve-http.ts filters on `localOnly`) AND at runtime via the in-handler
  // ctx.remote check. Defense in depth: hidden + rejected.
  localOnly: true,
  params: {
    days: { type: 'number', description: 'Window in days. Default 7.' },
    summary: {
      type: 'boolean',
      description: 'When true (default), return first ~300 chars per transcript. When false, full content (capped at 100 KB per file).',
    },
    limit: { type: 'number', description: 'Max transcripts (default 50).' },
  },
  handler: async (ctx, p) => {
    // Trust gate (eng review D2 + codex C3): MCP / HTTP callers (`remote=true`)
    // are blocked. Local CLI callers (`remote=false`) and the trusted-workspace
    // dream cycle pass through. This op is intentionally NOT in the subagent
    // allow-list (subagents always run with remote=true; they would always be
    // rejected, which is a footgun if the op is visible).
    if (ctx.remote === true) {
      throw new OperationError(
        'permission_denied',
        'get_recent_transcripts is local-only — call via the gbrain CLI.',
      );
    }
    const { listRecentTranscripts } = await import('./transcripts.ts');
    return listRecentTranscripts(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      summary: typeof p.summary === 'boolean' ? p.summary : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'transcripts', hidden: true },
};

// --- v0.28: whoami + sources management ---

const whoami: Operation = {
  name: 'whoami',
  description:
    'Introspect the calling identity. Returns one of three transport shapes: ' +
    '{transport: "oauth", client_id, client_name, scopes, expires_at}, ' +
    '{transport: "legacy", token_name, scopes, expires_at: null}, or ' +
    '{transport: "local", scopes: []}. Throws unknown_transport when the ' +
    'context is ambiguous (remote=true without auth) — fail-closed posture ' +
    'mirroring the v0.26.9 trust-boundary contract.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    // Trust boundary: ctx.remote === false is the trusted local CLI surface.
    // Returning OAuth-shaped scopes here would resurrect the v0.26.9 footgun
    // where code conditionally trusted on `scopes.includes('admin')` instead
    // of `ctx.remote === false`. Empty scopes array forces clients to
    // special-case `transport: 'local'` explicitly.
    if (ctx.remote === false) {
      return { transport: 'local', scopes: [] };
    }
    if (!ctx.auth) {
      throw new OperationError(
        'unknown_transport',
        'whoami called over a remote transport that did not thread ctx.auth. ' +
          'This is a transport bug — every remote call site must populate ctx.auth ' +
          'or set ctx.remote === false.',
      );
    }
    // OAuth tokens have client_id starting with 'gbrain_cl_'; legacy
    // access_tokens reuse `name` as both clientId and clientName (verifyAccessToken
    // at oauth-provider.ts:417-430). Detect by inspecting the prefix.
    const isOauth = ctx.auth.clientId.startsWith('gbrain_cl_');
    if (isOauth) {
      return {
        transport: 'oauth',
        client_id: ctx.auth.clientId,
        client_name: ctx.auth.clientName ?? ctx.auth.clientId,
        scopes: ctx.auth.scopes,
        expires_at: ctx.auth.expiresAt ?? null,
      };
    }
    return {
      transport: 'legacy',
      token_name: ctx.auth.clientName ?? ctx.auth.clientId,
      scopes: ctx.auth.scopes,
      expires_at: null,
    };
  },
  cliHints: { name: 'whoami' },
};

const sources_add: Operation = {
  name: 'sources_add',
  description:
    'Register a new source. Supports either --path (existing v0.17 behavior) ' +
    'or --url (v0.28 federated remote-clone path: parses the URL through the ' +
    'SSRF gate, clones into $GBRAIN_HOME/clones/<id>/ via temp-dir + rename ' +
    'atomicity, and stores remote_url in sources.config). Pre-flight collision ' +
    'check on id; rollback on either-side failure.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Source id ([a-z0-9-]{1,32}). Immutable citation key.',
    },
    name: { type: 'string', description: 'Display name (defaults to id).' },
    path: { type: 'string', description: 'Local path. Mutually optional with url.' },
    url: {
      type: 'string',
      description:
        'HTTPS git URL. Cloned into $GBRAIN_HOME/clones/<id>/. SSRF-guarded.',
    },
    federated: {
      type: 'boolean',
      description: 'true → cross-source default search. false → isolated.',
    },
    clone_dir: {
      type: 'string',
      description:
        'Override clone destination (only valid with url). Default: $GBRAIN_HOME/clones/<id>/.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { addSource } = await import('./sources-ops.ts');

    // v0.28.1 codex finding (CRITICAL + HIGH): a `sources_admin` token over
    // HTTP MCP must not be able to plant content at arbitrary host paths.
    //
    // - `path` lets a remote caller register `/etc/` (or any host dir) as a
    //   "source"; later `gbrain sync --all` walks every sources.local_path,
    //   which exfiltrates host content into the brain.
    // - `clone_dir` lets a remote caller name the destination directly;
    //   addSource's renameSync places the cloned tree there with no
    //   confinement, AND validateRepoState's degraded-state recovery later
    //   does rm -rf on src.local_path, so the same primitive doubles as
    //   arbitrary-delete.
    //
    // Both fields are CLI-only (the operator runs `gbrain sources add --path
    // /home/me/notes`). For HTTP MCP, ignore overrides — clone_dir defaults
    // to $GBRAIN_HOME/clones/<id>/ and path is rejected. Local CLI callers
    // (ctx.remote === false, per F7b fail-closed contract) keep the override.
    const isLocal = ctx.remote === false;
    const remotePath = isLocal ? (p.path as string | undefined) ?? null : null;
    const remoteCloneDir = isLocal ? (p.clone_dir as string | undefined) : undefined;
    if (!isLocal && (p.path !== undefined || p.clone_dir !== undefined)) {
      ctx.logger.warn(
        '[sources_add] ignoring path/clone_dir overrides on HTTP MCP transport ' +
          '(remote callers can only register a remote --url; the clone path is ' +
          'fixed under $GBRAIN_HOME/clones/).',
      );
    }

    const row = await addSource(ctx.engine, {
      id: p.id as string,
      name: p.name as string | undefined,
      localPath: remotePath,
      remoteUrl: p.url as string | undefined,
      federated:
        p.federated === undefined ? null : (p.federated as boolean),
      cloneDir: remoteCloneDir,
    });
    return row;
  },
  cliHints: { name: 'sources_add', hidden: true },
};

const sources_list: Operation = {
  name: 'sources_list',
  description:
    'List registered sources with page counts and remote_url. v0.28 surfaces ' +
    'the new remote_url field so a remote MCP caller can confirm a source is ' +
    'managed by clone+pull rather than user-supplied path.',
  params: {
    include_archived: { type: 'boolean', description: 'Include soft-deleted sources.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { listSources } = await import('./sources-ops.ts');
    return {
      sources: await listSources(ctx.engine, {
        includeArchived: (p.include_archived as boolean) === true,
      }),
    };
  },
  cliHints: { name: 'sources_list', hidden: true },
};

const sources_remove: Operation = {
  name: 'sources_remove',
  description:
    'Hard-remove a source (cascades pages/chunks/embeddings). Refuses to ' +
    'delete the auto-managed clone dir unless its resolved path is confined ' +
    'under $GBRAIN_HOME/clones/ (realpath+lstat — symlink-safe). For most ' +
    'workflows prefer sources_archive for the soft-delete path.',
  params: {
    id: { type: 'string', required: true },
    confirm_destructive: {
      type: 'boolean',
      description:
        'Required when the source has data (pages, chunks). Without it the op refuses.',
    },
    dry_run: { type: 'boolean', description: 'Preview impact without side effects.' },
    keep_storage: {
      type: 'boolean',
      description: 'Skip clone-dir cleanup even when the source is auto-managed.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { removeSource } = await import('./sources-ops.ts');
    return removeSource(ctx.engine, {
      id: p.id as string,
      confirmDestructive: (p.confirm_destructive as boolean) === true,
      dryRun: (p.dry_run as boolean) === true || ctx.dryRun,
      keepStorage: (p.keep_storage as boolean) === true,
    });
  },
  cliHints: { name: 'sources_remove', hidden: true },
};

const sources_status: Operation = {
  name: 'sources_status',
  description:
    'Per-source diagnostic. Returns clone_state ("healthy" | "missing" | ' +
    '"not-a-dir" | "no-git" | "url-drift" | "corrupted" | "not-applicable") ' +
    'so a remote MCP caller can diagnose whether the on-disk clone is ' +
    'syncable without SSH access to the brain host.',
  params: {
    id: { type: 'string', required: true },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { getSourceStatus } = await import('./sources-ops.ts');
    return getSourceStatus(ctx.engine, p.id as string);
  },
  cliHints: { name: 'sources_status', hidden: true },
};

// ============================================================
// v0.31 — Hot memory ops: extract_facts / recall / forget_fact
// ============================================================

const extract_facts: Operation = {
  name: 'extract_facts',
  description:
    'v0.31: extract personal-knowledge facts (events, preferences, commitments, beliefs) from a conversation turn into the per-source hot memory. Sanitizes turn_text via INJECTION_PATTERNS, calls Haiku to extract structured claims, runs the cosine fast-path + classifier dedup pipeline, INSERTs into facts. Returns counts by status. Skips extraction when the turn is dream-generated content (anti-loop).',
  params: {
    turn_text: { type: 'string', required: true, description: 'The user message or page body to extract facts from. Sanitized via INJECTION_PATTERNS before the LLM call.' },
    session_id: { type: 'string', description: 'Opaque session id (e.g. topic-id from MCP _meta.session_id, or CLI --session). Stored on each fact for the recall --session filter. Not an auth surface.' },
    entity_hints: { type: 'array', items: { type: 'string' }, description: 'Existing canonical entity slugs the agent has already resolved. Helps the extractor pick the right slug.' },
    is_dream_generated: { type: 'boolean', description: 'When true, extraction is skipped (anti-loop). Caller flips this on for pages with dream_generated:true frontmatter.' },
    visibility: { type: 'string', description: 'Default visibility for extracted facts. private (default) | world.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'extract_facts' };
    const { isFactsExtractionEnabled } = await import('./facts/extract.ts');
    const { runFactsPipeline } = await import('./facts/backstop.ts');

    // D15: kill switch. Operator can disable facts extraction across the
    // brain without binary downgrade by setting `facts.extraction_enabled`
    // to false. Returns zero-counts envelope so callers see a clean
    // success rather than a 'permission_denied' false alarm.
    if (!(await isFactsExtractionEnabled(ctx.engine))) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_disabled' };
    }

    // v0.31.2: routed through the shared pipeline (PR1 commit 9). Anti-loop
    // dream-generated check stays at the op layer because extract_facts is
    // an explicit user op without a parsedPage — the eligibility predicate
    // doesn't apply, but the dream-generated guard still does.
    if (p.is_dream_generated === true) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'dream_generated' };
    }

    const sourceId = ctx.sourceId ?? 'default';
    const visibility: 'private' | 'world' = p.visibility === 'world' ? 'world' : 'private';

    const r = await runFactsPipeline(p.turn_text as string, {
      engine: ctx.engine,
      sourceId,
      sessionId: typeof p.session_id === 'string' ? p.session_id : null,
      entityHints: Array.isArray(p.entity_hints) ? (p.entity_hints as string[]) : undefined,
      source: 'mcp:extract_facts',
      visibility,
      mode: 'inline',  // declarative; runFactsPipeline always inline
    });

    return {
      inserted: r.inserted,
      duplicate: r.duplicate,
      superseded: r.superseded,
      fact_ids: r.fact_ids,
    };
  },
};

const recall: Operation = {
  name: 'recall',
  description:
    'v0.31: query per-source hot memory (facts table). Filters by entity / since / session. Remote callers see only visibility=world facts. Returns most-recent first. v0.32 adds optional include_pending to return pending_consolidation_count alongside facts in one round trip.',
  params: {
    entity: { type: 'string', description: 'Entity slug (canonical). Returns facts about this entity newest first.' },
    since: { type: 'string', description: 'ISO datetime or duration shorthand (e.g. "8 hours ago"). Returns facts created since.' },
    session_id: { type: 'string', description: 'Source session id (e.g. topic-A). Returns facts captured in that session.' },
    include_expired: { type: 'boolean', description: 'When true, include expired_at IS NOT NULL rows. Default false.' },
    supersessions: { type: 'boolean', description: 'When true, return only the supersession audit log (expired_at + superseded_by both set).' },
    limit: { type: 'number', description: 'Max rows to return. Default 50, cap 100.' },
    grep: { type: 'string', description: 'Substring filter on fact text (case-insensitive). Applied client-side after recall.' },
    include_pending: { type: 'boolean', description: 'v0.32: when true, response includes pending_consolidation_count (facts not yet promoted to takes by the dream-cycle consolidate phase). One round trip; backward-compatible (field omitted when false).' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const sourceId = ctx.sourceId ?? 'default';
    const limit = typeof p.limit === 'number' ? p.limit : 50;
    const includeExpired = p.include_expired === true;
    const grep = typeof p.grep === 'string' ? p.grep.toLowerCase() : null;

    // Visibility filter: remote callers see world-only unless their token
    // grants elevated visibility (future-proofing; v0.31 ships world-only
    // for remote, all for local CLI).
    const visibility =
      ctx.remote === false
        ? undefined
        : ['world'] as ('private' | 'world')[];

    let rows: Awaited<ReturnType<typeof ctx.engine.listFactsByEntity>> = [];

    if (p.supersessions === true) {
      const since = parseSinceParam(p.since);
      rows = await ctx.engine.listSupersessions(sourceId, { since: since ?? undefined, limit });
    } else if (typeof p.entity === 'string' && p.entity.length > 0) {
      const { resolveEntitySlug } = await import('./entities/resolve.ts');
      const slug = (await resolveEntitySlug(ctx.engine, sourceId, p.entity)) ?? p.entity;
      rows = await ctx.engine.listFactsByEntity(sourceId, slug, {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    } else if (typeof p.session_id === 'string' && p.session_id.length > 0) {
      rows = await ctx.engine.listFactsBySession(sourceId, p.session_id, {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    } else if (p.since !== undefined) {
      const since = parseSinceParam(p.since);
      if (since) {
        rows = await ctx.engine.listFactsSince(sourceId, since, {
          activeOnly: !includeExpired,
          limit,
          visibility,
        });
      }
    } else {
      // No filter: return recent across the source.
      rows = await ctx.engine.listFactsSince(sourceId, new Date(0), {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    }

    if (grep) rows = rows.filter(r => r.fact.toLowerCase().includes(grep));

    // v0.32: optional pending-consolidation count piggy-backed on the recall
    // response. Single round trip on thin-client; omitted when not requested
    // so existing callers see no shape change.
    let pending_consolidation_count: number | undefined;
    if (p.include_pending === true) {
      try {
        pending_consolidation_count = await ctx.engine.countUnconsolidatedFacts(sourceId);
      } catch (e) {
        // Best-effort: if the count query fails we still return facts. Field
        // stays undefined so callers can tell the difference between "0
        // pending" and "we couldn't ask."
        process.stderr.write(
          `[recall] countUnconsolidatedFacts failed: ${(e as Error).message}\n`,
        );
      }
    }

    return {
      facts: rows.map(r => ({
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
        visibility: r.visibility,
        // v0.31.2: notability surfaced to recall consumers (CLI, MCP, admin).
        // Pre-v46 brains return 'medium' via the row mapper's fallback so the
        // contract stays total.
        notability: r.notability,
        valid_from: r.valid_from.toISOString(),
        valid_until: r.valid_until?.toISOString() ?? null,
        expired_at: r.expired_at?.toISOString() ?? null,
        superseded_by: r.superseded_by,
        consolidated_at: r.consolidated_at?.toISOString() ?? null,
        consolidated_into: r.consolidated_into,
        source: r.source,
        source_session: r.source_session,
        confidence: r.confidence,
        created_at: r.created_at.toISOString(),
      })),
      total: rows.length,
      ...(pending_consolidation_count !== undefined ? { pending_consolidation_count } : {}),
    };
  },
};

const forget_fact: Operation = {
  name: 'forget_fact',
  description: 'v0.32.2: forget a fact. Rewrites the page\'s `## Facts` fence to strike through the row and set valid_until=today (the DB\'s expired_at derives via valid_until + now() on the next reconcile so the forget survives `gbrain rebuild`). Falls back to legacy DB-only expire for pre-v51 / thin-client rows. Idempotent on already-expired or unknown ids.',
  params: {
    id: { type: 'number', required: true, description: 'Fact id to forget.' },
    reason: { type: 'string', required: false, description: 'Optional reason; written to the fence row\'s context cell as "forgotten: <reason>". Default: "forgotten".' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'forget_fact', id: p.id };
    const id = p.id as number;
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    const { forgetFactInFence } = await import('./facts/forget.ts');
    const result = await forgetFactInFence(ctx.engine, id, { reason });
    if (!result.ok && result.path === 'not_found') {
      throw new OperationError('fact_not_found', `Fact id ${id} not found.`);
    }
    if (!result.ok && result.path === 'already_expired') {
      throw new OperationError('fact_already_expired', `Fact id ${id} already expired.`);
    }
    return { id, expired: true, path: result.path, reason: result.reason };
  },
};

/**
 * Parse a `since` parameter into a Date. Accepts ISO 8601, plain duration
 * shorthand ("8 hours ago", "3 days ago", "30m", "1h", "2d", "7d"), or
 * Unix epoch millis. Returns null on unparseable input.
 */
function parseSinceParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Try ISO first.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  // "N (minutes|hours|days) ago" or compact forms.
  const ago = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// v0.34 Cathedral III — code-intelligence ops (MCP-exposed).
//
// Pre-v0.34 code-callers / code-callees / code-def / code-refs lived only in
// the CLI_ONLY set at cli.ts:30 — agents calling gbrain via MCP couldn't reach
// them and fell through to text search. These wrappers expose the existing
// engine + library functions to the MCP surface with resolver-grade
// descriptions (operations-descriptions.ts) so agents route to them
// automatically during plan-mode.
//
// All four are scope:'read'. Source-scoped via ctx.sourceId when set.
// Both `source_id` and `all_sources` are params so per-call overrides work.
// ──────────────────────────────────────────────────────────────────────────────

const code_callers: Operation = {
  name: 'code_callers',
  description: CODE_CALLERS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callers of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources (equivalent to source_id=__all__): every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver: remote callers can't span sources outside
    // their grant, and `__all__` collapses to their grant (not the whole brain).
    const { allSources, sourceId } = resolveCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCallersOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources,
    });
    return { symbol, count: edges.length, status: readiness.status, ready: readiness.ready, callers: edges };
  },
  cliHints: { name: 'code_callers', hidden: true },
};

const code_callees: Operation = {
  name: 'code_callees',
  description: CODE_CALLEES_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callees of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources: every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver (see code_callers).
    const { allSources, sourceId } = resolveCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCalleesOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources,
    });
    return { symbol, count: edges.length, status: readiness.status, ready: readiness.ready, callees: edges };
  },
  cliHints: { name: 'code_callees', hidden: true },
};

const code_def: Operation = {
  name: 'code_def',
  description: CODE_DEF_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol name (bare token; e.g., parseMarkdown, BrainEngine).' },
    limit: { type: 'number', description: 'Max definition sites returned. Default 20.' },
    lang: { type: 'string', description: "Filter by content_chunks.language (e.g. 'typescript', 'python')." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeDef } = await import('../commands/code-def.ts');
    const defs = await findCodeDef(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 20,
      language: (p.lang as string) || undefined,
    });
    // code_def is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: defs.length });
    return { symbol: p.symbol as string, count: defs.length, status: readiness.status, ready: readiness.ready, defs };
  },
  cliHints: { name: 'code_def', hidden: true },
};

const code_refs: Operation = {
  name: 'code_refs',
  description: CODE_REFS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find references to.' },
    limit: { type: 'number', description: 'Max references returned. Default 50.' },
    lang: { type: 'string', description: "Filter by content_chunks.language." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeRefs } = await import('../commands/code-refs.ts');
    const refs = await findCodeRefs(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 50,
      language: (p.lang as string) || undefined,
    });
    // code_refs is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: refs.length });
    return { symbol: p.symbol as string, count: refs.length, status: readiness.status, ready: readiness.ready, refs };
  },
  cliHints: { name: 'code_refs', hidden: true },
};

// --- v0.34 W3: recursive code_blast + code_flow ---

const code_blast: Operation = {
  name: 'code_blast',
  description: 'BEFORE editing any function, run code_blast with the symbol name to surface every transitive caller grouped by depth (direct → 2-hop → 3-hop). Use this during plan-mode to size the change. Returns up to 200 nodes. Returns: {result, depth_groups?, truncation?, cycles_detected?, did_you_mean?, candidates?}. Example ok: {result:"ok", depth_groups:[{depth:1, nodes:[{symbol,chunk_id}], confidence:0.77}], truncation:"none"}.',
  params: {
    symbol: { type: 'string', required: true, description: 'Bare or qualified symbol name (e.g. "performSync" or "src/foo::performSync")' },
    depth: { type: 'number', description: 'Hop cap (default 5, max 8)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation; treat symbol as exact qualified name' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.symbol as string;
    const depth = Math.min((p.depth as number) ?? 5, 8);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver: a remote federated client can't traverse a
    // source outside its grant (pre-fix this scoped by bare ctx.sourceId only).
    // Falls back to ctx.sourceId (a required string) for the trusted-local case,
    // exactly preserving pre-fix local behavior.
    const { sourceId: scopedSourceId } = resolveCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol, depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callers',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_blast', hidden: true },
};

const code_flow: Operation = {
  name: 'code_flow',
  description: 'When tracing how a request flows through the codebase from entry point to side effect (DB write, HTTP call, file I/O), run code_flow from the entry point. Returns ordered execution chain with terminal-node tags. Returns: same envelope as code_blast plus terminal_nodes: [{symbol, sink_kind}] where sink_kind ∈ "db_call"|"http_call"|"file_io"|"process_exec"|"unknown".',
  params: {
    entry_point: { type: 'string', required: true, description: 'Entry-point symbol name (bare or qualified)' },
    depth: { type: 'number', description: 'Hop cap (default 8, max 12)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.entry_point as string;
    const depth = Math.min((p.depth as number) ?? 8, 12);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver (see code_blast).
    const { sourceId: scopedSourceId } = resolveCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol + ':flow', depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callees',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_flow', hidden: true },
};

// --- v0.34 W3b: code_traversal_cache admin op ---

const code_traversal_cache_clear: Operation = {
  name: 'code_traversal_cache_clear',
  description: 'Clear cached code_blast / code_flow traversal results. Source-scoped by default; pass all_sources=true to wipe everything (D8 destructive-guard).',
  params: {
    source_id: { type: 'string', description: 'Source to clear. Required unless all_sources=true.' },
    all_sources: { type: 'boolean', description: 'Wipe cache across every source. Explicit opt-out of source-scoping.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    // INTENTIONAL exemption from resolveRequestedScope: this is a localOnly
    // admin/destructive op with its own D8 all_sources guard. The read-side
    // trust+grant resolver does not apply here (no remote caller reaches it).
    const { clearTraversalCache } = await import('./code-intel/traversal-cache.ts');
    const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId;
    const allSources = (p.all_sources as boolean) ?? false;
    if (ctx.dryRun) {
      return { dry_run: true, action: 'code_traversal_cache_clear', source_id: sourceId, all_sources: allSources };
    }
    const deleted = await clearTraversalCache(ctx.engine, {
      sourceId: allSources ? undefined : sourceId,
      allSources,
    });
    return { deleted, source_id: allSources ? null : sourceId, all_sources: allSources };
  },
  cliHints: { name: 'code_traversal_cache_clear', hidden: true },
};

// --- v0.36 Phase 2: search_by_image (image-as-query) ---

const search_by_image: Operation = {
  name: 'search_by_image',
  description:
    'v0.36 cross-modal Phase 2: image-as-query retrieval. Accepts a local path (CLI), data: URI, or http(s):// URL ' +
    '(SSRF-defended). Returns visually-similar image chunks plus any OCR text they carry. Optional `query` text ' +
    'refinement merges via weighted RRF (D13 hybrid intersect). True image→full-text-knowledge requires Phase 3 ' +
    '(`gbrain reindex --multimodal` + `search.unified_multimodal: true`).',
  params: {
    image_path: { type: 'string', description: 'Absolute path to image (local CLI callers only — rejected for remote MCP per D18).' },
    image_url: { type: 'string', description: 'http(s):// URL to image. SSRF-defended; max 3 redirect hops; 10MB cap.' },
    image_data: { type: 'string', description: 'Base64-encoded image bytes (preferred for remote MCP callers). PNG/JPEG/WebP only.' },
    image_mime: { type: 'string', description: 'Optional MIME hint when ambiguous. Magic-byte sniff is authoritative.' },
    query: { type: 'string', description: 'Optional text refinement; runs hybrid intersect via D13 weighted RRF.' },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
  },
  scope: 'read',
  // NOT localOnly: remote MCP callers can pass image_url or image_data
  // (subject to D18 image_path ban + D12 size cap + D23-#6 spend cap).
  handler: async (ctx, p) => {
    const imagePath = p.image_path as string | undefined;
    const imageUrl = p.image_url as string | undefined;
    const imageData = p.image_data as string | undefined;
    const imageMime = (p.image_mime as string) || undefined;
    const queryRefinement = p.query as string | undefined;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;

    // D18 P0 — remote callers cannot pass image_path. Rejecting at handler
    // entry, before any file I/O fires. validateParams catches it too at the
    // dispatch layer; this is defense-in-depth.
    if (ctx.remote === true && imagePath) {
      throw new Error(
        'permission_denied: image_path is not permitted for remote callers (D18). ' +
        'Use image_url or image_data instead.',
      );
    }

    if (!imagePath && !imageUrl && !imageData) {
      throw new Error('search_by_image requires one of: image_path, image_url, image_data');
    }
    if ([imagePath, imageUrl, imageData].filter(Boolean).length > 1) {
      throw new Error('search_by_image accepts only one of: image_path, image_url, image_data');
    }

    // D23-#6 — pre-flight daily-budget check for remote OAuth clients.
    // Local CLI callers (ctx.remote=false) bypass the cap (clientId="").
    const clientId = (ctx.remote === true ? (ctx.auth?.clientId ?? '') : '');
    if (clientId) {
      const budgetUsd = await getDailyImageBudgetUsd(ctx.engine);
      const { checkBudget } = await import('./spend-log.ts');
      await checkBudget(ctx.engine, clientId, Math.round(budgetUsd * 100));
    }

    // Resolve image bytes via the SSRF-defended loader. For remote callers,
    // tighter byte cap.
    const remoteCap = await getRemoteMaxBytes(ctx.engine);
    const localCap = await getLocalMaxBytes(ctx.engine);
    const cap = ctx.remote === true ? remoteCap : localCap;
    const { loadImageInput } = await import('./search/image-loader.ts');
    const loaded = await loadImageInput(
      (imagePath ?? imageUrl ?? `data:${imageMime ?? 'image/png'};base64,${imageData}`)!,
      { maxBytes: cap },
    );

    // Resolve source-scope through the single trust+grant resolver. Pre-fix
    // this branch computed resolvedSourceId then spread sourceScopeOpts(ctx)
    // after it (double-application: the spread silently won, and `__all__`
    // didn't opt out for local callers with ctx.sourceId set). One resolver,
    // one spread — `__all__` spans the brain only for trusted local callers.
    const imageSourceScope = resolveRequestedScope(ctx, sourceIdParam);

    const { searchByImage } = await import('./search/by-image.ts');
    const results = await searchByImage(
      ctx.engine,
      { base64: loaded.base64, mime: loaded.contentType },
      {
        limit: (p.limit as number) || 20,
        offset: (p.offset as number) || 0,
        query: queryRefinement,
        ...imageSourceScope,
      },
    );

    // D23-#6 — record successful Voyage call. Best-effort; failures don't
    // block the response.
    if (clientId) {
      const { recordSpend, VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS } = await import('./spend-log.ts');
      // Approximate: 1 image embed + (query ? 1 text embed : 0). Both are
      // billed at the same per-call rate by Voyage.
      const calls = 1 + (queryRefinement ? 1 : 0);
      void recordSpend(ctx.engine, {
        clientId,
        tokenName: ctx.auth?.clientName ?? null,
        operation: 'search_by_image',
        spendCents: VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS * calls,
        provider: 'voyage',
        model: 'voyage-multimodal-3',
      });
    }

    return results;
  },
  cliHints: { name: 'search-by-image' },
};

async function getDailyImageBudgetUsd(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.daily_budget_usd_per_client');
    if (v == null) return 5; // default $5
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 5;
  } catch {
    return 5;
  }
}

async function getLocalMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.max_bytes');
    if (v == null) return 10 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

async function getRemoteMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.remote_max_bytes');
    if (v == null) return 2 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024;
  } catch {
    return 2 * 1024 * 1024;
  }
}

// --- Exports ---

// ──────────────────────────────────────────────────────────────────────
// v0.40.6.0 Schema Cathedral v3 — 9 new MCP ops for the agent on-ramp.
//
// Read ops (scope: read; NOT localOnly) — any read-scope OAuth client.
// Write ops (scope: admin; NOT localOnly per D2) — admin-scope client
// (your OpenClaw and similar remote agents) can author schema packs
// remotely. Audit log captures actor=mcp:<clientId8> on every mutation
// (see src/core/schema-pack/mutate-audit.ts privacy posture per D20).
//
// Per-call schema_pack opt STAYS rejected for remote callers — that
// trust boundary is enforced by op-trust-gate.ts and is separate from
// the localOnly posture (R2 regression preserved).
// ──────────────────────────────────────────────────────────────────────

const get_active_schema_pack: Operation = {
  name: 'get_active_schema_pack',
  description: 'v0.40.6.0: cheap identity packet for the active schema pack. Returns {pack_name, version, sha8, page_types_count, link_types_count, primitive_summary, source_tier}. Useful for agents to know which pack they are operating against without paying full manifest load cost.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack, resolveActivePackNameOnly } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const sourceOpts: Record<string, unknown> = {};
    if (ctx.sourceId) sourceOpts.sourceId = ctx.sourceId;
    const resolution = resolveActivePackNameOnly({ cfg, remote: ctx.remote ?? true, ...sourceOpts });
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, ...sourceOpts });
    const primitiveSummary: Record<string, number> = {};
    for (const t of pack.manifest.page_types) {
      primitiveSummary[t.primitive] = (primitiveSummary[t.primitive] ?? 0) + 1;
    }
    return {
      pack_name: pack.manifest.name,
      version: pack.manifest.version,
      sha8: pack.manifest_sha8,
      identity: pack.identity,
      page_types_count: pack.manifest.page_types.length,
      link_types_count: pack.manifest.link_types.length,
      primitive_summary: primitiveSummary,
      source_tier: resolution.source,
    };
  },
};

const list_schema_packs: Operation = {
  name: 'list_schema_packs',
  description: 'v0.40.6.0: list installed schema packs (bundled + user-installed). Returns {bundled: string[], installed: string[]}. Read-only directory listing.',
  params: {},
  scope: 'read',
  handler: async (_ctx) => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { gbrainPath } = await import('./config.ts');
    const bundled = ['gbrain-base', 'gbrain-recommended'];
    const installedDir = gbrainPath('schema-packs');
    const installed: string[] = [];
    if (existsSync(installedDir)) {
      for (const entry of readdirSync(installedDir)) {
        const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
        for (const c of candidates) {
          if (existsSync(join(installedDir, entry, c))) { installed.push(entry); break; }
        }
      }
    }
    return { bundled, installed };
  },
};

const schema_stats: Operation = {
  name: 'schema_stats',
  description: 'v0.40.6.0: per-type page counts + typed-coverage from the DB. Returns {schema_version:1, pack_identity, aggregate, per_source, dead_prefixes}. Multi-source aware via ctx.sourceId/allowedSources.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { runStatsCore } = await import('./schema-pack/stats.ts');
    const scope = sourceScopeOpts(ctx);
    const opts: { sourceId?: string; sourceIds?: string[] } = {};
    if (scope.sourceIds && scope.sourceIds.length > 0) opts.sourceIds = scope.sourceIds;
    else if (scope.sourceId) opts.sourceId = scope.sourceId;
    return runStatsCore(ctx, opts);
  },
};

const schema_lint: Operation = {
  name: 'schema_lint',
  description: 'v0.40.6.0: lint the active (or named) schema pack. File-plane rules only over MCP — the with_db option is rejected for remote callers (DB-aware rules require local CLI). Returns {ok, errors, warnings} structured report.',
  params: {
    pack: { type: 'string', description: 'Pack name (default: active pack)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runAllLintRules } = await import('./schema-pack/lint-rules.ts');
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig, gbrainPath } = await import('./config.ts');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfg = loadConfig();
    let manifest;
    if (p.pack) {
      // Locate by name without trust-gating per-call schema_pack opt
      // (that's a separate axis — this is just file lookup).
      const packName = p.pack as string;
      const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
      let path: string | null = null;
      for (const c of candidates) {
        const candidate = join(gbrainPath('schema-packs', packName), c);
        if (existsSync(candidate)) { path = candidate; break; }
      }
      if (!path) return { error: 'pack_not_found', pack: packName };
      const { loadPackFromFile: loader } = await import('./schema-pack/loader.ts');
      manifest = loader(path);
    } else {
      const resolved = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
      manifest = resolved.manifest;
    }
    // File-plane only over MCP; the engine-aware --with-db opt-in is
    // CLI-only (Phase 5 wiring). MCP callers get the 9 file-plane rules.
    return await runAllLintRules(manifest);
  },
};

const schema_graph: Operation = {
  name: 'schema_graph',
  description: 'v0.40.6.0: schema pack graph as JSON edges. Returns {nodes: [{name, primitive}], edges: [{from, verb, to}]} derived from link_types inference + frontmatter_links.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const nodes = pack.manifest.page_types.map((t) => ({ name: t.name, primitive: t.primitive }));
    const edges: Array<{ from: string; verb: string; to: string }> = [];
    for (const lt of pack.manifest.link_types) {
      if (lt.inference?.page_type) {
        edges.push({
          from: lt.inference.page_type,
          verb: lt.name,
          to: lt.inference.target_type ?? '*',
        });
      }
    }
    for (const fl of pack.manifest.frontmatter_links) {
      edges.push({ from: fl.page_type, verb: fl.link_type, to: '*' });
    }
    return { schema_version: 1, pack: pack.manifest.name, nodes, edges };
  },
};

const schema_explain_type: Operation = {
  name: 'schema_explain_type',
  description: 'v0.40.6.0: resolved settings for a single page_type in the active pack. Returns {pack, type, primitive, path_prefixes, aliases, extractable, expert_routing}.',
  params: {
    type: { type: 'string', required: true, description: 'Page type name to explain' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const found = pack.manifest.page_types.find((t) => t.name === p.type);
    if (!found) return { error: 'type_not_found', type: p.type as string, pack: pack.manifest.name };
    return { schema_version: 1, pack: pack.manifest.name, type: found };
  },
};

const schema_review_orphans: Operation = {
  name: 'schema_review_orphans',
  description: 'v0.40.6.0: list pages with no active-pack type match. Returns {orphan_count, orphans: [{slug, source_id}]}.',
  params: {
    limit: { type: 'number', description: 'Max orphans to return (default 100)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const limit = Math.max(1, Math.min(10000, (p.limit as number) ?? 100));
    const scope = sourceScopeOpts(ctx);
    let where = `WHERE deleted_at IS NULL AND (type IS NULL OR type = '')`;
    const params: unknown[] = [];
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      where += ` AND source_id = ANY($1::text[])`;
      params.push(scope.sourceIds);
    } else if (scope.sourceId) {
      where += ` AND source_id = $1`;
      params.push(scope.sourceId);
    }
    try {
      const rows = await ctx.engine.executeRaw<{ slug: string; source_id: string }>(
        `SELECT slug, COALESCE(source_id, 'default') AS source_id FROM pages ${where} ORDER BY source_id, slug LIMIT ${limit}`,
        params,
      );
      return {
        schema_version: 1,
        orphan_count: rows.length,
        orphans: rows.map((r) => ({ slug: r.slug, source_id: r.source_id })),
      };
    } catch {
      return { schema_version: 1, orphan_count: 0, orphans: [] };
    }
  },
};

const schema_apply_mutations: Operation = {
  name: 'schema_apply_mutations',
  description: 'v0.40.7.0: batched schema pack mutation. ATOMIC: all mutations succeed or all roll back. Audit log records one batch_id. Admin scope; NOT localOnly so remote agents (your OpenClaw, etc.) can author packs over normal MCP. Mutation shape per ApplyMutationsRequest type — supports add_type / remove_type / update_type / add_alias / remove_alias / add_prefix / remove_prefix / add_link_type / remove_link_type / set_extractable / set_expert_routing.',
  params: {
    pack: { type: 'string', required: true, description: 'Pack to mutate (must not be bundled)' },
    mutations: {
      type: 'array',
      required: true,
      description: 'Array of {op, ...args} mutation records to apply atomically',
      items: { type: 'object' },
    },
    force: { type: 'boolean', description: 'Steal stale per-pack lock' },
  },
  scope: 'admin',
  mutating: true,
  handler: async (ctx, p) => {
    const pack = p.pack as string;
    const mutations = p.mutations as Array<{ op: string; [k: string]: unknown }>;
    const force = p.force === true;
    if (!Array.isArray(mutations) || mutations.length === 0) {
      return { error: 'invalid_request', message: 'mutations must be a non-empty array' };
    }
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const actor = ctx.auth?.clientId ? `mcp:${ctx.auth.clientId.slice(0, 8)}` : 'cli';
    const sourceId = ctx.sourceId;  // codex C5: write-side scoping
    // Compose every mutation inside ONE withPackLock so the batch is
    // truly atomic. The withMutation skeleton handles audit / cache
    // invalidation per operation; we orchestrate the lock + iteration.
    const { withPackLock } = await import('./schema-pack/pack-lock.ts');
    const {
      addTypeToPack, removeTypeFromPack, updateTypeOnPack,
      addAliasToType, removeAliasFromType, addPrefixToType, removePrefixFromType,
      addLinkTypeToPack, removeLinkTypeFromPack,
      setExtractableOnType, setExpertRoutingOnType,
      SchemaPackMutationError,
    } = await import('./schema-pack/mutate.ts');
    const baseMutateOpts = {
      actor: actor as 'cli' | `mcp:${string}`,
      batchId,
      engine: ctx.engine,
      ...(sourceId ? { sourceId } : {}),
      ...(force ? { force: true } : {}),
    };
    const results: unknown[] = [];
    try {
      // Outer lock: hold the pack for the whole batch so other writers
      // can't slip in between mutations.
      await withPackLock(pack, { force, lockDir: undefined }, async () => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i]!;
          // Each primitive acquires the lock internally; the outer
          // withPackLock makes that re-entrant via fast-stale-detect
          // (--force option for the inner call). To keep semantics
          // simple, we pass {force:true} to the inner calls because
          // they're nested inside our outer lock — we already own it.
          const innerOpts = { ...baseMutateOpts, force: true };
          let r: unknown;
          switch (m.op) {
            case 'add_type':
              r = await addTypeToPack(pack, {
                name: m.name as string,
                primitive: m.primitive as never,
                prefix: m.prefix as string,
                extractable: m.extractable as boolean | undefined,
                expertRouting: m.expert_routing as boolean | undefined,
                aliases: m.aliases as string[] | undefined,
              }, innerOpts);
              break;
            case 'remove_type':
              r = await removeTypeFromPack(pack, m.name as string, innerOpts);
              break;
            case 'update_type':
              r = await updateTypeOnPack(pack, { name: m.name as string, patch: (m.patch as object) ?? {} }, innerOpts);
              break;
            case 'add_alias':
              r = await addAliasToType(pack, m.type as string, m.alias as string, innerOpts);
              break;
            case 'remove_alias':
              r = await removeAliasFromType(pack, m.type as string, m.alias as string, innerOpts);
              break;
            case 'add_prefix':
              r = await addPrefixToType(pack, m.type as string, m.prefix as string, innerOpts);
              break;
            case 'remove_prefix':
              r = await removePrefixFromType(pack, m.type as string, m.prefix as string, innerOpts);
              break;
            case 'add_link_type':
              r = await addLinkTypeToPack(pack, {
                name: m.name as string,
                inverse: m.inverse as string | undefined,
                inference: m.inference as { regex?: string; page_type?: string; target_type?: string } | undefined,
              }, innerOpts);
              break;
            case 'remove_link_type':
              r = await removeLinkTypeFromPack(pack, m.name as string, innerOpts);
              break;
            case 'set_extractable':
              r = await setExtractableOnType(pack, m.type as string, m.value as boolean, innerOpts);
              break;
            case 'set_expert_routing':
              r = await setExpertRoutingOnType(pack, m.type as string, m.value as boolean, innerOpts);
              break;
            default:
              throw new SchemaPackMutationError(
                'INVALID_RESULT',
                `unknown mutation op: '${m.op}' at index ${i}`,
                { index: i, op: m.op },
              );
          }
          results.push({ index: i, op: m.op, ...(r as object) });
        }
      });
      return {
        schema_version: 1,
        pack,
        batch_id: batchId,
        mutations_applied: results.length,
        results,
      };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'UNKNOWN';
      return {
        error: 'mutation_failed',
        code,
        message: (e as Error).message,
        batch_id: batchId,
        // Partial results recorded so the agent can inspect which
        // mutations landed before the failure (the atomic guarantee
        // is at the LOCK level — individual mutations are sequential
        // and each is atomic; pack state reflects everything up to the
        // failed mutation).
        partial_results: results,
      };
    }
  },
};

const reload_schema_pack: Operation = {
  name: 'reload_schema_pack',
  description: 'v0.40.6.0: flush the in-process schema pack cache so the next loadActivePack re-reads from disk. Cascades through extends-chain (codex C6). Admin scope; NOT localOnly. Returns {invalidated: string[]}.',
  params: {
    pack: { type: 'string', description: 'Pack name to invalidate (omit to flush all)' },
  },
  scope: 'admin',
  mutating: false,  // no DB writes
  handler: async (_ctx, p) => {
    const { invalidatePackCache } = await import('./schema-pack/registry.ts');
    return invalidatePackCache(p.pack as string | undefined);
  },
};

// v0.41.18.0 (A7 + T16, codex finding #5): MCP op for federated / thin-client
// brain installs to drive `gbrain onboard --auto` over MCP. Admin scope
// (NOT localOnly) so remote agents authenticated via OAuth can probe
// brain health + submit auto-eligible remediation handlers.
//
// Critical security gate (codex #5): admin scope alone is NOT sufficient
// to submit handlers in PROTECTED_JOB_NAMES (synthesize, patterns,
// consolidate, extract-takes-from-pages, contextual_reindex_per_chunk).
// Without this gate, an admin-scoped OAuth token would bypass the same
// guard that `submit_job` enforces. The new NAMED scope
// `run_protected_onboard` MUST be granted IN ADDITION TO admin for any
// protected child handler to fire.
//
// Behavior:
//   - mode='check' (default): returns the OnboardReport JSON envelope,
//     never submits jobs. Admin scope sufficient.
//   - mode='auto':            submits auto_apply tier. Admin + non-protected
//                             handlers only.
//   - mode='auto-with-prompt': submits auto_apply + prompt_required tier.
//                             Same protection check.
//
// Any LLM-bearing handler the plan would have submitted gets filtered out
// unless the caller has run_protected_onboard. Filtered items appear in
// the response with status='skipped_missing_scope' so the caller knows
// what they would have gotten with the right grants.
const run_onboard: Operation = {
  name: 'run_onboard',
  description: 'Probe brain health + optionally submit onboard remediations. Admin scope required. Protected handlers (LLM-bearing) require run_protected_onboard scope ADDITIONALLY.',
  params: {
    mode: { type: 'string', description: "'check' (default), 'auto', or 'auto-with-prompt'" },
    target_score: { type: 'number', description: 'Target brain_score (default 90)' },
    max_usd: { type: 'number', description: 'USD cap for autopilot path (required for auto modes)' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const mode = (typeof p.mode === 'string' ? p.mode : 'check') as 'check' | 'auto' | 'auto-with-prompt';
    const targetScore = typeof p.target_score === 'number' ? p.target_score : 90;
    const maxUsd = typeof p.max_usd === 'number' ? p.max_usd : undefined;

    const { computeRemediationPlan, runRemediation } = await import('./remediation/index.ts');
    const { runAllOnboardChecks } = await import('./onboard/checks.ts');
    const { buildOnboardReport } = await import('./onboard/render.ts');

    // Per A26: source-scope via sourceScopeOpts(ctx). The recommendation
    // planner is brain-wide today; future extension can scope by reading
    // ctx.sourceId / ctx.auth.allowedSources for per-source plans.

    let extraRemediations: import('./remediation-step.ts').RemediationStep[] = [];
    try {
      const checkResults = await runAllOnboardChecks(ctx.engine);
      extraRemediations = checkResults.flatMap((r) => r.remediations);
    } catch {
      // Fail-open per A19 — return plan without extras rather than error.
    }

    // 'check' mode: just return the plan + JSON envelope. No submission.
    if (mode === 'check') {
      const plan = await computeRemediationPlan(ctx.engine, { targetScore, extraRemediations });
      const report = buildOnboardReport(plan);
      return report;
    }

    // 'auto' and 'auto-with-prompt' modes: require --max-usd per A12 + A20
    // safety posture (cron-safety; refuses surprise spend).
    if (maxUsd === undefined) {
      throw new OperationError('invalid_params', `mode='${mode}' requires max_usd (cron-safety cap)`);
    }

    // Critical T16 + codex #5 security gate: filter out PROTECTED_JOB_NAMES
    // unless the caller has the run_protected_onboard scope IN ADDITION
    // to admin. Admin alone is insufficient.
    const grantedScopes = ctx.auth?.scopes ?? [];
    const canRunProtected = grantedScopes.includes('run_protected_onboard');
    const { isProtectedJobName } = await import('./minions/protected-names.ts');

    const skippedMissingScope: Array<{ id: string; job: string; reason: string }> = [];
    const allowedExtras = extraRemediations.filter((r) => {
      if (canRunProtected) return true;
      if (isProtectedJobName(r.job)) {
        skippedMissingScope.push({ id: r.id, job: r.job, reason: 'requires run_protected_onboard scope' });
        return false;
      }
      return true;
    });

    // Run remediation with filtered extras. Hooks emit nothing — MCP
    // returns structured result. Per A23 client_id attribution: stamp
    // job.data.client_id on each submission so the spend chain (T10)
    // attributes correctly. The library doesn't do this today; the
    // upstream submit-side gating in submit_job filters protected names
    // for ctx.remote !== false callers, so even if MCP run_onboard had a
    // typo, the underlying queue.add would reject. Defense-in-depth.
    const result = await runRemediation(
      ctx.engine,
      { targetScore, maxUsd },
      {},
    );

    return {
      ...result,
      skipped_missing_scope: skippedMissingScope,
    };
  },
};

// v0.41.20.0 SkillOpt — MCP exposure (admin scope + per-skill allowlist
// via the resolver inside the handler). Designed for trusted admin tokens
// that want to drive optimization remotely; the same trust gates as the
// CLI fire (working tree, install path, lock acquisition, bundled-skill
// guard). NOT localOnly so admin HTTP MCP clients can invoke.
const run_skillopt: Operation = {
  name: 'run_skillopt',
  description: 'Run SkillOpt against a single skill. Admin scope; mutating; rate-limited per-skill via DB lock. See gbrain skillopt CLI for the full flag surface.',
  params: {
    skill_name: { type: 'string', required: true, description: 'Kebab-case skill name (resolves to skills/<name>/SKILL.md)' },
    benchmark_path: { type: 'string', description: 'Absolute path to benchmark JSONL; defaults to skills/<name>/skillopt-benchmark.jsonl' },
    epochs: { type: 'number', description: 'Default 4' },
    batch_size: { type: 'number', description: 'Default 8' },
    lr: { type: 'number', description: 'Default 4' },
    max_cost_usd: { type: 'number', description: 'Default 5.00' },
    no_mutate: { type: 'boolean', description: 'Write proposed.md without replacing SKILL.md' },
    allow_mutate_bundled: { type: 'boolean', description: 'Required to mutate bundled skills' },
    held_out_path: { type: 'string', description: 'Path to a held-out test set (JSONL). REQUIRED (>=5 rows) to mutate a bundled skill in place — otherwise the run hard-refuses. Remote callers: must resolve within the skills directory.' },
    dry_run: { type: 'boolean', description: 'Cost preview, no LLM calls' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: false,
  handler: async (ctx, p) => {
    // SECURITY: skill_name is joined into filesystem paths (SKILL.md, default
    // benchmark, checkpoint, history, best.md, proposed.md). A traversal-shaped
    // name (`../`, absolute) would escape the skills dir even WITH the
    // caller-supplied-path confinement below. Validate kebab-only up front so
    // every derived path is contained by construction. Applies to all callers.
    const skillNameRaw = (p.skill_name as string) ?? '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillNameRaw)) {
      throw new OperationError(`run_skillopt: skill_name must be kebab-case (matching ^[a-z0-9][a-z0-9-]*$); got '${skillNameRaw}'`, 'invalid_params');
    }
    if (ctx.remote !== false) {
      // Remote: enforce per-skill allowlist read from config.
      // `skillopt.allowed_skills` is a JSON-array config of skill names
      // an admin-scoped OAuth client may target. Default DENY-ALL: when
      // unset, MCP cannot drive skillopt on any skill.
      const allowedRaw = await ctx.engine.getConfig('skillopt.allowed_skills');
      let allowed: string[] = [];
      try {
        if (allowedRaw) allowed = JSON.parse(allowedRaw) as string[];
      } catch { /* fall through to deny */ }
      const skillName = (p.skill_name as string) ?? '';
      if (!allowed.includes(skillName)) {
        throw new OperationError(`run_skillopt: skill '${skillName}' is not in skillopt.allowed_skills allowlist (default deny-all for remote callers)`, 'permission_denied');
      }
    }
    const { runSkillOpt } = await import('./skillopt/orchestrator.ts');
    const { autoDetectSkillsDirReadOnly } = await import('./repo-root.ts');
    const { resolveModel } = await import('./model-config.ts');
    const detected = autoDetectSkillsDirReadOnly(process.cwd());
    const skillsDir = detected.dir;
    if (!skillsDir) {
      throw new OperationError('run_skillopt: skills directory not found', 'config_error');
    }
    const optimizerModel = await resolveModel(ctx.engine, { tier: 'deep', fallback: 'anthropic:claude-opus-4-7' });
    const targetModel = await resolveModel(ctx.engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
    const judgeModel = await resolveModel(ctx.engine, { tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' });
    const skillName = p.skill_name as string;
    const benchmarkPath = (p.benchmark_path as string) ??
      `${skillsDir}/${skillName}/skillopt-benchmark.jsonl`;
    const heldOutPath = p.held_out_path as string | undefined;
    // SECURITY: remote callers must NOT be able to point benchmark/held-out at
    // arbitrary host files (loadBenchmark → fs.readFileSync would otherwise be an
    // arbitrary-read + existence oracle). Confine any caller-supplied path to the
    // skills directory. Local CLI callers (ctx.remote === false) are unconfined.
    if (ctx.remote !== false) {
      const nodePath = await import('node:path');
      const nodeFs = await import('node:fs');
      const rootReal = (() => {
        try { return nodeFs.realpathSync(skillsDir); } catch { return nodePath.resolve(skillsDir); }
      })();
      const confine = (label: string, candidate: string | undefined): void => {
        if (!candidate) return;
        const resolved = nodePath.resolve(candidate);
        let real = resolved;
        try {
          real = nodeFs.realpathSync(resolved);
        } catch {
          // Not yet present: canonicalize the nearest existing ancestor so a
          // legit in-dir path under a symlinked skillsDir (e.g. macOS /tmp ->
          // /private/tmp, Conductor worktrees) isn't wrongly rejected.
          try { real = nodePath.join(nodeFs.realpathSync(nodePath.dirname(resolved)), nodePath.basename(resolved)); }
          catch { /* parent also missing; fall back to resolved form */ }
        }
        if (real !== rootReal && !real.startsWith(rootReal + nodePath.sep)) {
          throw new OperationError(`run_skillopt: ${label} must resolve within the skills directory for remote callers`, 'permission_denied');
        }
      };
      confine('benchmark_path', p.benchmark_path as string | undefined);
      confine('held_out_path', heldOutPath);
    }
    const result = await runSkillOpt({
      engine: ctx.engine,
      skillName,
      skillsDir,
      benchmarkPath,
      epochs: (p.epochs as number) ?? 4,
      batchSize: (p.batch_size as number) ?? 8,
      lr: (p.lr as number) ?? 4,
      lrSchedule: 'cosine',
      split: [4, 1, 5],
      optimizerModel,
      targetModel,
      judgeModel,
      mode: 'patch',
      dryRun: (p.dry_run as boolean) === true,
      noMutate: (p.no_mutate as boolean) === true,
      allowMutateBundled: (p.allow_mutate_bundled as boolean) === true,
      bootstrapReviewed: false,
      ...(heldOutPath ? { heldOutPath } : {}),
      json: true,
      maxCostUsd: (p.max_cost_usd as number) ?? 5.0,
      maxRuntimeMin: 30,
      force: false,
    });
    return {
      outcome: result.outcome,
      receipt: result.receipt,
      mutated_skill_file: result.mutatedSkillFile,
      proposed_path: result.proposedPath,
    };
  },
};

// ── v0.42.x — Life Chronicle (#2390) timeline read ops ───────────────────
// CLI names avoid the existing `timeline` (get_timeline, a page's own timeline):
// `gbrain day <date>` / `gbrain since <date>` / `gbrain last-seen <entity>`.
// All route through sourceScopeOpts(ctx) so reads honor source isolation.
const chronicle_day: Operation = {
  name: 'chronicle_day',
  description:
    'Life Chronicle: events + timeline entries on a given day (or its ISO week when week=true), ' +
    "ordered chronologically; each row backlinks to its depth page. Distinct from `get_timeline`/" +
    "`gbrain timeline <slug>`, which shows ONE page's timeline. CLI: `gbrain day <date>`.",
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Day as YYYY-MM-DD.' },
    week: { type: 'boolean', description: 'Expand to the ISO week (Mon–Sun) containing the date.' },
    limit: { type: 'number', description: 'Max rows (default 200).' },
    narrative: { type: 'boolean', description: 'Also return a prose day-by-day narrative.' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getTimelineForDate(String(p.date), {
      week: p.week === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...sourceScopeOpts(ctx),
    });
    if (p.narrative === true) {
      const { renderTimelineNarrative } = await import('./chronicle/narrative.ts');
      return { date: String(p.date), narrative: renderTimelineNarrative(rows), events: rows };
    }
    return rows;
  },
  cliHints: { name: 'day', positional: ['date'] },
};

const chronicle_on_this_day: Operation = {
  name: 'chronicle_on_this_day',
  description:
    'Life Chronicle: events from the same calendar day in PRIOR years ("on this day"). ' +
    'CLI: `gbrain on-this-day [--date YYYY-MM-DD]`.',
  scope: 'read',
  params: {
    date: { type: 'string', description: 'Anchor day YYYY-MM-DD (default today); matches its month-day in prior years.' },
    limit: { type: 'number', description: 'Max rows (default 50).' },
  },
  handler: async (ctx, p) => ctx.engine.getOnThisDay({
    date: typeof p.date === 'string' ? p.date : undefined,
    limit: typeof p.limit === 'number' ? p.limit : undefined,
    ...sourceScopeOpts(ctx),
  }),
  cliHints: { name: 'on-this-day' },
};

const chronicle_since: Operation = {
  name: 'chronicle_since',
  description:
    'Life Chronicle: events + timeline entries on or after a date, optionally filtered by event kind. ' +
    'CLI: `gbrain since <date> [--kind commitment]`.',
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Lower-bound day as YYYY-MM-DD (inclusive).' },
    kind: { type: 'string', description: "Filter event projections by event.kind (e.g. 'commitment')." },
    limit: { type: 'number', description: 'Max rows (default 200).' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getSince(String(p.date), {
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'since', positional: ['date'] },
};

const chronicle_last_seen: Operation = {
  name: 'chronicle_last_seen',
  description:
    "Life Chronicle: when an entity was last seen — its own timeline rows OR an event's `who`. " +
    'Returns last_date, the event slug, and days_ago. CLI: `gbrain last-seen <entity-slug>`.',
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Reference day YYYY-MM-DD for days_ago (default today).' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLastSeen(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'last-seen', positional: ['entity'] },
};

const ontology_get: Operation = {
  name: 'ontology_get',
  description:
    "Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` " +
    "(default now), with provenance + confidence + validity. CLI: `gbrain ontology <entity> [--asof YYYY-MM-DD]`.",
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Valid-time as-of day YYYY-MM-DD (time-travel; default now).' },
    min_confidence: { type: 'number', description: 'Only return observations at/above this confidence (0..1).' },
    include_quarantined: { type: 'boolean', description: 'Include quarantined novel dimensions (default false).' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getOntology(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      includeQuarantined: p.include_quarantined === true,
      ...sourceScopeOpts(ctx),
    });
    // Remote redaction: never surface diary-sourced ontology to untrusted callers.
    return ctx.remote !== false ? rows.filter((r) => !(r.source ?? '').startsWith('life/diary/')) : rows;
  },
  cliHints: { name: 'ontology', positional: ['entity'] },
};

const ontology_propose: Operation = {
  name: 'ontology_propose',
  description:
    'Life Chronicle: record one ontology observation (entity has dimension=value), sourced + ' +
    'confidence-weighted + bi-temporal. Idempotent on (entity,dimension,value,source). A new value ' +
    'supersedes the prior; a backdated conflict is flagged not rewritten. CLI: `gbrain ontology-add <entity> <dimension> <value>`.',
  scope: 'write',
  mutating: true,
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug.' },
    dimension: { type: 'string', required: true, description: 'Dimension (e.g. role, risk_tolerance). Normalized at write.' },
    value: { type: 'string', required: true, description: 'The resolved value (e.g. advisor).' },
    confidence: { type: 'number', description: '0..1; default 0.7.' },
    source: { type: 'string', description: 'Provenance (page slug / uri); default "manual".' },
    valid_from: { type: 'string', description: 'ISO date the value became true (default: now).' },
    valid_to: { type: 'string', description: 'ISO date the value stopped being true (default: open).' },
    visibility: { type: 'string', enum: ['private', 'world'], description: 'Default private.' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.mergeOntologyFact({
      entitySlug: String(p.entity),
      dimension: String(p.dimension),
      value: String(p.value),
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
      source: typeof p.source === 'string' && p.source ? p.source : 'manual',
      validFrom: typeof p.valid_from === 'string' ? p.valid_from : undefined,
      validTo: typeof p.valid_to === 'string' ? p.valid_to : undefined,
      visibility: p.visibility === 'world' ? 'world' : 'private',
      sourceId: ctx.sourceId,
    });
  },
  cliHints: { name: 'ontology-add', positional: ['entity', 'dimension', 'value'] },
};

const ontology_dimensions: Operation = {
  name: 'ontology_dimensions',
  description:
    'Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with ' +
    'entity + observation counts. CLI: `gbrain ontology-dimensions`.',
  scope: 'read',
  params: {},
  handler: async (ctx) => ctx.engine.discoverOntologyDimensions(sourceScopeOpts(ctx)),
  cliHints: { name: 'ontology-dimensions' },
};

const ontology_conflicts: Operation = {
  name: 'ontology_conflicts',
  description:
    'Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine ' +
    'disagreement, not temporal supersession). CLI: `gbrain ontology-contradictions`.',
  scope: 'read',
  params: {
    min_confidence: { type: 'number', description: 'Only consider observations at/above this confidence (0..1).' },
  },
  handler: async (ctx, p) => {
    const conflicts = await ctx.engine.findOntologyConflicts({
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      ...sourceScopeOpts(ctx),
    });
    if (ctx.remote === false) return conflicts;
    // Remote: redact diary-sourced values; drop conflicts that no longer have
    // ≥2 distinct values once diary provenance is removed (no leak via conflicts).
    return conflicts
      .map((c) => ({ ...c, values: c.values.filter((v) => !(v.source ?? '').startsWith('life/diary/')) }))
      .filter((c) => new Set(c.values.map((v) => v.value)).size >= 2);
  },
  cliHints: { name: 'ontology-contradictions' },
};

const volunteer_chronicle: Operation = {
  name: 'volunteer_chronicle',
  description:
    'Life Chronicle agent-orientation: the recent timeline (last N days) + the current ' +
    'validity-resolved ontology for the named entities, in one zero-LLM payload, so an agent ' +
    'orients before acting. Diary-sourced ontology is redacted for remote callers. ' +
    'CLI: `gbrain orient [--days 7] [--entities people/a,people/b]`.',
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Recent-timeline lookback in days (default 7).' },
    entities: { type: 'string', description: 'Comma-separated entity slugs to resolve ontology for.' },
    limit: { type: 'number', description: 'Max timeline rows (default 50).' },
  },
  handler: async (ctx, p) => {
    const { loadChronicleContext } = await import('./context/chronicle-context.ts');
    const entities = typeof p.entities === 'string'
      ? p.entities.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    return loadChronicleContext(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      entities,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      remote: ctx.remote !== false,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'orient' },
};

const chronicle_backfill: Operation = {
  name: 'chronicle_backfill',
  description:
    'Life Chronicle: sweep existing meeting/conversation/calendar pages into timeline events by ' +
    'enqueuing chronicle_extract jobs (one per eligible page). --dry-run counts without enqueuing. ' +
    'Local-only bulk op. CLI: `gbrain chronicle-backfill [--since YYYY-MM-DD] [--limit N] [--dry-run]`.',
  scope: 'admin',
  mutating: true,
  localOnly: true,
  params: {
    since: { type: 'string', description: 'Only pages updated on/after this date (YYYY-MM-DD).' },
    limit: { type: 'number', description: 'Max pages per type to sweep (default 1000).' },
    dry_run: { type: 'boolean', description: 'Count eligible pages without enqueuing.' },
  },
  handler: async (ctx, p) => {
    const { isChronicleEligible } = await import('./chronicle/eligibility.ts');
    const TYPES = ['meeting', 'conversation', 'calendar-event'] as const;
    const limit = typeof p.limit === 'number' ? p.limit : 1000;
    const updated_after = typeof p.since === 'string' ? p.since : undefined;
    const dryRun = p.dry_run === true;
    const scope = sourceScopeOpts(ctx);
    type QueueLike = { add: (n: string, d: Record<string, unknown>) => Promise<unknown> };
    let queue: QueueLike | null = null;
    if (!dryRun) {
      const { MinionQueue } = await import('./minions/queue.ts');
      queue = new MinionQueue(ctx.engine) as unknown as QueueLike;
    }
    let scanned = 0, eligible = 0, enqueued = 0;
    const errors: { slug: string; error: string }[] = [];
    for (const type of TYPES) {
      const pages = await ctx.engine.listPages({ type, updated_after, limit, ...scope });
      for (const page of pages) {
        scanned++;
        const dreamGenerated = (page.frontmatter as Record<string, unknown> | undefined)?.dream_generated === true;
        const elig = isChronicleEligible({ type: page.type, slug: page.slug, body: page.compiled_truth, dreamGenerated });
        if (!elig.ok) continue;
        eligible++;
        if (dryRun || !queue) continue;
        try {
          await queue.add('chronicle_extract', { slug: page.slug, sourceId: ctx.sourceId ?? 'default' });
          enqueued++;
        } catch (e) {
          // Never swallow — surface per-page failures (the #2057 no-swallow pattern).
          errors.push({ slug: page.slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return { scanned, eligible, enqueued, dry_run: dryRun, errors };
  },
  cliHints: { name: 'chronicle-backfill' },
};

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // v0.26.5 destructive-guard ops (page-level soft-delete + recovery + admin purge)
  restore_page, purge_deleted_pages,
  // Search
  search, query,
  // v0.36 Phase 2: image-as-query
  search_by_image,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, list_link_sources, traverse_graph,
  // Timeline
  add_timeline_entry, get_timeline,
  // Admin
  get_stats, get_health, run_doctor, get_versions, revert_version,
  // v0.31.1 (Issue #734): thin-client banner identity packet (read-scope, banner-only)
  get_brain_identity,
  // PR1: skill catalog over MCP — discover + fetch host-repo skills (read-scope)
  list_skills, get_skill, list_brain_skillpack, advisor,
  // v0.41.19.0: thin-client `gbrain status` payload (admin-scope, sync + cycle only)
  get_status_snapshot,
  // Sync
  sync_brain,
  // Raw data
  put_raw_data, get_raw_data,
  // Resolution & chunks
  resolve_slugs, get_chunks,
  // Ingest log
  log_ingest, get_ingest_log,
  // Files
  file_list, file_upload, file_url,
  // Jobs (Minions)
  submit_job, get_job, list_jobs, cancel_job, retry_job, get_job_progress,
  pause_job, resume_job, replay_job, send_job_message,
  // v0.38 Slice 3: remote-callable agent dispatch with OAuth-bound trust boundary
  submit_agent,
  // Orphans
  find_orphans,
  // v0.36.1.0 (T7) — Hindsight calibration wave: read profile via MCP
  get_calibration_profile,
  // v0.28: Takes + think
  takes_list, takes_search, think,
  // v0.30: calibration aggregates over takes
  takes_scorecard, takes_calibration,
  // v0.28: whoami + scoped sources management
  whoami, sources_add, sources_list, sources_remove, sources_status,
  // v0.29: Salience + anomalies + recent transcripts
  get_recent_salience, find_anomalies, get_recent_transcripts,
  // v0.42.x (#2390): Life Chronicle timeline reads
  chronicle_day, chronicle_on_this_day, chronicle_since, chronicle_last_seen,
  ontology_get, ontology_propose, ontology_dimensions, ontology_conflicts,
  volunteer_chronicle, chronicle_backfill,
  // v0.43 (#2095): push-based context
  volunteer_context,
  // v0.31: hot memory (facts table)
  extract_facts, recall, forget_fact,
  // v0.32.6: contradiction probe MCP surface (M3)
  find_contradictions,
  // v0.33: expertise + relationship-proximity routing
  find_experts,
  // v0.35.4: temporal trajectory (typed claims over time + regression detection)
  find_trajectory,
  // v0.33.3: Cathedral III code-intelligence (MCP-exposed; were CLI_ONLY pre-v0.33.3)
  code_callers, code_callees, code_def, code_refs,
  // v0.34 W3: recursive code_blast + code_flow
  code_blast, code_flow,
  // v0.34 W3b: code_traversal_cache admin clear op
  code_traversal_cache_clear,
  // v0.40.6.0 Schema Cathedral v3: 9 new ops — 7 read + 2 admin (NOT
  // localOnly per D2 so remote agents (your OpenClaw, etc.) can author packs).
  // schema_apply_mutations is batched per D10 — one MCP tool, N
  // mutations applied atomically inside one withPackLock scope.
  get_active_schema_pack, list_schema_packs,
  schema_stats, schema_lint, schema_graph, schema_explain_type,
  schema_review_orphans,
  schema_apply_mutations, reload_schema_pack,
  // v0.41.18.0 (T16, A7, codex #5)
  run_onboard,
  // v0.41.20.0 SkillOpt — admin-scoped MCP op for remote optimization.
  // Per-skill allowlist via `skillopt.allowed_skills` config (default
  // deny-all for remote callers). NOT localOnly so admin OAuth clients
  // can submit; CLI bypass via ctx.remote === false.
  run_skillopt,
];

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
