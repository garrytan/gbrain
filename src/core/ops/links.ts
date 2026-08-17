/**
 * Links + graph operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). MANAGED_LINK_SOURCES stays exported (test suite + operations.ts
 * re-export depend on it); op consts stay module-private. `linksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceClientSlugFence, linkReadScopeOpts, sourceScopeOpts } from './context.ts';

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
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at)' },
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
    slug: { type: 'string', required: true, description: 'Slug of the page whose outgoing links to list.' },
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
    slug: { type: 'string', required: true, description: 'Slug of the page whose incoming links to list.' },
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
    slug: { type: 'string', required: true, description: "Slug of the page to start the traversal from, e.g. 'people/alice-example'. This is the start-node param — there is no `start` or `root` param." },
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


// Ops in EXACTLY the canonical `operations` array order.
export const linksOperations: Operation[] = [
  add_link, remove_link, get_links, get_backlinks, list_link_sources, traverse_graph,
];
