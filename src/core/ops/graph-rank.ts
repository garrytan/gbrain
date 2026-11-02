/**
 * #7168: `rank_entities` — graph aggregates without hand-written SQL over
 * `links`. Agents asked "who are the most connected people" by grouping link
 * rows themselves, and one owner's duplicate pages took the top rows. This op
 * ranks pages by inbound, outbound or total edges with one aggregate
 * statement (engine-sql/graph-rank.ts holds the counting and folding rules),
 * folds redirect stubs into their live target, flags title-prefixed person
 * duplicates without merging them, and says when link extraction is behind.
 *
 * get_backlinks answers "who links to this page" for one page and
 * find_experts ranks pages for a topic; neither ranks the whole graph.
 */
import { opError, type Operation, type OperationContext } from './contract.ts';
import { invalidParam } from './op-fix.ts';
import { assertSourceInCallerScope, linkReadScopeOpts, resolveRequestedScope, sourceScopeOpts } from './context.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { NON_RANKING_LINK_TYPES } from '../link-ranking-policy.ts';
import { rankEntitiesStatement, type RankDirection, type RankEntityRow } from '../engine-sql/graph-rank.ts';
import type { EntityTypeFilter } from '../schema-pack/entity-types.ts';

export const RANK_ENTITIES_DEFAULT_LIMIT = 20;
export const RANK_ENTITIES_MAX_LIMIT = 100;
export const RANK_ENTITIES_MAX_TYPES = 20;
/** Statement deadline (Postgres; PGLite has no statement timeout). */
export const RANK_ENTITIES_STATEMENT_MS = 15_000;
/** Folded slugs listed per row; folded_total counts them all. */
export const RANK_ENTITIES_FOLDED_CAP = 10;
/** Top rows checked for title-prefixed person duplicates, and the wall-clock budget for those checks. */
export const RANK_ENTITIES_DUPLICATE_ROWS = 10;
const DUPLICATE_BUDGET_MS = 3_000;
/** Above this many sources in scope, coverage is not read. */
const COVERAGE_SOURCE_CAP = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const DIRECTIONS = ['in', 'out', 'both'] as const;

interface PossibleDuplicate { slug: string; title: string; reason: string }

interface RankedEntity {
  slug: string;
  title: string;
  type: string | null;
  source_id: string;
  inbound: number;
  outbound: number;
  neighbors: number;
  folded?: Array<{ slug: string; reason: string }>;
  folded_total?: number;
  possible_duplicates?: PossibleDuplicate[];
}

type Coverage =
  | { state: 'current' | 'behind'; total?: number; actionable?: number; attendance_blocked?: number; held?: number; mention_due?: number | null }
  | { state: 'unread'; reason: 'too_many_sources' | 'read_failed' };

function parseParams(ctx: OperationContext, p: Record<string, unknown>) {
  const bad = (param: string, message: string, example: unknown, choices?: readonly string[]) =>
    invalidParam(ctx, 'rank_entities', param, `rank_entities: ${message}`, { def: rank_entities.params[param], example, ...(choices ? { choices } : {}) });
  const direction = p.direction ?? 'in';
  if (!DIRECTIONS.includes(direction as RankDirection)) throw bad('direction', "direction must be 'in', 'out' or 'both'", 'in', DIRECTIONS);
  let types: string[] | undefined;
  if (p.types !== undefined) {
    const ok = Array.isArray(p.types) && p.types.length >= 1 && p.types.length <= RANK_ENTITIES_MAX_TYPES
      && p.types.every(t => typeof t === 'string' && NAME.test(t));
    if (!ok) throw bad('types', `types must be a list of 1-${RANK_ENTITIES_MAX_TYPES} page type names (letters, digits, _ . : / -)`, ['person']);
    types = [...new Set(p.types as string[])].sort();
  }
  const linkType = p.link_type;
  if (linkType !== undefined && (typeof linkType !== 'string' || !NAME.test(linkType))) {
    throw bad('link_type', 'link_type must be one link type name (letters, digits, _ . : / -)', 'works_at');
  }
  if (typeof linkType === 'string' && NON_RANKING_LINK_TYPES.includes(linkType)) {
    throw bad('link_type', `link type '${linkType}' takes no part in ranking (link-ranking-policy); read it with get_links or get_backlinks`, 'works_at');
  }
  if (p.include_mentions !== undefined && typeof p.include_mentions !== 'boolean') throw bad('include_mentions', 'include_mentions must be true or false', true);
  const limit = p.limit ?? RANK_ENTITIES_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RANK_ENTITIES_MAX_LIMIT) {
    throw bad('limit', `limit must be an integer from 1 to ${RANK_ENTITIES_MAX_LIMIT}`, RANK_ENTITIES_DEFAULT_LIMIT);
  }
  const sourceId = p.source_id;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || sourceId.trim() === '')) throw bad('source_id', 'source_id must be a source id', 'default');
  return { direction: direction as RankDirection, types, linkType: linkType as string | undefined, includeMentions: p.include_mentions === true, limit, sourceId: sourceId as string | undefined };
}

