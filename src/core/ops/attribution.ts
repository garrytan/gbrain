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
import type { AttributedPageVersion, PageVersion, WriteAttributionView } from '../types.ts';
import { hasScope } from '../scope.ts';
import { opError, type Operation, type OperationContext } from './contract.ts';
import type { McpCall } from '../agent-output.ts';
import { opTransport, paramUse, readFix } from './op-fix.ts';
import { readHolders, readPolicyOpts } from './context.ts';

const DOCS = 'docs/mcp/ADMIN.md#write-attribution';

interface StoredAttribution {
  request_id: string | null;
  principal_kind: string | null;
  principal_id: string | null;
  /** The row's own timestamp for this write, used when no request records one. */
  at?: Date | string | null;
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
  const [requests, clients, tokens, writers] = await Promise.all([
    requestIds.length ? engine.executeRaw<{ id: string; operation: string; completed_at: Date | string | null }>(
      'SELECT id::text AS id, operation, completed_at FROM persistence_requests WHERE id = ANY($1::uuid[])', [requestIds]) : [],
    ids('oauth_client').length ? engine.executeRaw<{ id: string; name: string }>(
      'SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE client_id = ANY($1::text[])', [ids('oauth_client')]) : [],
    ids('legacy_token').length ? engine.executeRaw<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM access_tokens WHERE id::text = ANY($1::text[])', [ids('legacy_token')]) : [],
    localIds.length ? engine.executeRaw<{ id: string; lane: string }>(
      'SELECT id::text AS id, lane FROM persistence_local_writers WHERE id::text = ANY($1::text[])', [localIds]) : [],
  ]);
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
      origin: s.request_id ? 'request' : 'maintenance',
    };
  });
}

/** `get_versions` for trusted and admin callers: each snapshot with its origin and archiving writer. */
export async function attributeVersions(engine: BrainEngine, versions: PageVersion[]): Promise<AttributedPageVersion[]> {
  if (!versions.length) return [];
  const rows = await engine.executeRaw<{ id: number; w_req: string | null; w_kind: string | null; w_id: string | null;
    a_req: string | null; a_kind: string | null; a_id: string | null }>(
    `SELECT id, write_request_id::text AS w_req, write_principal_kind AS w_kind, write_principal_id AS w_id,
            archived_write_request_id::text AS a_req, archived_principal_kind AS a_kind, archived_principal_id AS a_id
       FROM page_versions WHERE id = ANY($1::int[])`, [versions.map(v => v.id)]);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const stored = versions.flatMap(v => {
    const r = byId.get(Number(v.id));
    return [
      { request_id: r?.w_req ?? null, principal_kind: r?.w_kind ?? null, principal_id: r?.w_id ?? null },
      { request_id: r?.a_req ?? null, principal_kind: r?.a_kind ?? null, principal_id: r?.a_id ?? null, at: v.snapshot_at },
    ];
  });
  const views = await resolveWriteAttributions(engine, stored);
  return versions.map((v, i) => ({ ...v, written_by: views[2 * i], archived_by: views[2 * i + 1] }));
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

type RowTarget = { kind: 'fact' | 'take' | 'timeline_entry'; label: string; sql: string; params: unknown[]; list: McpCall };

const get_write_attribution: Operation = {
  name: 'get_write_attribution',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Admin read: who created and who last changed a page, or one of its facts, takes or timeline entries. '
    + 'Each attribution names the request id, operation, principal (kind, id, current name), time and origin '
    + '(request, maintenance or unrecorded). Remote callers stay inside their source grant and see only world facts.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to attribute (or the page that holds the fact, take or timeline entry).' },
    fact: { type: 'number', description: 'Attribute this fact id (a fact about or fenced on the page) instead of the page.' },
    take: { type: 'number', description: 'Attribute the take at this row number of the page\'s takes table.' },
    timeline: { type: 'number', description: 'Attribute this timeline entry id of the page.' },
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
    const [live] = await ctx.engine.executeRaw<{ revision: string; req: string | null; kind: string | null; pid: string | null }>(
      `SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS req, revision_principal_kind AS kind, revision_principal_id AS pid
         FROM pages WHERE id = $1`, [page.id]);
    const liveStored: StoredAttribution = { request_id: live?.req ?? null, principal_kind: live?.kind ?? null, principal_id: live?.pid ?? null };

    let target: Record<string, unknown> = { kind: 'page', slug: page.slug, source_id: sourceId, page_id: page.id };
    let created: StoredAttribution;
    let last: StoredAttribution;
    const row = rowTarget(ctx, page.id, page.slug, sourceId, { fact, take, timeline });
    if (row) {
      const [found] = await ctx.engine.executeRaw<{ id: number; w_req: string | null; w_kind: string | null; w_id: string | null; created_at: Date | string | null;
        l_req: string | null; l_kind: string | null; l_id: string | null; last_written_at: Date | string | null }>(row.sql, row.params);
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
    } else {
      const [oldest] = await ctx.engine.executeRaw<{ req: string | null; kind: string | null; pid: string | null }>(
        `SELECT write_request_id::text AS req, write_principal_kind AS kind, write_principal_id AS pid
           FROM page_versions WHERE page_id = $1 ORDER BY snapshot_at, id LIMIT 1`, [page.id]);
      created = oldest ? { request_id: oldest.req, principal_kind: oldest.kind, principal_id: oldest.pid } : liveStored;
      last = liveStored;
    }
    const [createdView, lastView, liveView] = await resolveWriteAttributions(ctx.engine, [created, last, liveStored]);
    const versions = p.versions === true
      ? (await attributeVersions(ctx.engine, (await ctx.engine.getVersions(page.slug, policy)).filter(v => Number(v.page_id) === Number(page.id))))
        .map(v => ({ id: v.id, knowledge_revision: v.knowledge_revision ?? null, snapshot_at: iso(v.snapshot_at), written_by: v.written_by, archived_by: v.archived_by }))
      : undefined;
    return {
      target, created: createdView, last: lastView,
      live_revision: { knowledge_revision: live?.revision ?? null, written_by: liveView },
      ...(versions ? { versions } : {}),
    };
  },
};

