/**
 * Client grant writes and reads for the rescope, first-consent and attest-source flows: one SQL implementation for
 * PGLite and Postgres (the Rust store serves the same members, rust/docs/store/oauth-clients.md).
 *
 * Each text is the statement its caller sent through the `SqlQuery` tag before (grants/service.ts, access/attest-sources.ts),
 * byte for byte; a template statement is the positional text the tag sent, each `${}` the next `$n` even for a repeated
 * value (test/engine-sql-caller-raw-sql-pins.test.ts pins the engine route and the tag route to the same text and params).
 * `persistOauthClientGrant` is grants/service.ts `persistGrant`'s statement and its two follow-up writes. A bare `SqlQuery`
 * caller (the consent store, the provider) keeps the statements in grants/service.ts.
 *
 * The Rust store keeps the audit table as an append-only list (oauth_grant_audit) and rewrites the open subagent jobs the
 * way the statement's `legacy_jobs` part does. It keeps no `oauth_tokens` and no `oauth_codes`, so no Rust client holds an
 * authorization.
 */
import type { BrainEngine } from '../engine.ts';
import { normalizeOauthClientRow, type OauthClientRow } from './oauth-clients.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const CLIENT_GRANT_SQL = {
  client_for_update: 'SELECT * FROM oauth_clients WHERE client_id = $1 FOR UPDATE',
  live_clients: `SELECT * FROM oauth_clients WHERE (to_jsonb(oauth_clients)->>'deleted_at') IS NULL`,
  live_tokens: 'SELECT * FROM access_tokens WHERE revoked_at IS NULL',
  tokens_newest_first: 'SELECT * FROM access_tokens ORDER BY created_at DESC, id',
  client_name_lock: 'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
  holds_authorization: `SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = $1)
    OR EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = $2) AS held`,
  source_archived_for_share: 'SELECT archived FROM sources WHERE id = $1 FOR SHARE',
  source_attest_state: 'SELECT archived, config FROM sources WHERE id = $1',
  replace_source_config: 'UPDATE sources SET config = $1::text::jsonb WHERE id = $2',
  provenance_audit: `SELECT after_grant FROM oauth_grant_audit
      WHERE client_id = $1 AND after_grant->'catalogProvenance' IS NOT NULL ORDER BY id DESC LIMIT 1`,
  audit_rows: 'SELECT id, client_id, actor, action, revision, before_grant, after_grant, created_at FROM oauth_grant_audit WHERE client_id = $1 ORDER BY id',
  persist: `
    WITH updated AS (
      UPDATE oauth_clients SET
        scope = $1, source_id = $2,
        federated_read = ARRAY(SELECT jsonb_array_elements_text($3::text::jsonb)),
        source_grant = $4,
        takes_holders = CASE WHEN $5 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($6::text::jsonb)) END,
        bound_slug_prefixes = CASE WHEN $7 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($8::text::jsonb)) END,
        allowed_operations = CASE WHEN $9 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($10::text::jsonb)) END,
        bound_tools = CASE WHEN $11 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($12::text::jsonb)) END,
        bound_source_id = $13, bound_brain_id = $14,
        delegated_slug_prefixes = CASE WHEN $15 THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text($16::text::jsonb)) END,
        delegated_namespace = $17, bound_max_concurrent = $18, budget_usd_per_day = $19,
        surface = $20, surface_set_by = $21, token_ttl = $22,
        grant_profile = $23, grant_revision = $24,
        grant_repair_reasons = ARRAY(SELECT jsonb_array_elements_text($25::text::jsonb))
      WHERE client_id = $26 AND grant_revision = $27
      RETURNING client_id
    ), legacy_jobs AS (
      UPDATE minion_jobs j SET data = jsonb_set(j.data, '{__delegation_grant}', jsonb_build_object(
        'clientId', $28::text, 'sourceId', j.data->>'source_id',
        'brainId', $29::text, 'tools', j.data->'allowed_tools',
        'slugPrefixes', CASE WHEN COALESCE(j.data->'allowed_slug_prefixes', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb)
          THEN j.data->'allowed_slug_prefixes' ELSE '["wiki/agents/{job_id}/*"]'::jsonb END,
        'namespace', CASE WHEN COALESCE(j.data->'allowed_slug_prefixes', '[]'::jsonb) NOT IN ('[]'::jsonb, 'null'::jsonb) THEN 'prefixes' ELSE 'job' END,
        'readSources', CASE WHEN j.data->>'source_id' IN (SELECT jsonb_array_elements_text($30::text::jsonb))
          THEN jsonb_build_array(j.data->>'source_id') ELSE '[]'::jsonb END,
        'scopes', $31::text::jsonb,
        'allowedOperations', $32::text::jsonb,
        'maxConcurrent', $33::integer, 'budgetUsdPerDay', $34::text
      ))
      WHERE j.name = 'subagent' AND j.status IN ('waiting', 'active', 'waiting-children', 'delayed', 'paused')
        AND j.data->>'__owner_client_id' = $35 AND NOT (j.data ? '__delegation_grant')
        AND EXISTS (SELECT 1 FROM updated)
      RETURNING j.id
    ), audited AS (
      INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      SELECT client_id, $36, $37, $38, $39::text::jsonb, $40::text::jsonb FROM updated
      RETURNING client_id
    ) SELECT client_id FROM audited
  `,
  set_private_pages: 'UPDATE oauth_clients SET private_pages = $1 WHERE client_id = $2',
  set_private_facts: 'UPDATE oauth_clients SET private_facts = $1 WHERE client_id = $2',
} as const;

