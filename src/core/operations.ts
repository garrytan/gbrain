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
import { hybridSearch, hybridSearchCached } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { dedupResults } from './search/dedup.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from './eval-capture.ts';
import type { HybridSearchMeta } from './types.ts';
import { extractPageLinks, isAutoLinkEnabled, isAutoTimelineEnabled, parseTimelineEntries, makeResolver, type UnresolvedFrontmatterRef } from './link-extraction.ts';
import { isFactsBackstopEligible } from './facts/eligibility.ts';
import { stripTakesFence } from './takes-fence.ts';
import { stripFactsFence } from './facts-fence.ts';
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
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
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
    // v0.31.8 (D20): thread ctx.sourceId through read-side ops. Only pass
    // sourceId when it's set on ctx — when unset (local CLI default chain
    // resolves to no source), the engine two-branch query falls through to
    // the cross-source view, preserving pre-v0.31.8 behavior. MCP callers
    // (stdio + HTTP) populate ctx.sourceId via the transport layer.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};

    let page = await ctx.engine.getPage(slug, { includeDeleted, ...sourceOpts });
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
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

    const tags = await ctx.engine.getTags(page.slug, sourceOpts);
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
    return { ...visibleBody, tags, ...(resolved_slug ? { resolved_slug } : {}) };
  },
  scope: 'read',
  cliHints: { name: 'get', positional: ['slug'] },
};

