/**
 * The reads of `get_write_attribution` and of attributed `get_versions` (ops/attribution.ts): the write receipts a
 * page, its versions, facts, takes and timeline entries carry, and the request, OAuth client, legacy token and local
 * writer rows that name them. Each function keeps the statement text its call site ran, so PGLite and Postgres answer
 * exactly as before; a Rust brain answers from its store (rust/crates/gbrain-store/src/write_attribution.rs,
 * rust/docs/store/write_attribution.md).
 */
import { ownerOnlyTakeAllowedSql, ownerOnlyTimelineAllowedSql, privateFactFilterForReader } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The ids `readWriteAttributionNames` resolves, one list per joined table; an empty list runs no statement. */
export interface WriteAttributionNameIds {
  requestIds: string[]; oauthClientIds: string[]; legacyTokenIds: string[]; localWriterIds: string[];
}

/** One write request as an attribution names it; `agent_label` is the text of `authority.agentLabel`. */
export interface WriteRequestAttributionRow { id: string; operation: string; completed_at: Date | string | null; agent_label: string | null }

/** The rows behind each name list: requests, OAuth clients, legacy tokens and local writers (revoked ones included). */
export interface WriteAttributionNames {
  requests: WriteRequestAttributionRow[];
  clients: Array<{ id: string; name: string }>;
  tokens: Array<{ id: string; name: string }>;
  writers: Array<{ id: string; lane: string }>;
}

/** The live revision of a page with the actor that wrote it, its trust tier and write origin. */
export interface PageRevisionAttributionRow {
  revision: string; req: string | null; kind: string | null; pid: string | null; trust_tier: string | null; write_origin: unknown;
}

/** One version snapshot's writer (`w_*`), archiving writer (`a_*`) and trust tier. */
export interface VersionAttributionRow {
  id: number; w_req: string | null; w_kind: string | null; w_id: string | null;
  a_req: string | null; a_kind: string | null; a_id: string | null; trust_tier: string | null;
}

/** A write receipt as `(request id, principal kind, principal id)`. */
export interface ActorAttributionRow { req: string | null; kind: string | null; pid: string | null }

/** A version to attribute: its id and the page it snapshots (the Rust store keys versions by page). */
export interface VersionRef { id: number; page_id: number }

/**
 * The fact, take or timeline entry `readRowAttribution` picks. A fact matches on the page's source and slug (entity or
 * fenced source page); `worldOnly` keeps world facts only and `excludePrivate` applies the reader's private-fact
 * filter. A take matches on page and row number, inside `holders` when given. A take or timeline row under `excludePrivate` also
 * drops one whose own recorded inputs reach owner-only data (GST-3032; the caller's page is tested apart).
 */
export type RowAttributionTarget =
  | { kind: 'fact'; id: number; sourceId: string; slug: string; worldOnly: boolean; excludePrivate: boolean }
  | { kind: 'take'; pageId: number; rowNum: number; holders?: string[]; excludePrivate?: boolean }
  | { kind: 'timeline'; id: number; pageId: number; excludePrivate?: boolean };

/** A row's creating (`w_*`, `created_at`) and last (`l_*`, `last_written_at`) write receipts, tier and origin. */
export interface RowAttributionRow {
  id: number; w_req: string | null; w_kind: string | null; w_id: string | null; created_at: Date | string | null;
  l_req: string | null; l_kind: string | null; l_id: string | null; last_written_at: Date | string | null;
  trust_tier: string | null; write_origin: unknown;
}

/** The rows that name each attribution: one statement per joined table, whatever the input size. */
export async function readWriteAttributionNames(exec: LegacyUnscopedRead, ids: WriteAttributionNameIds): Promise<WriteAttributionNames> {
  const [requests, clients, tokens, writers] = await Promise.all([
    ids.requestIds.length ? exec.executeRaw<WriteRequestAttributionRow>(
      "SELECT id::text AS id, operation, completed_at, authority->>'agentLabel' AS agent_label FROM persistence_requests WHERE id = ANY($1::uuid[])", [ids.requestIds]) : [],
    ids.oauthClientIds.length ? exec.executeRaw<{ id: string; name: string }>(
      'SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE client_id = ANY($1::text[])', [ids.oauthClientIds]) : [],
    ids.legacyTokenIds.length ? exec.executeRaw<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM access_tokens WHERE id::text = ANY($1::text[])', [ids.legacyTokenIds]) : [],
    ids.localWriterIds.length ? exec.executeRaw<{ id: string; lane: string }>(
      'SELECT id::text AS id, lane FROM persistence_local_writers WHERE id::text = ANY($1::text[])', [ids.localWriterIds]) : [],
  ]);
  return { requests, clients, tokens, writers };
}

