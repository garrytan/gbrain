/**
 * The `oauth_clients` table (engine-sql/oauth-clients.ts), served by the store (rust/docs/store/oauth-clients.md).
 * A time crosses the binding as ISO text. The store refuses a write that breaks a constraint of the table with
 * `constraint_violation`; the PGLite and Postgres engines raise SQLSTATE 23514 / 23505 / 23503 with the constraint name,
 * so this file gives the Rust refusal the same code and constraint, and a caller branches on one error shape.
 */
import { normalizeOauthClientRow, type OauthClientInsert, type OauthClientPatch, type OauthClientPatchGuard, type OauthClientPatched, type OauthClientRow } from '../../engine-sql/oauth-clients.ts';
import { storeCall, type StoreMember } from './common.ts';

/** Which Postgres error a store message is: `new row for relation "t" violates check constraint "c"` and its siblings. */
const PG_REFUSALS: ReadonlyArray<{ re: RegExp; code: string }> = [
  { re: /^new row for relation "([^"]+)" violates check constraint "([^"]+)"$/, code: '23514' },
  { re: /^duplicate key value violates unique constraint "([^"]+)"$/, code: '23505' },
  { re: /^insert or update on table "([^"]+)" violates foreign key constraint "([^"]+)"$/, code: '23503' },
];

/** A `constraint_violation` of the store as the error PGLite (`constraint`, `table`) and postgres.js (`constraint_name`, `table_name`) raise. */
export function asSqlConstraintError(error: unknown): unknown {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'constraint_violation') return error;
  for (const { re, code } of PG_REFUSALS) {
    const m = re.exec(error.message);
    if (!m) continue;
    const [table, constraint] = code === '23505' ? [undefined, m[1]!] : [m[1]!, m[2]!];
    return Object.assign(error, { code, constraint, constraint_name: constraint, ...(table ? { table, table_name: table } : {}) });
  }
  return error;
}

async function refusing<T>(member: string, run: () => Promise<T>): Promise<T> {
  try {
    return await storeCall({ member }, run);
  } catch (error) {
    throw asSqlConstraintError(error);
  }
}

export const insertOauthClient: StoreMember<[row: OauthClientInsert], void> = async (brain, row) => {
  const wire = { ...row, deleted_at: row.deleted_at?.toISOString() ?? null, created_at: row.created_at?.toISOString() ?? null, reads_unscoped: row.reads_unscoped?.toISOString() ?? null };
  await refusing('insertOauthClient', () => brain.insertOauthClient(wire));
};

export const readOauthClient: StoreMember<[clientId: string], OauthClientRow | null> = async (brain, clientId) => {
  const raw = await storeCall({ member: 'readOauthClient' }, () => brain.readOauthClient(clientId)) as Record<string, unknown> | null;
  return raw ? normalizeOauthClientRow(raw) : null;
};

export const patchOauthClient: StoreMember<[clientId: string, patch: OauthClientPatch, guard?: OauthClientPatchGuard], OauthClientPatched | null> = async (brain, clientId, patch, guard) => {
  const set = (Object.keys(patch) as Array<keyof OauthClientPatch>).filter(k => patch[k] !== undefined);
  const raw = await refusing('patchOauthClient', () => brain.patchOauthClient(clientId, { ...patch, set }, guard ?? {})) as { row: Record<string, unknown>; before: OauthClientPatched['before'] } | null;
  return raw ? { row: normalizeOauthClientRow(raw.row), before: raw.before } : null;
};