/** Both endpoints of every counted edge stay inside this list; undefined is brain-wide. Remote scalar scopes are promoted (linkReadScopeOpts). */
function rankScope(ctx: OperationContext, named: string | undefined): string[] | undefined {
  let scope: { sourceId?: string; sourceIds?: string[] };
  if (named === ALL_SOURCES) scope = resolveRequestedScope(ctx, named);
  else if (named !== undefined) {
    assertSourceInCallerScope(ctx, named);
    scope = { sourceId: named };
  } else scope = sourceScopeOpts(ctx);
  scope = linkReadScopeOpts(ctx, scope);
  if (scope.sourceIds?.length) return [...new Set(scope.sourceIds)].sort();
  return scope.sourceId ? [scope.sourceId] : undefined;
}

function typesFor(filter: EntityTypeFilter, sourceId: string): string[] {
  return filter.per_source.find(s => s.source_id === sourceId)?.types ?? filter.types;
}

function parseFolded(value: unknown): Array<{ slug: string; reason: string }> {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(list) ? list.map(f => ({ slug: String(f.slug), reason: String(f.reason) })) : [];
}

async function readCoverage(ctx: OperationContext, sourceIds: string[] | undefined, includeMentions: boolean, excludePrivate: boolean): Promise<Coverage> {
  const targets: Array<string | undefined> = sourceIds ?? [undefined];
  if (targets.length > COVERAGE_SOURCE_CAP) return { state: 'unread', reason: 'too_many_sources' };
  if (ctx.remote !== false) return readRemoteCoverage(ctx, sourceIds, includeMentions, excludePrivate);
  const { readExtractionLag } = await import('../extraction-lag.ts');
  const sum = { total: 0, actionable: 0, attendance_blocked: 0, held: 0, mention_due: null as number | null };
  try {
    for (const sourceId of targets) {
      const lag = await readExtractionLag(ctx.engine, sourceId ? { sourceId } : {});
      sum.total += lag.total;
      sum.actionable += lag.actionable;
      sum.attendance_blocked += lag.attendance_blocked;
      sum.held += lag.held ?? 0;
      if (lag.mention_due !== null) sum.mention_due = (sum.mention_due ?? 0) + lag.mention_due;
    }
  } catch {
    return { state: 'unread', reason: 'read_failed' };
  }
  return { state: sum.actionable > 0 || (includeMentions && (sum.mention_due ?? 0) > 0) ? 'behind' : 'current', ...sum };
}