/** The live revision attribution of page `pageId`, or null. */
export async function readPageRevisionAttribution(exec: LegacyUnscopedRead, pageId: number): Promise<PageRevisionAttributionRow | null> {
  const [live] = await exec.executeRaw<PageRevisionAttributionRow>(
    `SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS req, revision_principal_kind AS kind, revision_principal_id AS pid,
              trust_tier, write_origin FROM pages WHERE id = $1`, [pageId]);
  return live ?? null;
}

/** The attribution of each listed version that exists; the SQL engines match on id alone. */
export function readVersionAttributions(exec: LegacyUnscopedRead, versions: VersionRef[]): Promise<VersionAttributionRow[]> {
  if (!versions.length) return Promise.resolve([]);
  return exec.executeRaw<VersionAttributionRow>(
    `SELECT id, write_request_id::text AS w_req, write_principal_kind AS w_kind, write_principal_id AS w_id,
            archived_write_request_id::text AS a_req, archived_principal_kind AS a_kind, archived_principal_id AS a_id, trust_tier
       FROM page_versions WHERE id = ANY($1::int[])`, [versions.map(v => v.id)]);
}

/** The writer of page `pageId`'s oldest snapshot (snapshot time, then id), or null when it has none. */
export async function readOldestVersionAttribution(exec: LegacyUnscopedRead, pageId: number): Promise<ActorAttributionRow | null> {
  const [oldest] = await exec.executeRaw<ActorAttributionRow>(
    `SELECT write_request_id::text AS req, write_principal_kind AS kind, write_principal_id AS pid
           FROM page_versions WHERE page_id = $1 ORDER BY snapshot_at, id LIMIT 1`, [pageId]);
  return oldest ?? null;
}

const ROW_COLS = `write_request_id::text AS w_req, write_principal_kind AS w_kind, write_principal_id AS w_id, created_at,
    last_write_request_id::text AS l_req, last_write_principal_kind AS l_kind, last_write_principal_id AS l_id, last_written_at,
    trust_tier, write_origin`;

/** The statement and parameters of `target`: every filter runs in the statement, before the row is picked. */
export function rowAttributionStatement(target: RowAttributionTarget): { sql: string; params: unknown[] } {
  const cols = trustedSql(ROW_COLS);
  let fragment;
  if (target.kind === 'fact') {
    const worldOnly = trustedSql(target.worldOnly ? "AND visibility = 'world'" : '');
    const excludePrivate = trustedSql(target.excludePrivate ? `AND ${privateFactFilterForReader('facts')}` : '');
    fragment = sqlFragment`SELECT id, ${cols} FROM facts WHERE id = ${target.id} AND source_id = ${target.sourceId}
        AND (entity_slug = ${target.slug} OR source_markdown_slug = ${target.slug}) ${worldOnly} ${excludePrivate}`;
  } else if (target.kind === 'take') {
    const holders = target.holders ? sqlFragment`AND holder = ANY(${target.holders}::text[])` : sqlFragment``;
    fragment = sqlFragment`SELECT id, ${cols} FROM takes WHERE page_id = ${target.pageId} AND row_num = ${target.rowNum} ${holders}${trustedSql(target.excludePrivate ? ownerOnlyTakeAllowedSql('takes') : '')}`;
  } else {
    fragment = sqlFragment`SELECT id, ${cols} FROM timeline_entries WHERE id = ${target.id} AND page_id = ${target.pageId}${trustedSql(target.excludePrivate ? ownerOnlyTimelineAllowedSql('timeline_entries') : '')}`;
  }
  const { text, params } = renderFragment(fragment);
  return { sql: text, params };
}

/** The attributed row `target` names, or null when none is visible. */
export async function readRowAttribution(exec: LegacyUnscopedRead, target: RowAttributionTarget): Promise<RowAttributionRow | null> {
  const { sql, params } = rowAttributionStatement(target);
  const [found] = await exec.executeRaw<RowAttributionRow>(sql, params);
  return found ?? null;
}