const put_page: Operation = {
  name: 'put_page',
  description: 'Write/update a page (markdown with frontmatter). Chunks, embeds, reconciles tags, and (when auto_link/auto_timeline are enabled) extracts + reconciles graph links and timeline entries.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;

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
    const result = await importFromContent(ctx.engine, slug, p.content as string, {
      noEmbed,
      ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
    });

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
            const created = await ctx.engine.addTimelineEntriesBatch(batch);
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
  const resolver = makeResolver(engine, { mode: 'live' });
  const { candidates, unresolved } = await extractPageLinks(
    slug, fullContent, parsed.frontmatter, parsed.type, resolver,
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

    // Reconcilable outgoing edges: markdown + our own frontmatter edges.
    // Manual edges (link_source='manual') are NEVER touched by reconciliation.
    const reconcilableOut = existingOut.filter(
      l => l.link_source === 'markdown' || l.link_source == null ||
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

const company_share_export: Operation = {
  name: 'company_share_export',
  description: 'Export pages explicitly approved for company-wide sharing. Private by default; source defaults and page overrides decide whether a page exports as summary or full sanitized content.',
  params: {
    member_id: { type: 'string', description: 'Member id to stamp into the signed manifest.' },
    limit: { type: 'number', description: 'Max records in this page of export results.' },
    cursor: { type: 'string', description: 'Opaque cursor returned by the previous export page.' },
  },
  handler: async (ctx, p) => {
    const { buildCompanyShareExport, CompanyShareError } = await import('./company-share.ts');
    try {
      return await buildCompanyShareExport(ctx.engine, {
        memberId: typeof p.member_id === 'string' ? p.member_id : undefined,
        limit: typeof p.limit === 'number' ? p.limit : undefined,
        cursor: typeof p.cursor === 'string' ? p.cursor : undefined,
        ...sourceScopeOpts(ctx),
      });
    } catch (err) {
      if (err instanceof CompanyShareError) {
        throw new OperationError('invalid_params', err.message);
      }
      throw err;
    }
  },
  scope: 'read',
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: SEARCH_DESCRIPTION,
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const queryText = p.query as string;
    // v0.34.1 (#861 — P0 leak seal): thread caller's source scope into
    // searchKeyword. Pre-fix this op silently returned cross-source hits
    // for any auth'd OAuth client.
    const raw = await ctx.engine.searchKeyword(queryText, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
      ...sourceScopeOpts(ctx),
    });
    const results = dedupResults(raw);
    const latency_ms = Date.now() - startedAt;

    // Op-layer capture (v0.25.0). Fire-and-forget — no await on the
    // capture call so MCP response latency is unaffected. search has
    // no expand/detail/vector semantics so meta fields are fixed.
    if (isEvalCaptureEnabled(ctx.config)) {
      void captureEvalCandidate(
        ctx.engine,
        {
          tool_name: 'search',
          query: queryText,
          results,
          meta: { vector_enabled: false, detail_resolved: null, expansion_applied: false },
          latency_ms,
          remote: ctx.remote ?? false,
          expand_enabled: null,
          detail: null,
          job_id: ctx.jobId ?? null,
          subagent_id: ctx.subagentId ?? null,
        },
        { scrub_pii: isEvalScrubEnabled(ctx.config) },
      );
    }

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
        "v0.34: scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile). Pass '__all__' to force cross-source search in multi-source brains.",
    },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    const queryText = p.query as string | undefined;
    const imageData = p.image as string | undefined;
    const imageMime = (p.image_mime as string) || 'image/jpeg';

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
        ...sourceScopeOpts(ctx),
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
    // v0.34 (Codex finding #2): thread ctx.sourceId so multi-source brains
    // get source-scoped retrieval. Explicit `source_id` param wins over
    // ctx.sourceId; literal `__all__` opts out (cross-source).
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const resolvedSourceId =
      sourceIdParam !== undefined
        ? sourceIdParam === '__all__'
          ? undefined
          : sourceIdParam
        : ctx.sourceId;
    // v0.32.x search-lite: route the query op through hybridSearchCached so
    // semantic cache + token budget + intent weighting fire automatically.
    // Plain hybridSearch remains the bare API for callers that opt out.
    const results = await hybridSearchCached(ctx.engine, queryText, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
      detail,
      language: (p.lang as string) || undefined,
      symbolKind: (p.symbol_kind as string) || undefined,
      nearSymbol: (p.near_symbol as string) || undefined,
      walkDepth: typeof p.walk_depth === 'number' ? (p.walk_depth as number) : undefined,
      sourceId: resolvedSourceId,
      // v0.29.1 — agent-explicit recency + salience. Omitted = heuristic defaults.
      salience: p.salience as 'off' | 'on' | 'strong' | undefined,
      recency: p.recency as 'off' | 'on' | 'strong' | undefined,
      since: typeof p.since === 'string' ? p.since : undefined,
      until: typeof p.until === 'string' ? p.until : undefined,
      // v0.32.x search-lite: token budget + cache opt-outs.
      tokenBudget: typeof p.token_budget === 'number' ? (p.token_budget as number) : undefined,
      useCache: typeof p.use_cache === 'boolean' ? (p.use_cache as boolean) : undefined,
      intentWeighting: typeof p.intent_weighting === 'boolean' ? (p.intent_weighting as boolean) : undefined,
      onMeta: (m) => { capturedMeta = m; },
      // v0.34.1 (#861 — P0 leak seal): thread caller's source scope. The
      // hybridSearch internal searchOpts rebuild (hybrid.ts:223) was
      // dropping these fields pre-fix even when callers passed them.
      ...sourceScopeOpts(ctx),
    });
    const latency_ms = Date.now() - startedAt;

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
    const { runThink, persistSynthesis } = await import('./think/index.ts');
    const result = await runThink(ctx.engine, {
      question: String(p.question),
      anchor: p.anchor ? String(p.anchor) : undefined,
      rounds: typeof p.rounds === 'number' ? (p.rounds as number) : undefined,
      save: safeSave,
      take: safeTake,
      model: p.model ? String(p.model) : undefined,
      since: p.since ? String(p.since) : undefined,
      until: p.until ? String(p.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
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
      saved_slug: savedSlug ?? null,
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
    // v0.31.8 (D20): thread ctx.sourceId for read-side ops on multi-source brains.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    return ctx.engine.getTags(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

const add_link: Operation = {
  name: 'add_link',
  description: 'Create link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at)' },
    context: { type: 'string', description: 'Context for the link' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    // v0.31.8 (D7): single ctx.sourceId scopes both endpoints + origin. Cross-
    // source link creation is out of scope for this wave; use the engine API
    // directly for that edge case.
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId, originSourceId: ctx.sourceId }
      : undefined;
    await ctx.engine.addLink( // gbrain-allow-direct-insert: add_link MCP op is the explicit canonical surface for manual link creation; auto-link reconciliation runs separately via auto_link post-hook
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
      undefined, undefined, undefined,
      linkOpts,
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'link', positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId }
      : undefined;
    await ctx.engine.removeLink(p.from as string, p.to as string, undefined, undefined, linkOpts);
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    // v0.31.8 (D16): thread ctx.sourceId. When unset, engine falls through
    // to cross-source view (back-compat).
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
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
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    return ctx.engine.getBacklinks(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'backlinks', positional: ['slug'] },
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
    // v0.31.8 (D20): thread ctx.sourceId.
    const sourceId = ctx.sourceId;
    return ctx.engine.getTimeline(p.slug as string, sourceId ? { sourceId } : undefined);
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
    const { getCompanyShareRole } = await import('./company-share.ts');
    const { companySkillProfile } = await import('./company-skill-policy.ts');
    const stats = await ctx.engine.getStats();
    const brainRole = await getCompanyShareRole(ctx.engine);
    return {
      version: VERSION,
      engine: ctx.engine.kind,
      brain_role: brainRole,
      page_count: stats.page_count,
      chunk_count: stats.chunk_count,
      last_sync_iso: null as string | null,
      ...(brainRole === 'company' ? { skill_profile: companySkillProfile() } : {}),
    };
  },
  scope: 'read',
  // intentionally no cliHints — banner-only op
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
    return queue.add(name, (p.data as Record<string, unknown>) || {}, {
      queue: (p.queue as string) || 'default',
      priority: (p.priority as number) || 0,
      max_attempts: (p.max_attempts as number) || 3,
      delay: (p.delay as number) || undefined,
      timeout_ms: (p.timeout_ms as number) || undefined,
    }, trusted);
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
    return findOrphans(ctx.engine, { includePseudo: (p.include_pseudo as boolean) || false });
  },
  cliHints: { name: 'orphans', hidden: true },
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
    return findExperts(ctx.engine, {
      topic,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      explain: p.explain === true,
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
    entity_hints: { type: 'array', description: 'Existing canonical entity slugs the agent has already resolved. Helps the extractor pick the right slug.' },
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
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; pass '__all__' to force cross-source." },
    all_sources: { type: 'boolean', description: 'Force cross-source search (equivalent to source_id=__all__).' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const allSourcesParam = p.all_sources === true;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const allSources = allSourcesParam || sourceIdParam === '__all__';
    const sourceId = allSources
      ? undefined
      : sourceIdParam !== undefined
        ? sourceIdParam
        : ctx.sourceId;
    const edges = await ctx.engine.getCallersOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    return { symbol, count: edges.length, callers: edges };
  },
  cliHints: { name: 'code_callers', hidden: true },
};

const code_callees: Operation = {
  name: 'code_callees',
  description: CODE_CALLEES_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callees of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; pass '__all__' to force cross-source." },
    all_sources: { type: 'boolean', description: 'Force cross-source search.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const allSourcesParam = p.all_sources === true;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const allSources = allSourcesParam || sourceIdParam === '__all__';
    const sourceId = allSources
      ? undefined
      : sourceIdParam !== undefined
        ? sourceIdParam
        : ctx.sourceId;
    const edges = await ctx.engine.getCalleesOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    return { symbol, count: edges.length, callees: edges };
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
    return { symbol: p.symbol as string, count: defs.length, defs };
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
    return { symbol: p.symbol as string, count: refs.length, refs };
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
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.symbol as string;
    const depth = Math.min((p.depth as number) ?? 5, 8);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol, depth, source_id: ctx.sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callers',
        depth,
        maxNodes: max_nodes,
        sourceId: ctx.sourceId,
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
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.entry_point as string;
    const depth = Math.min((p.depth as number) ?? 8, 12);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol + ':flow', depth, source_id: ctx.sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callees',
        depth,
        maxNodes: max_nodes,
        sourceId: ctx.sourceId,
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

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // Company-wide sharing
  company_share_export,
  // v0.26.5 destructive-guard ops (page-level soft-delete + recovery + admin purge)
  restore_page, purge_deleted_pages,
  // Search
  search, query,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, traverse_graph,
  // Timeline
  add_timeline_entry, get_timeline,
  // Admin
  get_stats, get_health, run_doctor, get_versions, revert_version,
  // v0.31.1 (Issue #734): thin-client banner identity packet (read-scope, banner-only)
  get_brain_identity,
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
  // Orphans
  find_orphans,
  // v0.28: Takes + think
  takes_list, takes_search, think,
  // v0.30: calibration aggregates over takes
  takes_scorecard, takes_calibration,
  // v0.28: whoami + scoped sources management
  whoami, sources_add, sources_list, sources_remove, sources_status,
  // v0.29: Salience + anomalies + recent transcripts
  get_recent_salience, find_anomalies, get_recent_transcripts,
  // v0.31: hot memory (facts table)
  extract_facts, recall, forget_fact,
  // v0.32.6: contradiction probe MCP surface (M3)
  find_contradictions,
  // v0.33: expertise + relationship-proximity routing
  find_experts,
  // v0.33.3: Cathedral III code-intelligence (MCP-exposed; were CLI_ONLY pre-v0.33.3)
  code_callers, code_callees, code_def, code_refs,
  // v0.34 W3: recursive code_blast + code_flow
  code_blast, code_flow,
  // v0.34 W3b: code_traversal_cache admin clear op
  code_traversal_cache_clear,
];

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
