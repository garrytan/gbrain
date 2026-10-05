/**
 * Context validators + scope resolvers for the operations layer (pure move
 * from src/core/operations.ts): upload/slug/filename validators, the
 * subagent + bound-client slug fences, and the source-scope resolution
 * ladder every read-side op routes through. Helpers that were file-private
 * in operations.ts (enforceSubagentSlugFence, slugUnderSubagentFence,
 * slugOutsideCallerFence, enforceClientSlugFence, BOUND_CLIENT_META_OPS,
 * stampEvidenceSafe, maybeCaptureSearch) are exported HERE for future domain
 * modules, but are deliberately NOT re-exported from operations.ts — they
 * were never part of its public surface.
 */

import { lstatSync, realpathSync } from 'fs';
import { resolve, relative, sep } from 'path';
import { OperationError, opError } from './contract.ts';
import type { AuthInfo, Operation, OperationContext } from './contract.ts';
import type { Action } from '../agent-output.ts';
import { hostFix, invalidParam, paramUse, readFix } from './op-fix.ts';
import { CJK_SLUG_CHARS, SLUG_WORD_CHARS } from '../cjk.ts';
import { ALL_SOURCES, NO_SOURCES, isValidSourceId } from '../source-id.ts';
import { encodeDeepResearchId } from '../deep-research-id.ts';
import { isSearchMode } from '../search/mode.ts';
import { stampEvidence } from '../search/evidence.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from '../eval-capture.ts';
import type { SearchResult, HybridSearchMeta, PageReadScope, PageReadPolicy } from '../types.ts';
import { resolveExcludePrivatePages, isPrivatePage } from '../search/private-visibility.ts';

// --- Agent-contract fixes shared by the op error sites ---

/**
 * A slug that can sit in a fix's argv as a bare positional: it cannot read as
 * a flag and needs no shell quoting. Any other printable slug goes after `--`
 * (the op parser honours it since D6); see getPageFix.
 */
export function cliSafeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9._/:-]{0,254}$/i.test(slug);
}

/** Read-only: the sources this caller can read (MCP sources_list is grant-confined). */
export function sourcesListFix(why: string): Action {
  return readFix(why, { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } });
}

/** Read-only: one page by slug, scoped to a source when known. */
export function getPageFix(slug: string, why: string, opts: { sourceId?: string; includeDeleted?: boolean; fuzzy?: boolean } = {}): Action | undefined {
  if (typeof slug !== 'string' || !slug || slug.length > 512 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(slug)) return undefined;
  const source = opts.sourceId !== undefined && isValidSourceId(opts.sourceId) ? opts.sourceId : undefined;
  const flags = [...(opts.includeDeleted ? ['--include-deleted'] : []), ...(opts.fuzzy ? ['--fuzzy'] : []), ...(source ? ['--source', source] : [])];
  return readFix(why, {
    // A slug like `--yes` or one with shell metacharacters lands after `--`; shellQuote quotes it in `command`.
    argv: cliSafeSlug(slug) ? ['gbrain', 'get', slug, ...flags] : ['gbrain', 'get', ...flags, '--', slug],
    mcp: { tool: 'get_page', arguments: { slug, ...(opts.includeDeleted ? { include_deleted: true } : {}), ...(opts.fuzzy ? { fuzzy: true } : {}), ...(source ? { source_id: source } : {}) } },
  });
}

/** opError options carrying a fix only when one could be built. */
export function withFix(fix: Action | undefined): { fix?: Action } {
  return fix ? { fix } : {};
}

/**
 * get_page's miss (#4516): where the slug lives when a trusted local probe
 * found it in another source, otherwise the soft-delete / fuzzy check, as
 * surface-correct prose plus the matching read.
 */
export function pageNotFoundError(
  ctx: Pick<OperationContext, 'remote' | 'transport'>,
  slug: string,
  opts: { includeDeleted: boolean; sourceIdParam?: string; elsewhereSource?: string },
): OperationError {
  const retry = opts.includeDeleted ? `Check the slug or use ${paramUse(ctx, 'fuzzy')}` : `Page may be soft-deleted; pass ${paramUse(ctx, 'include_deleted')} to verify`;
  const where = opts.elsewhereSource;
  const explicit = opts.sourceIdParam !== ALL_SOURCES ? opts.sourceIdParam : undefined;
  return opError('page_not_found', `Page not found: ${slug}`,
    where !== undefined ? `Page exists in source '${where}' — pass ${paramUse(ctx, 'source', where)}. ${retry}` : retry,
    withFix(where !== undefined
      ? getPageFix(slug, `Reads the page from source ${where}, where it exists.`, { sourceId: where })
      : getPageFix(slug, opts.includeDeleted ? 'Fuzzy-matches the slug.' : 'Shows the page if it is soft-deleted (deleted_at set).',
        { sourceId: explicit, ...(opts.includeDeleted ? { fuzzy: true } : { includeDeleted: true }) })));
}

/**
 * The miss of a by-slug page read that ran under `scope` (get_page,
 * get_timeline). #4516: a trusted local caller (`ctx.remote === false`)
 * whose read was scoped learns which source holds the slug; for a remote
 * caller that probe would be a cross-source existence oracle outside its
 * grant, so it never runs.
 */
export async function scopedPageNotFoundError(
  ctx: OperationContext,
  slug: string,
  scope: PageReadScope,
  opts: { includeDeleted: boolean; sourceIdParam?: string },
): Promise<OperationError> {
  let elsewhereSource: string | undefined;
  if (ctx.remote === false && (scope.sourceId !== undefined || scope.sourceIds !== undefined)) {
    try {
      // gbrain-allow-unscoped-getpage: read-only diagnostic existence probe —
      // deliberately spans all sources to name where the slug lives.
      const elsewhere = await ctx.engine.getPage(slug, { includeDeleted: opts.includeDeleted });
      if (elsewhere && !(scope.excludePrivate && isPrivatePage(elsewhere))) {
        elsewhereSource = elsewhere.source_id;
      }
    } catch {
      // Diagnostic only — a probe failure must never mask the real error.
    }
  }
  return pageNotFoundError(ctx, slug, { ...opts, elsewhereSource });
}

const HTTP_HOST = { remote: true, transport: 'http' } as const;
const TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The OAuth client id when it is safe to name in a command. */
function safeClientId(auth: Pick<AuthInfo, 'clientId' | 'principal'> | undefined): string | undefined {
  return auth?.principal?.kind === 'oauth_client' && CLIENT_ID_RE.test(auth.clientId) ? auth.clientId : undefined;
}

/**
 * B5/B6: the brain host operator's grant change for this connection (token
 * flags or client flags), or the grant listing when the principal cannot be
 * named. Credential-bearing callers reach the server over HTTP.
 */
function grantFix(
  auth: Pick<AuthInfo, 'clientId' | 'principal'> | undefined,
  change: { token: string[]; client: string[] },
  why: string,
  inputs?: Action['inputs'],
): Action {
  const principal = auth?.principal;
  const clientId = safeClientId(auth);
  const target = principal?.kind === 'legacy_token' && TOKEN_ID_RE.test(principal.id)
    ? ['rescope-token', '--id', principal.id, ...change.token]
    : clientId ? ['rescope-client', clientId, ...change.client] : null;
  if (!target) {
    return hostFix(HTTP_HOST, principal?.kind === 'oauth_client' ? ['gbrain', 'auth', 'clients', '--json'] : ['gbrain', 'auth', 'list'],
      'Lists the grants so the operator can find and widen this connection.');
  }
  return { ...hostFix(HTTP_HOST, ['gbrain', 'auth', ...target], why, { consent: ['credentials'] }), ...(inputs ? { inputs } : {}) };
}

