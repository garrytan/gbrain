/**
 * Write attribution reads (Foundations 1, F1b). The attribution columns store
 * only a (request id, principal kind, principal id) snapshot per row; this
 * module joins the request's operation and time and the principal's current
 * name at read time, so identity is never duplicated into content tables.
 *
 * `get_write_attribution` is admin-scoped. Remote admin callers stay inside
 * their source grant (`readPolicyOpts`), see only `world` facts and only the
 * take holders their grant allows, like every other remote read.
 * Never import from '../operations.ts' here (cycle).
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteAttributionView } from '../types.ts';
import type { PageVersionMetadata } from '../page-state/version-types.ts';
import { hasScope } from '../scope.ts';
import { opError, type Operation, type OperationContext } from './contract.ts';
import type { McpCall } from '../agent-output.ts';
import { opTransport, paramUse, readFix } from './op-fix.ts';
import { readHolders, readPolicyOpts } from './context.ts';
import { storedTrustTier, type TrustTier, type WriteOrigin } from '../trust/tier.ts';
import { worldOnlyFacts } from '../search/private-visibility.ts';
import type { RowAttributionTarget } from '../engine-sql/write-attribution.ts';

const DOCS = 'docs/mcp/ADMIN.md#write-attribution';

interface StoredAttribution {
  request_id: string | null;
  principal_kind: string | null;
  principal_id: string | null;
  /** The row's own timestamp for this write, used when no request records one. */
  at?: Date | string | null;
}

interface StoredTrust { trust_tier: string | null; write_origin: unknown }
/** jsonb reads back as an object on both engines; a text-shaped value (a driver path that hands jsonb back undecoded) is parsed. */
function originObject(value: unknown): WriteOrigin | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as WriteOrigin; } catch { return null; } }
  return typeof value === 'object' ? value as WriteOrigin : null;
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Trusted local callers and `admin` holders see who wrote what; plain readers never do. */
export function canReadWriteAttribution(ctx: OperationContext): boolean {
  return ctx.remote === false || hasScope(ctx.auth?.scopes ?? [], 'admin');
}

/** Resolve stored snapshots to views: one query per joined table, whatever the input size. */
export async function resolveWriteAttributions(engine: BrainEngine, stored: StoredAttribution[]): Promise<WriteAttributionView[]> {
  const ids = (kind: string) => [...new Set(stored.filter(s => s.principal_kind === kind && s.principal_id).map(s => s.principal_id!))];
  const requestIds = [...new Set(stored.map(s => s.request_id).filter((id): id is string => !!id))];
  const localIds = [...ids('local_cli'), ...ids('local_stdio')];
  const { requests, clients, tokens, writers } = await engine.readWriteAttributionNames({
    requestIds, oauthClientIds: ids('oauth_client'), legacyTokenIds: ids('legacy_token'), localWriterIds: localIds,
  });
  const requestById = new Map(requests.map(r => [r.id, r]));
  const names = new Map<string, string>([
    ...clients.map(c => [`oauth_client:${c.id}`, c.name] as const),
    ...tokens.map(t => [`legacy_token:${t.id}`, t.name] as const),
    ...writers.map(w => [`local_${w.lane}:${w.id}`, `local ${w.lane} writer`] as const),
  ]);
  return stored.map(s => {
    if (!s.request_id && !s.principal_kind) return { request_id: null, operation: null, principal: null, at: null, origin: 'unrecorded' };
    const request = s.request_id ? requestById.get(s.request_id) : undefined;
    return {
      request_id: s.request_id,
      operation: request?.operation ?? null,
      principal: s.principal_kind && s.principal_id
        ? { kind: s.principal_kind, id: s.principal_id, name: names.get(`${s.principal_kind}:${s.principal_id}`) ?? null } : null,
      at: iso(request?.completed_at ?? s.at),
      ...(request?.agent_label ? { agent_label: request.agent_label } : {}),
      origin: s.request_id ? 'request' : 'maintenance',
    };
  });
}

