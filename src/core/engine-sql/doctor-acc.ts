/**
 * Doctor reads, second set: the statements `gbrain doctor` checks of the access, token, OAuth, request-log, decide,
 * memory-proposal, chronicle, feedback, belief and volunteer families ran through `executeRaw`, each with the same
 * text and parameters on the engine's own `executeRaw`; only their home moved (src/commands/doctor/**, src/core/**).
 * The Rust engine answers them from what its store keeps (rust/docs/store/cli-reads-doctor-acc.md): a relation the
 * store has no writer for answers as an empty one does.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { isMissingSchemaObject } from '../utils.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

export { DOCTOR_ACC_MEMBERS } from './doctor-acc-members.ts';

export type Row = Record<string, unknown>;

/** Every source that holds folder access state, by id. */
export async function listPolicySourceIds(raw: EngineRawRead): Promise<string[]> {
  return (await raw<{ source_id: string }>('SELECT source_id FROM access_policy_state ORDER BY source_id COLLATE "C"')).map(r => r.source_id);
}

/** Whether the database role cannot read the folder access tables (row-level security hides them). */
export async function isAccessStateUnreadable(raw: EngineRawRead): Promise<boolean> {
  const [row] = await raw<{ unreadable: boolean }>('SELECT gbrain_access_state_unreadable() AS unreadable');
  return Boolean(row?.unreadable);
}

export interface RawOnlyRuleRow { source_id: string; rule_id: string; prefix: string }

/** Folder and page rules that keep their pages to their readers but not the pages derived from them. */
export function listRawOnlyRules(raw: EngineRawRead): Promise<RawOnlyRuleRow[]> {
  return raw<RawOnlyRuleRow>('SELECT source_id, rule_id, prefix FROM access_rules WHERE NOT covers_derived ORDER BY source_id, rule_id');
}

/** Enabled members marked as an audience, by id. */
export async function listAudienceMemberIds(raw: EngineRawRead): Promise<string[]> {
  return (await raw<{ id: string }>(
    "SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE \"C\"")).map(r => r.id);
}

/** Enabled members that carry the labelled-only grant, by id. */
export async function listLabelledOnlyMemberIds(raw: EngineRawRead): Promise<string[]> {
  return (await raw<{ id: string }>(
    'SELECT id FROM access_members WHERE labelled_only AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id')).map(r => r.id);
}

const LIST_MEMBERS_SQL = `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id`;
const LIST_LIVE_MEMBERS_SQL = `SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`;

/** Every member row with its groups, removed members only when asked. */
export function listAccessMemberRows(raw: EngineRawRead, includeRemoved: boolean): Promise<Row[]> {
  return raw<Row>(includeRemoved ? LIST_MEMBERS_SQL : LIST_LIVE_MEMBERS_SQL);
}

export interface AttestCredentialRow { kind: 'token' | 'client'; id: string; name: string; row: Row | string }

/** Active tokens and live OAuth clients that carry an attest actor, as JSON rows (a client's secret hash left out). */
export function listAttestCredentialRows(raw: EngineRawRead): Promise<AttestCredentialRow[]> {
  return raw<AttestCredentialRow>(
    `SELECT * FROM (
       SELECT 'token' AS kind, t.id::text AS id, t.name, to_jsonb(t) AS row FROM access_tokens t
        WHERE t.revoked_at IS NULL AND to_jsonb(t)->>'attest_actor' IS NOT NULL
       UNION ALL
       SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row FROM oauth_clients c
        WHERE (to_jsonb(c)->>'deleted_at') IS NULL AND to_jsonb(c)->>'attest_actor' IS NOT NULL
       ) u ORDER BY kind COLLATE "C", name COLLATE "C"`);
}

/** Active (not revoked) API tokens, oldest first. */
export function listActiveAccessTokenRows(raw: EngineRawRead): Promise<Row[]> {
  return raw<Row>('SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at, id');
}

/** OAuth clients not deleted, by id. */
export function listActiveOauthClientRows(raw: EngineRawRead): Promise<Row[]> {
  return raw<Row>('SELECT * FROM oauth_clients WHERE deleted_at IS NULL ORDER BY client_id COLLATE "C"');
}

export interface OauthClientAuthShape { client_id: string; method: string | null; hash: string | null }

