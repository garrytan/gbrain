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
import { OperationError } from './contract.ts';
import type { AuthInfo, Operation, OperationContext } from './contract.ts';
import { CJK_SLUG_CHARS, PAGE_SLUG_SEG } from '../cjk.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { isSearchMode } from '../search/mode.ts';
import { stampEvidence } from '../search/evidence.ts';
import { captureEvalCandidate, isEvalCaptureEnabled, isEvalScrubEnabled } from '../eval-capture.ts';
import type { SearchResult, HybridSearchMeta } from '../types.ts';

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
  // #3417: letters/numbers from any script allowed in segments (u flag required
  // for the \p{...} classes in PAGE_SLUG_SEG). Shape rules (lead char, hyphen
  // continuation) preserved.
  if (!new RegExp(`^${PAGE_SLUG_SEG}(\\/${PAGE_SLUG_SEG})*$`, 'iu').test(slug)) {
    throw new OperationError('invalid_params', `Invalid page_slug: ${slug} (allowed: letters/numbers in any script, hyphens, forward-slash separated segments)`);
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
    throw new OperationError('permission_denied', `${opName} via subagent requires ctx.subagentId`);
  }
  if (slugUnderSubagentFence(ctx, slug)) return;
  const allowList = ctx.allowedSlugPrefixes;
  throw new OperationError(
    'permission_denied',
    allowList && allowList.length > 0
      ? `${opName} slug '${slug}' is not within the trusted-workspace allow-list (${allowList.join(', ')})`
      : `${opName} via subagent must write under 'wiki/agents/${ctx.subagentId}/...'`,
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
 * lands on `ctx.viaSubagent` + `ctx.allowedSlugPrefixes` (glob grammar) and
 * carries NO `ctx.auth` at all. Testing only the OAuth field therefore lets
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
    throw new OperationError(
      'permission_denied',
      `${opName}: this brain's oauth_clients projection is missing bound_slug_prefixes, so the write fence cannot be evaluated. Refusing the write rather than running unfenced.`,
      'Run `gbrain apply-migrations --yes` on the brain host.',
    );
  }
  const prefixes = ctx.auth?.boundSlugPrefixes;
  if (!prefixes) return;
  if (!slugUnderBoundPrefixes(prefixes, slug)) {
    throw new OperationError(
      'permission_denied',
      `${opName}: slug '${slug}' is not under any of client ${ctx.auth?.clientId ?? '(unknown)'}'s bound_slug_prefixes (${prefixes.join(', ')})`,
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
  'takes_add', 'takes_update', 'takes_resolve', 'takes_supersede',
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
export const BOUND_CLIENT_META_OPS: ReadonlySet<string> = new Set(['request_tools']);

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
  auth: Pick<AuthInfo, 'boundSlugPrefixes' | 'fenceProjectionDegraded'> | undefined,
  op: Pick<Operation, 'name' | 'scope' | 'mutating'>,
): boolean {
  const degraded = auth?.fenceProjectionDegraded === true;
  if (!degraded && !auth?.boundSlugPrefixes) return true;
  const isRead = op.scope === 'read' && op.mutating !== true;
  if (isRead) return true;
  if (BOUND_CLIENT_META_OPS.has(op.name)) return true;
  if (degraded) return false;
  return CLIENT_FENCED_WRITE_OPS.has(op.name);
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
  if (opAllowedForBoundClient(auth, op)) return;
  const degraded = auth?.fenceProjectionDegraded === true;
  if (degraded) {
    const err = new OperationError(
      'permission_denied',
      `${op.name}: this brain's oauth_clients projection is missing bound_slug_prefixes, so client write bindings cannot be evaluated. Refusing every non-read operation rather than running unfenced.`,
      'Run `gbrain apply-migrations --yes` on the brain host.',
    );
    // Amendment 33 / D10: OP-level fence denial — the tools/list filter
    // (opAllowedForBoundClient, the same predicate) should have hidden this
    // op, so serve-http counts it toward the honest-catalog metric
    // (status='denied_after_list'). key=value detail grammar (WP1).
    err.detail = 'fence=op';
    throw err;
  }
  const err = new OperationError(
    'permission_denied',
    `${op.name} is not available to slug-bound clients: it can write outside client ${auth?.clientId ?? '(unknown)'}'s bound_slug_prefixes (${(auth?.boundSlugPrefixes ?? []).join(', ')}).`,
    'Use put_page / add_timeline_entry / add_link under your own prefixes, or ask an operator to clear the binding with `gbrain auth rescope-client <id> --bound-slug-prefixes none`.',
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
  // #1712: the __all__ sentinel spans the brain — but ONLY for trusted local
  // callers (strictly `remote === false`). For remote/untrusted callers the
  // literal stays as-is: it can never match a real source id (underscores are
  // rejected at creation), so the read fail-closes to empty rather than
  // widening past the caller's grant. Do NOT "simplify" this to `{}`.
  if (ctx.sourceId === ALL_SOURCES) {
    return ctx.remote === false ? {} : { sourceId: ctx.sourceId };
  }
  if (ctx.sourceId) return { sourceId: ctx.sourceId };
  return {};
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
  const wantsAll = allSourcesParam || sourceIdParam === ALL_SOURCES;
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
 * The expansion NEVER applies when:
 *   - a per-call `source_id` was passed (explicit wins, including `__all__`);
 *   - the resolver already produced a federated array (OAuth grant governs);
 *   - the transport didn't populate `localFederatedSourceIds` (see that
 *     field's doc: it is only set for callers with NO explicit source scope,
 *     and never from caller-controlled params — so trust stays fail-closed).
 *
 * Deliberately NOT inside `sourceScopeOpts`: code-intel ops collapse a
 * multi-element scope to an error (`resolveCodeIntelScope`), and the remaining
 * scalar reads (get_links, get_chunks, …) keep their long-standing behavior.
 */
export function federatedSearchScope(
  ctx: OperationContext,
  sourceIdParam?: string,
): { sourceId?: string; sourceIds?: string[] } {
  const scope = resolveRequestedScope(ctx, sourceIdParam);
  if (
    sourceIdParam === undefined &&
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
export function stampEvidenceSafe(results: SearchResult[]): void {
  try { stampEvidence(results); } catch { /* non-fatal */ }
}

/**
 * #4039 — OpenAI deep-research contract: search results must carry an `id`
 * that the paired `fetch` tool round-trips. id = slug (what `fetch` — the
 * thin get_page adapter in ops/pages.ts — resolves). Additive stamp; every
 * other consumer of SearchResult ignores it.
 */
export function stampDeepResearchIds(results: SearchResult[]): void {
  for (const r of results) (r as SearchResult & { id?: string }).id = r.slug;
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