/** Grant at least one readable source to this connection (value supplied by the user). */
function sourceGrantFix(auth: Pick<AuthInfo, 'clientId' | 'principal'> | undefined): Action {
  return grantFix(auth, { token: ['--sources', '<sources>'], client: ['--federated-read', '<sources>'] },
    'Grants this connection the sources it may read; only the brain host operator can change grants.',
    [{ name: 'sources', how: 'Ask the user which source ids this connection should read (comma-separated; `gbrain sources list` on the brain host shows them).' }]);
}

/** Pending schema migrations on the brain host restore a degraded grant/fence projection. */
function migrationsFix(ctx: Pick<OperationContext, 'remote' | 'transport'>): Action {
  return hostFix(ctx, ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'],
    'The oauth_clients projection predates the grant columns; applying the pending migrations lets the fence be evaluated again.');
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
      throw opError('invalid_params', `File not found: ${filePath}`,
        'Pass the path of an existing file; a relative path resolves against the working directory of the process running gbrain.');
    }
    throw opError('invalid_params', `Cannot resolve path: ${filePath}`,
      'Pass a readable regular file: the path or one of its parent directories could not be resolved (permissions or a broken link).');
  }
  // Always reject final-component symlinks (basic safety for both modes).
  try {
    if (lstatSync(resolve(filePath)).isSymbolicLink()) {
      throw opError('invalid_params', `Symlinks are not allowed for upload: ${filePath}`,
        "Pass the link's real target path instead of the symlink (`realpath` prints it).");
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
    throw opError('invalid_params', `Confinement root not accessible: ${root}`,
      "The upload root (the server's working directory) is unreadable on the brain host; tell the user so its operator can fix that directory.");
  }
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== real) {
    throw opError('invalid_params', `Upload path must be within the working directory: ${filePath}`,
      "Copy the file under the server's working directory and pass that path; a symlinked parent that resolves outside it is refused too.");
  }
  return real;
}

/**
 * Op-boundary page-slug segment (#4665/#5032): cjk.ts's PAGE_SLUG_SEG shape
 * widened LOCALLY so `.` and `_` are allowed as part-CONTINUATION characters.
 * Colon separates individually valid parts inside a path segment, preserving
 * existing integration slugs such as `calendar:event-id` without admitting
 * empty or dot-led parts (`calendar:../x` remains invalid). The
 * sync slugifier deliberately preserves both (`notes/v1.0.0`,
 * `people/my_file_name` — see slugifySegment in src/core/sync.ts), so the
 * put_page boundary must round-trip every slug sync can produce. The lead
 * char stays a word char, so dot-LED segments remain impossible — `..`
 * traversal and every H5 rejection (backslash, %2e/%2f encodings, control
 * chars, RTL overrides, spaces) still fail. Deliberately NOT widened in
 * cjk.ts: cite-render, SlugRegistry's SLUG_RE, and the dream-cycle
 * SUMMARY_SLUG_RE consume the shared grammar with different semantics.
 * Compose with the `u` flag — see SLUG_WORD_CHARS.
 */
// Underscore may also LEAD a segment: the sync slugifier preserves leading
// underscores (`_index.md` → `_index`, the Hugo convention), so rejecting
// them recreates the un-updatable-synced-page class this widen closes.
// Dot stays continuation-only — `..` traversal remains impossible.
const OP_PAGE_SLUG_PART = `[${SLUG_WORD_CHARS}_][${SLUG_WORD_CHARS}._\\-]*`;
const OP_PAGE_SLUG_SEG = `${OP_PAGE_SLUG_PART}(?::${OP_PAGE_SLUG_PART})*`;

/**
 * Allowlist validator for page slugs. Rejects URL-encoded traversal, backslashes,
 * control chars, RTL overrides, Unicode lookalikes — anything outside the allowlist.
 * Format: alphanumeric parts (dot/underscore/hyphen continuation allowed),
 * optionally colon-separated within segments; segments use single forward slashes.
 */