/** Every OAuth client's id, auth method and secret hash. */
export function listOauthClientAuthShapes(raw: EngineRawRead): Promise<OauthClientAuthShape[]> {
  return raw<OauthClientAuthShape>(
    `SELECT client_id,
              token_endpoint_auth_method AS method,
              client_secret_hash AS hash
         FROM oauth_clients`);
}

export interface DanglingFederatedRead { client_id: string; client_name: string | null; grant_id: string }

/** Federated read grants of live clients that name no source. */
export function listDanglingFederatedReads(raw: EngineRawRead): Promise<DanglingFederatedRead[]> {
  return raw<DanglingFederatedRead>(
    `SELECT c.client_id, c.client_name, g.grant_id
         FROM oauth_clients c
         CROSS JOIN LATERAL unnest(c.federated_read) AS g(grant_id)
         LEFT JOIN sources s ON s.id = g.grant_id
        WHERE s.id IS NULL AND c.deleted_at IS NULL
        ORDER BY c.client_id COLLATE "C", g.grant_id COLLATE "C"`);
}

const ORPHAN_WORKSPACE_FACTS_SQL = `SELECT s.id
         FROM sources s
        WHERE s.id LIKE '%' || $1
          AND s.local_path IS NULL
          AND COALESCE(s.archived, false) = false
          AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = s.id)
          AND NOT EXISTS (
            SELECT 1 FROM oauth_clients c
             WHERE c.deleted_at IS NULL
               AND (c.source_id = s.id OR s.id = ANY(c.federated_read))
          )
        ORDER BY s.id COLLATE "C"`;
const ORPHAN_WORKSPACE_SQL = `SELECT s.id
         FROM sources s
        WHERE s.id LIKE '%' || $1
          AND s.local_path IS NULL
          AND COALESCE(s.archived, false) = false
          AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id)
          AND NOT EXISTS (
            SELECT 1 FROM oauth_clients c
             WHERE c.deleted_at IS NULL
               AND (c.source_id = s.id OR s.id = ANY(c.federated_read))
          )
        ORDER BY s.id COLLATE "C"`;

/**
 * Derived-workspace sources (id ending in `suffix`) with no path, no pages, no facts, not archived and no live client
 * naming them. A brain from before the facts table (a source cannot hold facts it has no table for) answers without
 * the facts exclusion.
 */
export async function listOrphanWorkspaceSources(raw: EngineRawRead, suffix: string): Promise<Array<{ id: string }>> {
  try {
    return await raw<{ id: string }>(ORPHAN_WORKSPACE_FACTS_SQL, [suffix]);
  } catch (error) {
    if (!isMissingSchemaObject(error, 'table', 'facts')) throw error;
    return raw<{ id: string }>(ORPHAN_WORKSPACE_SQL, [suffix]);
  }
}

export interface PrivilegedDcrClient { client_id: string; client_name: string | null; scope: string }

/**
 * Live clients whose scope matches `scopeRegex` with grant revision 0 and no `register` audit row (the anonymous
 * self-registration signature). A brain without the audit table or the revision column answers `null`: the signature
 * cannot be evaluated there.
 */
export async function listPrivilegedDcrClients(raw: EngineRawRead, scopeRegex: string): Promise<PrivilegedDcrClient[] | null> {
  try {
    return await raw<PrivilegedDcrClient>(
      `SELECT c.client_id, c.client_name, c.scope
           FROM oauth_clients c
          WHERE c.deleted_at IS NULL
            AND COALESCE(c.grant_revision, 0) = 0
            AND COALESCE(c.scope, '') ~ $1
            AND NOT EXISTS (
              SELECT 1 FROM oauth_grant_audit a
               WHERE a.client_id = c.client_id AND a.action = 'register'
            )
          ORDER BY c.client_id COLLATE "C"`,
      [scopeRegex]);
  } catch (error) {
    if (!(isMissingSchemaObject(error, 'table', 'oauth_grant_audit') || isMissingSchemaObject(error, 'column', 'grant_revision'))) throw error;
    return null;
  }
}

/** The request log's total relation size in bytes (the engine's own measure of what the log occupies). */
export async function readMcpRequestLogBytes(raw: EngineRawRead): Promise<number> {
  const [size] = await raw<{ bytes: string }>("SELECT pg_total_relation_size('mcp_request_log')::text AS bytes");
  return Number(size?.bytes ?? 0);
}

