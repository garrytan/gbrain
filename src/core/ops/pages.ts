/**
 * Page CRUD operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `pagesOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts (order is contractual — docs/TOOL_CATALOG.md is
 * generated from that array). Never import from '../operations.ts' here
 * (cycle); shared contract/context helpers come from the ops/ foundation.
 */

import type { BrainEngine } from '../engine.ts';
import { clampSearchLimit } from '../engine.ts';
import type { Page, PageType } from '../types.ts';
import { importFromContent } from '../import-file.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { writePageThrough, deletePageThrough, resolvePageWriteTarget, type WriteThroughResult } from '../write-through.ts';
import { extractPageLinks, isAutoLinkEnabled, isAutoTimelineEnabled, isGlobalBasenameEnabled, parseTimelineEntries, makeResolver, type UnresolvedFrontmatterRef } from '../link-extraction.ts';
// #3190: pack-aware link typing on the put_page auto-link path.
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { isFactsBackstopEligible } from '../facts/eligibility.ts';
import { stripTakesFence } from '../takes-fence.ts';
import type { WriterLintPayload } from '../output/post-write.ts';
import { stripFactsFence } from '../facts-fence.ts';
import { getContentFlag } from '../quarantine.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { resolveExcludePrivatePages, isPrivatePage, findPrivateOnlySlugs } from '../search/private-visibility.ts';
import { LIST_PAGES_DESCRIPTION, CAPTURE_DESCRIPTION } from '../operations-descriptions.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  enforceSubagentSlugFence,
  slugOutsideCallerFence,
  enforceClientSlugFence,
  federatedSearchScope,
  normalizeSlugPrefix,
  parseSourceIdParam,
  validatePageSlug,
} from './context.ts';

// --- Page CRUD ---

/**
 * #4329 (S1-tightened): write-authority gate for a per-call source_id on the
 * destructive page ops. Trusted local callers (ctx.remote === false) own the
 * brain and may target any source (slug fences still apply). EVERY other
 * caller — authenticated HTTP MCP, unauthenticated transports (stdio MCP,
 * subagent dispatch), unset trust — may target ONLY its write authority:
 * `ctx.auth.sourceId` when auth exists (falling back to `ctx.sourceId` for
 * legacy tokens that predate the v0.34.1 source grant), else `ctx.sourceId`.
 *
 * `ctx.auth.allowedSources` is the READ-federation grant (see contract.ts:
 * "array of source ids this OAuth client may READ from") and plays NO role
 * in writes — mirroring put_page, which writes only to ctx.sourceId
 * (`localFederatedSourceIds` is likewise consumed exclusively by
 * federatedSearchScope, a read path). Fail-closed permission_denied
 * otherwise, never a silent retarget.
 */
function assertSourceInWriteGrant(ctx: OperationContext, sourceId: string): void {
  if (ctx.remote === false) return;
  const writeAuthority = ctx.auth?.sourceId ?? ctx.sourceId;
  if (sourceId === writeAuthority) return;
  throw new OperationError(
    'permission_denied',
    `source '${sourceId}' is outside your write authority`,
    'Omit source_id (or pass your write source) to target your write source. Federated read grants do not confer delete/restore access.',
  );
}

/**
 * #4352 remediation — filter fuzzy-resolution candidates so get_page's
 * ambiguous_slug candidate list can't enumerate private slugs to an
 * untrusted caller. Probe SQL lives ONCE in findPrivateOnlySlugs (a slug
 * with at least one non-private in-scope page stays visible; candidates
 * come from resolveSlugs, so every slug has a live page row).
 * Order-preserving (resolveSlugs returns ranked candidates). Read-only,
 * scope-threaded — not a getPage/putPage pair (no unscoped-check/scoped-write
 * hazard).
 */
async function dropPrivateSlugs(
  engine: BrainEngine,
  candidates: string[],
  scope: { sourceId?: string; sourceIds?: string[] },
  includeDeleted: boolean,
): Promise<string[]> {
  const hidden = await findPrivateOnlySlugs(engine, candidates, scope, { includeDeleted });
  return candidates.filter(c => !hidden.has(c));
}

/**
 * #3625: strip the takes/private-facts fences from BOTH compiled_truth and
 * timeline before a page reaches an untrusted reader. Pre-#3625 this only
 * covered compiled_truth — a `## Facts` fence written below the
 * `<!-- timeline -->` sentinel lands in the `timeline` column (splitBody's
 * split boundary), which get_page/fetch_page returned verbatim, unstripped.
 * A private fact fence misplaced there was fully readable by any remote MCP
 * caller. Same stripping rule as compiled_truth: takes fence dropped
 * entirely, facts fence keeps only `world`-visibility rows.
 */
function stripPrivacyFencesForRemoteReader(page: Page): Page {
  return {
    ...page,
    compiled_truth: stripFactsFence(
      stripTakesFence(page.compiled_truth),
      { keepVisibility: ['world'] },
    ),
    timeline: stripFactsFence(
      stripTakesFence(page.timeline ?? ''),
      { keepVisibility: ['world'] },
    ),
  };
}

