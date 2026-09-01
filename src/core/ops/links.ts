/**
 * Links + graph operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). MANAGED_LINK_SOURCES stays exported (test suite + operations.ts
 * re-export depend on it); op consts stay module-private. `linksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import { OperationError, type Operation } from './contract.ts';
import {
  enforceClientSlugFence,
  linkReadScopeOpts,
  reclassifyMutationTimePageMiss,
  requireWritablePage,
  sourceScopeOpts,
} from './context.ts';
import { PageMissingError } from '../engine-errors.ts';
import { TRAVERSE_PATH_ROW_CAP } from '../engine-constants.ts';
// #4224: flag-gated cross-source identity union for the link read ops.
import { unionLinksAcrossIdentity } from '../entity-identity.ts';
import { findPrivateOnlySlugs, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import type { BrainEngine } from '../engine.ts';
import type { Link } from '../types.ts';
// #4655: write-time pack vocabulary enforcement for explicit link verbs.
import {
  loadActivePackForWriteVocabulary,
  packDeclaresLinkType,
  undeclaredLinkTypeMessage,
  undeclaredLinkTypeSuggestion,
} from '../schema-pack/write-vocabulary.ts';

/**
 * #4352 remediation shared by get_links / get_backlinks: when the caller is
 * untrusted, a `visibility: private` queried page reads exactly like a
 * missing one ([]), and edges touching a private endpoint (from / to /
 * frontmatter origin) are dropped so the link surface can't enumerate
 * private slugs. One probe covers the queried slug + every endpoint; the
 * probe considers deleted rows too (fail-closed). Trusted local + the
 * operator opt-outs short-circuit before any query.
 */
