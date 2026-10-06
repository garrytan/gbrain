import { coordinatedManualLinkWrite } from '../persistence/manual-links.ts';
import { filterBacklinkRows, readBacklinkPage, wantsPagedBacklinks } from './backlinks-paged.ts';
/**
 * Links + graph operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). MANAGED_LINK_SOURCES stays exported (test suite + operations.ts
 * re-export depend on it); op consts stay module-private. `linksOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import { opError, type Operation } from './contract.ts';
import type { Action } from '../agent-output.ts';
import { presentEdgeContext, resolveChainAnchors, runRelationalChain, validateChainHops, type ChainEvidenceEdge, type ChainPlan } from '../search/relational-chain.ts';
import { invalidParam, paramUse, readFix } from './op-fix.ts';
import {
  assertExplicitSourceLive,
  enforceClientSlugFence,
  federatedSearchScope,
  linkReadScopeOpts,
  parseSourceIdParam,
  readPolicyOpts,
  reclassifyMutationTimePageMiss,
  requireWritablePage,
  sourceScopeOpts,
  assertSourceInCallerScope,
} from './context.ts';
import { listWantedPages } from '../wanted-links-store.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { OperationContext } from './contract.ts';
import type { Link, PageReadPolicy } from '../types.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { PageMissingError } from '../engine-errors.ts';
import { TRAVERSE_PATH_ROW_CAP } from '../engine-constants.ts';
// #4224: flag-gated cross-source identity union for the link read ops.
import { unionLinksAcrossIdentity } from '../entity-identity.ts';
import { TEMPORAL_EDGE_PARAMS, STARTER_STATUS_PARAM, STARTER_AS_OF_PARAM, resolveEdgeTemporal, filterTemporalLinks, reportTemporal } from './edge-temporal.ts';
import { isCalendarDate, relationSemantics, temporalLinkTypes } from '../link-validity.ts';
import { writeManualTransitions, removeManualTransitions } from '../link-temporal-apply.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { primeRelationSemantics } from '../link-semantics-pack.ts';
// #4655: write-time pack vocabulary enforcement for explicit link verbs.
import {
  loadActivePackForWriteVocabulary,
  packDeclaresLinkType,
  undeclaredLinkTypeMessage,
  undeclaredLinkTypeSuggestion,
} from '../schema-pack/write-vocabulary.ts';

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
export const MANAGED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved', 'mcp-remote-mention'];

/** add_link valid_from / valid_until: calendar dates on a dated relation type. Null when neither is given. */
function validateLinkDates(ctx: OperationContext, p: Record<string, unknown>, linkType: string): { validFrom?: string; validUntil?: string } | null {
  const validFrom = p.valid_from, validUntil = p.valid_until;
  if (validFrom === undefined && validUntil === undefined) return null;
  for (const [name, value] of [['valid_from', validFrom], ['valid_until', validUntil]] as const) {
    if (value !== undefined && !isCalendarDate(value)) {
      throw opError('invalid_params', `add_link: ${name} must be a calendar date YYYY-MM-DD (got ${JSON.stringify(value)})`,
        `Pass ${paramUse(ctx, name, '2025-03-01')}; omit it when the date is unknown.`);
    }
  }
  if (typeof validFrom === 'string' && typeof validUntil === 'string' && validUntil < validFrom) {
    throw opError('invalid_params', 'add_link: valid_until is before valid_from', `Swap them, or pass only ${paramUse(ctx, 'valid_until')} to record when the relationship ended.`);
  }
  if (relationSemantics(linkType) === 'reference') {
    throw opError('invalid_params', `add_link: link_type '${linkType || '(none)'}' has no dates; valid_from/valid_until apply to dated relations (${temporalLinkTypes().join(', ')})`,
      `Pass link_type such as works_at with the dates, or drop valid_from/valid_until.`);
  }
  if (relationSemantics(linkType) === 'event' && validUntil !== undefined) {
    throw opError('invalid_params', `add_link: ${linkType} is an event and does not end; pass only valid_from (when it happened)`, `Drop ${paramUse(ctx, 'valid_until')}.`);
  }
  return { ...(typeof validFrom === 'string' ? { validFrom } : {}), ...(typeof validUntil === 'string' ? { validUntil } : {}) };
}