/** The client's row read `FOR UPDATE` inside the caller's transaction (a lock is a no-op where nothing else writes), or null. */
export async function readOauthClientForUpdate(tx: Raw, clientId: string): Promise<OauthClientRow | null> {
  const rows = await tx.executeRaw<Record<string, unknown>>(CLIENT_GRANT_SQL.client_for_update, [clientId]);
  return rows[0] ? normalizeOauthClientRow(rows[0]) : null;
}

/** Every client not deleted, whole rows, in no promised order (the grant checks read them all). */
export async function readLiveOauthClients(tx: Raw): Promise<OauthClientRow[]> {
  return (await tx.executeRaw<Record<string, unknown>>(CLIENT_GRANT_SQL.live_clients)).map(normalizeOauthClientRow);
}

/** Every access token not revoked, whole rows without a hash on the Rust store (the grant checks read them all). */
export function readLiveAccessTokenRows(tx: Raw): Promise<Record<string, unknown>[]> {
  return tx.executeRaw<Record<string, unknown>>(CLIENT_GRANT_SQL.live_tokens);
}

/** Every access token, revoked ones too, whole rows newest first (a tie by id): the admin key list. */
export function listAccessTokenRows(tx: Raw): Promise<Record<string, unknown>[]> {
  return tx.executeRaw<Record<string, unknown>>(CLIENT_GRANT_SQL.tokens_newest_first);
}

/** Takes the transaction-scoped lock on a client name key (agent-register.ts `registerClientNameLockKey`), so two same-name registrations serialize. */
export async function lockOauthClientName(tx: Raw, lockKey: string): Promise<void> {
  await tx.executeRaw(CLIENT_GRANT_SQL.client_name_lock, [lockKey]);
}

/** Whether the client holds an OAuth token or an authorization code. The Rust store keeps neither, so none holds one there. */
export async function oauthClientHoldsAuthorization(tx: Raw, clientId: string): Promise<boolean> {
  const [row] = await tx.executeRaw<{ held: boolean }>(CLIENT_GRANT_SQL.holds_authorization, [clientId, clientId]);
  return row?.held === true;
}

/** Whether the source is archived, read `FOR SHARE` inside the caller's transaction so it stays active to commit; null for no such source. */
export async function readSourceArchivedForShare(tx: Raw, id: string): Promise<boolean | null> {
  const [row] = await tx.executeRaw<{ archived: boolean }>(CLIENT_GRANT_SQL.source_archived_for_share, [id]);
  return row ? row.archived === true : null;
}

/** The source's archived flag and config, or null for no such source (the `--attest-sources` check reads each listed source). */
export async function readSourceAttestState(tx: Raw, id: string): Promise<{ archived: boolean; config: unknown } | null> {
  const [row] = await tx.executeRaw<{ archived: boolean; config: unknown }>(CLIENT_GRANT_SQL.source_attest_state, [id]);
  return row ?? null;
}

/** Sets the source's whole `config` (the `--attest-sources` mark); nothing for no such source. */
export async function replaceSourceConfig(tx: Raw, id: string, config: Record<string, unknown>): Promise<void> {
  await tx.executeRaw(CLIENT_GRANT_SQL.replace_source_config, [JSON.stringify(config), id]);
}

/**
 * The `after_grant` document of the client's newest audit row that records a catalog provenance, or null. A missing audit
 * table raises (the caller treats it as no provenance).
 */