export function validatePageSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw opError('invalid_params', 'page_slug must be a non-empty string', 'Pass a slug such as people/alice-example.');
  }
  if (slug.length > 255) {
    throw opError('invalid_params', 'page_slug exceeds 255 characters', 'Shorten the slug to 255 characters or fewer.');
  }
  // #3417: letters/numbers from any script allowed in segments (u flag required
  // for the \p{...} classes in OP_PAGE_SLUG_SEG). Shape rules (word-char lead,
  // dot/underscore/hyphen continuation) preserved.
  if (!new RegExp(`^${OP_PAGE_SLUG_SEG}(\\/${OP_PAGE_SLUG_SEG})*$`, 'iu').test(slug)) {
    throw opError('invalid_params', `Invalid page_slug: ${slug} (allowed: letters/numbers in any script, with '.', '_', '-' after the first character of a part, optional colon-separated namespace parts, and forward-slash separated segments)`,
      'Use a slug shaped like people/alice-example or notes/v1.0.0: no spaces, backslashes, percent-encoding or dot-led segments.');
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
 * Subagent slug-fence enforcement, shared by every mutating op a subagent
 * can reach (put_page, add_timeline_entry). FAIL-CLOSED: `viaSubagent=true`
 * enforces the check even if the dispatcher forgot to populate `subagentId`.
 *
 *   - Trusted-workspace path (ctx.allowedSlugPrefixes set by cycle.ts under
 *     PROTECTED_JOB_NAMES \u2014 MCP cannot reach it): slug must match the
 *     allow-list globs.
 *   - Legacy default: slug must live under `wiki/agents/<subagentId>/...`
 *     (anchored, slash-boundary \u2014 `wiki/agents/12evil/*` can't impersonate
 *     subagent 12).
 */
export function enforceSubagentSlugFence(ctx: OperationContext, slug: string, opName: string): void {
  if (ctx.viaSubagent !== true) return;
  if (typeof ctx.subagentId !== 'number' || Number.isNaN(ctx.subagentId)) {
    throw opError('permission_denied', `${opName} via subagent requires ctx.subagentId`,
      'This is a gbrain dispatch fault, not a caller mistake: report it to the user instead of resubmitting the write.');
  }
  if (slugUnderSubagentFence(ctx, slug)) return;
  const allowList = ctx.allowedSlugPrefixes;
  const fenced = allowList && allowList.length > 0;
  throw opError(
    'permission_denied',
    fenced
      ? `${opName} slug '${slug}' is not within the trusted-workspace allow-list (${allowList.join(', ')})`
      : `${opName} via subagent must write under 'wiki/agents/${ctx.subagentId}/...'`,
    fenced
      ? `Write to a slug matching one of: ${allowList.join(', ')}.`
      : `Write under wiki/agents/${ctx.subagentId}/ (for example wiki/agents/${ctx.subagentId}/notes).`,
  );
}

/**
 * The subagent fence's MATCH RULE, without the throwing. Split out so the
 * resolved-slug re-check in put_page can ask the same question the entry
 * fence asks, instead of re-deriving the namespace literal and drifting.
 * Callers must have already established `ctx.viaSubagent === true`.
 */
export function slugUnderSubagentFence(ctx: OperationContext, slug: string): boolean {
  const allowList = ctx.allowedSlugPrefixes;
  if (allowList && allowList.length > 0) return matchesSlugAllowList(slug, allowList);
  const prefix = `wiki/agents/${ctx.subagentId}/`;
  return slug.startsWith(prefix) && slug.length > prefix.length;
}

/**
 * Is `slug` outside whatever slug confinement THIS caller is under?
 *
 * A caller can be confined by EITHER mechanism, and the two arrive on
 * different context fields: an OAuth binding lands on `ctx.auth
 * .boundSlugPrefixes` (plain-prefix grammar), while a delegated subagent
 * lands on `ctx.viaSubagent` + `ctx.allowedSlugPrefixes` (glob grammar).
 * Its auth carries read scope, not the parent's direct-write fence. Testing
 * only the OAuth field therefore lets
 * a bound client that also holds `agent` scope re-open the path it is fenced
 * out of simply by delegating the write through submit_agent — the same
 * bypass shape the facts-backstop gate below is keyed against.
 *
 * Unconfined callers (local CLI, unbound client) match neither arm and are
 * never fenced.
 */
export function slugOutsideCallerFence(ctx: OperationContext, slug: string): boolean {
  const bound = ctx.auth?.boundSlugPrefixes;
  if (bound && !slugUnderBoundPrefixes(bound, slug)) return true;
  if (ctx.viaSubagent === true && !slugUnderSubagentFence(ctx, slug)) return true;
  return false;
}

/**
 * OAuth-client slug-fence enforcement (v0.42.72.0 — write-side isolation
 * symmetry). When the authenticated client was registered with
 * --bound-slug-prefixes, every direct slug-mutating write must target a
 * slug under one of those prefixes. Shared by put_page, delete_page,
 * restore_page, add_tag, remove_tag, add_link/remove_link (`from`
 * endpoint), add_timeline_entry, revert_version, and put_raw_data; runs
 * BEFORE each op's dry-run short-circuit so preview calls surface the
 * same rejection.
 *
 * Semantics deliberately match submit_agent's bound_slug_prefixes check
 * (plain startsWith, NOT the `/*` glob grammar of the subagent allow-list
 * above): a non-null binding fences fail-closed (empty array = deny all
 * writes), no binding / no auth = no fence (local CLI and unbound clients
 * keep full-source write authority). Register prefixes with a trailing
 * slash ('wiki/agents/alice/') — a bare 'notes' also admits
 * 'notes-archive/...' by startsWith construction.
 */
export function enforceClientSlugFence(ctx: OperationContext, slug: string, opName: string): void {
  if (ctx.auth?.fenceProjectionDegraded) {
    throw opError(
      'permission_denied',
      `${opName}: this brain's oauth_clients projection is missing bound_slug_prefixes, so the write fence cannot be evaluated. Refusing the write rather than running unfenced.`,
      "The brain host's operator applies the pending migrations (command in fix); then repeat the write.",
      { fix: migrationsFix(ctx) },
    );
  }
  const prefixes = ctx.auth?.boundSlugPrefixes;
  if (!prefixes) return;
  if (!slugUnderBoundPrefixes(prefixes, slug)) {
    throw opError(
      'permission_denied',
      `${opName}: slug '${slug}' is not under any of client ${ctx.auth?.clientId ?? '(unknown)'}'s bound_slug_prefixes (${prefixes.join(', ')})`,
      `Write to a slug under ${prefixes.join(', ') || 'a granted prefix'}; only the brain host's operator can change this client's binding.`,
    );
  }
}

/**
 * The one place the fence's match rule lives. Exported so non-op write
 * surfaces that never build an OperationContext (the `/ingest` route in
 * serve-http.ts) enforce byte-identical semantics instead of re-deriving
 * them.
 *
 * An empty-string prefix is IGNORED rather than honored: `startsWith('')`
 * is true for every slug, so a stray `''` (an unset shell variable in a
 * provisioning template) would silently turn a binding into a wildcard
 * while still rendering as "fenced" to the operator. Registration now
 * rejects empty prefixes outright; this is the second line of defence for
 * rows already in the database.
 */
export function slugUnderBoundPrefixes(prefixes: readonly string[], slug: string): boolean {
  // Compare against the CANONICAL slug. `validateSlug` lowercases before the
  // row is written, so checking the caller's raw string let `EMP-ALICE/x`
  // satisfy an `EMP-ALICE/` binding, commit as `emp-alice/x`, and only then
  // trip the resolved-slug re-check — an error returned after the write had
  // already landed. Registration rejects non-lowercase prefixes going
  // forward; lowercasing both sides keeps pre-existing rows meaning what
  // their operator intended.
  const canonical = slug.toLowerCase();
  return prefixes.some((bp) => {
    const base = normalizeSlugPrefix(bp);
    if (base === '') return false;
    // Boundary-aware: a prefix must match whole SEGMENTS. Plain `startsWith`
    // let a boundary-less `emp-alice` admit `emp-alice-2/onboarding` — and
    // with the `emp-<slug>` naming this guide recommends, sibling collisions
    // (`alice` vs `alice-2`) are the common case, not a corner case.
    return base.endsWith('/')
      ? canonical.startsWith(base)
      : canonical === base || canonical.startsWith(`${base}/`);
  });
}

/**
 * Canonical form of one stored prefix, lowercased. `oauth_clients.bound_slug_prefixes`
 * predates this fence — migration v85 introduced it as submit_agent's binding,
 * whose grammar is the `<prefix>/*` glob of `matchesSlugAllowList` — so both
 * spellings have to mean the same span of slugs or upgrading silently changes
 * what an existing client may write.
 */
export function normalizeSlugPrefix(prefix: string): string {
  return (prefix.endsWith('/*') ? prefix.slice(0, -1) : prefix).toLowerCase();
}

/**
 * Write ops a slug-bound client may call: every op that routes through
 * `enforceClientSlugFence`, plus `think` (scope `read` for remote callers;
 * it stays on this list because it is `mutating` locally, but remote callers
 * cannot persist — `save`/`take` are forced false for `remote !== false`).
 *
 * This list is an ALLOW-list on purpose. The fence used to be enforced op
 * by op, which made every unfenced write op a silent hole — `extract_entities`
 * mutating `people/*` timelines, `forget_fact` rewriting another source's
 * page by numeric id, `extract_facts` appending to any entity's fact fence.
 * Enumerating what is SAFE fails closed instead: a write op added later is
 * denied to bound clients until someone fences it and adds it here.
 */
export const CLIENT_FENCED_WRITE_OPS: ReadonlySet<string> = new Set([
  'put_page', 'delete_page', 'restore_page', 'add_tag', 'remove_tag',
  'add_link', 'remove_link', 'add_timeline_entry', 'revert_version',
  // #5616: edit_page enforces the slug fence in its handler and submission.
  'edit_page',
  // #6007: put_pages fences every page as the put_page it is submitted as.
  'put_pages',
  'put_raw_data', 'think',
  // submit_agent enforces bound_slug_prefixes itself (it is the op the column
  // was introduced for — see its bound_* binding check), so denying it here
  // would break the original feature for clients that legitimately hold both
  // a binding and `agent` scope.
  'submit_agent',
  // CLI→MCP gap-closure wave: capture delegates to put_page with the same ctx
  // (inheriting its enforceClientSlugFence) and [EV7] defaults its slug UNDER
  // the caller's first bound prefix — the zero-config path exists for exactly
  // the bound-agent audience. The takes write verbs each call
  // enforceClientSlugFence themselves (their markdown mirror writes the
  // page file under the slug), the same guarantee as add_tag/add_timeline_entry.
  'capture',
  // Own-principal receipt controls recheck original/current source + slug
  // authority. They are not meta-op exemptions: degraded fences still deny.
  'get_write_request', 'list_write_requests', 'cancel_write_request',
  'takes_add', 'takes_update', 'takes_resolve', 'takes_supersede',
  'put_skill', 'delete_skill',
]);

/**
 * WP4 (D9) — discovery meta-ops exempt from the bound-client fence's
 * LISTING/dispatch denial. `request_tools` is `mutating: true` (its persist
 * branch writes oauth_clients.surface), which would otherwise hide discovery
 * from every slug-bound client. The exemption is safe because the persist
 * branch SELF-ENFORCES its own guards — server ceiling (D2), operator lock
 * (amendment 19), OAuth scopes, and a per-client rate limit (D14.5) — and it
 * never touches a slug. Lives here (not inline in the predicate) so the
 * tools/list filter and the dispatch fence consume the identical carve-out
 * (ENG-3 drift-proofing).
 */
export const BOUND_CLIENT_META_OPS: ReadonlySet<string> = new Set(['request_tools', 'join_brain', 'sync_brain_skills', 'leave_brain']);

/**
 * Single source of truth for "may a slug-bound client use this op" (ENG-3).
 * Consumed by BOTH the dispatch-time fence below AND the tools/list filter
 * in serve-http, so the advertised catalog and the deny behavior cannot
 * drift — a bound client is never shown an op that will fence-deny at call
 * time. Gate on "mutates, or carries any non-read scope" rather than on the
 * two literal scope strings 'write'/'admin': `sources_add`/`sources_remove`
 * carry the bespoke `sources_admin` scope and are `mutating: true`, so a
 * scope-string check let a bound client DROP AN ENTIRE SOURCE — every page
 * in it, far outside any prefix. Anything that isn't a plain read must be
 * explicitly allow-listed. A degraded projection (binding unreadable) denies
 * every non-read op — the unfenceable ops must not stay reachable precisely
 * when the fence is unreadable. Exception: BOUND_CLIENT_META_OPS (D9) stay
 * allowed even degraded — they are slug-free discovery ops whose only write
 * self-enforces ceiling+lock+scopes+rate-limit (and a degraded projection
 * also dropped the surface columns, so that write fails 'migration pending'
 * rather than running unguarded).
 */
export function opAllowedForBoundClient(
  auth: Pick<AuthInfo, 'boundSlugPrefixes' | 'fenceProjectionDegraded' | 'allowedOperations' | 'grantProjectionDegraded'> | undefined,
  op: Pick<Operation, 'name' | 'scope' | 'mutating'>,
): boolean {
  if (auth?.grantProjectionDegraded) return false;
  if (Array.isArray(auth?.allowedOperations) && !auth.allowedOperations.includes(op.name)) return false;
  const degraded = auth?.fenceProjectionDegraded === true;
  if (!degraded && !auth?.boundSlugPrefixes) return true;
  const isRead = op.scope === 'read' && op.mutating !== true;
  if (isRead) return true;
  if (BOUND_CLIENT_META_OPS.has(op.name)) return op.name === 'request_tools' || !degraded;
  if (degraded) return false;
  return CLIENT_FENCED_WRITE_OPS.has(op.name);
}

/**
 * The explicit no-source grant (`permissions.source_id: []`, written by
 * `gbrain auth rescope-token <name> --sources none`) refuses every operation:
 * it never falls back to the `default` floor for reads or writes.
 */
export function noSourceGrantError(operation?: string, auth?: Pick<AuthInfo, 'clientId' | 'principal'>): OperationError {
  const fix = sourceGrantFix(auth);
  const err = opError('permission_denied',
    `${operation ? `${operation}: ` : ''}this token is granted no sources (its source grant is an explicit empty list).`,
    fix.inputs
      ? "Ask the brain host's operator to grant this token at least one source (command in fix), then reconnect."
      : "Ask the brain host's operator to find this token in the token list (command in fix) and grant it at least one source, then reconnect.",
    { docs: 'docs/mcp/ADMIN.md#legacy-token-grants', fix });
  err.detail = 'fence=no_source_grant';
  return err;
}

/**
 * Fail-closed gate for slug-bound clients, applied at dispatch (the single
 * choke point both MCP transports share) so it cannot be forgotten per op.
 * Read ops are untouched — read scope is enforced by source federation.
 * Allow/deny derives from `opAllowedForBoundClient`; this wrapper only owns
 * the error envelopes.
 */
export function enforceBoundClientOpAllowList(
  auth: AuthInfo | undefined,
  op: Pick<Operation, 'name' | 'scope' | 'mutating'>,
): void {
  if (auth?.sourceId === NO_SOURCES) throw noSourceGrantError(op.name, auth);
  if (opAllowedForBoundClient(auth, op)) return;
  if (auth?.grantProjectionDegraded || (Array.isArray(auth?.allowedOperations) && !auth.allowedOperations.includes(op.name))) {
    const err = opError('permission_denied', `${op.name} is outside this client's approved operation snapshot.`,
      "Ask the brain host's operator to explicitly regrant the required operation (command in fix); upgrading the server does not expand client grants.",
      { fix: auth?.grantProjectionDegraded ? migrationsFix(HTTP_HOST) : grantFix(auth, {
        token: ['--refresh-operations', '--add', op.name],
        client: ['--allowed-operations', [...new Set([...(auth?.allowedOperations ?? []), op.name])].join(',')],
      }, `Adds ${op.name} to this connection's approved operations; only the brain host operator can change grants.`) });
    err.detail = 'fence=operation_grant';
    throw err;
  }
  const degraded = auth?.fenceProjectionDegraded === true;
  if (degraded) {
    const err = opError(
      'permission_denied',
      `${op.name}: this brain's oauth_clients projection is missing bound_slug_prefixes, so client write bindings cannot be evaluated. Refusing every non-read operation rather than running unfenced.`,
      "The brain host's operator applies the pending migrations (command in fix); then repeat the call.",
      { fix: migrationsFix(HTTP_HOST) },
    );
    // Amendment 33 / D10: OP-level fence denial — the tools/list filter
    // (opAllowedForBoundClient, the same predicate) should have hidden this
    // op, so serve-http counts it toward the honest-catalog metric
    // (status='denied_after_list'). key=value detail grammar (WP1).
    err.detail = 'fence=op';
    throw err;
  }
  const clientId = safeClientId(auth);
  const err = opError(
    'permission_denied',
    `${op.name} is not available to slug-bound clients: it can write outside client ${auth?.clientId ?? '(unknown)'}'s bound_slug_prefixes (${(auth?.boundSlugPrefixes ?? []).join(', ')}).`,
    `Use put_page / add_timeline_entry / add_link under your own prefixes, or ask the brain host's operator to clear the binding${clientId ? ` (gbrain auth rescope-client ${clientId} --bound-slug-prefixes none)` : ''}.`,
  );
  // Amendment 33 / D10: op-level, not argument-level — see above. The
  // slug-prefix ARGUMENT denials (enforceClientSlugFence) deliberately do
  // NOT carry this marker: a listed write op denying an out-of-fence slug
  // is legitimate and excluded from the metric.
  err.detail = 'fence=op';
  throw err;
}

/**
 * Allowlist validator for uploaded file basenames. Rejects control chars, backslashes,
 * RTL overrides (\u202E), leading dot (hidden files) and leading dash (CLI flag confusion).
 * Allows extension dots and underscores. Max 255 chars.
 */
export function validateFilename(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw opError('invalid_params', 'Filename must be a non-empty string', 'Pass a file name such as report-2026.pdf.');
  }
  if (name.length > 255) {
    throw opError('invalid_params', 'Filename exceeds 255 characters', 'Shorten the file name to 255 characters or fewer.');
  }
  // v0.32.7: CJK ranges (Han / Hiragana / Katakana / Hangul) allowed in filenames.
  // Leading-dot / leading-dash rejection preserved.
  const FILENAME_RE = new RegExp(`^[a-zA-Z0-9${CJK_SLUG_CHARS}][a-zA-Z0-9${CJK_SLUG_CHARS}._\\-]*$`);
  if (!FILENAME_RE.test(name)) {
    throw opError('invalid_params', `Invalid filename: ${name} (allowed: alphanumeric, CJK, dot, underscore, hyphen — no leading dot/dash, no control chars or backslash)`,
      'Rename the file to letters, digits, CJK, dots, underscores and hyphens, starting with a letter or digit (e.g. report-2026.pdf).');
  }
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
  if (ctx.sourceId === NO_SOURCES || ctx.auth?.sourceId === NO_SOURCES) throw noSourceGrantError(undefined, ctx.auth);
  const allowed = ctx.auth?.allowedSources;
  // Treat an empty `allowedSources: []` as "no federated read scope" — the
  // op-handler defers to scalar `ctx.sourceId` below. An attacker-controlled
  // value of `[]` MUST NOT widen scope to "all sources" by being interpreted
  // as "no filter."
  if (allowed && allowed.length > 0) return { sourceIds: allowed };
  // #1712: the __all__ sentinel spans the brain — but ONLY for trusted local
  // callers (strictly `remote === false`). For remote/untrusted callers the
  // literal stays as-is: it can never match a real source id (underscores are
  // rejected at creation), so the read fail-closes to empty rather than
  // widening past the caller's grant. Do NOT "simplify" this to `{}`.
  if (ctx.sourceId === ALL_SOURCES) {
    return ctx.remote === false ? {} : { sourceId: ctx.sourceId };
  }
  if (ctx.sourceId) return { sourceId: ctx.sourceId };
  if (ctx.remote !== false && allowed !== undefined) {
    throw opError('permission_denied', 'No readable source is granted for this request.',
      "This connection's grant names no readable source; ask the brain host's operator to grant one (command in fix).",
      { fix: sourceGrantFix(ctx.auth) });
  }
  return {};
}