/** `get_versions` for trusted and admin callers: each snapshot with its origin and archiving writer. */
export async function attributeVersions<V extends PageVersionMetadata>(
  engine: BrainEngine, versions: V[],
): Promise<Array<V & { written_by: WriteAttributionView; archived_by: WriteAttributionView; trust_tier: TrustTier }>> {
  if (!versions.length) return [];
  const rows = await engine.readVersionAttributions(versions.map(v => ({ id: Number(v.id), page_id: Number(v.page_id) })));
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const stored = versions.flatMap(v => {
    const r = byId.get(Number(v.id));
    return [
      { request_id: r?.w_req ?? null, principal_kind: r?.w_kind ?? null, principal_id: r?.w_id ?? null },
      { request_id: r?.a_req ?? null, principal_kind: r?.a_kind ?? null, principal_id: r?.a_id ?? null, at: v.snapshot_at },
    ];
  });
  const views = await resolveWriteAttributions(engine, stored);
  // ENG-10: a legacy snapshot (taken before tiers) reads as unknown.
  return versions.map((v, i) => ({ ...v, written_by: views[2 * i], archived_by: views[2 * i + 1], trust_tier: storedTrustTier(byId.get(Number(v.id))?.trust_tier) }));
}

const SLUG = /^[a-z0-9][a-z0-9/_.-]{0,254}$/i;

const paramName = (ctx: OperationContext, param: string) => (opTransport(ctx) === 'cli' ? paramUse(ctx, param) : param);

function positiveInt(ctx: OperationContext, value: unknown, param: 'fact' | 'take' | 'timeline'): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    const name = paramName(ctx, param);
    throw opError('invalid_params', `${name} must be a positive integer, got '${String(value)}'.`,
      `Pass ${name} as a row id from the page, for example ${paramUse(ctx, param, 1)}.`, { docs: DOCS });
  }
  return n;
}

function attributionCall(slug: string, row: { fact?: number; take?: number; timeline?: number }) {
  const [key, id] = Object.entries(row).find(([, v]) => v !== undefined) as ['fact' | 'take' | 'timeline', number];
  return readFix(`Attributes the ${key} you named on its own.`, {
    argv: ['gbrain', 'attribution', slug, `--${key}`, String(id)],
    mcp: { tool: 'get_write_attribution', arguments: { slug, [key]: id } },
  });
}

type RowTarget = { kind: 'fact' | 'take' | 'timeline_entry'; label: string; target: RowAttributionTarget; list: McpCall };

