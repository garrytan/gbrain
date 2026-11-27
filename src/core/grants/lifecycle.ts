import type { BrainEngine } from '../engine.ts';
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
    const row = await tx.readOauthClientForUpdate(clientId) as Record<string, unknown> | null;
    if (!row) throw new GrantError('client_not_found', 'Client no longer exists; inspect the client list before continuing');
    if (!('grant_revision' in row)) throw new GrantError('grant_schema_required', 'Upgrade the running server and apply migrations before client administration');
    const before = grantFromRow(row);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== before.revision) throw new GrantError('grant_conflict', 'Client changed; review a fresh lifecycle preview');
    const after = { ...before, revision: before.revision + 1, revoked: action === 'invalidate-tokens' ? before.revoked : true };
    const result = { action, dry_run: dryRun, before, grant: action === 'delete' ? null : after, consequences: CLIENT_LIFECYCLE_CONSEQUENCES[action] };
    if (dryRun) return result;
    await tx.deleteOauthClientTokens(clientId);
    await tx.deleteOauthClientCodes(clientId);
    if (action === 'delete') await tx.deleteOauthClientRow(clientId);
    else await tx.setOauthClientRevision(clientId, after.revision, action === 'revoke');
    // GST-2898: invalidating tokens changes no grant, so a switched client stays switched at the new revision.
    if (action === 'invalidate-tokens' && before.readShared === true) await tx.setOauthClientReadSharedRevision(clientId, after.revision);
    const auditAfter = action === 'delete' ? { clientId, revision: after.revision, deleted: true } : after;
    await tx.insertOauthGrantAudit({ client_id: clientId, actor: opts.actor, action, revision: after.revision,
      before_grant: JSON.stringify(before), after_grant: JSON.stringify(auditAfter) });
    return result;
  });
}