/** The request log's row count: the planner's estimate on Postgres, a count bounded to `limit` rows elsewhere. */
export async function countMcpRequestLogRows(raw: EngineRawRead, kind: 'postgres' | 'pglite', limit: number): Promise<number> {
  const [count] = kind === 'postgres'
    ? await raw<{ rows: string }>("SELECT GREATEST(reltuples, 0)::bigint::text AS rows FROM pg_class WHERE oid = to_regclass('mcp_request_log')")
    : await raw<{ rows: string }>('SELECT count(*)::text AS rows FROM (SELECT 1 FROM mcp_request_log LIMIT $1) t', [limit]);
  return Number(count?.rows ?? 0);
}

/** Whether a request older than `days` days that retention would delete (its operation not in `keepOperations`) is waiting. */
export async function hasMcpLogRowsPastWindow(raw: EngineRawRead, days: number, keepOperations: readonly string[]): Promise<boolean> {
  const [pending] = await raw<{ waiting: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM mcp_request_log WHERE created_at < now() - ($1::int * interval '1 day') AND operation <> ALL($2::text[])) AS waiting`,
    [days, [...keepOperations]]);
  return pending?.waiting === true;
}

/** `pages.knowledge_revision`: null when the column is absent, else whether it is NOT NULL (the revision backfill finished). */
export async function readKnowledgeRevisionNotNull(raw: EngineRawRead): Promise<boolean | null> {
  const column = await raw<{ notnull: boolean }>(
    `SELECT attnotnull AS notnull FROM pg_attribute
      WHERE attrelid = to_regclass('pages') AND attname = 'knowledge_revision' AND NOT attisdropped`);
  return column.length === 0 ? null : Boolean(column[0]!.notnull);
}

export type DriftSchema = 'current' | 'pre_attribution' | 'pre_trust';

async function columnsOf(raw: EngineRawRead, table: string): Promise<Set<string>> {
  const rows = await raw<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = ANY(current_schemas(false))', [table]);
  return new Set(rows.map(row => row.column_name));
}

/** Whether this brain has the columns the provenance scan reads: trust tiers, then write attribution. */
export async function readDriftSchema(raw: EngineRawRead): Promise<DriftSchema> {
  const pages = await columnsOf(raw, 'pages');
  if (!pages.has('trust_tier')) return 'pre_trust';
  const versions = await columnsOf(raw, 'page_versions');
  return pages.has('revision_write_request_id') && versions.has('archived_write_request_id') ? 'current' : 'pre_attribution';
}

export interface DriftLiveRow {
  id: number | string; slug: string; trust_tier: string | null; frontmatter: Row | string | null; revision: string;
  source_kind: string | null; ingested_via: string | null; ingested_at: string | Date | null; req: string | null; kind: string | null; remote: string | null;
}
export interface DriftVersionRow { page_id: number | string; frontmatter: Row | string | null; req: string | null; kind: string | null; remote: string | null }

const LIVE_ATTRIBUTED_SQL = `SELECT p.id, p.slug, p.trust_tier, p.frontmatter, p.knowledge_revision::text AS revision, p.source_kind, p.ingested_via, p.ingested_at,
            p.revision_write_request_id::text AS req, p.revision_principal_kind AS kind, r.authority->>'remote' AS remote
       FROM pages p LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $2
      ORDER BY p.id LIMIT 500`;
const LIVE_ATTRIBUTED_SLUG_SQL = `SELECT p.id, p.slug, p.trust_tier, p.frontmatter, p.knowledge_revision::text AS revision, p.source_kind, p.ingested_via, p.ingested_at,
            p.revision_write_request_id::text AS req, p.revision_principal_kind AS kind, r.authority->>'remote' AS remote
       FROM pages p LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = $2
      ORDER BY p.id LIMIT 500`;
const LIVE_PLAIN_SQL = `SELECT p.id, p.slug, p.trust_tier, p.frontmatter, p.knowledge_revision::text AS revision, p.source_kind, p.ingested_via, p.ingested_at,
            NULL::text AS req, NULL::text AS kind, NULL::text AS remote
       FROM pages p 
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.id > $2
      ORDER BY p.id LIMIT 500`;
const LIVE_PLAIN_SLUG_SQL = `SELECT p.id, p.slug, p.trust_tier, p.frontmatter, p.knowledge_revision::text AS revision, p.source_kind, p.ingested_via, p.ingested_at,
            NULL::text AS req, NULL::text AS kind, NULL::text AS remote
       FROM pages p 
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = $2
      ORDER BY p.id LIMIT 500`;

/** The page-batch size of the live read: `DRIFT_BATCH` in src/core/trust/provenance-drift.ts, pinned by test/doctor-acc-sql.test.ts. */
export const DRIFT_BATCH = 500;

/** One batch of a source's live pages after page id `at.after`, or the page at `at.slug`, with the writer of its revision. */
export function listDriftLiveRows(raw: EngineRawRead, schema: DriftSchema, sourceId: string, at: { after?: number; slug?: string }): Promise<DriftLiveRow[]> {
  const attributed = schema === 'current';
  const bySlug = at.slug !== undefined;
  const sql = attributed ? (bySlug ? LIVE_ATTRIBUTED_SLUG_SQL : LIVE_ATTRIBUTED_SQL) : (bySlug ? LIVE_PLAIN_SLUG_SQL : LIVE_PLAIN_SQL);
  return raw<DriftLiveRow>(sql, [sourceId, at.slug ?? at.after ?? 0]);
}

const VERSIONS_ATTRIBUTED_SQL = `SELECT v.page_id, v.frontmatter,
            v.archived_write_request_id::text AS req, v.archived_principal_kind AS kind, r.authority->>'remote' AS remote
       FROM page_versions v LEFT JOIN persistence_requests r ON r.id = v.archived_write_request_id
      WHERE v.page_id = ANY($1::int[]) ORDER BY v.page_id, v.id`;
const VERSIONS_PLAIN_SQL = `SELECT v.page_id, v.frontmatter,
            NULL::text AS req, NULL::text AS kind, NULL::text AS remote
       FROM page_versions v 
      WHERE v.page_id = ANY($1::int[]) ORDER BY v.page_id, v.id`;

/** The versions of the given pages, oldest first, with the writer of each. */
export function listDriftVersionRows(raw: EngineRawRead, schema: DriftSchema, pageIds: number[]): Promise<DriftVersionRow[]> {
  return raw<DriftVersionRow>(schema === 'current' ? VERSIONS_ATTRIBUTED_SQL : VERSIONS_PLAIN_SQL, [pageIds]);
}

/** Whether the index `name` exists (a non-Postgres engine; Postgres also reads whether it is valid). */
export async function originIndexPresent(raw: EngineRawRead, name: string): Promise<boolean> {
  const [row] = await raw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
  return Boolean(row?.present);
}

/** Decide calibrations (`slot` null for every slot), retired ones only with `includeRetired`. */
export function listDecideCalibrationRows(raw: EngineRawRead, slot: string | null, includeRetired: boolean): Promise<Row[]> {
  return raw<Row>(
    `SELECT * FROM decide_calibrations
      WHERE ($1::text IS NULL OR slot = $1) AND ($2::boolean OR retired_at IS NULL)
      ORDER BY slot COLLATE "C", created_at DESC, id DESC`,
    [slot, includeRetired]);
}

/** Resolved models of the receipts in the trailing window, newest first. */
export function listRecentResolvedModels(raw: EngineRawRead, sinceHours: number): Promise<Row[]> {
  return raw<Row>(
    `SELECT slot, provider, model_resolved, COUNT(*)::int AS n, MAX(created_at) AS last_at FROM decision_receipts
      WHERE model_resolved IS NOT NULL AND created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot, provider, model_resolved ORDER BY MAX(created_at) DESC`,
    [sinceHours]);
}

/** Decisions per slot whose rows failed on mixed resolved models, in the trailing window. */
export function listMixedModelDecisions(raw: EngineRawRead, sinceHours: number): Promise<Row[]> {
  return raw<Row>(
    `SELECT slot, COUNT(*)::int AS n FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND error_reason = 'mixed_model'
      GROUP BY slot`,
    [sinceHours]);
}

/** Per-slot decision counts, tokens, errors and egress refusals in the trailing window. */
export function listDecideSlotUsage(raw: EngineRawRead, sinceHours: number): Promise<Row[]> {
  return raw<Row>(
    `SELECT slot, COUNT(DISTINCT decision_id)::int AS decisions, COUNT(*)::int AS rows,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END)::int AS errors,
            SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END)::int AS skipped,
            SUM(CASE WHEN error_reason LIKE 'egress%' OR error_reason IN ('denied_source','missing_provenance') THEN 1 ELSE 0 END)::int AS egress
       FROM decision_receipts WHERE created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot ORDER BY slot COLLATE "C"`,
    [sinceHours]);
}

/** Spend of TypeSafe providers since `sinceIso` (an ISO timestamp), in total and from remote callers. */
export async function readDecideDailySpend(raw: EngineRawRead, sinceIso: string): Promise<{ total: number; remote: number }> {
  const rows = await raw<{ total: number | string | null; remote: number | string | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COALESCE(SUM(CASE WHEN remote THEN cost_usd ELSE 0 END), 0) AS remote
       FROM decide_spend WHERE created_at >= $1::timestamptz AND provider LIKE 'typesafe:%'`,
    [sinceIso]);
  return { total: Number(rows[0]?.total ?? 0), remote: Number(rows[0]?.remote ?? 0) };
}