const get_page: Operation = {
  name: 'get_page',
  description: 'Read a page by slug (supports optional fuzzy matching). To edit a page, pass include_content: true — the returned `content` field is the canonical full markdown (frontmatter + body + timeline sentinel); edit THAT and pass it back to put_page to round-trip losslessly. Reassembling compiled_truth/timeline by hand risks dropping sections. Soft-deleted pages are hidden by default; pass include_deleted: true to surface them with deleted_at populated (see v0.26.5 recovery window).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
    include_content: { type: 'boolean', description: '#2225: include the canonical serialized `content` field (frontmatter + body + timeline sentinel) for lossless get→edit→put_page round-trips. Default false — it roughly duplicates compiled_truth + timeline, so read-only callers should not pay for it.' },
    include_deleted: { type: 'boolean', description: 'v0.26.5: surface soft-deleted pages with deleted_at populated (default: false). Used by restore workflows.' },
    source_id: { type: 'string', description: "#4329: scope the lookup to a single source (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId / the caller's grant. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;
    const includeDeleted = (p.include_deleted as boolean) === true;
    const includeContent = (p.include_content as boolean) === true;
    // #4329: honor a per-call source_id (pre-fix it was silently dropped).
    // resolveRequestedScope (inside federatedSearchScope) enforces the remote
    // caller's grant on the explicit value.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'get_page', { allowAll: true });
    // #1393: route BOTH the exact-match read and the fuzzy resolveSlugs through
    // the canonical precedence ladder (federated array > scalar > nothing). The
    // exact path previously used scalar `ctx.sourceId` only, so a remote client
    // with a federated `allowedSources` grant (and no single ctx.sourceId) got
    // an UNSCOPED exact lookup — a cross-source read of any page by slug. getPage
    // now honors sourceIds[] (both engines), so the same scope closes both paths.
    // #3242: federatedSearchScope (not bare sourceScopeOpts) so an unqualified
    // read sees pages in `federated: true` sources, matching search/query.
    const sourceOpts = federatedSearchScope(ctx, sourceIdParam);
    const fuzzyScope = sourceOpts;

    // #4352 remediation: untrusted callers never read `visibility: private`
    // bodies — the same resolveExcludePrivatePages gate search/recall/entity
    // already apply (trusted local + the operator opt-outs resolve to false).
    // A gated private page behaves exactly like a missing one (no existence
    // oracle), composing with — not replacing — the source-grant scope above.
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    let page = await ctx.engine.getPage(slug, { includeDeleted, ...sourceOpts });
    if (page && excludePrivate && isPrivatePage(page.frontmatter)) page = null;
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      let candidates = await ctx.engine.resolveSlugs(slug, fuzzyScope);
      // #4352: the ambiguous_slug candidate list must not enumerate private slugs.
      if (excludePrivate && candidates.length > 0) {
        candidates = await dropPrivateSlugs(ctx.engine, candidates, fuzzyScope, includeDeleted);
      }
      if (candidates.length === 1) {
        const fuzzyPage = await ctx.engine.getPage(candidates[0], { includeDeleted, ...sourceOpts });
        // Multi-source backstop: the slug may still resolve to a private
        // variant (same slug private in one source, world in another —
        // getPage returns the first in-scope match).
        if (fuzzyPage && !(excludePrivate && isPrivatePage(fuzzyPage.frontmatter))) {
          page = fuzzyPage;
          resolved_slug = candidates[0];
        }
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      let hint = includeDeleted ? 'Check the slug or use fuzzy: true' : 'Page may be soft-deleted; pass include_deleted: true to verify';
      // #4516: source scoping is by-design isolation, but the miss diagnostic
      // should say WHERE the slug actually lives. Trusted local callers only
      // (`ctx.remote === false`) — for a remote caller the probe would be a
      // cross-source existence oracle outside its grant. Only when the lookup
      // was actually scoped (an unscoped read already spanned every source).
      if (ctx.remote === false && (sourceOpts.sourceId !== undefined || sourceOpts.sourceIds !== undefined)) {
        try {
          // gbrain-allow-unscoped-getpage: read-only diagnostic existence probe —
          // deliberately spans all sources to name where the slug lives.
          const elsewhere = await ctx.engine.getPage(slug, { includeDeleted });
          if (elsewhere && !(excludePrivate && isPrivatePage(elsewhere.frontmatter))) {
            hint = `Page exists in source '${elsewhere.source_id}' — pass --source ${elsewhere.source_id} (source_id: '${elsewhere.source_id}' over MCP). ${hint}`;
          }
        } catch {
          // Diagnostic only — a probe failure must never mask the real error.
        }
      }
      throw new OperationError('page_not_found', `Page not found: ${slug}`, hint);
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
      ? stripPrivacyFencesForRemoteReader(page)
      : page;
    // v0.42 (#1699) agent-warning channel: surface the page's content_flag
    // marker as a top-level field (parallel to SearchResult.content_flag) so
    // an agent reading a page directly gets the same "this looks odd, examine
    // it" signal it would get from search. The marker is also in frontmatter;
    // this is the clean, documented accessor.
    const content_flag = getContentFlag(page.frontmatter as Record<string, unknown> | null);
    // #2225: `content` is the canonical serialized markdown (frontmatter +
    // compiled_truth + `<!-- timeline -->` sentinel + timeline). Clients that
    // edit-and-put_page this field round-trip losslessly; hand-concatenating
    // compiled_truth + timeline without the sentinel used to silently destroy
    // pages.timeline on the next write. Built from visibleBody so the
    // privacy-fence strip above applies to untrusted readers here too.
    // Opt-in (include_content: true): get_page is the most-called read op, and
    // `content` roughly duplicates compiled_truth + timeline — always emitting
    // it would double every reader's payload for the round-trip minority.
    return {
      ...visibleBody,
      tags,
      ...(includeContent ? { content: serializePageToMarkdown(visibleBody as Page, tags) } : {}),
      ...(resolved_slug ? { resolved_slug } : {}),
      ...(content_flag ? { content_flag } : {}),
    };
  },
  scope: 'read',
  cliHints: { name: 'get', positional: ['slug'] },
};

/**
 * #4039: OpenAI deep-research adapter. ChatGPT's deep research mode requires
 * an MCP server to expose a `search`/`fetch` PAIR with a fixed contract:
 * search results carry an `id`, and `fetch(id)` returns
 * `{ id, title, text, url, metadata }`. gbrain had `search` but no `fetch`,
 * so the connector worked in normal chat and failed in deep research. This
 * is a thin get_page adapter: id = slug (the `search` op stamps `id: slug`
 * on every result so the pair round-trips), same source scoping and
 * remote-reader privacy fences as get_page, no fuzzy resolution (deep
 * research always echoes back an id it was handed).
 */
const fetch_page: Operation = {
  name: 'fetch',
  description: "Fetch the full text of one search result by its `id` (OpenAI deep-research contract: the search/fetch pair). `id` is the page slug stamped on every `search` result. Returns { id, title, text, url, metadata } — `text` is the page's canonical markdown. For the richer gbrain-native read (fuzzy slugs, soft-delete recovery, lossless edit round-trips), use get_page.",
  params: {
    id: { type: 'string', required: true, description: 'Result id from a prior `search` call (= the page slug).' },
  },
  handler: async (ctx, p) => {
    const id = p.id as string;
    if (typeof id !== 'string' || !id.trim()) {
      throw new OperationError('invalid_params', 'fetch requires a non-empty id', 'Pass the `id` field from a `search` result.');
    }
    const slug = id.trim();
    // Same scope ladder as get_page's unqualified read: federated array >
    // scalar > nothing — a remote caller only fetches what its grant spans.
    const sourceOpts = federatedSearchScope(ctx);
    let page = await ctx.engine.getPage(slug, sourceOpts);
    // #4352 remediation: a `visibility: private` page reads as missing for
    // untrusted callers (same resolveExcludePrivatePages gate as get_page —
    // fetch is remote-facing by design, every MCP transport). Cheap row
    // check first; the resolver short-circuits for trusted local callers.
    if (page && isPrivatePage(page.frontmatter) && (await resolveExcludePrivatePages(ctx.engine, ctx.remote))) {
      page = null;
    }
    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Pass an id returned by a `search` call.');
    }
    bumpLastRetrievedAt(ctx.engine, [page.id]);
    const tags = await ctx.engine.getTags(page.slug, { sourceId: page.source_id });
    // Same privacy boundary as get_page: untrusted readers (ctx.remote ===
    // true — every MCP transport) never see takes or private facts fences.
    const visibleBody = ctx.remote === false
      ? page
      : stripPrivacyFencesForRemoteReader(page);
    return {
      id: page.slug,
      title: page.title,
      text: serializePageToMarkdown(visibleBody as Page, tags),
      // Pages have no public http home; a stable brain-local URI satisfies
      // the contract's citation slot without inventing a fake web URL.
      url: `gbrain://page/${page.source_id}/${page.slug}`,
      metadata: {
        type: page.type,
        source_id: page.source_id,
        updated_at: page.updated_at,
        tags,
      },
    };
  },
  scope: 'read',
  cliHints: { name: 'fetch', positional: ['id'] },
};