function rowTarget(ctx: OperationContext, pageId: number, slug: string, sourceId: string,
  ids: { fact?: number; take?: number; timeline?: number }): RowTarget | undefined {
  const cols = `write_request_id::text AS w_req, write_principal_kind AS w_kind, write_principal_id AS w_id, created_at,
    last_write_request_id::text AS l_req, last_write_principal_kind AS l_kind, last_write_principal_id AS l_id, last_written_at`;
  if (ids.fact !== undefined) {
    return { kind: 'fact', label: `fact #${ids.fact}`, list: { tool: 'recall', arguments: { entity: slug } },
      sql: `SELECT id, ${cols} FROM facts WHERE id = $1 AND source_id = $2 AND (entity_slug = $3 OR source_markdown_slug = $3)
        ${ctx.remote === false ? '' : "AND visibility = 'world'"}`, params: [ids.fact, sourceId, slug] };
  }
  if (ids.take !== undefined) {
    const holders = readHolders(ctx);
    return { kind: 'take', label: `take at row ${ids.take}`, list: { tool: 'takes_list', arguments: { page_slug: slug } },
      sql: `SELECT id, ${cols} FROM takes WHERE page_id = $1 AND row_num = $2 ${holders ? 'AND holder = ANY($3::text[])' : ''}`,
      params: holders ? [pageId, ids.take, holders] : [pageId, ids.take] };
  }
  if (ids.timeline !== undefined) {
    return { kind: 'timeline_entry', label: `timeline entry #${ids.timeline}`, list: { tool: 'get_timeline', arguments: { slug } },
      sql: `SELECT id, ${cols} FROM timeline_entries WHERE id = $1 AND page_id = $2`, params: [ids.timeline, pageId] };
  }
  return undefined;
}

export const attributionOperations: Operation[] = [get_write_attribution];