/**
 * Confine an explicitly named source id to the caller's resolved READ scope
 * (#4433 wave-L posture; used by sources_status — the destructive
 * sources_remove keys on `assertSourceInCallerWriteScope` below instead):
 * EVERY untrusted caller (anything not strictly `remote === false`) may only
 * name a source inside the canonical `sourceScopeOpts` ladder — federated
 * grant > scalar bound source. An out-of-scope id answers `not_found`, exactly
 * like a nonexistent source (anti-enumeration). The trusted local CLI passes
 * unconditionally (full operator view). Returns void; throws otherwise.
 */
export function assertSourceInCallerScope(ctx: OperationContext, id: string): void {
  if (ctx.remote === false) return;
  const scope = sourceScopeOpts(ctx);
  const allowed = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
  if (allowed && !allowed.includes(id)) {
    throw opError('not_found', `Unknown source: ${id}`, 'Pass a source id from sources_list, which lists the sources this connection can read.',
      { fix: sourcesListFix('Lists the sources this connection can read.') });
  }
}

/**
 * WRITE-authority twin of `assertSourceInCallerScope`, for the DESTRUCTIVE
 * source ops (`sources_remove`). Federation (`ctx.auth.allowedSources`) is READ
 * authority by contract (contract.ts: "source ids this OAuth client may READ
 * from") and confers no removal right, so this helper deliberately does NOT
 * consult the `sourceScopeOpts` ladder — a client bound to write `alpha` with
 * `federated_read: [alpha, beta]` may read `beta` but never cascade-delete it.
 *
 * Rules, in order:
 *  - trusted local CLI (`remote === false`) passes unconditionally;
 *  - an untrusted caller that is BOUND — carries a write source
 *    (`ctx.auth.sourceId`, falling back to `ctx.sourceId`; the same notion as
 *    delete_page/restore_page's write gate) and/or a federated grant — may
 *    name ONLY its write source; a bound caller with no write source (or the
 *    `__all__` sentinel as its source) may name nothing;
 *  - an UNBOUND untrusted caller (neither axis set — an operator-registered
 *    client with no source binding) keeps full authority, unchanged.
 * Out-of-authority ids answer `not_found`, byte-identical to a nonexistent
 * id (anti-enumeration; the same shape the read helper uses, so a caller
 * cannot tell "hidden" from "absent"). Returns void; throws otherwise.
 */