const put_page: Operation = {
  name: 'put_page',
  description: 'Write or replace a page (markdown with frontmatter). REPLACES the entire page; this is not a partial edit. Before modifying an existing page, read its canonical content with `get_page include_content:true`, then submit the complete page. Chunks, embeds, reconciles tags, and (when auto_link/auto_timeline are enabled) extracts + reconciles graph links and timeline entries. Remote (MCP) callers: body wikilinks are NOT reconciled into the graph — auto_link/auto_timeline are skipped for untrusted writers (response reports auto_links: {skipped: "remote"}); use local capture/put_page for link extraction. For large content on Windows (pipe-buffer limit ~45KB) or any file-as-input workflow, use `gbrain capture --file PATH --slug SLUG` — capture reads the file as a Buffer with a binary-NUL guard and adds provenance write-through (v0.39.3.0).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: 'Complete markdown content with YAML frontmatter. REPLACES the entire page; this is not a partial edit. Read the canonical page first with `get_page include_content:true` before modifying it.' },
    allow_empty: { type: 'boolean', required: false, description: 'Allow overwriting an existing non-empty page with empty/whitespace-only content (default: false). Without it, put_page rejects the empty overwrite — the empty-stdin failure class.' },
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
    validatePageSlug(slug);

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
    // short-circuit so preview calls surface the same rejection. See
    // enforceSubagentSlugFence for the fail-closed policy.
    enforceSubagentSlugFence(ctx, slug, 'put_page');
    enforceClientSlugFence(ctx, slug, 'put_page');

    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug: p.slug };

    // Empty-overwrite guard: empty/whitespace-only content over an existing
    // non-empty page is almost always an input-plumbing failure (e.g. a
    // caller that meant file input — put has no --file flag — so the missing
    // --content fell back to reading an empty non-interactive stdin), not an
    // intentional write. Refuse loudly unless the caller opts in with
    // allow_empty. The read is scoped to the exact (source_id, slug) row the
    // write below targets (engine.putPage defaults to 'default' when
    // sourceId is unset). New-slug creates and soft-deleted-page overwrites
    // stay allowed — nothing recoverable is lost there.
    if ((p.content as string).trim() === '' && p.allow_empty !== true) {
      const existing = await ctx.engine.getPage(slug, { sourceId: ctx.sourceId ?? 'default' });
      const existingBody = existing
        ? `${existing.compiled_truth ?? ''}\n${existing.timeline ?? ''}`.trim()
        : '';
      if (existingBody !== '') {
        throw new OperationError(
          'invalid_params',
          `Refusing to overwrite existing non-empty page '${slug}' with empty content.`,
          'For file input use `gbrain capture --file PATH --slug SLUG` (put has no --file flag). To intentionally blank the page, pass allow_empty: true (CLI: --allow-empty).',
        );
      }
    }

    // Skip embedding when the AI gateway has no embedding provider configured.
    // Checks all auth env vars for the resolved provider, not just OPENAI_API_KEY,
    // so Gemini / Ollama / Voyage brains don't silently drop embeddings (Codex C2).
    // #4216: ctx.deferEmbeds (server-side-only context field, set by the
    // oneshot runner) also defers — chunks land `embedding IS NULL` and the
    // standing embed machinery backfills them outside the model loop.
    const { isAvailable } = await import('../ai/gateway.ts');
    const noEmbed = ctx.deferEmbeds === true || !isAvailable('embedding');
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
      const { loadActivePack } = await import('../schema-pack/load-active.ts');
      const { loadConfig } = await import('../config.ts');
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
      // Only an EXPLICIT allow_empty reaches the engine's empty-overwrite
      // escape hatch; the default put_page path stays guarded end-to-end
      // (including frontmatter-only content the raw-content check above
      // can't see — the parsed body is blank even though content isn't).
      ...(p.allow_empty === true ? { allowEmptyOverwrite: true } : {}),
    });

    // The dedup pre-check in importFromContent can resolve the write to a
    // DIFFERENT page than the one requested (same content_hash, or the same
    // `frontmatter.id`), and the disk write-through below runs against that
    // RESOLVED slug. Fence it too: a bound client can read a victim page's
    // frontmatter id over its federated grant, echo it back in an in-prefix
    // put_page, and otherwise have write-through rewrite the victim's file
    // with falsified provenance. Dedup returns status 'skipped' without
    // touching the DB, so throwing here leaves nothing to roll back.
    if (result.slug && result.slug !== slug) {
      // Deliberately does NOT name the resolved slug: it belongs to a page
      // outside the fence, and echoing it would turn frontmatter-id guessing
      // into a slug-enumeration oracle.
      if (slugOutsideCallerFence(ctx, result.slug)) {
        ctx.logger.warn(`[put_page] dedup resolved '${slug}' to an out-of-fence page; refusing (client ${ctx.auth?.clientId ?? 'unknown'}, subagent ${ctx.subagentId ?? 'none'})`);
        throw new OperationError(
          'permission_denied',
          `put_page: this content already exists on a page outside your write scope, so the write would have modified that page instead.`,
          'Remove the `id:` frontmatter field (or change the content) to write a new page under your own prefix.',
        );
      }
    }

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
          const { logSchemaEvent } = await import('../schema-events.ts');
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
    // row. A failure here is fatal to the call (see the check right below)
    // except for the deliberate DB-only configurations.
    //
    // Trust gating:
    //   - Subagent sandbox (viaSubagent without allowedSlugPrefixes) → DB-only.
    //   - All other writes → write-through.
    // put_page's own trust-gating produces two skip reasons ('subagent_sandbox',
    // 'dry_run') that never come out of writePageThrough itself — widen the
    // field rather than losing the commit/pushed/lastPushStatus typing.
    let writeThrough: (Omit<WriteThroughResult, 'skipped'> & { skipped?: WriteThroughResult['skipped'] | 'subagent_sandbox' | 'dry_run' }) | undefined;
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

    // The markdown file is the system of record (docs/architecture/
    // system-of-record.md); the DB row is a derived cache. The deliberate,
    // by-design DB-only outcomes are `no_repo_configured` (no `sync.repo_path`
    // set at all), `disabled_by_config` (operator opted out via
    // `sync.write_through=false`), `subagent_sandbox`, and `dry_run` (no real
    // write was supposed to happen). Every other non-written outcome — a
    // thrown write error, or a guard that REFUSED to write into an existing
    // repo (missing dir, sibling-source collision, escaped path, case-fold
    // clash, unreadable row) — means a file was supposed to exist and
    // doesn't, so put_page must not report success.
    if (writeThrough && !writeThrough.written
      && writeThrough.skipped !== 'no_repo_configured'
      && writeThrough.skipped !== 'disabled_by_config'
      && writeThrough.skipped !== 'subagent_sandbox'
      && writeThrough.skipped !== 'dry_run') {
      // Roll back rather than leave an index-only orphan, but only when this
      // call is what created the row: created_at === updated_at is set by
      // the SAME insert statement (the ON CONFLICT UPDATE branch never
      // touches created_at), so equality here means "brand new, this call."
      // An update (or a dedup hit resolved to a pre-existing page) is left
      // alone — the prior file on disk still matches the prior DB content.
      try {
        const row = await ctx.engine.getPage(result.slug, { sourceId: ctx.sourceId ?? 'default' });
        if (row && row.created_at.getTime() === row.updated_at.getTime()) {
          await ctx.engine.deletePage(result.slug, { sourceId: ctx.sourceId ?? 'default' });
        }
      } catch {
        // best-effort; the error thrown below still surfaces the failure
      }
      throw new OperationError(
        'storage_error',
        `put_page: the page content could not be written to disk (${writeThrough.skipped ?? writeThrough.error}).`,
        'Check that the configured repo path exists and is writable, then retry.',
      );
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
      | { skipped: 'remote'; hint?: string }
      | undefined;
    let autoTimeline: { created: number } | { error: string } | { skipped: 'remote'; hint?: string } | undefined;
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
      // #4525: say WHY and what to do about it — pre-fix the bare
      // {skipped: 'remote'} left agents believing their body wikilinks had
      // been reconciled into the graph.
      const hint = 'auto_link/auto_timeline run for trusted local writers only; '
        + 'body wikilinks were saved as text but NOT reconciled into the graph. '
        + 'Use local `gbrain capture`/`gbrain call put_page` for link extraction.';
      autoLinks = { skipped: 'remote', hint };
      autoTimeline = { skipped: 'remote', hint };
    } else if (result.parsedPage) {
      try {
        const enabled = await isAutoLinkEnabled(ctx.engine);
        if (enabled) {
          // ctx.sourceId is REQUIRED on OperationContext (v0.34 D4) — always
          // pass it so the reconciliation reads/writes AND the advisory lock
          // key stay scoped to the source this put_page targets.
          autoLinks = await runAutoLink(ctx.engine, slug, result.parsedPage, { sourceId: ctx.sourceId });
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
            // #3957: thread source_id — the batch JOIN maps a missing
            // source_id to 'default', so a put_page against a named source
            // silently dropped every timeline row (or attached them to a
            // same-slug page in 'default'). Also carry the parsed source
            // label so the row shape matches the FS/db extract paths and
            // the (page_id, date, summary, source) dedup collapses
            // re-extractions of the same bullet.
            const batch = entries.map(e => ({
              slug,
              date: e.date,
              source: e.source,
              summary: e.summary,
              detail: e.detail || '',
              ...(ctx.sourceId ? { source_id: ctx.sourceId } : {}),
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
    // Slug-bound clients do not get the facts backstop. It extracts entities
    // from the (attacker-controllable) page body and writes fact rows — and,
    // on a source with a local_path, a `## Facts` fence in the entity's own
    // .md — keyed to `people/…` / `companies/…` slugs the caller never named.
    // That is exactly the capability `extract_facts` is denied at dispatch
    // for, reachable indirectly through a perfectly in-prefix put_page. The
    // sibling post-hooks above already skip for untrusted callers (auto-link
    // at `remote !== false && !trustedWorkspace`, chronicle at
    // `remote !== false`); this one had no gate at all.
    // Keyed on "the caller is slug-confined at all", not on ctx.auth alone:
    // the delegated (submit_agent → subagent) context carries
    // `allowedSlugPrefixes` but NOT `auth`, so an auth-only test would let a
    // bound client re-open this path simply by delegating the write.
    if (ctx.auth?.boundSlugPrefixes || ctx.viaSubagent === true) {
      factsQueued = { skipped: 'slug_bound_client' };
    } else {
    try {
      const { runFactsBackstop } = await import('../facts/backstop.ts');
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
        const { runChronicleBackstop } = await import('../chronicle/backstop.ts');
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
    // Response contract (T11): lint ran → full summary (counts, errors-first
    // top_findings with hints, by_validator histogram) even at zero findings;
    // lint crashed → {status: 'lint_error'}; lint off (flag / validate:false)
    // → key absent.
    let writerLint: WriterLintPayload | undefined;
    try {
      const { writerLintForPutPage } = await import('../output/post-write.ts');
      writerLint = await writerLintForPutPage(ctx.engine, result.slug, {
        sourceId: ctx.sourceId ?? 'default',
      });
    } catch {
      // Module-load failure gets the same crash marker; never blocks put_page.
      writerLint = { status: 'lint_error' };
    }

    // #2822: a 0-chunk put looks like success but the page is unsearchable —
    // say WHY instead of leaving the caller to discover it at query time.
    let chunkSkipReason: string | undefined;
    if (result.chunks === 0) {
      if (result.status === 'skipped') {
        chunkSkipReason = 'write_skipped'; // dedup / unchanged content — prior chunks stand
      } else if (result.parsedPage) {
        const { isQuarantined } = await import('../quarantine.ts');
        const { isEmbedSkipped } = await import('../embed-skip.ts');
        const fm = result.parsedPage.frontmatter as Record<string, unknown> | undefined;
        const bodyBlank = `${result.parsedPage.compiled_truth ?? ''}${result.parsedPage.timeline ?? ''}`.trim() === '';
        chunkSkipReason = isQuarantined(fm) ? 'quarantined'
          : isEmbedSkipped(fm) ? 'embed_skip'
          : bodyBlank ? 'empty_body'
          : 'unknown';
      }
    }

    return {
      slug: result.slug,
      status: result.status === 'imported' ? 'created_or_updated' : result.status,
      chunks: result.chunks,
      // #3984: a skipped/error status without the reason is a silent no-op to
      // MCP callers (e.g. the >5MB size guard returned bare status 'skipped'
      // and the agent had no idea why the page never appeared). Thread
      // importFromContent's error text through. capture delegates here, so
      // it inherits the reason too.
      ...(result.error ? { error: result.error } : {}),
      ...(chunkSkipReason ? { chunk_skip_reason: chunkSkipReason } : {}),
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
 * Advisory-lock key for the auto-link reconciliation critical section.
 * Source-scoped (PR6 D5): two concurrent put_page calls on the SAME slug in
 * DIFFERENT sources reconcile disjoint link rows — a shared `auto_link:${slug}`
 * key serialized them for no correctness benefit (cross-source contention),
 * while same-(source, slug) writers still serialize. runAutoLink has two
 * callers (the put_page handler above and autoLinkWrittenPage below), both
 * lock-covered inside runAutoLink itself; the `?? ''` fallback is
 * belt-and-braces only, never a real key shape.
 */
export function autoLinkLockKey(sourceId: string | undefined, slug: string): string {
  return `auto_link:${sourceId ?? ''}:${slug}`;
}

/**
 * #4216 post-batch auto-link reconciliation for the oneshot runner.
 *
 * Within one oneshot batch, page A can wikilink page B that is written LATER
 * in the same batch: at A's put_page, runAutoLink's getAllSlugs filter
 * silently drops the A→B edge (B doesn't exist yet). The content keeps the
 * wikilink; only the links-table edge is missing. This wrapper re-runs the
 * reconciliation for a written page AFTER the whole batch landed, so
 * in-batch forward references materialize (serialized per (source, slug) by
 * runAutoLink's own advisory lock).
 *
 * Policy-preserving (CDX-11): gated on the same `auto_link` config as the
 * put_page hook; best-effort (an error never fails the batch); re-fetches +
 * re-shapes the page because runAutoLink needs the parsed shape (OV-m2).
 */
export async function autoLinkWrittenPage(
  engine: BrainEngine,
  slug: string,
  opts?: { sourceId?: string },
): Promise<void> {
  try {
    if (!(await isAutoLinkEnabled(engine))) return;
    // Scope the read to the write's source (mirrors putPage's schema default).
    const page = await engine.getPage(slug, { sourceId: opts?.sourceId ?? 'default' });
    if (!page) return;
    await runAutoLink(engine, slug, {
      type: page.type,
      compiled_truth: page.compiled_truth ?? '',
      timeline: page.timeline ?? '',
      frontmatter: (page.frontmatter ?? {}) as Record<string, unknown>,
    }, opts?.sourceId ? { sourceId: opts.sourceId } : undefined);
  } catch (e) {
    process.stderr.write(`[oneshot] post-batch auto-link for ${slug} failed (best-effort): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

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
  // inserts. runAutoLink has exactly ONE caller (the put_page handler) and
  // ctx.sourceId is a REQUIRED string there, so opts.sourceId is always set in
  // practice; the omitted-opts branches below (and the `?? ''` in
  // autoLinkLockKey) are belt-and-braces only, not a live back-compat path.
  const sourceOpts = opts?.sourceId ? { sourceId: opts.sourceId } : {};
  const linkSourceOpts = opts?.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId, originSourceId: opts.sourceId }
    : {};
  const removeSourceOpts = opts?.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId }
    : {};

  // Live-mode resolver: per-put throwaway cache, pg_trgm + optional search.
  // Issue #972 (codex [P1]): pass sourceId so basename resolution stays
  // within this page's source — no cross-source basename edges. Also scopes
  // the fuzzy fallback (findByTitleFuzzy) to the same source the put_page is
  // targeting — without it, cross-source slug suggestions get silently dropped
  // at the FK filter and the link looks like it failed to resolve. Twin of
  // #1436's `tryFuzzyMatch` fix.
  const resolver = makeResolver(engine, { mode: 'live', sourceId: opts?.sourceId });
  // Issue #972: opt-in bare-wikilink basename resolution. Off by default.
  const globalBasename = await isGlobalBasenameEnabled(engine);
  // #3190: pack-aware link typing + pack frontmatter_links on the put_page
  // auto-link path. Loaded via the local-engine best-effort resolver (this
  // hook only runs for trusted-local / trusted-workspace writes); null keeps
  // the legacy in-code inference.
  const pack = (await loadActivePackForLocalEngine(engine))?.manifest ?? null;
  const { candidates, unresolved } = await extractPageLinks(
    slug, fullContent, parsed.frontmatter, parsed.type, resolver,
    { globalBasename, pack },
  );

  // Resolve which targets exist (skip refs to non-existent pages to avoid FK
  // violation churn in addLink). #2544: targeted membership probe over just
  // the candidate target/from slugs instead of materializing the whole slug
  // set — getAllSlugs was a full-table scan on EVERY put_page while the
  // candidates are typically a handful. Mirrors the proven oneshot probe
  // (subagent-oneshot.ts). Deliberately does NOT filter deleted_at: the
  // getAllSlugs it replaces included soft-deleted pages, and changing link
  // visibility is out of scope here. Skips the query entirely when there are
  // no candidates. v0.31.8 (D12): scoped to the source when opts.sourceId is
  // set so wikilink resolution doesn't span unrelated sources.
  const candidateSlugs = [...new Set(candidates.flatMap(c => (c.fromSlug ? [c.targetSlug, c.fromSlug] : [c.targetSlug])))];
  let existingSlugs = new Set<string>();
  if (candidateSlugs.length > 0) {
    const rows = opts?.sourceId
      ? await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE slug = ANY($1::text[]) AND source_id = $2`,
          [candidateSlugs, opts.sourceId],
        )
      : await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE slug = ANY($1::text[])`,
          [candidateSlugs],
        );
    existingSlugs = new Set(rows.map(r => r.slug));
  }
  const valid = candidates.filter(c =>
    existingSlugs.has(c.targetSlug) && (!c.fromSlug || existingSlugs.has(c.fromSlug))
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
      // hashtext (not hashtextextended): this call must behave identically on
      // BOTH engines and any failure here is SILENTLY swallowed by the catch
      // below — a primitive that errored on either engine would quietly drop
      // the lock entirely. hashtext is the primitive every advisory-lock site
      // in this repo already proves on both engines; keep the family uniform.
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [autoLinkLockKey(opts?.sourceId, slug)]);
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
    slug: { type: 'string', required: true, description: "Slug of the page to soft-delete, e.g. 'people/alice-example'." },
    source_id: { type: 'string', description: "#4329: source holding the row to soft-delete (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId. Remote callers may only target their write source — federated read grants do not confer delete access." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'delete_page');
    // #4329: honor a per-call source_id (pre-fix it was silently dropped and
    // the delete landed on ctx.sourceId's row — the wrong-source soft-delete).
    const requestedSource = parseSourceIdParam(p.source_id, 'delete_page');
    if (requestedSource !== undefined) assertSourceInWriteGrant(ctx, requestedSource);
    if (ctx.dryRun) return { dry_run: true, action: 'soft_delete_page', slug };
    // v0.31.8 (D7): thread ctx.sourceId so multi-source brains soft-delete the
    // intended row instead of always targeting (default, slug).
    const sourceOpts = requestedSource
      ? { sourceId: requestedSource }
      : ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    // #4022 trust gating: sandbox subagents (viaSubagent without
    // allowedSlugPrefixes) stay DB-only, matching put_page's write-through gate.
    const isSandboxSubagent = ctx.viaSubagent === true
      && !(Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0);
    // #4022: resolve the artifact target BEFORE softDeletePage stamps
    // deleted_at — resolvePageWriteTarget reads the recorded source_path from
    // active rows only, so a post-stamp resolution would fall back to the
    // slug-derived twin and miss the real artifact.
    const wtSourceId = sourceOpts.sourceId ?? 'default';
    const target = isSandboxSubagent
      ? undefined
      : await resolvePageWriteTarget(ctx.engine, slug, wtSourceId);
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
        throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug (and source_id on a multi-source brain).');
      }
      return { status: 'already_soft_deleted', slug, ...(sourceOpts.sourceId ? { source_id: sourceOpts.sourceId } : {}), deleted_at: existing.deleted_at };
    }
    // #4022: remove the on-disk artifact too. Pre-fix this was DB-only, so the
    // deleted page's `.md` survived, any timer-based commit (snapshot cron,
    // hardened post-commit push) pushed it back into git, and the next
    // `gbrain sync` resurrected the page. Best-effort like put_page's
    // write-through: a skip/error never fails the delete (the DB row is the
    // durable sink and the stale file reconciles on the next sync).
    const writeThrough = isSandboxSubagent
      ? { removed: false, skipped: 'subagent_sandbox' as const }
      : await deletePageThrough(ctx.engine, slug, { sourceId: wtSourceId, logger: ctx.logger, target });
    // Echo the targeted source so a multi-source caller can verify WHICH row
    // the delete landed on (#4329's false-confidence failure mode).
    return { status: 'soft_deleted', slug, ...(sourceOpts.sourceId ? { source_id: sourceOpts.sourceId } : {}), recoverable_until: 'now + 72h via restore_page', write_through: writeThrough };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const restore_page: Operation = {
  name: 'restore_page',
  description: 'v0.26.5 — restore a soft-deleted page (clear deleted_at). Returns success only if the page was actually soft-deleted. After this op, the page reappears in search and in get_page/list_pages without the include_deleted flag.',
  params: {
    slug: { type: 'string', required: true, description: "Slug of the soft-deleted page to restore, e.g. 'people/alice-example'." },
    source_id: { type: 'string', description: "#4329: source holding the row to restore (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId. Remote callers may only target their write source — federated read grants do not confer restore access." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'restore_page');
    // #4329: honor a per-call source_id (pre-fix it was silently dropped).
    const requestedSource = parseSourceIdParam(p.source_id, 'restore_page');
    if (requestedSource !== undefined) assertSourceInWriteGrant(ctx, requestedSource);
    if (ctx.dryRun) return { dry_run: true, action: 'restore_page', slug };
    // v0.31.8 (D7): thread ctx.sourceId.
    const sourceOpts = requestedSource
      ? { sourceId: requestedSource }
      : ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    const ok = await ctx.engine.restorePage(slug, sourceOpts);
    if (!ok) {
      // Distinguish "not found" from "already active" (idempotent-as-false).
      const existing = await ctx.engine.getPage(slug, { includeDeleted: true, ...sourceOpts });
      if (!existing) {
        throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug (and source_id on a multi-source brain).');
      }
      return { status: 'already_active', slug, ...(sourceOpts.sourceId ? { source_id: sourceOpts.sourceId } : {}) };
    }
    // #4022: re-render the artifact — delete_page now removes it, so without
    // this a restored page has a DB row and no file, and `sync --full`'s
    // delete-reconcile treats the missing artifact as a user deletion,
    // silently re-deleting the page that was just restored. Keeps the two
    // sinks symmetric across the delete/restore pair; sandbox subagents stay
    // DB-only, matching put_page's trust gate.
    const isSandboxSubagent = ctx.viaSubagent === true
      && !(Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0);
    const writeThrough = isSandboxSubagent
      ? { written: false, skipped: 'subagent_sandbox' as const }
      : await writePageThrough(ctx.engine, slug, { sourceId: sourceOpts.sourceId, logger: ctx.logger });
    return { status: 'restored', slug, ...(sourceOpts.sourceId ? { source_id: sourceOpts.sourceId } : {}), write_through: writeThrough };
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
    limit: { type: 'number', description: 'Max results (default 50; remote callers are capped at 100)' },
    offset: {
      type: 'number',
      description: 'Skip first N rows (pagination). Engine-supported since PageFilters gained offset; previously accepted at the CLI and silently dropped.',
    },
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
    // #4400 — list_pages had no source-scoping param at all: unlike
    // search/query it silently ignored any caller-supplied source and always
    // fell back to whatever federatedSearchScope() resolved from ctx alone,
    // so a non-federated source's pages could never be enumerated remotely
    // (get_stats counts them; list_pages could not list them). Mirrors the
    // `source_id` param already on search/query, same '__all__' semantics.
    source_id: {
      type: 'string',
      description:
        "v0.46.25: scope listing to a single source. Defaults to OperationContext.sourceId / federated scope. Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
    },
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
    // #3242 / #4400: federatedSearchScope so unqualified listing spans
    // federated sources (same visibility set as search / get_page); an
    // explicit per-call source_id (including '__all__') wins, same contract
    // as search/query's sourceIdParam.
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    const scope = federatedSearchScope(ctx, sourceIdParam);
    // #4352 remediation: untrusted listing never enumerates
    // `visibility: private` pages (slugs + titles are the leak surface here).
    // Composes with the #4400 per-call source_id and the v0.34.1 grant scope
    // above — an ADDITIONAL predicate threaded into PageFilters, never a
    // replacement for the source filter. Trusted local enumeration unchanged.
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    // The 100-row cap exists to protect remote MCP/OAuth transports from
    // unbounded result dumps. Local CLI callers (ctx.remote === false — the
    // same trust boundary that already bypasses scope enforcement, see the
    // Operation.scope doc above) own the machine, and a full enumeration is a
    // legitimate local operation, so an explicit limit above 100 is honored.
    // Anything that is not strictly `false` stays remote/untrusted (defense
    // in depth, matching the ctx.remote contract).
    const requestedLimit = p.limit as number | undefined;
    const isLocal = ctx.remote === false;
    const limit = isLocal
      ? clampSearchLimit(requestedLimit, 50, Number.MAX_SAFE_INTEGER)
      : clampSearchLimit(requestedLimit, 50, 100);
    if (!isLocal && requestedLimit !== undefined && Number.isFinite(requestedLimit) && requestedLimit > limit) {
      // Loud clamp, parity with the three search paths ("search limit clamped
      // from N to 100"). logger.warn goes to stderr — `list` stdout is
      // tab-separated and consumed by scripts, so it must stay clean.
      ctx.logger.warn(`[gbrain] Warning: list limit clamped from ${requestedLimit} to ${limit}; use offset to paginate`);
    }
    // Thread offset through — PageFilters has supported it all along; the op
    // layer just never passed it, so `--offset` was accepted and ignored.
    const requestedOffset = p.offset as number | undefined;
    const offset =
      requestedOffset !== undefined && Number.isFinite(requestedOffset) && requestedOffset > 0
        ? Math.floor(requestedOffset)
        : undefined;
    // Probe one row past the effective limit so truncation is detectable
    // without a COUNT query. The bug class sealed here is SILENT truncation
    // — an exhaustive consumer (audit, scan, backfill) gets a full-looking
    // list and never learns rows were dropped, and with the default
    // updated_desc sort the dropped rows are always the OLDEST, i.e. exactly
    // the pages such consumers exist to find.
    const rows = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: limit + 1,
      offset,
      includeDeleted: (p.include_deleted as boolean) === true,
      updated_after: typeof p.updated_after === 'string' ? p.updated_after : undefined,
      sort,
      excludePrivate,
      ...scope,
    });
    const truncated = rows.length > limit;
    const pages = truncated ? rows.slice(0, limit) : rows;
    // Warn only when the caller's limit was NOT honored (unset → default 50):
    // an explicit honored limit that happens to land on more rows is ordinary
    // pagination, not a trap. Local (CLI) only — same operator-facing stderr
    // channel as the put_page unknown-type hint above — but with no isTTY
    // gate: scripted callers are precisely the consumers that cannot detect
    // truncation any other way, and stderr keeps stdout parseable for them.
    // (Local explicit limits are honored unbounded since #3322, so the
    // requestedLimit > limit arm is defense in depth only.)
    if (truncated && isLocal && (requestedLimit === undefined || requestedLimit > limit)) {
      console.error(
        `[list_pages] output truncated at ${limit} rows (default 50). ` +
        `Pass an explicit limit, page through with sort=updated_asc + ` +
        `updated_after=<last row's updated_at>, or narrow with type/tag.`,
      );
    }
    return pages.map(pg => ({
      slug: pg.slug,
      source_id: pg.source_id,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
      ...(pg.deleted_at ? { deleted_at: pg.deleted_at } : {}),
    }));
  },
  scope: 'read',
  cliHints: { name: 'list' },
};


// Ops in EXACTLY the order they appear in the canonical `operations` array
/**
 * CLI→MCP gap-closure wave — `capture` over MCP (D2A). The documented "just
 * get this into my brain" entrypoint: three separate docs carried the
 * "unknown tool: capture → use put_page" FAQ because agents kept reaching for
 * it. Thin sugar that DELEGATES to the put_page handler with the same ctx
 * (inheriting every fence: slug fence, dedupe, unknown-type audit,
 * write-through, remote auto-link skip) after adding what agents had to
 * hand-roll: a stable content-derived default slug + the frontmatter merge +
 * the binary/empty guards. Remote provenance stays the CV6 server-stamp
 * `mcp:put_page` (the write API truthfully IS put_page); the result carries
 * channel: 'capture' for the receipt. Joins STARTER_OPS as a direct literal
 * [EV8] so the plugin/starter lanes that retired the FAQ can actually call it.
 */
const capture: Operation = {
  name: 'capture',
  description: CAPTURE_DESCRIPTION,
  params: {
    content: { type: 'string', required: true, description: 'Markdown or plain text to capture. File paths are NOT accepted over MCP — read the file yourself and pass its content (the CLI --file lane is local-only).' },
    slug: { type: 'string', required: false, description: "Target slug. Default: inbox/YYYY-MM-DD-<sha8-of-content> (stable per content — recapturing identical text hits the same slug); type diary/event routes under life/. Fenced clients: the default lands under your first bound prefix." },
    type: { type: 'string', required: false, description: "Page type for the stamped frontmatter (default 'note')." },
  },
  scope: 'write',
  mutating: true,
  area: 'pages',
  // 'capture' is in CLI_ONLY (rich local UX: --file/--stdin/event sugar);
  // hidden hint per the advisor pattern.
  cliHints: { name: 'capture', hidden: true },
  handler: async (ctx, p) => {
    const {
      detectBinaryNullByte, normalizeForHash, mergeCaptureFrontmatter,
      defaultSlug,
    } = await import('../capture-content.ts');
    const { computeContentHash } = await import('../ingestion/types.ts');
    const content = p.content as string;
    const nulAt = detectBinaryNullByte(Buffer.from(content, 'utf8'));
    if (nulAt !== -1) {
      throw new OperationError('invalid_params',
        `content contains a NUL byte at offset ${nulAt} — binary payloads are refused.`,
        'Capture takes text/markdown; upload binaries through the files lane on the host.');
    }
    const normalized = normalizeForHash(content);
    if (normalized.length === 0) {
      throw new OperationError('invalid_params', 'Refusing to capture empty content.');
    }
    const type = typeof p.type === 'string' && p.type.length > 0 ? p.type : 'note';
    let slug = typeof p.slug === 'string' && p.slug.length > 0 ? p.slug : undefined;
    if (slug) {
      // Defense-in-depth on the caller-supplied slug (matches the takes ops);
      // put_page validates again, but reject a malformed slug before we build
      // provenance frontmatter around it.
      validatePageSlug(slug);
    } else {
      slug = defaultSlug(normalized, new Date(), type);
      // [EV7] A slug-bound client would 403 on the inbox/ default via the
      // inherited slug fence — the zero-config path must work for exactly
      // that audience, so the ENTIRE default slug (type prefix included —
      // diary/event prefixes are two segments) nests under the FIRST bound
      // prefix. Normalize a stored `<prefix>/*` glob (submit_agent binding
      // grammar) to `<prefix>/` first so the nested slug never carries a
      // literal `*` segment.
      const bound = ctx.auth?.boundSlugPrefixes;
      if (bound && bound.length > 0) {
        const base = normalizeSlugPrefix(bound[0]);
        const prefix = base.endsWith('/') ? base : `${base}/`;
        slug = `${prefix}${slug}`;
      }
    }
    // Remote MCP captures record `capture-mcp` provenance; local CLI callers
    // (ctx.remote === false) keep the neutral 'capture-cli' default.
    const capturedVia = ctx.remote !== false ? 'capture-mcp' : undefined;
    const fullContent = mergeCaptureFrontmatter(content, { type, capturedVia });
    if (ctx.dryRun) return { dry_run: true, action: 'capture', slug };
    // Delegate with the SAME ctx (the runCapture local-path precedent) —
    // put_page enforces the slug fence, validates the slug, dedupes, and
    // server-stamps provenance for remote callers.
    const result = await put_page.handler(ctx, { slug, content: fullContent }) as Record<string, unknown>;
    return {
      ...result,
      slug,
      channel: 'capture',
      content_hash: computeContentHash(normalized),
      dedupe: 'identical normalized content produces the same default slug and hash',
    };
  },
};

// (Page CRUD quartet first, then the v0.26.5 destructive-guard ops:
// page-level soft-delete recovery + admin purge, then capture.)
export const pagesOperations: Operation[] = [
  get_page, put_page, delete_page, list_pages,
  restore_page, purge_deleted_pages, capture,
  fetch_page,
];