/** Receipt counts and latency per slot, mode, outcome and error reason in the trailing window (`slot` null for every slot). */
export function listDecideReceiptStats(raw: EngineRawRead, sinceHours: number, slot: string | null): Promise<Row[]> {
  return raw<Row>(
    `SELECT slot, mode, outcome, error_reason, COUNT(*)::int AS n, AVG(answer_value)::float8 AS avg_value,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p50_latency,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95_latency,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens
       FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND ($2::text IS NULL OR slot = $2)
      GROUP BY slot, mode, outcome, error_reason ORDER BY slot COLLATE "C", mode COLLATE "C", outcome COLLATE "C", error_reason COLLATE "C"`,
    [sinceHours, slot]);
}

/** Life Chronicle ledger rollups (automatic rows only). `available` is false when the ledger tables are absent. */
export interface ChronicleLedgerStats {
  available: boolean;
  pending: number;
  autoCalls24h: number;
  principals24h: Array<{ principal: string; calls: number }>;
  last7d: { extracted: number; failed: number; skipped: number; reasons: Record<string, number>; failedReasons: Record<string, number> };
  spend7d: { knownUsd: number; unpricedCalls: number; incompleteRecords: number };
}

export const EMPTY_CHRONICLE_LEDGER_STATS: ChronicleLedgerStats = {
  available: false, pending: 0, autoCalls24h: 0, principals24h: [],
  last7d: { extracted: 0, failed: 0, skipped: 0, reasons: {}, failedReasons: {} },
  spend7d: { knownUsd: 0, unpricedCalls: 0, incompleteRecords: 0 },
};

