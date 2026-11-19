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
  await guarded(() => engine.setAccessTokenMinTrust(tokenId, tier));
}

/**
 * Sets the floor of one connection named by OAuth client id, legacy token id
 * or active legacy token name (names are not unique: an ambiguous name is
 * refused). `null` clears it. Returns the before/after values.
 */
export async function setMinTrust(engine: BrainEngine, target: string, tier: TrustTier | null): Promise<MinTrustChange> {
  return guarded(async () => {
    const patched = await engine.patchOauthClient(target, { min_trust: tier }, { live: true });
    if (patched) return { kind: 'oauth_client', id: patched.row.client_id, name: patched.row.client_name ?? patched.row.client_id, before: patched.before.min_trust as TrustTier | null, after: tier };
    const tokens = await engine.findActiveAccessTokens(target);
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
    return { kind: 'legacy_token', id: token.id, name: token.name, before: token.min_trust as TrustTier | null, after: tier };
  });
}
