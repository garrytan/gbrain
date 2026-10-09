/**
 * Per-token read floors (#5575, CEO-18). `oauth_clients.min_trust` and
 * `access_tokens.min_trust` hold the lowest trust tier a connection may read;
 * token verification carries it as `AuthInfo.minTrust` and read ops apply
 * max(floor, caller param). Only the trusted local CLI writes it
 * (`gbrain auth create --min-trust`, `gbrain auth set-min-trust`); no MCP or
 * admin HTTP surface can change it.
 */
import type { BrainEngine } from '../engine.ts';
import { isUndefinedColumnError } from '../utils.ts';
import { opError } from '../ops/contract.ts';
import type { TrustTier } from './tier.ts';

export interface MinTrustChange {
  kind: 'oauth_client' | 'legacy_token';
  id: string;
  name: string;
  before: TrustTier | null;
  after: TrustTier | null;
}

function migrationsPending(): Error {
  return opError('migrations_pending', 'This brain is missing the per-token min_trust column, so it cannot store a read floor.',
    'Apply the pending schema migrations on the brain host, then set the floor again.', {
      why: 'Read floors live in a column the memory-trust migration adds.',
      fix: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
        why: 'Applies the pending schema migrations, including the min_trust column; no user decision needed.', verify: { argv: ['gbrain', 'doctor', '--json'] } },
    });
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { if (isUndefinedColumnError(error, 'min_trust')) throw migrationsPending(); throw error; }
}

/** Sets a legacy token's floor by row id (the mint path already knows the id). */
export async function setTokenMinTrust(engine: BrainEngine, tokenId: string, tier: TrustTier | null): Promise<void> {
  await guarded(() => engine.executeRaw('UPDATE access_tokens SET min_trust = $1 WHERE id = $2::uuid', [tier, tokenId]));
}

/**
 * Sets the floor of one connection named by OAuth client id, legacy token id
 * or active legacy token name (names are not unique: an ambiguous name is
 * refused). `null` clears it. Returns the before/after values.
 */
export async function setMinTrust(engine: BrainEngine, target: string, tier: TrustTier | null): Promise<MinTrustChange> {
  return guarded(async () => {
    const [client] = await engine.executeRaw<{ id: string; name: string | null; before: string | null }>(
      `UPDATE oauth_clients c SET min_trust = $2 FROM (SELECT client_id, min_trust FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR UPDATE) prior
        WHERE c.client_id = prior.client_id RETURNING c.client_id AS id, c.client_name AS name, prior.min_trust AS before`, [target, tier]);
    if (client) return { kind: 'oauth_client', id: client.id, name: client.name ?? client.id, before: client.before as TrustTier | null, after: tier };
    const tokens = await engine.executeRaw<{ id: string; name: string; before: string | null }>(
      `SELECT id::text AS id, name, min_trust AS before FROM access_tokens
        WHERE revoked_at IS NULL AND (id::text = $1 OR name = $1)`, [target]);
    if (tokens.length > 1) {
      throw opError('invalid_params', `${tokens.length} active tokens are named "${target}".`,
        'Name the token by its id from gbrain auth list instead.');
    }
    const token = tokens[0];
    if (!token) {
      throw opError('not_found', `No active OAuth client or token is named "${target}".`,
        'List clients with gbrain auth clients and tokens with gbrain auth list, then pass a client id, token id or token name.');
    }
    await setTokenMinTrust(engine, token.id, tier);
    return { kind: 'legacy_token', id: token.id, name: token.name, before: token.before as TrustTier | null, after: tier };
  });
}