export function assertSourceInCallerWriteScope(ctx: OperationContext, id: string): void {
  if (ctx.remote === false) return;
  const writeSource = ctx.auth?.sourceId ?? ctx.sourceId;
  const bound = writeSource !== undefined || ctx.auth?.allowedSources !== undefined;
  if (!bound) return;
  if (writeSource === undefined || writeSource === ALL_SOURCES || id !== writeSource) {
    throw opError('not_found', `Unknown source: ${id}`, "Name this connection's own write source; sources_list shows the sources it can read.",
      { fix: sourcesListFix('Lists the sources this connection can read.') });
  }
}

/** Holder permissions are independent of the operator's page-visibility opt-out. */
export function readHolders(ctx: OperationContext): string[] | undefined {
  return ctx.remote === false ? ctx.takesHoldersAllowList : ctx.takesHoldersAllowList ?? ['world'];
}

/** Resolve policy once at the operation boundary; callers may supply a canonical per-call scope. */
export async function readPolicyOpts(
  ctx: OperationContext,
  scope: PageReadScope = sourceScopeOpts(ctx),
): Promise<PageReadPolicy> {
  return {
    ...scope,
    excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
    requireSafeChunks: ctx.remote !== false,
    takesHoldersAllowList: readHolders(ctx),
  };
}

