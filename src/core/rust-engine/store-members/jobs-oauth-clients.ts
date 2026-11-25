/**
 * The `oauth_clients` table (engine-sql/oauth-clients.ts), served by the store (rust/docs/store/oauth-clients.md).
 * A time crosses the binding as ISO text. The store refuses a write that breaks a constraint of the table with
 * `constraint_violation`; the PGLite and Postgres engines raise SQLSTATE 23514 / 23505 / 23503 with the constraint name,
 * so constraint-errors.ts gives the Rust refusal the same code and constraint, and a caller branches on one error shape.
 * The delete, the liveness check, the column probes, the scoped-client insert and its lifetime write are the credential
 * members of engine-sql/access-credentials.ts. The store keeps the grant audit (oauth_grant_audit, jobs-client-grants.ts):
 * the scoped-client insert writes its register row. No client reads as lifetime-clamped: the upgrade migrations that
 * clamp a lifetime do not run on a Rust brain.
 */
import { normalizeOauthClientRow, type OauthClientInsert, type OauthClientPatch, type OauthClientPatchGuard, type OauthClientPatched, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
import { OAUTH_CLIENT_PROBE_COLUMNS, type DeletedOAuthClient, type OauthClientGrantInsert, type OauthClientProbe } from '../../engine-sql/access-credentials.ts';
import { storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';

export const insertOauthClient: StoreMember<[row: OauthClientInsert], void> = async (brain, row) => {
  const wire = { ...row, deleted_at: row.deleted_at?.toISOString() ?? null, created_at: row.created_at?.toISOString() ?? null, reads_unscoped: row.reads_unscoped?.toISOString() ?? null };
  await refusing('insertOauthClient', () => brain.insertOauthClient(wire));
};

export const readOauthClient: StoreMember<[clientId: string], OauthClientRow | null> = async (brain, clientId) => {
  const raw = await storeCall({ member: 'readOauthClient' }, () => brain.readOauthClient(clientId)) as Record<string, unknown> | null;
  return raw ? normalizeOauthClientRow(raw) : null;
};

export const listOauthClients: StoreMember<[], OauthClientRow[]> = async (brain) => {
  const raw = await storeCall({ member: 'listOauthClients' }, () => brain.listOauthClients()) as Record<string, unknown>[];
  return raw.map(normalizeOauthClientRow);
};

export const patchOauthClient: StoreMember<[clientId: string, patch: OauthClientPatch, guard?: OauthClientPatchGuard], OauthClientPatched | null> = async (brain, clientId, patch, guard) => {
  const set = (Object.keys(patch) as Array<keyof OauthClientPatch>).filter(k => patch[k] !== undefined);
  const raw = await refusing('patchOauthClient', () => brain.patchOauthClient(clientId, { ...patch, set }, guard ?? {})) as { row: Record<string, unknown>; before: OauthClientPatched['before'] } | null;
  return raw ? { row: normalizeOauthClientRow(raw.row), before: raw.before } : null;
};

export const deleteOAuthClient: StoreMember<[clientId: string], DeletedOAuthClient | null> = (brain, clientId) =>
  refusing('deleteOAuthClient', () => brain.deleteOauthClient(clientId)) as Promise<DeletedOAuthClient | null>;

export const oauthClientLive: StoreMember<[clientId: string], boolean> = (brain, clientId) =>
  storeCall({ member: 'oauthClientLive' }, () => brain.oauthClientLive(clientId)) as Promise<boolean>;

/** The store keeps every `oauth_clients` column, so each probe names all of its columns. */
export const readOauthClientColumns: StoreMember<[probe: OauthClientProbe], string[]> = async (_brain, probe) => [...OAUTH_CLIENT_PROBE_COLUMNS[probe]];

export const setOauthClientTokenTtl: StoreMember<[clientId: string, ttlSeconds: number], boolean> = (brain, clientId, ttlSeconds) =>
  refusing('setOauthClientTokenTtl', () => brain.setOauthClientTokenTtl(clientId, ttlSeconds)) as Promise<boolean>;

/** The client row and its register audit row, in one store write. */
export const insertOauthClientGrant: StoreMember<[row: OauthClientGrantInsert], void> = async (brain, row) => {
  const { audit, budget_usd_per_day, ...columns } = row;
  const wire = { ...columns, budget_usd_per_day: budget_usd_per_day === null ? null : Number(budget_usd_per_day), deleted_at: null, created_at: null, reads_unscoped: null };
  await refusing('insertOauthClientGrant', () => brain.insertOauthClientGrant(wire, audit));
};

/** The upgrade migrations that clamp a lifetime do not run on a Rust brain, so no client was clamped. */
export const readTokenLifetimeClampedClients: StoreMember<[], string[]> = async () => [];

/** The inspection columns the admin clients list reads (harness/client-setup.ts CLIENT_INSPECTION_COLUMNS). */
const ADMIN_CLIENT_COLUMNS = ['client_id', 'client_name', 'redirect_uris', 'grant_types', 'token_endpoint_auth_method', 'client_id_issued_at',
  'client_secret_expires_at', 'created_at', 'deleted_at', 'scope', 'source_id', 'federated_read', 'bound_slug_prefixes', 'allowed_operations',
  'bound_tools', 'bound_source_id', 'bound_brain_id', 'delegated_slug_prefixes', 'delegated_namespace', 'bound_max_concurrent',
  'budget_usd_per_day', 'surface', 'surface_set_by', 'token_ttl', 'grant_profile', 'grant_revision', 'grant_repair_reasons'] as const;

const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * Every client, deleted ones included, as its inspection columns: newest `created_at` first (the stored ISO text, so
 * microseconds order a tie inside one millisecond), then by byte order of client id.
 */
export const listAdminClientRows: StoreMember<[], Array<Record<string, unknown>>> = async (brain) => {
  const raw = await storeCall({ member: 'listAdminClientRows' }, () => brain.listOauthClients()) as Record<string, unknown>[];
  const sorted = [...raw].sort((a, b) => byteCompare(String(b.created_at), String(a.created_at)) || byteCompare(String(a.client_id), String(b.client_id)));
  return sorted.map(r => {
    const row = normalizeOauthClientRow(r) as unknown as Record<string, unknown>;
    return Object.fromEntries(ADMIN_CLIENT_COLUMNS.map(c => [c, row[c]]));
  });
};