const add_link: Operation = {
  name: 'add_link',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Create a typed link (edge) from one page to another in the same source. Use when recording a relationship (works_at, invested_in, mentions); remote page writes already link [[wikilinks]] to existing pages as mentions (receipt auto_links), so add only typed links or ones the text lacks. Needs write scope; an explicit link_type must be declared by the active schema pack. On page_not_found: resolve both slugs with resolve_slugs.',
  params: {
    from: { type: 'string', required: true, description: "Slug of the page the link originates from (the edge renders on this page), e.g. 'people/alice-example'. These are page slugs — there is no `source`/`target` pair." },
    to: { type: 'string', required: true, description: "Slug of the page the link points to, e.g. 'companies/acme-example'." },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at). When the active schema pack declares a link vocabulary, an explicit link_type must be one of its declared verbs (undeclared verbs are rejected, also under dry_run). Omitted = untyped edge.' },
    context: { type: 'string', description: 'Context for the link' },
    link_source: { type: 'string', description: "Provenance tag (kebab-case, e.g. 'citation-graph'). Defaults to 'manual'. Reconciliation-managed built-ins (markdown/frontmatter/mentions/wikilink-resolved) are rejected." },
    valid_from: { type: 'string', description: 'When the relationship started (YYYY-MM-DD), for dated relations such as works_at or invested_in.' },
    valid_until: { type: 'string', description: 'When it ended (YYYY-MM-DD, exclusive). Re-run add_link with valid_until to record that a relationship ended.' },
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
        throw opError(
          'invalid_params',
          undeclaredLinkTypeMessage(linkType, activePack, 'add_link'),
          undeclaredLinkTypeSuggestion(activePack),
        );
      }
    }
    await primeRelationSemantics(ctx.engine);
    const dates = validateLinkDates(ctx, p, linkType);
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    // v114 (#1941): default omitted provenance to 'manual' (NOT the engine's
    // 'markdown' default) so hand/tool-created CLI edges are honestly manual,
    // and forbid forging the reconciliation-managed built-ins.
    const linkSource = ((p.link_source as string) || 'manual').trim();
    if (MANAGED_LINK_SOURCES.includes(linkSource)) {
      throw opError('invalid_params',
        `link_source '${linkSource}' is reconciliation-managed and cannot be set manually; ` +
        `use 'manual' (the default) or a custom kebab tag like 'citation-graph'`,
        `Omit link_source (defaults to 'manual') or pass a custom kebab tag such as 'citation-graph'; ${MANAGED_LINK_SOURCES.join(', ')} are reserved for reconciliation.`);
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
      // #5280: a managed brain takes the coordinated database-only path.
      const managed = await coordinatedManualLinkWrite(ctx, 'add_link', p.from as string, p.to as string, async (engine, sourceId) => {
        await engine.addLink(p.from as string, p.to as string, (p.context as string) || '', linkType, linkSource, undefined, undefined, // gbrain-allow-direct-insert: coordinated manual link inside withCoordinatedWrite
          { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
        if (dates) await writeManualTransitions(engine, { from: p.from as string, to: p.to as string, linkType, sourceId }, dates);
      });
      if (!managed && !dates) await ctx.engine.addLink( // gbrain-allow-direct-insert: add_link MCP op is the explicit canonical surface for manual link creation; auto-link reconciliation runs separately via auto_link post-hook
        p.from as string, p.to as string,
        (p.context as string) || '', linkType,
        linkSource, undefined, undefined,
        linkOpts,
      );
      if (!managed && dates) {
        const sourceId = ctx.sourceId ?? 'default';
        await maintenanceTransaction(ctx.engine, async tx => {
          await tx.addLink(p.from as string, p.to as string, (p.context as string) || '', linkType, linkSource, undefined, undefined, // gbrain-allow-direct-insert: add_link with dated manual evidence, one maintenance transaction
            linkOpts);
          await writeManualTransitions(tx, { from: p.from as string, to: p.to as string, linkType, sourceId }, dates);
        });
      }
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
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Remove a link between two pages (optionally only one link_type or link_source). Use when a relationship was recorded wrongly. Needs write scope. On page_not_found: resolve both slugs with resolve_slugs.',
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
    await primeRelationSemantics(ctx.engine);
    const linkOpts = ctx.sourceId
      ? { fromSourceId: ctx.sourceId, toSourceId: ctx.sourceId }
      : undefined;
    const remove = async (engine: typeof ctx.engine, opts: typeof linkOpts) => {
      const removed = await engine.removeLink(
        p.from as string, p.to as string,
        (p.link_type as string) || undefined,
        (p.link_source as string) || undefined,
        opts,
      );
      // Manual dated statements belong to manual edges; drop them with the edge.
      if (removed > 0 && (!p.link_source || p.link_source === 'manual')) {
        await removeManualTransitions(engine, { from: p.from as string, to: p.to as string, linkType: (p.link_type as string) || undefined, sourceId: opts?.fromSourceId ?? 'default' });
      }
      return removed;
    };
    // #4527: report how many edges actually died — an unconditional
    // `{ status: 'ok' }` made a zero-match delete (typo'd slug, wrong
    // link_type, already removed) indistinguishable from a real removal.
    // #5280: a managed brain takes the coordinated database-only path.
    const managed = await coordinatedManualLinkWrite(ctx, 'remove_link', p.from as string, p.to as string,
      (engine, sourceId) => remove(engine, { fromSourceId: sourceId, toSourceId: sourceId }));
    const removed = managed ? managed.value : await remove(ctx.engine, linkOpts);
    return { status: 'ok', removed };
  },
  cliHints: { name: 'unlink', aliases: ['link-rm'], positional: ['from', 'to'] },
};

const LINK_SOURCE_ID_PARAM = {
  type: 'string',
  description: "One source, or '__all__'.",
} as const;
const LINK_ALL_SOURCES_PARAM = {
  type: 'boolean',
  description: 'Same as source_id __all__.',
} as const;

/**
 * #5827: the per-call source scope of a link read (get_links, get_backlinks,
 * traverse_graph). `federatedSearchScope` is the single trust + grant
 * resolver (#5081 explicit-read admission; an unqualified no-grant read widens
 * to the transport-computed federated set; a grant never widens), the
 * liveness check runs strictly after it (an archived source the caller was
 * never granted answers permission_denied, not unknown_source), and
 * `linkReadScopeOpts` promotes a remote scalar to `sourceIds[]` so the
 * engine's #2200 all-endpoints branch applies. Trusted local callers get the
 * scope as resolved: an explicit source stays scalar, `__all__` is brain-wide,
 * and an unqualified read may come back as the federated `sourceIds[]`.
 */
async function resolveLinkReadScope(
  ctx: OperationContext,
  p: Record<string, unknown>,
  opName: string,
): Promise<{ requested: string | undefined; policy: PageReadPolicy }> {
  const sourceIdParam = parseSourceIdParam(p.source_id, opName, { allowAll: true });
  if (p.all_sources === true && sourceIdParam !== undefined && sourceIdParam !== ALL_SOURCES) {
    throw opError(
      'invalid_params',
      `${opName}: pass either source_id or all_sources, not both.`,
      `Drop ${paramUse(ctx, 'all_sources')} to read source ${sourceIdParam}, or drop source_id to span sources.`,
    );
  }
  const requested = p.all_sources === true ? ALL_SOURCES : sourceIdParam;
  const scope = federatedSearchScope(ctx, requested);
  await assertExplicitSourceLive(ctx, requested);
  return { requested, policy: await readPolicyOpts(ctx, linkReadScopeOpts(ctx, scope)) };
}

const linkIdentity = (l: Link) => JSON.stringify([
  l.from_source_id, l.from_slug, l.to_source_id, l.to_slug, l.link_type,
  l.link_source ?? null, l.origin_source_id ?? null, l.origin_slug ?? null, l.origin_field ?? null,
]);

/**
 * get_links / get_backlinks body. A trusted local unqualified read whose scope
 * widened to the federated set runs the scalar read once per federated source
 * (resolved source first, the set's own order) and merges, de-duplicated on
 * link identity: the scalar branch keeps the cross-source far-endpoint view
 * local callers rely on, which the all-endpoints branch would drop for far
 * pages in non-federated sources. Every other caller runs one read.
 */
async function readLinkEdges(
  ctx: OperationContext,
  p: Record<string, unknown>,
  opName: 'get_links' | 'get_backlinks',
  direction: 'out' | 'in',
): Promise<Link[]> {
  const slug = p.slug as string;
  const { requested, policy } = await resolveLinkReadScope(ctx, p, opName);
  const temporal = await resolveEdgeTemporal(ctx, p, opName);
  const linkType = typeof p.link_type === 'string' && p.link_type ? p.link_type : undefined;
  // Rows come back annotated with their relationship status; the policy is
  // applied below so hidden former relationships can be counted and reported.
  const annotate = temporal.disabled ? undefined : { ...temporal, status: 'all' as const, during: undefined };
  const finish = (links: Link[]): Link[] => {
    const typed = linkType ? links.filter(l => l.link_type === linkType) : links;
    const { kept, hidden } = filterTemporalLinks(typed, temporal);
    reportTemporal(ctx, opName, p, temporal, hidden);
    return kept;
  };
  const scopes: PageReadPolicy[] = ctx.remote === false && policy.sourceIds
    ? policy.sourceIds.map((sourceId) => ({ ...policy, sourceIds: undefined, sourceId }))
    : [policy];
  const perScope: Link[][] = [];
  for (const sourceOpts of scopes) {
    const readOpts = annotate ? { ...sourceOpts, temporal: annotate } : sourceOpts;
    const links = direction === 'out'
      ? await ctx.engine.getLinks(slug, readOpts)
      : await ctx.engine.getBacklinks(slug, readOpts);
    // #4224: flag-gated identity union — merge edges from the page's identity
    // co-members (entity_identity.union config, default off; pure no-op then).
    // Member visibility never widens past the caller's grant. The scalar base
    // scope (when present) pins group resolution to the page actually read.
    // The engine authorizes the base and every member read before merging;
    // each union contributor must preserve this policy because no final filter runs.
    perScope.push(await unionLinksAcrossIdentity(ctx.engine, slug, links, direction, {
      sourceId: sourceOpts.sourceId,
      allowedSources: sourceOpts.sourceIds,
      excludePrivate: sourceOpts.excludePrivate,
      ...(annotate ? { temporal: annotate } : {}),
    }));
  }
  if (perScope.length === 1) {
    if (perScope[0].length === 0) await hintScopedLinkMiss(ctx, p, requested, policy, direction);
    return finish(perScope[0]);
  }
  const seen = new Set<string>();
  const merged = perScope.flat().filter((l) => {
    const key = linkIdentity(l);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (merged.length === 0) await hintScopedLinkMiss(ctx, p, requested, policy, direction);
  return finish(merged);
}

/**
 * #5827: local scoped-miss hint. A trusted local unqualified link read that
 * found nothing, for a slug that has links in a source outside the read scope
 * (a non-federated source, or any other source when the read was pinned),
 * names the scope it read, the per-source link counts and the exact rerun
 * command on stderr. stdout keeps the empty result; quiet under --json; never
 * for remote callers (no cross-source existence oracle).
 */
async function hintScopedLinkMiss(
  ctx: OperationContext,
  p: Record<string, unknown>,
  requested: string | undefined,
  policy: PageReadPolicy,
  direction: 'out' | 'in',
): Promise<void> {
  if (ctx.remote !== false || requested !== undefined || p.json === true) return;
  const readSources = policy.sourceIds ?? (policy.sourceId !== undefined ? [policy.sourceId] : undefined);
  if (readSources === undefined) return;
  const slug = p.slug as string;
  try {
    const rows = await ctx.engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT p.source_id FROM pages p JOIN sources s ON s.id = p.source_id
       WHERE p.slug = $1 AND p.deleted_at IS NULL AND s.archived IS NOT TRUE
       ORDER BY p.source_id`,
      [slug],
    );
    const counts: Array<{ sourceId: string; count: number }> = [];
    for (const { source_id: sourceId } of rows) {
      if (readSources.includes(sourceId)) continue;
      const opts = { sourceId, excludePrivate: policy.excludePrivate };
      const links = direction === 'out' ? await ctx.engine.getLinks(slug, opts) : await ctx.engine.getBacklinks(slug, opts);
      if (links.length > 0) counts.push({ sourceId, count: links.length });
    }
    if (counts.length === 0) return;
    const command = direction === 'out' ? 'links' : 'backlinks';
    const label = readSources.length === 1 ? `source ${readSources[0]}` : `sources ${readSources.join(', ')}`;
    ctx.logger.warn(
      `[gbrain] ${command}: no ${direction === 'out' ? 'outgoing' : 'incoming'} links for ${slug} in ${label}; ` +
      `found ${counts.map((c) => `${c.count} in source ${c.sourceId}`).join(', ')}. Rerun with:\n` +
      counts.map((c) => `  gbrain ${command} ${slug} --source ${c.sourceId}`).join('\n'),
    );
  } catch { /* the hint is best-effort; the empty result stands */ }
}

const get_links: Operation = {
  name: 'get_links',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'List a page\'s outgoing links (typed edges to other pages). Use when exploring what a page points at; rows carry status and dates, live relationships by default (status: "all" for history, during: "2022" for a period). Pass source_id or all_sources to widen. Needs read scope. On page_not_found: resolve the slug with resolve_slugs.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose outgoing links to list.' },
    link_type: { type: 'string', description: 'Only this type.' },
    ...TEMPORAL_EDGE_PARAMS,
    source_id: LINK_SOURCE_ID_PARAM,
    all_sources: LINK_ALL_SOURCES_PARAM,
  },
  handler: async (ctx, p) => readLinkEdges(ctx, p, 'get_links', 'out'),
  scope: 'read',
  cliHints: { name: 'links', aliases: ['get_links'], positional: ['slug'] },
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Links to a page; group:"page" pages by referrer, newest first.',
  params: {
    slug: { type: 'string', description: 'Page slug.', required: true },
    status: STARTER_STATUS_PARAM,
    as_of: STARTER_AS_OF_PARAM,
    source_id: LINK_SOURCE_ID_PARAM,
    all_sources: LINK_ALL_SOURCES_PARAM,
    type: { type: 'string', description: 'Referrer type.' },
    group: { type: 'string', enum: ['page'], description: 'Per page.' },
    limit: { type: 'number', description: 'Max 500.' },
    cursor: { type: 'string', description: 'Paging.' },
  },
  handler: async (ctx, p) => {
    if (!wantsPagedBacklinks(p)) return readLinkEdges(ctx, p, 'get_backlinks', 'in');
    if (p.group !== undefined) return readBacklinkPage(ctx, p, (await resolveLinkReadScope(ctx, p, 'get_backlinks')).policy);
    const links = await readLinkEdges(ctx, p, 'get_backlinks', 'in');
    return filterBacklinkRows(ctx, p, (await resolveLinkReadScope(ctx, p, 'get_backlinks')).policy, links);
  },
  scope: 'read',
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const list_link_sources: Operation = {
  name: 'list_link_sources',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  // v114 (#1941): the read-side counterpart to link-add/link-rm. Since
  // link_source is now an open kebab provenance (no allowlist), this is how an
  // agent discovers which provenances a brain actually carries.
  description: 'Link provenances in the brain (e.g. markdown, manual) with edge counts.',
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

/**
 * traverse_graph with `hops`: an agent-structured typed chain over the same
 * executor the search planner uses. Returns answers with the evidence edges of
 * each best path and per-hop diagnostics; a chain that finds nothing is a
 * successful result carrying a `relational_chain` notice with the next call.
 */
async function traverseChain(ctx: OperationContext, p: Record<string, unknown>, slug: string) {
  const conflicts = (['depth', 'link_type', 'direction'] as const).filter(k => p[k] !== undefined);
  if (conflicts.length) {
    throw opError('invalid_params', `traverse_graph: hops cannot be combined with ${conflicts.join(', ')}.`,
      `Drop ${conflicts.map(k => paramUse(ctx, k)).join(' and ')}: each hop already names its link type and direction (toward), and the chain length is the number of hops.`);
  }
  const parsed = validateChainHops(p.hops);
  if (!parsed.ok) {
    throw opError('invalid_params', `traverse_graph: ${parsed.path}: ${parsed.problem}.`,
      `Fix ${parsed.path} and retry; omit hops to walk the graph without a chain.`);
  }
  const { policy } = await resolveLinkReadScope(ctx, p, 'traverse_graph');
  const temporal = await resolveEdgeTemporal(ctx, p, 'traverse_graph');
  reportTemporal(ctx, 'traverse_graph', p, temporal, null);
  const anchors = await resolveChainAnchors(ctx.engine, slug, policy);
  const plan: ChainPlan = { hops: parsed.hops, excludeAnchor: false };
  const { rows, diagnostics } = await runRelationalChain(ctx.engine, anchors, plan, temporal.disabled ? policy : { ...policy, temporal });
  const remote = ctx.remote !== false;
  const edge = (e: ChainEvidenceEdge) => ({ ...e, context: presentEdgeContext(e.context, remote) });
  const answers = rows.filter(r => r.role === 'answer');
  const rawHops = p.hops as Array<Record<string, unknown>>;
  const status = diagnostics.status;
  const fix = chainFix(slug, status, rawHops, diagnostics.empty_hop);
  if (status !== 'fired' && fix) ctx.emitNotice?.({ code: 'relational_chain', kind: 'degraded', why: fix.why, fix });
  return {
    anchor: slug,
    answers: answers.map(r => ({ slug: r.slug, source_id: r.source_id, path_count: r.path_count, score: r.score })),
    paths: answers.map(r => ({ nodes: r.best_path.nodes, edges: r.best_path.edges.map(edge) })),
    diagnostics,
  };
}

/** A CLI flag token built at runtime (the flag-registry generator scans literal flag strings per command). */
const cliFlag = (name: string) => `--${name}`;

function chainFix(slug: string, status: string, hops: Array<Record<string, unknown>>, emptyHop?: number): Action | undefined {
  const hopArgs = (hs: Array<Record<string, unknown>>) => hs.flatMap(h => [cliFlag('hop'), `${String(h.link_type)}:${String(h.toward)}`]);
  if (status === 'anchor_not_found') return readFix(`No page "${slug}" is visible in the searched sources; search for the entity to find its exact slug, then retry the chain with that slug.`,
    { argv: ['gbrain', 'search', slug], mcp: { tool: 'search', arguments: { query: slug } } });
  if (status === 'no_edges') return readFix(`"${slug}" has no typed ${String(hops[0]?.link_type)} edges in the needed direction; the relationship may only be written as plain mentions. A depth-1 walk shows what is linked.`,
    { argv: ['gbrain', 'graph-query', slug, cliFlag('depth'), '1'], mcp: { tool: 'traverse_graph', arguments: { slug, depth: 1 } } });
  if (status === 'empty_hop' && emptyHop && emptyHop > 1) {
    const prefix = hops.slice(0, emptyHop - 1);
    return readFix(`Hop ${emptyHop} (${String(hops[emptyHop - 1]?.link_type)}) found no typed edges from the pages hop ${emptyHop - 1} reached; the shorter chain lists those pages so you can inspect them.`,
      { argv: ['gbrain', 'graph-query', slug, ...hopArgs(prefix)], mcp: { tool: 'traverse_graph', arguments: { slug, hops: prefix } } });
  }
  if (status === 'truncated') return readFix('A chain cap was hit (diagnostics.cap_hit names the cap and hop), so lower-ranked answers were dropped; narrow the chain or start from a more specific page for a complete list.',
    { argv: ['gbrain', 'graph-query', slug, ...hopArgs(hops)], mcp: { tool: 'traverse_graph', arguments: { slug, hops } } });
  return undefined;
}

const traverse_graph: Operation = {
  name: 'traverse_graph',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: `Walk the link graph from a page. Remote callers get bidirectional paths at depth ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH} by default.`,
  params: {
    slug: { type: 'string', description: 'Start page slug.', required: true },
    depth: { type: 'number', description: `Max depth (cap ${TRAVERSE_DEPTH_CAP}).` },
    link_type: { type: 'string', description: 'Follow only this link type.' },
    direction: { type: 'string', description: 'Remote default both.', enum: ['in', 'out', 'both'] },
    hops: {
      type: 'array',
      description: '≤3 typed hops, e.g. [{"link_type":"founded","toward":"subject"}]; toward: object|subject.',
      items: { type: 'object', properties: { link_type: { type: 'string' }, toward: { type: 'string' } } },
      fullSurfaceOnly: true,
    },
    source_id: LINK_SOURCE_ID_PARAM,
    all_sources: LINK_ALL_SOURCES_PARAM,
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    if (p.hops !== undefined) return traverseChain(ctx, p, slug);
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
    // #5827: the walk scopes every visited page, so a federated `sourceIds[]`
    // (no-grant remote, or a trusted local unqualified read) walks the
    // federated set in one query; nodes and edges carry their source ids.
    const { policy: readScope } = await resolveLinkReadScope(ctx, p, 'traverse_graph');
    const temporal = await resolveEdgeTemporal(ctx, p, 'traverse_graph');
    const scope = temporal.disabled ? readScope : { ...readScope, temporal };
    reportTemporal(ctx, 'traverse_graph', p, temporal, null);
    // Backward compat: trusted local no-filter callers keep the legacy
    // GraphNode[] shape used by `gbrain graph`. Remote MCP callers need the
    // natural no-filter invocation to surface inbound-only typed edges too,
    // so they default to direction=both and get explicit GraphPath[] edges.
    if (linkType === undefined && requestedDirection === undefined && ctx.remote === false) {
      return ctx.engine.traverseGraph(slug, depth, scope);
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
    return paths;
  },
  scope: 'read',
  cliHints: { name: 'graph', positional: ['slug'] },
};

const WANTED_DEFAULT_LIMIT = 50;
const WANTED_MAX_LIMIT = 100;

const wanted_pages: Operation = {
  name: 'wanted_pages',
  mutating: false,
  writeInference: 'none',
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Link targets that have no page yet, most-referenced first: each was written as a link but its page does not exist, so no edge exists. Use to find entities worth a page (enrichment) or typo links to fix. The edge appears on its own once the page is created.',
  params: {
    source_id: { type: 'string', description: 'Only targets referenced from this source (must be inside your source grant).' },
    limit: { type: 'number', description: `Rows per page (default ${WANTED_DEFAULT_LIMIT}, max ${WANTED_MAX_LIMIT}).` },
    offset: { type: 'number', description: 'Skip the first N targets.' },
    count_only: { type: 'boolean', description: 'Return the total with no rows.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const named = p.source_id === undefined ? undefined : String(p.source_id);
    if (named !== undefined) assertSourceInCallerScope(ctx, named);
    const policy = named !== undefined ? await readPolicyOpts(ctx, { sourceId: named }) : await readPolicyOpts(ctx);
    const limit = p.limit === undefined ? WANTED_DEFAULT_LIMIT : Number(p.limit);
    const offset = p.offset === undefined ? 0 : Number(p.offset);
    const limitOk = Number.isInteger(limit) && limit >= 1 && limit <= WANTED_MAX_LIMIT;
    if (!limitOk || !Number.isInteger(offset) || offset < 0) {
      throw invalidParam(ctx, 'wanted_pages', limitOk ? 'offset' : 'limit',
        `wanted_pages: limit must be 1-${WANTED_MAX_LIMIT} and offset a non-negative integer`,
        limitOk ? { def: wanted_pages.params.offset, example: 0 } : { def: wanted_pages.params.limit, example: WANTED_DEFAULT_LIMIT });
    }
    const { total, rows } = await listWantedPages(ctx.engine, { sourceId: policy.sourceId, sourceIds: policy.sourceIds,
      excludePrivate: policy.excludePrivate, privateFilter: privatePagesFilterFragment,
      limit: p.count_only === true ? 1 : limit, offset });
    const next = offset + limit < total ? offset + limit : null;
    return {
      total, limit, offset, next_offset: p.count_only === true ? null : next,
      targets: p.count_only === true ? [] : rows.map(row => ({ ...row,
        next: row.existing_matches.length
          ? `A page with this name exists (${row.existing_matches[0].slug}); link it by its full slug, e.g. [[${row.existing_matches[0].slug}]].`
          : `Create ${row.target} if it is a real entity (the ${row.referenced_by} linking page(s) gain the edge on the next extraction), or fix the link if it is a typo.` })),
      ...(total === 0 ? { note: 'Every authored link resolves to an existing page.' } : {}),
    };
  },
  cliHints: { name: 'wanted' },
};


// Ops in EXACTLY the canonical `operations` array order.
export const linksOperations: Operation[] = [
  add_link, remove_link, get_links, get_backlinks, list_link_sources, traverse_graph, wanted_pages,
];