/** A remote caller's state alone, computed over the pages it may read: a page it cannot see never makes coverage behind. */
async function readRemoteCoverage(ctx: OperationContext, sourceIds: string[] | undefined, includeMentions: boolean, excludePrivate: boolean): Promise<Coverage> {
  const { effectiveLinkExtractorWatermark } = await import('../link-extraction-watermark.ts');
  const { linkableTypesFor, loadSourcePack, readMentionPolicy } = await import('../mentions/policy.ts');
  const { rankCoverageStatement } = await import('../engine-sql/graph-rank.ts');
  try {
    const versionTs = await effectiveLinkExtractorWatermark(ctx.engine);
    const policy = includeMentions ? await readMentionPolicy(ctx.engine) : null;
    const ids = sourceIds ?? (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map(r => r.id);
    if (ids.length > COVERAGE_SOURCE_CAP) return { state: 'unread', reason: 'too_many_sources' };
    for (const sourceId of ids) {
      const mentionTypes = policy?.enabled ? linkableTypesFor(await loadSourcePack(ctx.engine, sourceId), policy) : undefined;
      const { text, params } = rankCoverageStatement({ sourceId, excludePrivate, versionTs, ...(mentionTypes ? { mentionTypes } : {}) });
      const [row] = await ctx.engine.executeRaw<{ link_behind: boolean; mention_due: boolean }>(text, params, { timeoutMs: 10_000 });
      if (row?.link_behind || row?.mention_due) return { state: 'behind' };
    }
  } catch {
    return { state: 'unread', reason: 'read_failed' };
  }
  return { state: 'current' };
}

async function attachDuplicates(ctx: OperationContext, rows: RankedEntity[], filter: EntityTypeFilter, excludePrivate: boolean): Promise<number> {
  const { nameVariantsEnabled, readPossibleDuplicates } = await import('../verbs/entity-variants.ts');
  if (!(await nameVariantsEnabled(ctx.engine))) return 0;
  const { privatePagesFilterForCaller } = await import('../search/private-visibility.ts');
  const deadline = Date.now() + DUPLICATE_BUDGET_MS;
  let checked = 0;
  for (const row of rows.slice(0, RANK_ENTITIES_DUPLICATE_ROWS)) {
    if (Date.now() > deadline) break;
    checked++;
    const duplicates = await readPossibleDuplicates(ctx.engine, row.source_id, { slug: row.slug, title: row.title, type: row.type, frontmatter: null }, {
      selectColumns: 'slug, title, type, frontmatter',
      entityTypes: new Set(typesFor(filter, row.source_id)),
      omitQuarantined: ctx.remote !== false,
      privatePredicate: excludePrivate ? ` AND ${privatePagesFilterForCaller('pages')}` : '',
      retirementPrivacy: excludePrivate ? ` AND ${privatePagesFilterForCaller('p')}` : '',
    });
    if (duplicates.length) row.possible_duplicates = duplicates;
  }
  return checked;
}

const rank_entities: Operation = {
  name: 'rank_entities',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  scope: 'read',
  description: 'Rank pages by graph connections: the most-linked people, companies or other entities. Use instead of counting link rows yourself. '
    + 'An edge is a distinct (from page, to page, link_type) between live pages in scope: self-links, links to deleted pages, non-ranking types (amends) and, unless include_mentions, mention rows do not count; several provenance rows for one edge count once. '
    + 'inbound/outbound count edges, neighbors counts distinct linked pages. A redirect stub (canonical: false, superseded_by, merged_into) is folded into its live target in the same source (listed under folded) and its edges count once; '
    + 'title-prefixed person duplicates are listed under possible_duplicates, never merged. Ties order by slug, then source_id. coverage.state is behind when link extraction lags, so counts cover only extracted pages.',
  params: {
    direction: { type: 'string', enum: [...DIRECTIONS], description: "Rank by 'in' (inbound edges, default), 'out' (outbound edges) or 'both' (inbound + outbound)." },
    types: { type: 'array', items: { type: 'string' }, description: "Page types to rank, e.g. ['person']. Default: the schema pack's entity types." },
    source_id: { type: 'string', description: "Only this source (it must be inside your source grant); '__all__' spans every source you can read. Both ends of a counted edge stay in scope." },
    link_type: { type: 'string', description: 'Count only edges of this link type, e.g. works_at.' },
    include_mentions: { type: 'boolean', description: 'Also count mention links (link_source mentions); default false.' },
    limit: { type: 'number', description: `Rows to return (default ${RANK_ENTITIES_DEFAULT_LIMIT}, max ${RANK_ENTITIES_MAX_LIMIT}).` },
  },
  handler: async (ctx, p) => {
    const params = parseParams(ctx, p);
    const sourceIds = rankScope(ctx, params.sourceId);
    const { resolveEntityTypes } = await import('../schema-pack/entity-types.ts');
    const resolution = params.types
      ? { status: 'explicit' as const, filter: { types: params.types, per_source: [] } }
      : await resolveEntityTypes(ctx.engine, sourceIds ?? null);
    const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const { text, params: values } = rankEntitiesStatement({
      direction: params.direction,
      types: resolution.filter,
      ...(sourceIds ? { sourceIds } : {}),
      ...(params.linkType !== undefined ? { linkType: params.linkType } : {}),
      includeMentions: params.includeMentions,
      limit: params.limit,
      foldedCap: RANK_ENTITIES_FOLDED_CAP,
      ...(ctx.remote !== false ? { remote: { excludePrivate } } : {}),
    });
    let raw: RankEntityRow[];
    try {
      raw = await ctx.engine.executeRaw<RankEntityRow>(text, values, { timeoutMs: RANK_ENTITIES_STATEMENT_MS });
    } catch (e) {
      const { isStatementTimeoutError } = await import('../retry-matcher.ts');
      if (!isStatementTimeoutError(e)) throw e;
      throw opError('rank_entities_timeout', `rank_entities: the ranking did not finish within ${RANK_ENTITIES_STATEMENT_MS / 1000} s`,
        'Narrow the ranking: pass source_id, types (e.g. ["person"]) or link_type, then call rank_entities again.');
    }
    const entities: RankedEntity[] = raw.map(r => {
      const folded = Number(r.folded_total) > 0 ? { folded: parseFolded(r.folded), folded_total: Number(r.folded_total) } : {};
      return { slug: r.slug, title: r.title ?? r.slug, type: r.type, source_id: r.source_id,
        inbound: Number(r.inbound), outbound: Number(r.outbound), neighbors: Number(r.neighbors), ...folded };
    });
    const duplicatesChecked = await attachDuplicates(ctx, entities, resolution.filter, excludePrivate);
    const coverage = await readCoverage(ctx, sourceIds, params.includeMentions, excludePrivate);
    const notes: string[] = [];
    if (resolution.status === 'pack_unavailable') notes.push('The schema pack did not load, so no entity types are known: pass types explicitly, e.g. ["person"].');
    if (coverage.state === 'behind') notes.push('Link extraction is behind: counts cover only pages whose links are extracted (the brain host runs gbrain extract --stale to catch up).');
    if (coverage.state === 'unread') notes.push('Link-extraction coverage was not read, so counts may cover only part of the brain.');
    return {
      direction: params.direction,
      ranked_by: params.direction === 'in' ? 'inbound' : params.direction === 'out' ? 'outbound' : 'inbound+outbound',
      types: params.types ?? 'schema_pack_entity_types',
      types_status: resolution.status,
      ...(params.linkType !== undefined ? { link_type: params.linkType } : {}),
      include_mentions: params.includeMentions,
      limit: params.limit,
      entities,
      duplicates_checked: duplicatesChecked,
      coverage,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  },
  cliHints: { name: 'rank-entities' },
};

export const graphRankOperations: Operation[] = [rank_entities];