/** The ledger as an empty one reads: tables present, nothing recorded. */
export const AVAILABLE_CHRONICLE_LEDGER_STATS: ChronicleLedgerStats = { ...EMPTY_CHRONICLE_LEDGER_STATS, available: true };

export async function readChronicleLedgerStats(raw: EngineRawRead): Promise<ChronicleLedgerStats> {
  try {
    const [counts] = await raw<{ pending: number; extracted: number; failed: number; skipped: number;
      known_usd: number | null; unpriced: number; incomplete: number }>(
      `SELECT
         count(*) FILTER (WHERE state = 'pending')::int AS pending,
         count(*) FILTER (WHERE state = 'extracted' AND updated_at > now() - interval '7 days')::int AS extracted,
         count(*) FILTER (WHERE state = 'failed' AND updated_at > now() - interval '7 days')::int AS failed,
         count(*) FILTER (WHERE state = 'skipped' AND updated_at > now() - interval '7 days')::int AS skipped,
         sum(cost_usd) FILTER (WHERE NOT unpriced AND updated_at > now() - interval '7 days')::float8 AS known_usd,
         count(*) FILTER (WHERE unpriced AND state IN ('extracted','failed') AND updated_at > now() - interval '7 days')::int AS unpriced,
         count(*) FILTER (WHERE NOT unpriced AND cost_usd IS NULL AND state IN ('extracted','failed') AND attempts > 0
           AND updated_at > now() - interval '7 days')::int AS incomplete
       FROM chronicle_page_state WHERE trigger = 'auto'`);
    const reasons = await raw<{ state: string; reason: string; n: number }>(
      `SELECT state, reason, count(*)::int AS n FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('skipped','failed') AND reason IS NOT NULL AND updated_at > now() - interval '7 days'
       GROUP BY state, reason ORDER BY n DESC, reason COLLATE "C"`);
    const tally = (rows: typeof reasons) => rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + Number(r.n);
      return acc;
    }, {});
    // One reservation row per automatic judge call (retries included): the daily limit's own count.
    const [calls] = await raw<{ n: number }>(
      `SELECT count(*)::int AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'`);
    const principals = await raw<{ principal: string; calls: number }>(
      `SELECT (coalesce(l.principal_kind, 'unattributed') || coalesce(':' || l.principal_id, '')) COLLATE "C" AS principal, count(*)::int AS calls
       FROM chronicle_judge_reservations r
       LEFT JOIN chronicle_page_state l ON l.source_id = r.source_id AND l.page_id = r.page_id
         AND l.content_hash = r.content_hash AND l.trigger = 'auto'
       WHERE r.reserved_at > now() - interval '24 hours'
       GROUP BY 1 ORDER BY calls DESC, principal LIMIT 5`);
    return {
      available: true,
      pending: Number(counts?.pending ?? 0),
      autoCalls24h: Number(calls?.n ?? 0),
      principals24h: principals.map((p) => ({ principal: p.principal, calls: Number(p.calls) })),
      last7d: { extracted: Number(counts?.extracted ?? 0), failed: Number(counts?.failed ?? 0), skipped: Number(counts?.skipped ?? 0),
        reasons: tally(reasons), failedReasons: tally(reasons.filter((r) => r.state === 'failed')) },
      spend7d: { knownUsd: Number(counts?.known_usd ?? 0), unpricedCalls: Number(counts?.unpriced ?? 0),
        incompleteRecords: Number(counts?.incomplete ?? 0) },
    };
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', ['chronicle_page_state', 'chronicle_judge_reservations'])) return EMPTY_CHRONICLE_LEDGER_STATS;
    throw error;
  }
}