const get_write_attribution: Operation = {
  name: 'get_write_attribution',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Admin read: who created and who last changed a page, or one of its facts, takes or timeline entries. '
    + 'Each attribution names the request id, operation, principal (kind, id, current name), time and origin '
    + '(request, maintenance or unrecorded), plus the row\'s trust_tier and write_origin (for derived rows, the inputs that set the tier). '
    + 'Remote callers stay inside their source grant and see only world facts, except credentials bound to the brain owner.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to attribute (or the page that holds the fact, take or timeline entry).' },
    fact: { type: 'number', minimum: 1, description: 'Attribute this fact id (a fact about or fenced on the page) instead of the page.' },
    take: { type: 'number', minimum: 1, description: 'Attribute the take at this row number of the page\'s takes table.' },
    timeline: { type: 'number', minimum: 1, description: 'Attribute this timeline entry id of the page.' },
    versions: { type: 'boolean', description: 'Also list every version snapshot with who wrote and who archived it.' },
  },
  scope: 'admin',
  localOnly: false,
  cliHints: { name: 'attribution', positional: ['slug'] },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fact = positiveInt(ctx, p.fact, 'fact');
    const take = positiveInt(ctx, p.take, 'take');
    const timeline = positiveInt(ctx, p.timeline, 'timeline');
    if ([fact, take, timeline].filter(v => v !== undefined).length > 1) {
      throw opError('invalid_params', `Pass at most one of ${paramName(ctx, 'fact')}, ${paramName(ctx, 'take')} or ${paramName(ctx, 'timeline')}.`,
        'Make one call per row; fix attributes the first row you named.',
        { docs: DOCS, ...(SLUG.test(slug) ? { fix: attributionCall(slug, { fact, take, timeline }) } : {}) });
    }
    const policy = await readPolicyOpts(ctx);
    const page = await ctx.engine.getPage(slug, policy);
    if (!page?.id) {
      throw opError('page_not_found', `No page '${slug}' is visible to this caller.`,
        'Find the exact slug by searching (fix), then call again with it. Pages outside your source grant read as missing.',
        { docs: DOCS, ...(SLUG.test(slug) ? { fix: readFix('Searches for pages near the slug you passed.', { argv: ['gbrain', 'search', slug], mcp: { tool: 'search', arguments: { query: slug } } }) } : {}) });
    }
    const sourceId = page.source_id ?? 'default';
    const live = await ctx.engine.readPageRevisionAttribution(page.id);
    const liveStored: StoredAttribution = { request_id: live?.req ?? null, principal_kind: live?.kind ?? null, principal_id: live?.pid ?? null };

    let target: Record<string, unknown> = { kind: 'page', slug: page.slug, source_id: sourceId, page_id: page.id };
    let created: StoredAttribution;
    let last: StoredAttribution;
    let trust: StoredTrust = { trust_tier: live?.trust_tier ?? null, write_origin: live?.write_origin ?? null };
    const row = rowTarget(ctx, page.id, page.slug, sourceId, { fact, take, timeline }, policy.excludePrivate === true);
    if (row) {
      const found = await ctx.engine.readRowAttribution(row.target);
      if (!found) {
        throw opError(row.kind === 'fact' ? 'fact_not_found' : 'not_found', `No ${row.label} is visible on page '${page.slug}'.`,
          'List the page\'s rows (fix), then call again with an id from that list.', {
            docs: DOCS,
            fix: readFix(`Lists the ${row.kind === 'timeline_entry' ? 'timeline entries' : `${row.kind}s`} on page '${page.slug}' with their ids.`,
              { argv: ['gbrain', 'call', '--source', sourceId, row.list.tool, JSON.stringify(row.list.arguments)], mcp: row.list }),
          });
      }
      target = { kind: row.kind, id: Number(found.id), ...(row.kind === 'take' ? { row_num: take } : {}), slug: page.slug, source_id: sourceId, page_id: page.id };
      created = { request_id: found.w_req, principal_kind: found.w_kind, principal_id: found.w_id, at: found.created_at };
      last = { request_id: found.l_req, principal_kind: found.l_kind, principal_id: found.l_id, at: found.last_written_at };
      trust = { trust_tier: found.trust_tier, write_origin: found.write_origin };
    } else {
      const oldest = await ctx.engine.readOldestVersionAttribution(page.id);
      created = oldest ? { request_id: oldest.req, principal_kind: oldest.kind, principal_id: oldest.pid } : liveStored;
      last = liveStored;
    }
    const [createdView, lastView, liveView] = await resolveWriteAttributions(ctx.engine, [created, last, liveStored]);
    const versions = p.versions === true
      ? (await attributeVersions(ctx.engine, (await ctx.engine.getVersions(page.slug, policy)).filter(v => Number(v.page_id) === Number(page.id))))
        .map(v => ({ id: v.id, knowledge_revision: v.knowledge_revision ?? null, snapshot_at: iso(v.snapshot_at), trust_tier: v.trust_tier, written_by: v.written_by, archived_by: v.archived_by }))
      : undefined;
    return {
      target, created: createdView, last: lastView,
      // CEO-1: the stored tier and its origin record (for a derived row, a bounded sample of the inputs that set it).
      trust_tier: storedTrustTier(trust.trust_tier), write_origin: originObject(trust.write_origin),
      live_revision: { knowledge_revision: live?.revision ?? null, written_by: liveView },
      ...(versions ? { versions } : {}),
    };
  },
};

function rowTarget(ctx: OperationContext, pageId: number, slug: string, sourceId: string,
  ids: { fact?: number; take?: number; timeline?: number }, excludePrivate: boolean): RowTarget | undefined {
  if (ids.fact !== undefined) {
    return { kind: 'fact', label: `fact #${ids.fact}`, list: { tool: 'recall', arguments: { entity: slug } },
      target: { kind: 'fact', id: ids.fact, sourceId, slug, worldOnly: worldOnlyFacts(ctx.remote), excludePrivate } };
  }
  if (ids.take !== undefined) {
    const holders = readHolders(ctx);
    return { kind: 'take', label: `take at row ${ids.take}`, list: { tool: 'takes_list', arguments: { page_slug: slug } },
      target: { kind: 'take', pageId, rowNum: ids.take, excludePrivate, ...(holders ? { holders } : {}) } };
  }
  if (ids.timeline !== undefined) {
    return { kind: 'timeline_entry', label: `timeline entry #${ids.timeline}`, list: { tool: 'get_timeline', arguments: { slug } },
      target: { kind: 'timeline', id: ids.timeline, pageId, excludePrivate } };
  }
  return undefined;
}

export const attributionOperations: Operation[] = [get_write_attribution];