export async function readLatestCatalogProvenanceAudit(tx: Raw, clientId: string): Promise<unknown | null> {
  const [row] = await tx.executeRaw<{ after_grant: unknown }>(CLIENT_GRANT_SQL.provenance_audit, [clientId]);
  if (!row) return null;
  return typeof row.after_grant === 'string' ? JSON.parse(row.after_grant) : row.after_grant;
}

/** One audit row of a client's grant, the documents parsed and the time as a `Date`. */
export interface OauthGrantAuditRow {
  id: number;
  client_id: string;
  actor: string;
  action: string;
  revision: number;
  before_grant: unknown | null;
  after_grant: unknown;
  created_at: Date;
}

/** The client's audit rows, oldest first. */
export async function listOauthGrantAudit(tx: Raw, clientId: string): Promise<OauthGrantAuditRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(CLIENT_GRANT_SQL.audit_rows, [clientId]);
  const doc = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v ?? null;
  return rows.map(r => ({
    id: Number(r.id), client_id: String(r.client_id), actor: String(r.actor), action: String(r.action), revision: Number(r.revision),
    before_grant: doc(r.before_grant), after_grant: doc(r.after_grant),
    created_at: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  }));
}

/**
 * `persistOauthClientGrant`: the grant columns of `after`, the revision the row must still hold, what the legacy job
 * rewrite reads of `before`, the audit row (documents as JSON text) and the private grants that changed (a value only
 * when it changed). Built by grants/service.ts `persistGrant`.
 */
export interface OauthClientGrantPersist {
  client_id: string;
  expected_revision: number;
  scope: string;
  source_id: string | null;
  federated_read: string[];
  source_grant: 'none' | null;
  takes_holders: string[] | null;
  bound_slug_prefixes: string[] | null;
  allowed_operations: string[] | null;
  bound_tools: string[] | null;
  bound_source_id: string | null;
  bound_brain_id: string | null;
  delegated_slug_prefixes: string[] | null;
  delegated_namespace: string;
  bound_max_concurrent: number;
  budget_usd_per_day: string | null;
  surface: string | null;
  surface_set_by: string | null;
  token_ttl: number | null;
  grant_profile: string | null;
  grant_revision: number;
  grant_repair_reasons: string[];
  /** The grant before the write: the open subagent jobs this client owns without a delegation grant receive it. */
  legacy_jobs: { brain_id: string | null; federated_read: string[]; scopes: string[]; allowed_operations: string[] | null; max_concurrent: number; budget_usd_per_day: string | null };
  audit: { actor: string; action: string; before_grant: string; after_grant: string };
  private_pages?: string;
  private_facts?: string;
}

/** Runs the grant write; false when no client held the expected revision (nothing changed). */
export async function persistOauthClientGrant(tx: Raw, g: OauthClientGrantPersist): Promise<boolean> {
  const list = (v: string[] | null) => [v === null, JSON.stringify(v ?? [])] as const;
  const result = await tx.executeRaw(CLIENT_GRANT_SQL.persist, [
    g.scope, g.source_id, JSON.stringify(g.federated_read), g.source_grant,
    g.takes_holders == null, JSON.stringify(g.takes_holders ?? []),
    ...list(g.bound_slug_prefixes), ...list(g.allowed_operations), ...list(g.bound_tools),
    g.bound_source_id, g.bound_brain_id,
    ...list(g.delegated_slug_prefixes),
    g.delegated_namespace, g.bound_max_concurrent, g.budget_usd_per_day, g.surface, g.surface_set_by, g.token_ttl,
    g.grant_profile, g.grant_revision, JSON.stringify(g.grant_repair_reasons),
    g.client_id, g.expected_revision,
    g.client_id, g.legacy_jobs.brain_id, JSON.stringify(g.legacy_jobs.federated_read), JSON.stringify(g.legacy_jobs.scopes),
    JSON.stringify(g.legacy_jobs.allowed_operations), g.legacy_jobs.max_concurrent, g.legacy_jobs.budget_usd_per_day, g.client_id,
    g.audit.actor, g.audit.action, g.grant_revision, g.audit.before_grant, g.audit.after_grant,
  ]);
  if (!result.length) return false;
  if (g.private_pages !== undefined) await tx.executeRaw(CLIENT_GRANT_SQL.set_private_pages, [g.private_pages, g.client_id]);
  if (g.private_facts !== undefined) await tx.executeRaw(CLIENT_GRANT_SQL.set_private_facts, [g.private_facts, g.client_id]);
  return true;
}