export interface ChronicleDuplicateEvents { pages: number; surplus: number }

/** Depth pages holding live events a newer extraction did not produce, and how many such events (#8972). */
export async function readChronicleDuplicateEvents(raw: EngineRawRead): Promise<ChronicleDuplicateEvents> {
  try {
    const [row] = await raw<{ pages: number; surplus: number }>(
      `WITH multi AS (
         SELECT source_id, page_id FROM chronicle_page_state WHERE cardinality(event_slugs) > 0 GROUP BY source_id, page_id HAVING count(*) > 1),
       newest AS (
         SELECT DISTINCT ON (c.source_id, c.page_id) c.source_id, c.page_id, c.event_slugs
           FROM chronicle_page_state c JOIN multi m ON m.source_id = c.source_id AND m.page_id = c.page_id
          WHERE c.state = 'extracted' ORDER BY c.source_id, c.page_id, c.decided_at DESC, c.updated_at DESC),
       live AS (
         SELECT DISTINCT c.source_id, c.page_id, e.slug
           FROM chronicle_page_state c JOIN multi m ON m.source_id = c.source_id AND m.page_id = c.page_id
           CROSS JOIN LATERAL unnest(c.event_slugs) AS s(slug)
           JOIN pages e ON e.source_id = c.source_id AND e.slug = s.slug AND e.deleted_at IS NULL AND e.content_hash = ANY(c.event_hashes))
       SELECT count(DISTINCT l.source_id || ':' || l.page_id)::int AS pages, count(*)::int AS surplus
         FROM live l LEFT JOIN newest n ON n.source_id = l.source_id AND n.page_id = l.page_id
        WHERE n.event_slugs IS NULL OR NOT (l.slug = ANY(n.event_slugs))`);
    return { pages: Number(row?.pages ?? 0), surplus: Number(row?.surplus ?? 0) };
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', ['chronicle_page_state'])) return { pages: 0, surplus: 0 };
    throw error;
  }
}

export interface FeedbackStatusRow {
  events: number; ratings_explicit: number; ratings_cited: number; weights_total: number; weights_off_neutral: number;
  last_rating_at: Date | null; top_client_share_7d: number | null;
  lowest: Array<{ source_id: string; slug: string; weight: number; low_ratings: number }>;
  highest: Array<{ source_id: string; slug: string; weight: number }>;
}

