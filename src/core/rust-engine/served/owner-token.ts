/**
 * The owner server token (served/auth.ts): the one credential a brain server accepts over the network until per-user
 * access lands. `gbrain auth create <name> --rust-server-owner` mints it on the server host (trusted local CLI only):
 * a legacy access token with full scopes, no operation, source or takes-holder list, and its id added to the brain
 * config key `rust_server.owner_token_ids`. Revoke it with `gbrain auth revoke <name>` as any token; the server stops
 * new work on its connections within RECHECK_MS.
 */
import type { BrainEngine } from '../../engine.ts';
import { generateToken, hashToken } from '../../utils.ts';
import { insertUnifiedToken } from '../../token-mint.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY, ownerTokenIds } from './auth.ts';

export async function mintOwnerServerToken(engine: BrainEngine, name: string): Promise<{ token: string; id: string }> {
  const token = generateToken('gbrain_');
  const [row] = await insertUnifiedToken(engine, {
    name, tokenHash: hashToken(token), scopes: ['read', 'write', 'admin'],
    grant: { sources: { kind: 'default' }, takesHolders: null, allowedOperations: null },
  });
  const id = String(row!.id);
  const ids = await ownerTokenIds(engine);
  ids.add(id);
  await engine.setConfig(OWNER_TOKEN_IDS_CONFIG_KEY, JSON.stringify([...ids].sort()));
  return { token, id };
}