async function dropPrivateLinkEndpoints(
  engine: BrainEngine,
  remote: boolean | undefined,
  slug: string,
  links: Link[],
  scope: { sourceId?: string; sourceIds?: string[] },
): Promise<Link[]> {
  if (!(await resolveExcludePrivatePages(engine, remote))) return links;
  const endpointSlugs = [...new Set([
    slug,
    ...links.flatMap(l => [l.from_slug, l.to_slug, ...(l.origin_slug ? [l.origin_slug] : [])]),
  ])];
  const hidden = await findPrivateOnlySlugs(engine, endpointSlugs, scope, { includeDeleted: true });
  if (hidden.has(slug)) return [];
  return links.filter(
    l => !hidden.has(l.from_slug) && !hidden.has(l.to_slug) && !(l.origin_slug && hidden.has(l.origin_slug)),
  );
}

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
    from: { type: 'string', required: true, description: "Slug of the page the link originates from (the edge renders on this page), e.g. 'people/alice-example'. These are page slugs — there is no `source`/`target` pair." },
    to: { type: 'string', required: true, description: "Slug of the page the link points to, e.g. 'companies/acme-example'." },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at). When the active schema pack declares a link vocabulary, an explicit link_type must be one of its declared verbs (undeclared verbs are rejected, also under dry_run). Omitted = untyped edge.' },
    context: { type: 'string', description: 'Context for the link' },
    link_source: { type: 'string', description: "Provenance tag (kebab-case, e.g. 'citation-graph'). Defaults to 'manual'. Reconciliation-managed built-ins (markdown/frontmatter/mentions/wikilink-resolved) are rejected." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    // Client fence on the `from` endpoint only: the edge originates from
    // (and renders on) the from page; linking TO a page outside the
    // binding is a reference, not a mutation of the target.
    enforceClientSlugFence(ctx, p.from as string, 'add_link');
    // #4655: an EXPLICIT link verb must be declared by the active pack (when
    // one resolves — best-effort, no pack means no vocabulary to enforce).
    // Runs before the dry-run return so a dry run previews the rejection.
    // Omitted/empty link_type stays unchecked (the untyped-edge default).
    const linkType = typeof p.link_type === 'string' ? p.link_type : '';
    if (linkType.length > 0) {
      const activePack = await loadActivePackForWriteVocabulary(ctx);
      if (activePack && !packDeclaresLinkType(activePack, linkType)) {
        throw new OperationError(
          'invalid_params',
          undeclaredLinkTypeMessage(linkType, activePack, 'add_link'),
          undeclaredLinkTypeSuggestion(activePack),
        );
      }
    }
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
    // #4109: per-endpoint source-boundary diagnostics before the mutation.
    await requireWritablePage(ctx, p.from as string, 'add_link', 'from');
    await requireWritablePage(ctx, p.to as string, 'add_link', 'to');
    try {
      await ctx.engine.addLink( // gbrain-allow-direct-insert: add_link MCP op is the explicit canonical surface for manual link creation; auto-link reconciliation runs separately via auto_link post-hook
        p.from as string, p.to as string,
        (p.context as string) || '', linkType,
        linkSource, undefined, undefined,
        linkOpts,
      );
    } catch (error) {
      // An endpoint hard-deleted between preflight and mutation: reclassify
      // the typed engine miss instead of surfacing it as internal_error.
      if (error instanceof PageMissingError) {
        return reclassifyMutationTimePageMiss(ctx, error.slug, 'add_link', error.endpoint);
      }
      throw error;
    }
    return { status: 'ok' };
  },
  cliHints: { name: 'link', aliases: ['link-add'], positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true, description: 'Slug of the page the link originates from (same endpoint order as add_link).' },
    to: { type: 'string', required: true, description: 'Slug of the page the link points to.' },
    link_type: { type: 'string', description: 'Only remove edges of this link type (omit = all types)' },
    link_source: { type: 'string', description: 'Only remove edges of this provenance (e.g. citation-graph); omit = any provenance' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.from as string, 'remove_link');
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId }
      : undefined;
    // #4527: report how many edges actually died — an unconditional
    // `{ status: 'ok' }` made a zero-match delete (typo'd slug, wrong
    // link_type, already removed) indistinguishable from a real removal.
    const removed = await ctx.engine.removeLink(
      p.from as string, p.to as string,
      (p.link_type as string) || undefined,
      (p.link_source as string) || undefined,
      linkOpts,
    );
    return { status: 'ok', removed };
  },
  cliHints: { name: 'unlink', aliases: ['link-rm'], positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose outgoing links to list.' },
  },
  handler: async (ctx, p) => {
    // #2200: linkReadScopeOpts so a federated grant — and an untrusted remote
    // scalar scope (promoted to sourceIds[]) — reaches the engine's all-endpoint
    // branch. Trusted local/internal callers keep the scalar cross-source view.
    const sourceOpts = linkReadScopeOpts(ctx);
    const links = await ctx.engine.getLinks(p.slug as string, sourceOpts);
    // #4224: flag-gated identity union — merge edges from the page's identity
    // co-members (entity_identity.union config, default off; pure no-op then).
    // Member visibility never widens past the caller's grant. The scalar base
    // scope (when present) pins group resolution to the page actually read.
    const unioned = await unionLinksAcrossIdentity(ctx.engine, p.slug as string, links, 'out', {
      sourceId: sourceOpts.sourceId,
      allowedSources: sourceOpts.sourceIds,
    });
    // #4352: private filtering runs AFTER the identity union so co-member
    // edges the union adds are subject to the same visibility gate.
    return dropPrivateLinkEndpoints(ctx.engine, ctx.remote, p.slug as string, unioned, sourceOpts);
  },
  scope: 'read',
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose incoming links to list.' },
  },
  handler: async (ctx, p) => {
    // #2200: linkReadScopeOpts — federated grant + untrusted remote scalar
    // (promoted to sourceIds[]) reach the engine's all-endpoint branch.
    const sourceOpts = linkReadScopeOpts(ctx);
    const links = await ctx.engine.getBacklinks(p.slug as string, sourceOpts);
    // #4224: flag-gated identity union (see get_links).
    const unioned = await unionLinksAcrossIdentity(ctx.engine, p.slug as string, links, 'in', {
      sourceId: sourceOpts.sourceId,
      allowedSources: sourceOpts.sourceIds,
    });
    // #4352: private filtering after the union (see get_links).
    return dropPrivateLinkEndpoints(ctx.engine, ctx.remote, p.slug as string, unioned, sourceOpts);
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

/**
 * Default depth for the remote no-direction call. #4666 made that call
 * bidirectional, and traversePaths' `both` branch is an uncapped
 * path-enumerating recursive CTE (no LIMIT) — on an entity hub with 10^2-10^3
 * edges the legacy depth-5 default is combinatorial, on the per-agent-turn
 * path. Two hops covers the realistic relationship query ("people who
 * attended meetings with Alice"); a caller that wants more passes `depth`
 * explicitly (still honored up to TRAVERSE_DEPTH_CAP).
 */
const REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH = 2;
const DEFAULT_TRAVERSE_DEPTH = 5;

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: `Traverse link graph from a page. Remote callers default to bidirectional edges (GraphPath[]) at depth ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH} (pass depth explicitly for deeper walks); trusted local no-filter callers keep the legacy node shape at depth ${DEFAULT_TRAVERSE_DEPTH}.`,
  params: {
    slug: { type: 'string', required: true, description: "Slug of the page to start the traversal from, e.g. 'people/alice-example'. This is the start-node param — there is no `start` or `root` param." },
    depth: { type: 'number', description: `Max traversal depth (capped at ${TRAVERSE_DEPTH_CAP}). Default ${DEFAULT_TRAVERSE_DEPTH}, except a remote call that lets direction default to 'both' uses ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH} (bidirectional path enumeration is combinatorial on hubs); an explicit depth is always honored up to the cap.` },
    link_type: { type: 'string', description: 'Filter to one link type (per-edge filter, traversal only follows matching edges)' },
    direction: { type: 'string', enum: ['in', 'out', 'both'], description: "Traversal direction ('in', 'out', or 'both'). Remote callers default to 'both'; trusted local no-filter callers keep the legacy outgoing-node output." },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const linkType = p.link_type as string | undefined;
    // #4666: remote callers (ctx.remote !== false — fail-closed) default to
    // direction=both, so a node with only INBOUND typed edges stops reading
    // as nodes=1/links=0 (indistinguishable from edge absence). An explicit
    // direction param still wins for callers that want outbound-only.
    const requestedDirection = p.direction as 'in' | 'out' | 'both' | undefined;
    const directionDefaultedToBoth = requestedDirection === undefined && ctx.remote !== false;
    const direction = requestedDirection ?? (directionDefaultedToBoth ? 'both' : undefined);
    // Depth default follows the direction default: a remote call that did not
    // ask for a direction (so walks `both`) AND did not ask for a depth gets
    // the conservative bidirectional default; everything else keeps 5.
    const depthRequested = typeof p.depth === 'number' && p.depth > 0;
    const requestedDepth = depthRequested
      ? (p.depth as number)
      : directionDefaultedToBoth ? REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH : DEFAULT_TRAVERSE_DEPTH;
    if (requestedDepth > TRAVERSE_DEPTH_CAP) {
      ctx.logger.warn(`[gbrain] traverse_graph depth clamped from ${requestedDepth} to ${TRAVERSE_DEPTH_CAP}`);
    }
    const depth = Math.max(1, Math.min(requestedDepth, TRAVERSE_DEPTH_CAP));
    // v0.34.1 (#861 — P0 leak seal): thread caller's source scope so graph
    // walks stay within the auth'd client's accessible sources. Pre-fix,
    // traverseGraph / traversePaths happily followed edges into pages from
    // foreign sources, leaking topology + page metadata via the graph op.
    const scope = sourceScopeOpts(ctx);
    // #4352 remediation: graph output must not enumerate private slugs to an
    // untrusted caller. A private START page reads exactly like a missing one
    // ([]); private nodes/edges elsewhere in the walk are stripped post-hoc
    // (op-level gate, same as get_page — the engine CTE stays shared).
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    if (excludePrivate) {
      const startHidden = await findPrivateOnlySlugs(ctx.engine, [slug], scope, { includeDeleted: true });
      if (startHidden.has(slug)) return [];
    }
    // Backward compat: trusted local no-filter callers keep the legacy
    // GraphNode[] shape used by `gbrain graph`. Remote MCP callers need the
    // natural no-filter invocation to surface inbound-only typed edges too,
    // so they default to direction=both and get explicit GraphPath[] edges.
    if (linkType === undefined && requestedDirection === undefined && ctx.remote === false) {
      const nodes = await ctx.engine.traverseGraph(slug, depth, scope);
      if (!excludePrivate) return nodes;
      const hidden = await findPrivateOnlySlugs(
        ctx.engine,
        [...new Set(nodes.flatMap(n => [n.slug, ...n.links.map(l => l.to_slug)]))],
        scope,
        { includeDeleted: true },
      );
      return nodes
        .filter(n => !hidden.has(n.slug))
        .map(n => (n.links.some(l => hidden.has(l.to_slug))
          ? { ...n, links: n.links.filter(l => !hidden.has(l.to_slug)) }
          : n));
    }
    const { paths, truncated } = await ctx.engine.traversePathsDetailed(slug, { depth, linkType, direction, ...scope });
    // Row cap hit: the walk's deepest edges were dropped. stderr-only so the
    // GraphPath[] wire shape stays unchanged (additive contract).
    if (truncated) {
      ctx.logger.warn(
        `[gbrain] traverse_graph output truncated at ${TRAVERSE_PATH_ROW_CAP} edge rows (shallowest first). ` +
        `Lower depth or narrow with link_type/direction for a complete walk.`,
      );
    }
    if (!excludePrivate) return paths;
    const hidden = await findPrivateOnlySlugs(
      ctx.engine,
      [...new Set(paths.flatMap(e => [e.from_slug, e.to_slug]))],
      scope,
      { includeDeleted: true },
    );
    return paths.filter(e => !hidden.has(e.from_slug) && !hidden.has(e.to_slug));
  },
  scope: 'read',
  cliHints: { name: 'graph', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const linksOperations: Operation[] = [
  add_link, remove_link, get_links, get_backlinks, list_link_sources, traverse_graph,
];