/** Retrieval feedback counts, the last rating time, the busiest client's share and the ten lowest and highest page weights. */
export async function readFeedbackStatus(raw: EngineRawRead): Promise<FeedbackStatusRow> {
  const [counts] = await raw<Record<string, number | string | Date | null>>(
    `SELECT
       (SELECT count(*)::int FROM retrieval_events) AS events,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'explicit') AS ratings_explicit,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'cited') AS ratings_cited,
       (SELECT count(*)::int FROM retrieval_weights) AS weights_total,
       (SELECT count(*)::int FROM retrieval_weights WHERE abs(weight - 0.5) > 0.01) AS weights_off_neutral,
       (SELECT max(applied_at) FROM retrieval_feedback) AS last_rating_at,
       (SELECT max(n)::float / NULLIF(sum(n), 0) FROM (
          SELECT count(*) AS n FROM retrieval_feedback
           WHERE signal = 'explicit' AND applied_at > now() - interval '7 days'
           GROUP BY client_id) c) AS top_client_share_7d`);
  const lowest = await raw<{ source_id: string; slug: string; weight: number | string; low_ratings: number | string }>(
    `SELECT w.source_id, w.element_key AS slug, w.weight,
            (SELECT count(*) FROM retrieval_feedback f
              WHERE f.element_kind = 'page' AND f.source_id = w.source_id
                AND f.element_key = w.element_key AND f.rating <= 2)::int AS low_ratings
       FROM retrieval_weights w
      WHERE w.element_kind = 'page' AND w.weight < 0.5
      ORDER BY w.weight ASC, w.source_id COLLATE "C", w.element_key COLLATE "C" LIMIT 10`);
  const highest = await raw<{ source_id: string; slug: string; weight: number | string }>(
    `SELECT source_id, element_key AS slug, weight FROM retrieval_weights
      WHERE element_kind = 'page' AND weight > 0.5
      ORDER BY weight DESC, source_id COLLATE "C", element_key COLLATE "C" LIMIT 10`);
  return {
    events: Number(counts?.events ?? 0),
    ratings_explicit: Number(counts?.ratings_explicit ?? 0),
    ratings_cited: Number(counts?.ratings_cited ?? 0),
    weights_total: Number(counts?.weights_total ?? 0),
    weights_off_neutral: Number(counts?.weights_off_neutral ?? 0),
    last_rating_at: counts?.last_rating_at ? new Date(counts.last_rating_at as string) : null,
    top_client_share_7d: counts?.top_client_share_7d == null ? null : Number(counts.top_client_share_7d),
    lowest: lowest.map(r => ({ ...r, weight: Number(r.weight), low_ratings: Number(r.low_ratings) })),
    highest: highest.map(r => ({ ...r, weight: Number(r.weight) })),
  };
}

/** Sources with a coverage event (`subject_key = coverageKey`) in their current incarnation, by id. */
export async function listBeliefCoveredSources(raw: EngineRawRead, coverageKey: string): Promise<string[]> {
  const rows = await raw<{ id: string }>(`SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM belief_events e
    WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $1 AND e.source_incarnation = s.incarnation) ORDER BY s.id COLLATE "C"`, [coverageKey]);
  return rows.map(r => r.id);
}

export interface VolunteerChannelRow { channel: string; n: string | number; last_fired: string | Date | null }

const VOLUNTEER_SCOPED_SQL = `SELECT channel, count(*)::int AS n, max(volunteered_at) AS last_fired
             FROM context_volunteer_events
            WHERE source_id = ANY($1::text[])
              AND volunteered_at > now() - interval '7 days'
            GROUP BY channel
            ORDER BY channel COLLATE "C"`;
const VOLUNTEER_ALL_SQL = `SELECT channel, count(*)::int AS n, max(volunteered_at) AS last_fired
             FROM context_volunteer_events
            WHERE volunteered_at > now() - interval '7 days'
            GROUP BY channel
            ORDER BY channel COLLATE "C"`;

