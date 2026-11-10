/**
 * The token mint behind `gbrain auth create`, shared with `gbrain access serves
 * several` (GST-363), which mints one member-bound key per person through the
 * same path. Returns the token value to the caller; never prints it.
 */
import type { BrainEngine } from '../core/engine.ts';
import { generateToken, hashToken } from '../core/utils.ts';
import { insertUnifiedToken } from '../core/token-mint.ts';
import type { GrantSources } from '../core/grants/model.ts';
import { setTokenMinTrust } from '../core/trust/min-trust.ts';
import type { TrustTier } from '../core/trust/tier.ts';
import { bindCredential, type BindingPatch, type BindingResult } from '../core/access/members.ts';
import { checkBindingTarget } from './auth-binding.ts';

export interface MintTokenOpts { takesHolders?: string[]; scopes?: string[]; minTrust?: TrustTier; binding?: BindingPatch | null; sources?: GrantSources }
export interface MintedToken { token: string; id: string; takesHolders: string[]; bound: BindingResult | null }

export async function mintToken(engine: BrainEngine, name: string, opts: MintTokenOpts = {}): Promise<MintedToken> {
  const token = generateToken('gbrain_');
  // v0.28: persist per-token takes-holder allow-list. Default ['world'] keeps
  // private hunches hidden from MCP-bound tokens.
  const takesHolders = opts.takesHolders && opts.takesHolders.length > 0 ? opts.takesHolders : ['world'];
  await checkBindingTarget(engine, opts.binding ?? null);
  // F3: the token is born on the unified grant shape (columns + the
  // permissions JSONB mirror older binaries read). Scopes land in the
  // original-schema scopes TEXT[] column; omitted → NULL → the historical
  // grandfathered full-access grant.
  const [row] = await insertUnifiedToken(engine, {
    name, tokenHash: hashToken(token), ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
    grant: { sources: opts.sources ?? { kind: 'default' }, takesHolders, allowedOperations: null },
  });
  // #5575 (CEO-18): the read floor; the CLI is the only writer of it.
  if (opts.minTrust) await setTokenMinTrust(engine, row!.id, opts.minTrust);
  const bound = opts.binding ? await bindCredential(engine, { kind: 'token', id: String(row!.id) }, opts.binding) : null;
  return { token, id: String(row!.id), takesHolders, bound };
}
