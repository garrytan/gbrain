/**
 * The `oauth_clients` table (engine-sql/oauth-clients.ts), served by the store (rust/docs/store/oauth-clients.md).
 * A time crosses the binding as ISO text. The store refuses a write that breaks a constraint of the table with
 * `constraint_violation`; the PGLite and Postgres engines raise SQLSTATE 23514 / 23505 / 23503 with the constraint name,
 * so constraint-errors.ts gives the Rust refusal the same code and constraint, and a caller branches on one error shape.
 */
import { normalizeOauthClientRow, type OauthClientInsert, type OauthClientPatch, type OauthClientPatchGuard, type OauthClientPatched, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
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