/** Context-volunteer events of the last 7 days per channel; `sourceIds` null reads the whole brain. */
export function listVolunteerChannels(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<VolunteerChannelRow[]> {
  return sourceIds === null ? raw<VolunteerChannelRow>(VOLUNTEER_ALL_SQL) : raw<VolunteerChannelRow>(VOLUNTEER_SCOPED_SQL, [sourceIds]);
}

// ---- pages that name readers (the member-access checks) -----------------------------------------------------------

export interface MalformedReaderPageRow { source_id: string; slug: string; total: number }
export interface UnknownReaderRow { reader: string; kind: 'unknown' | 'retired' | 'empty_group'; pages: number; sample: { source_id: string; slug: string } }
export interface ReaderNarrowingRow { source_id: string; slug: string; readers: string[]; writer: string | null; updated_at: string; total: number }

/** Live pages whose `readable_by` normalizes to nobody, by source then slug in byte order (the first `limit`), each with the total. */
export function listMalformedReaderPages(raw: EngineRawRead, limit: number): Promise<MalformedReaderPageRow[]> {
  return raw<MalformedReaderPageRow>(
    `SELECT source_id, slug, count(*) OVER ()::int AS total FROM pages
      WHERE deleted_at IS NULL AND frontmatter->'readable_by' IS NOT NULL AND gbrain_access_readers(frontmatter) = ARRAY['!nobody']::text[]
      ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT $1`, [limit]);
}

/**
 * The readers pages name that match no live member or no group (or a group with no member), each with its page count and the
 * first page naming it, by kind then reader in byte order (the first `limit`).
 */
export function listUnknownReaders(raw: EngineRawRead, limit: number): Promise<UnknownReaderRow[]> {
  return raw<UnknownReaderRow>(
    `WITH named AS (
       SELECT p.source_id, p.slug, r AS reader FROM pages p, unnest(gbrain_access_readers(p.frontmatter)) AS r
        WHERE p.deleted_at IS NULL AND p.frontmatter->'readable_by' IS NOT NULL AND r <> '!nobody'),
     classified AS (
       SELECT n.*, CASE
         WHEN n.reader LIKE 'member:%' THEN (SELECT CASE WHEN m.id IS NULL THEN 'unknown' WHEN m.tombstoned_at IS NOT NULL THEN 'retired' END
           FROM (SELECT 1) one LEFT JOIN access_members m ON m.id = substr(n.reader, 8))
         ELSE (SELECT CASE WHEN g.id IS NULL THEN 'unknown' WHEN NOT EXISTS (SELECT 1 FROM access_group_members gm WHERE gm.group_id = g.id) THEN 'empty_group' END
           FROM (SELECT 1) one LEFT JOIN access_groups g ON g.id = substr(n.reader, 7)) END AS kind
       FROM named n)
     SELECT reader, kind, count(*)::int AS pages, (array_agg(jsonb_build_object('source_id', source_id, 'slug', slug) ORDER BY source_id COLLATE "C", slug COLLATE "C"))[1] AS sample
       FROM classified WHERE kind IS NOT NULL GROUP BY reader, kind ORDER BY kind COLLATE "C", reader COLLATE "C" LIMIT $1`, [limit]);
}

/**
 * Live pages written in the last `days` days that name readers where the newest earlier version named none, newest first
 * (a tie by page id, the first `limit`), each with the total and the principal that wrote the revision.
 */
export function listRecentReaderNarrowings(raw: EngineRawRead, days: number, limit: number): Promise<ReaderNarrowingRow[]> {
  return raw<ReaderNarrowingRow>(
    `SELECT p.source_id, p.slug, gbrain_access_readers(p.frontmatter) AS readers, p.updated_at::text AS updated_at,
            CASE WHEN p.revision_principal_kind IS NULL THEN NULL ELSE p.revision_principal_kind || ':' || p.revision_principal_id END AS writer,
            count(*) OVER ()::int AS total
       FROM pages p
       JOIN LATERAL (SELECT v.frontmatter FROM page_versions v WHERE v.page_id = p.id ORDER BY v.snapshot_at DESC, v.id DESC LIMIT 1) prev ON true
      WHERE p.deleted_at IS NULL AND p.frontmatter->'readable_by' IS NOT NULL AND prev.frontmatter->'readable_by' IS NULL
        AND p.updated_at > now() - make_interval(days => $1::int)
      ORDER BY p.updated_at DESC, p.id LIMIT $2`, [days, limit]);
}
