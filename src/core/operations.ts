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
import { hybridSearch } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { dedupResults } from './search/dedup.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from './eval-capture.ts';
import type { HybridSearchMeta } from './types.ts';
import { extractPageLinks, isAutoLinkEnabled, isAutoTimelineEnabled, parseTimelineEntries, makeResolver, type UnresolvedFrontmatterRef } from './link-extraction.ts';
import * as db from './db.ts';

// --- Types ---

export type ErrorCode =
  | 'page_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'bucket_not_found'
  | 'database_error'
  | 'permission_denied';

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
  if (!/^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)*$/i.test(slug)) {
    throw new OperationError('invalid_params', `Invalid page_slug: ${slug} (allowed: alphanumeric, hyphens, forward-slash separated segments)`);
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-]*$/.test(name)) {
    throw new OperationError('invalid_params', `Invalid filename: ${name} (allowed: alphanumeric, dot, underscore, hyphen — no leading dot/dash, no control chars or backslash)`);
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
   * When unset, operations MUST default to the stricter (remote=true) behavior.
   */
  remote?: boolean;
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
   * Connected-gbrains brain id (v0.19+). Identifies which brain this op is
   * targeting. 'host' for the default brain configured in ~/.gbrain/config.json;
   * otherwise a mount id registered in ~/.gbrain/mounts.json.
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
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  scope?: 'read' | 'write' | 'admin';
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
  description: 'Read a page by slug (supports optional fuzzy matching)',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;

    let page = await ctx.engine.getPage(slug);
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0]);
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
    }

    const tags = await ctx.engine.getTags(page.slug);
    return { ...page, tags, ...(resolved_slug ? { resolved_slug } : {}) };
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
    // Skip embedding when no OpenAI key is configured. importFromContent's existing
    // try/catch around embed only catches; without a key the OpenAI client would
    // attempt 5 retries with exponential backoff (up to ~2 minutes total) before
    // giving up. Detect early.
    const noEmbed = !process.env.OPENAI_API_KEY;
    const result = await importFromContent(ctx.engine, slug, p.content as string, { noEmbed });

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
    if (ctx.remote === true && !trustedWorkspace) {
      autoLinks = { skipped: 'remote' };
      autoTimeline = { skipped: 'remote' };
    } else if (result.parsedPage) {
      try {
        const enabled = await isAutoLinkEnabled(ctx.engine);
        if (enabled) {
          autoLinks = await runAutoLink(ctx.engine, slug, result.parsedPage);
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
    };
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

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
): Promise<{ created: number; removed: number; errors: number; unresolved: UnresolvedFrontmatterRef[] }> {
  const fullContent = parsed.compiled_truth + '\n' + parsed.timeline;
  // Live-mode resolver: per-put throwaway cache, pg_trgm + optional search.
  const resolver = makeResolver(engine, { mode: 'live' });
  const { candidates, unresolved } = await extractPageLinks(
    slug, fullContent, parsed.frontmatter, parsed.type, resolver,
  );

  // Resolve which targets exist (skip refs to non-existent pages to avoid FK
  // violation churn in addLink). One getAllSlugs call upfront, O(1) lookup.
  const allSlugs = await engine.getAllSlugs();
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
    const existingOut = await tx.getLinks(slug);
    // Incoming: we only look at frontmatter edges WE authored (origin_slug=slug).
    // Non-frontmatter and other-page frontmatter edges survive untouched.
    const existingInRaw = await tx.getBacklinks(slug);
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
          await tx.removeLink(slug, l.to_slug, l.link_type, l.link_source ?? undefined);
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
          await tx.removeLink(l.from_slug, slug, l.link_type, 'frontmatter');
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
  description: 'Delete a page',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'delete_page', slug: p.slug };
    await ctx.engine.deletePage(p.slug as string);
    return { status: 'deleted' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const list_pages: Operation = {
  name: 'list_pages',
  description: 'List pages with optional filters',
  params: {
    type: { type: 'string', description: 'Filter by page type' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    const pages = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: clampSearchLimit(p.limit as number | undefined, 50, 100),
    });
    return pages.map(pg => ({
      slug: pg.slug,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
    }));
  },
  scope: 'read',
  cliHints: { name: 'list' },
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: 'Keyword search using full-text search',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const queryText = p.query as string;
    const raw = await ctx.engine.searchKeyword(queryText, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
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
  description: 'Hybrid search with vector + keyword + multi-query expansion',
  params: {
    query: { type: 'string', required: true },
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
  },
  handler: async (ctx, p) => {
    const startedAt = Date.now();
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    const queryText = p.query as string;

    // v0.25.0 — capture meta side-channel. hybridSearch's return contract
    // stays SearchResult[] (Cathedral II callers depend on that); meta
    // arrives via callback so eval capture can record what actually ran.
    let capturedMeta: HybridSearchMeta | null = null;
    const results = await hybridSearch(ctx.engine, queryText, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
      detail,
      language: (p.lang as string) || undefined,
      symbolKind: (p.symbol_kind as string) || undefined,
      nearSymbol: (p.near_symbol as string) || undefined,
      walkDepth: typeof p.walk_depth === 'number' ? (p.walk_depth as number) : undefined,
      onMeta: (m) => { capturedMeta = m; },
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
    await ctx.engine.addTag(p.slug as string, p.tag as string);
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
    await ctx.engine.removeTag(p.slug as string, p.tag as string);
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
    return ctx.engine.getTags(p.slug as string);
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
    await ctx.engine.addLink(
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
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
    await ctx.engine.removeLink(p.from as string, p.to as string);
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
    return ctx.engine.getLinks(p.slug as string);
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
    return ctx.engine.getBacklinks(p.slug as string);
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
    // Backward compat: when neither link_type nor direction is provided, return
    // the legacy GraphNode[] shape. Once either is set, switch to GraphPath[].
    if (linkType === undefined && direction === undefined) {
      return ctx.engine.traverseGraph(slug, depth);
    }
    return ctx.engine.traversePaths(slug, { depth, linkType, direction });
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
    await ctx.engine.addTimelineEntry(p.slug as string, {
      date,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    });
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
    return ctx.engine.getTimeline(p.slug as string);
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

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getVersions(p.slug as string);
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
    await ctx.engine.createVersion(p.slug as string);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number);
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
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object);
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
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined);
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
    return ctx.engine.getChunks(p.slug as string);
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
    if (ctx.remote && isProtectedJobName(name)) {
      throw new OperationError('permission_denied', `'${name}' jobs cannot be submitted over MCP (CLI-only for security)`);
    }

    const { MinionQueue } = await import('./minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    // Trusted flag set only when this is a local (non-remote) submission. When
    // remote=true, the guard above has already thrown for protected names, so
    // passing undefined here is safe for any non-protected name that slips by.
    const trusted = !ctx.remote && isProtectedJobName(name) ? { allowProtectedSubmit: true } : undefined;
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

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // Search
  search, query,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, traverse_graph,
  // Timeline
  add_timeline_entry, get_timeline,
  // Admin
  get_stats, get_health, get_versions, revert_version,
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
];

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