/** Map the operation-layer scope names onto runThink's public options. */
export function thinkSourceScopeOpts(ctx: OperationContext): {
  sourceId?: string;
  allowedSources?: string[];
} {
  const scope = sourceScopeOpts(ctx);
  return scope.sourceIds !== undefined
    ? { allowedSources: scope.sourceIds }
    : scope.sourceId !== undefined
      ? { sourceId: scope.sourceId }
      : {};
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
 * cross-source view, and a federated array passes through unchanged. `scope`
 * defaults to the ambient ladder; the link ops pass their resolved per-call
 * scope (`federatedSearchScope`) so the same promotion applies to it.
 */
export function linkReadScopeOpts(
  ctx: OperationContext,
  scope: { sourceId?: string; sourceIds?: string[] } = sourceScopeOpts(ctx),
): { sourceId?: string; sourceIds?: string[] } {
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
 *       remote, outside the caller's grant or scalar scope, and outside
 *       `explicitReads` (when passed)                     → permission_denied
 *       otherwise                                        → `{ sourceId }`
 *   - neither → the caller's grant (sourceScopeOpts).
 *
 * `explicitReads` (#5081) is the explicit-read admission set; only
 * `federatedSearchScope` passes it. The other callers (image, loops,
 * code-intel) pass nothing and keep denying every id outside the scope, with
 * the original hint.
 *
 * `code_traversal_cache_clear` is intentionally NOT a caller — it is localOnly
 * and carries its own destructive D8 all_sources guard.
 */
export function resolveRequestedScope(
  ctx: OperationContext,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
  explicitReads?: readonly string[],
): { sourceId?: string; sourceIds?: string[] } {
  const wantsAll = allSourcesParam || sourceIdParam === ALL_SOURCES;
  if (wantsAll) {
    return ctx.remote === false ? {} : sourceScopeOpts(ctx);
  }
  if (sourceIdParam !== undefined) {
    const scope = sourceScopeOpts(ctx);
    const granted = scope.sourceIds !== undefined
      ? scope.sourceIds.includes(sourceIdParam)
      : scope.sourceId === sourceIdParam;
    if (ctx.remote !== false && !granted && !explicitReads?.includes(sourceIdParam)) {
      throw opError(
        'permission_denied',
        'Requested source is outside your granted sources',
        explicitReads === undefined
          ? 'Request access to this source, or omit source_id to search within your grant.'
          : explicitReadDeniedHint(ctx, sourceIdParam),
        explicitReads === undefined
          ? { fix: sourcesListFix('Lists the sources this connection can read; pass one of them as source_id, or omit it.') }
          : { docs: EXPLICIT_READ_DOCS, fix: explicitReadDeniedFix(ctx, sourceIdParam) },
      );
    }
    return { sourceId: sourceIdParam };
  }
  return sourceScopeOpts(ctx);
}

const EXPLICIT_READ_DOCS = 'docs/guides/multi-source-brains.md#explicit-reads-from-a-bound-agent-connection';

/**
 * #5081 / DX-O6(c): why an explicit read was refused, with the exact command
 * that would admit it. A granted token is told about its grant; a connection
 * bound by GBRAIN_SOURCE or a .gbrain-source pin is told about the binding
 * (its own opt-out, the target's opt-out, or a target that was never
 * federated); an unbound connection is told the target is not federated.
 */
function explicitReadDeniedHint(ctx: OperationContext, id: string): string {
  const auth = ctx.auth;
  if (auth !== undefined && (auth.allowedSources !== undefined || auth.hasSourceGrant !== false)) {
    const granted = auth.allowedSources ?? (auth.sourceId !== undefined ? [auth.sourceId] : []);
    return auth.principal?.kind === 'oauth_client'
      ? `Your token is not granted ${id}; ask the brain owner to grant it ` +
        `(gbrain auth rescope-client ${auth.principal.id} --federated-read ${[...granted, id].join(',')}).`
      : `Your token is not granted ${id}; ask the brain owner to grant it.`;
  }
  const binding = ctx.explicitReadBinding;
  if (binding === undefined) {
    return `${id} is not federated; the brain owner can run \`gbrain sources federate ${id}\` on the brain host, ` +
      'or omit source_id to read within this connection\'s sources.';
  }
  const bound = `This connection is bound to source ${binding.sourceId} (${binding.via}).`;
  const unbind = binding.via === 'GBRAIN_SOURCE'
    ? 'start this connection without GBRAIN_SOURCE'
    : 'start this connection outside the directory pinned by .gbrain-source';
  if (binding.optedOut.includes(binding.sourceId)) {
    return `${bound} ${binding.sourceId} opted out of federation (federated: false), so it reads no other source; ` +
      `the brain owner can run \`gbrain sources federate ${binding.sourceId}\` on the brain host, or ${unbind}.`;
  }
  const reason = binding.optedOut.includes(id) ? 'opted out of federation (federated: false)' : 'is not federated';
  return `${bound} ${id} ${reason}; the brain owner can run \`gbrain sources federate ${id}\` on the brain host, or ${unbind}.`;
}

/**
 * The command behind explicitReadDeniedHint: widen the token's grant, or
 * federate the source this connection's reads stop at (host-only either way).
 */
function explicitReadDeniedFix(ctx: OperationContext, id: string): Action | undefined {
  const auth = ctx.auth;
  if (auth !== undefined && (auth.allowedSources !== undefined || auth.hasSourceGrant !== false)) {
    const granted = auth.allowedSources ?? (auth.sourceId !== undefined ? [auth.sourceId] : []);
    const wanted = [...new Set([...granted, id])].join(',');
    return grantFix(auth, { token: ['--sources', wanted], client: ['--federated-read', wanted] },
      `Adds ${id} to this connection's readable sources; only the brain host operator can change grants.`);
  }
  const binding = ctx.explicitReadBinding;
  const target = binding?.optedOut.includes(binding.sourceId) ? binding.sourceId : id;
  if (!isValidSourceId(target)) return undefined;
  return hostFix(ctx, ['gbrain', 'sources', 'federate', target],
    `Lets unqualified and explicit reads from other connections include ${target}; only the trusted CLI on the brain host changes federation.`);
}

/**
 * #5081: the sources an explicit `source_id` read may name beyond the scope.
 * A grant (`ctx.auth.allowedSources`) governs alone. Otherwise a bound stdio
 * connection uses its binding's set, and an unbound connection uses the set
 * its unqualified reads already span (`localFederatedSourceIds`), so an
 * explicit read there is never wider than an unqualified one.
 */
function explicitReadAdmission(ctx: OperationContext): readonly string[] {
  if (ctx.auth?.allowedSources !== undefined) return [];
  return ctx.explicitReadBinding?.sourceIds ?? ctx.localFederatedSourceIds ?? [];
}

/**
 * #4329: parse a per-call `source_id` param. Pre-fix, get_page / delete_page /
 * restore_page had NO source_id in their contracts, so an agent-passed
 * source_id was SILENTLY dropped and the op acted on ctx.sourceId —
 * soft-deleting the WRONG row on a multi-source brain while returning a
 * success that named the requested slug. A caller-supplied value is either
 * honored or rejected loudly — never ignored. `allowAll` admits the
 * `__all__` sentinel for read ops (resolveRequestedScope collapses it per
 * trust); destructive ops target exactly one source and reject it.
 */
export function parseSourceIdParam(
  raw: unknown,
  opName: string,
  opts?: { allowAll?: boolean },
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw === ALL_SOURCES) {
      if (opts?.allowAll === true) return raw;
      throw opError(
        'invalid_params',
        `${opName}: source_id '${ALL_SOURCES}' is not a valid target — this op acts on exactly one source.`,
        'Pass the single source_id of the row to target, or omit source_id to use the ambient source scope.',
        { fix: sourcesListFix('Lists the source ids this caller can name.') },
      );
    }
    if (isValidSourceId(raw)) return raw;
  }
  throw opError(
    'invalid_params',
    `${opName}: invalid source_id ${JSON.stringify(raw)} — must be 1-32 lowercase alnum chars with optional interior hyphens.`,
    'Pass a registered source id (sources_list shows them), or omit source_id to use the ambient source scope.',
    { fix: sourcesListFix('Lists the source ids this caller can name.') },
  );
}

/**
 * #2561 / #3242 — source scope for the page-visibility read ops (`search`,
 * `query`, `get_page`, `list_pages`, `resolve_slugs`).
 *
 * Delegates to `resolveRequestedScope` (the single trust+grant resolver), then
 * widens an UNQUALIFIED scalar scope to the transport-computed federated set
 * (`ctx.localFederatedSourceIds`, resolved source first). This is what makes
 * `sources add --federated` mean something: a federated source participates in
 * unqualified reads (#3242 — pages ingested into a `federated: true` source
 * were invisible to get_page/search/list_pages while resolve_slugs leaked them).
 *
 * An explicit per-call `source_id` is admitted inside the explicit-read set
 * (#5081, `explicitReadAdmission`): the binding's set for a connection bound
 * by GBRAIN_SOURCE or a .gbrain-source pin, otherwise the federated set.
 *
 * The expansion NEVER applies when:
 *   - a concrete per-call `source_id` was passed (explicit wins);
 *   - the resolver already produced a federated array (OAuth grant governs);
 *   - the transport didn't populate `localFederatedSourceIds` (see that
 *     field's doc: it is transport-computed and never derived from
 *     caller-controlled params — so trust stays fail-closed).
 *
 * The read-only `__all__` sentinel is equivalent to an unqualified read when
 * it resolves to the caller's scalar floor. It may therefore use the same
 * transport-computed federated set, but never widens an OAuth grant.
 *
 * Deliberately NOT inside `sourceScopeOpts`: code-intel ops collapse a
 * multi-element scope to an error (`resolveCodeIntelScope`), and the remaining
 * scalar reads (get_links, get_chunks, …) keep their long-standing behavior.
 */
export function federatedSearchScope(
  ctx: OperationContext,
  sourceIdParam?: string,
): { sourceId?: string; sourceIds?: string[] } {
  const scope = resolveRequestedScope(ctx, sourceIdParam, false, explicitReadAdmission(ctx));
  if (
    (sourceIdParam === undefined || sourceIdParam === ALL_SOURCES) &&
    ctx.auth?.allowedSources === undefined &&
    scope.sourceId !== undefined &&
    scope.sourceIds === undefined &&
    ctx.localFederatedSourceIds !== undefined &&
    ctx.localFederatedSourceIds.length > 1
  ) {
    return { sourceIds: ctx.localFederatedSourceIds };
  }
  return scope;
}

/**
 * #4620 — the #1712 rule on the op path: an EXPLICIT per-call `source_id`
 * that names no live (unarchived) source fails loudly instead of silently
 * scoping the read to a source with no rows (page_not_found with a
 * soft-delete hint, or an empty list). Reachable because a federated_read
 * grant / `.gbrain-source` dotfile has no FK and outlives `sources remove`.
 * Call it AFTER `federatedSearchScope` so the grant check has already run —
 * it can only name a source the caller was granted, never a cross-grant
 * existence oracle. `__all__` and an omitted param skip it (nothing explicit
 * to verify). Async on purpose: `resolveRequestedScope` stays sync for its
 * ~10 engine-free call sites.
 */
export async function assertExplicitSourceLive(
  ctx: OperationContext,
  sourceIdParam: string | undefined,
): Promise<void> {
  if (sourceIdParam === undefined || sourceIdParam === ALL_SOURCES) return;
  // Point lookup, not listAllSources (wave review): this runs on every
  // search/query/get_page/list_pages call that names a source, and the full
  // enumeration hauled every row's config JSONB across the wire each time.
  // Same liveness predicate as listAllSources' default filter.
  const live = await ctx.engine.executeRaw<{ ok: number }>(
    `SELECT 1 AS ok FROM sources WHERE id = $1 AND archived IS NOT TRUE LIMIT 1`,
    [sourceIdParam],
  );
  if (live.length > 0) return;
  const clientId = safeClientId(ctx.auth);
  throw opError(
    'unknown_source',
    `source '${sourceIdParam}' does not exist (removed or archived)`,
    'Omit source_id to read within your grant, or pick an id from sources_list. ' +
      'If a .gbrain-source dotfile or a federated_read grant still names it, update them ' +
      `(the brain host operator rescopes ${clientId ? `client ${clientId}'s` : 'the'} federated_read grant; gbrain doctor lists dangling grants).`,
    { fix: sourcesListFix('Lists the live sources this caller can read.') },
  );
}

/**
 * #4109 — preflight a page endpoint for a same-source graph mutation
 * (add_link / add_timeline_entry).
 *
 * These ops intentionally write only to `ctx.sourceId`, while page reads may
 * span the caller's federated visibility scope. When the requested slug
 * exists only in another READABLE source, report that source boundary
 * explicitly (`permission_denied`) instead of the misleading "not found" the
 * engine's exact-source resolution emits — which surfaced over MCP as
 * `internal_error` and made intentional source isolation look like data
 * loss. Sources outside the caller's read grant remain indistinguishable
 * from absence: the diagnostic lookup uses `federatedSearchScope`, the SAME
 * visibility ladder as `get_page`, so this preflight can never become a
 * cross-source existence oracle.
 * Remote-owned subagents also require visibility of existing write targets;
 * put_page allows creation only when no row exists, including soft-deleted rows.
 */
export async function requireWritablePage(
  ctx: OperationContext,
  slug: string,
  operation: string,
  endpoint: 'from' | 'to' | 'page',
  allowCreate = false,
): Promise<void> {
  const writeSource = ctx.sourceId || 'default';
  // Graph rows may reference soft-deleted pages — includeDeleted preserves
  // that engine mutation contract for the exact write source. The federated
  // diagnostic lookup below intentionally stays active-page-only so a
  // soft-deleted foreign page is never disclosed.
  const writable = await ctx.engine.getPage(slug, {
    sourceId: writeSource,
    includeDeleted: true,
  });
  if (writable) {
    if (ctx.viaSubagent === true && ctx.auth && isPrivatePage(writable)
      && await resolveExcludePrivatePages(ctx.engine, ctx.remote)) {
      throw opError('permission_denied', `${operation}: this page is outside your write visibility.`,
        'The page is private and this delegated write cannot see it; choose a different slug, or report the refusal to the user.');
    }
    return;
  }
  if (allowCreate) return;

  const visibleScope = federatedSearchScope(ctx);
  const spansAnotherSource =
    (visibleScope.sourceIds?.some((sourceId) => sourceId !== writeSource) ?? false) ||
    (visibleScope.sourceId !== undefined && visibleScope.sourceId !== writeSource);
  if (spansAnotherSource) {
    const visible = await ctx.engine.getPage(slug, visibleScope);
    if (visible && visible.source_id !== writeSource) {
      throw opError(
        'permission_denied',
        `${operation}${endpoint === 'page' ? '' : ` ${endpoint}`} page "${slug}" is readable from source "${visible.source_id}" but this client writes to source "${writeSource}".`,
        'Graph mutations are same-source by design. Use a client whose write source owns the page, or import the page into your write source first.',
        { why: `The page lives in source "${visible.source_id}"; this connection writes only to "${writeSource}".` },
      );
    }
  }

  throw opError(
    'page_not_found',
    `${operation}${endpoint === 'page' ? '' : ` ${endpoint}`} page "${slug}" was not found in writable source "${writeSource}".`,
    `Check the slug (fuzzy lookup in fix), or create the page in source "${writeSource}" with put_page first.`,
    withFix(getPageFix(slug, `Looks the slug up in source ${writeSource} with fuzzy matching.`, { sourceId: writeSource, fuzzy: true })),
  );
}

/**
 * #4109 — reclassify a typed engine miss (PageMissingError) raised by the
 * mutation itself, after `requireWritablePage` already passed: the page was
 * hard-deleted between preflight and mutation. Re-running the preflight
 * regenerates the same permission_denied / page_not_found envelope; if the
 * page reappeared between those reads (restore race), fall through to a
 * deterministic miss instead of leaking the raw engine error as
 * internal_error.
 */
export async function reclassifyMutationTimePageMiss(
  ctx: OperationContext,
  slug: string,
  operation: string,
  endpoint: 'from' | 'to' | 'page',
): Promise<never> {
  await requireWritablePage(ctx, slug, operation, endpoint);
  const writeSource = ctx.sourceId || 'default';
  throw opError(
    'page_not_found',
    `${operation}${endpoint === 'page' ? '' : ` ${endpoint}`} page "${slug}" was unavailable in writable source "${writeSource}" during the mutation.`,
    'The page was deleted or restored while the write ran; read its current state (fix) before deciding whether to repeat the write.',
    withFix(getPageFix(slug, 'Shows whether the page exists now, including a soft-deleted row.', { sourceId: writeSource, includeDeleted: true })),
  );
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
  opName = 'code_callers',
): { allSources: boolean; sourceId?: string } {
  const scope = resolveRequestedScope(ctx, sourceIdParam, allSourcesParam);
  if (scope.sourceId) return { allSources: false, sourceId: scope.sourceId };
  if (scope.sourceIds && scope.sourceIds.length === 1) {
    return { allSources: false, sourceId: scope.sourceIds[0] };
  }
  if (scope.sourceIds && scope.sourceIds.length > 1) {
    throw invalidParam(ctx, opName, 'source_id',
      'Code traversal runs against a single source. Specify source_id (one of your granted sources).',
      { choices: scope.sourceIds });
  }
  // Empty scope: span everything only for trusted local callers; a remote caller
  // that reached here has no source in scope and must NOT get cross-source results.
  if (ctx.remote === false) return { allSources: true, sourceId: undefined };
  throw opError(
    'permission_denied',
    'No source in scope for this request.',
    'Pass source_id naming one of your granted sources (sources_list shows them).',
    { fix: sourcesListFix('Lists the sources this connection can read.') },
  );
}

/**
 * Federated re-route for the graph four (code_callers / code_callees /
 * code_blast / code_flow) — the #3242 sibling. An UNQUALIFIED graph query from
 * a no-grant caller collapses to the scalar seed source (usually 'default'),
 * which on vault+code brains holds no code — so the graph ops report
 * `not_built` while code_def / code_refs (which widen across
 * `ctx.localFederatedSourceIds`) answer fine. Graph traversal must stay
 * single-source (engine API + cache key take ONE sourceId), so instead of
 * widening we RE-ROUTE: when the collapsed source has no code chunks and
 * exactly one source in the caller's federated read set does, traverse that
 * one — the multi-source cousin of the CLI's `sole_non_default` tier (#1434).
 *
 * Fail-closed, in order: never fires when the caller passed `source_id` or
 * `all_sources` (explicit wins), when the scope is already brain-wide, when a
 * grant is present (`ctx.auth.allowedSources` governs — same guard as
 * `federatedSearchScope`), when there is no federated read set (a granted
 * token never widens), when the collapsed source itself has code, or when
 * zero or 2+ federated sources have code (ambiguous → original scope stands
 * and readiness reports honestly). Probe errors also keep the original scope.
 */
export async function routeCodeIntelScope(
  ctx: OperationContext,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
  opName = 'code_callers',
): Promise<{ allSources: boolean; sourceId?: string }> {
  const scope = resolveCodeIntelScope(ctx, sourceIdParam, allSourcesParam, opName);
  if (
    sourceIdParam !== undefined || allSourcesParam ||
    scope.allSources || scope.sourceId === undefined ||
    ctx.auth?.allowedSources !== undefined ||
    !ctx.localFederatedSourceIds || ctx.localFederatedSourceIds.length < 2
  ) {
    return scope;
  }
  try {
    const { codeChunksExist } = await import('../code-graph-readiness.ts');
    if (await codeChunksExist(ctx.engine, scope.sourceId)) return scope;
    const withCode: string[] = [];
    for (const id of ctx.localFederatedSourceIds) {
      if (id === scope.sourceId) continue;
      if (await codeChunksExist(ctx.engine, id)) withCode.push(id);
    }
    if (withCode.length === 1) return { allSources: false, sourceId: withCode[0] };
  } catch { /* probe failure → original scope stands */ }
  return scope;
}

/**
 * T4/D5 — resolve a per-call search-mode override. Honored ONLY for trusted/
 * local callers (ctx.remote === false) so a remote OAuth client can't escalate
 * to the costly tokenmax bundle. Local + unknown mode → loud reject; remote +
 * mode → silently ignored (server-configured mode wins). Returns undefined to
 * mean "use the configured mode".
 */
export function resolvePerCallMode(ctx: OperationContext, raw: unknown, opName = 'query'): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (ctx.remote !== false) return undefined; // remote can't select mode
  if (!isSearchMode(raw)) {
    throw invalidParam(ctx, opName, 'mode', `Unknown search mode '${raw}'. Valid: conservative, balanced, tokenmax.`,
      { choices: ['conservative', 'balanced', 'tokenmax'], example: 'balanced' });
  }
  return raw;
}

/** T4 — stamp evidence/create_safety on a result set, fail-soft. */
export function stampEvidenceSafe(results: SearchResult[]): void {
  try { stampEvidence(results); } catch { /* non-fatal */ }
}

export function stampDeepResearchIds(results: SearchResult[]): void {
  for (const r of results) (r as SearchResult & { id?: string }).id = encodeDeepResearchId(r.source_id, r.slug);
}

/** T4 — shared eval-capture for the `search` op (keyword-only + cheap-hybrid paths). */
export function maybeCaptureSearch(
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
