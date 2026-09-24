import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { GrantError, grantFromRow } from './model.ts';

export const CLIENT_LIFECYCLE_CONSEQUENCES = {
  'invalidate-tokens': 'Remove all access tokens, refresh tokens, and authorization codes; invalidate pending approvals. Retain registration, secret, and permissions. Machine credentials can obtain new tokens. Accepted jobs continue under their existing grant checks.',
  revoke: 'Disable registration and remove all tokens and codes. Accepted jobs are denied at their next authority check; already admitted external work may complete. Retain audit, request history, and spending settlement.',
  delete: 'Permanently remove registration, tokens, and codes. Accepted jobs are denied at their next authority check; already admitted external work may complete. Retain an audit tombstone, request history, and spending settlement.',
} as const;
export type ClientLifecycleAction = keyof typeof CLIENT_LIFECYCLE_CONSEQUENCES;

/** Same client-row lock as token issuance, refresh, consent and grant edits. */
export async function mutateClientLifecycle(engine: BrainEngine, clientId: string, action: ClientLifecycleAction,
  opts: { actor: string; dryRun?: boolean; yes?: boolean; expectedRevision?: number }) {
  if (!Object.hasOwn(CLIENT_LIFECYCLE_CONSEQUENCES, action)) throw new GrantError('invalid_grant', 'Unknown client lifecycle action');
  if (opts.expectedRevision !== undefined && (!Number.isSafeInteger(opts.expectedRevision) || opts.expectedRevision < 0)) throw new GrantError('invalid_grant', 'expectedRevision must be a nonnegative integer');
  const dryRun = opts.dryRun !== false;
  if (!dryRun && (opts.yes !== true || opts.expectedRevision === undefined)) throw new GrantError('invalid_grant', 'Apply requires yes=true and the reviewed expectedRevision; preview first');
  return engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
    if (!row) throw new GrantError('client_not_found', 'Client no longer exists; inspect the client list before continuing');
    if (!('grant_revision' in row)) throw new GrantError('grant_schema_required', 'Upgrade the running server and apply migrations before client administration');
    const before = grantFromRow(row);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== before.revision) throw new GrantError('grant_conflict', 'Client changed; review a fresh lifecycle preview');
    const after = { ...before, revision: before.revision + 1, revoked: action === 'invalidate-tokens' ? before.revoked : true };
    const result = { action, dry_run: dryRun, before, grant: action === 'delete' ? null : after, consequences: CLIENT_LIFECYCLE_CONSEQUENCES[action] };
    if (dryRun) return result;
    await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
    await sql`DELETE FROM oauth_codes WHERE client_id = ${clientId}`;
    if (action === 'delete') await sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`;
    else if (action === 'revoke') await sql`UPDATE oauth_clients SET deleted_at = COALESCE(deleted_at, now()), grant_revision = ${after.revision} WHERE client_id = ${clientId}`;
    else await sql`UPDATE oauth_clients SET grant_revision = ${after.revision} WHERE client_id = ${clientId}`;
    const auditAfter = action === 'delete' ? { clientId, revision: after.revision, deleted: true } : after;
    await sql`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      VALUES (${clientId}, ${opts.actor}, ${action}, ${after.revision}, ${JSON.stringify(before)}::text::jsonb, ${JSON.stringify(auditAfter)}::text::jsonb)`;
    return result;
  });
}
