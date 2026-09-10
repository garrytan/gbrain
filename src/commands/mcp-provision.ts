import type { BrainEngine } from '../core/engine.ts';
import { GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { resolveGrantProfile, readClientGrant, rescopeClientGrantInTransaction, validateClientGrant, grantValidationContext,
  type GrantPatch, type GrantProfileId, type ClientGrant } from '../core/grants/service.ts';
import { GRANT_PROFILES } from '../core/grants/model.ts';
import { harnessAdapter } from '../core/harness/registry.ts';
import { assertSecureEndpoint, type HarnessCredentials } from '../core/harness/credentials.ts';
import { isValidName, normalizeMcpUrl } from '../core/mcp-registration.ts';
import { registerClientNameLockKey } from './agent-register.ts';
import { recoverCredentialDelivery, retainCredentialDelivery } from '../core/harness/delivery.ts';

export interface ProvisionGrantInput {
  name: string; harness: string; profile?: GrantProfileId; sourceId?: string; url: string;
  clientId?: string; expectedRevision?: number; dryRun?: boolean; resume?: boolean; patch?: GrantPatch;
}

/** Called by trusted local CLI or cookie-authenticated admin routes only. */
export async function provisionHarnessGrant(engine: BrainEngine, input: ProvisionGrantInput, actor: string) {
  if (!isValidName(input.name)) throw new Error('Use a lowercase connection name containing letters, numbers, underscores or hyphens');
  const adapter = harnessAdapter(input.harness);
  const normalized = normalizeMcpUrl(input.url);
  if (!normalized.ok) throw new Error('Pass a valid MCP endpoint URL');
  assertSecureEndpoint(normalized.url);
  if (input.profile !== undefined && !GRANT_PROFILES.includes(input.profile)) throw new Error('Unknown grant profile');
  return engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${registerClientNameLockKey(input.name)})::bigint)`;
    const existing = input.clientId ? await readClientGrant(tx, input.clientId) : undefined;
    if (input.resume) {
      if (!existing || existing.revoked) throw new Error('--resume requires an active --client');
      if (input.profile || input.sourceId || Object.keys(input.patch ?? {}).length || input.dryRun) throw new Error('--resume only recovers delivery; run a separate grant update to change permissions');
      const credentials = recoverCredentialDelivery(existing.clientId, normalized.url);
      // The journal is a delivery record, never authority after secret rotation.
      // Verify the renewable credential against the current confidential client.
      try {
        if (!credentials.client_secret) throw new Error('missing secret');
        await new GBrainOAuthProvider({ sql }).verifyConfidentialClientSecret(existing.clientId, credentials.client_secret);
      } catch { throw new Error('credential_delivery_stale: the retained handoff no longer matches the current client secret. Use the handoff from the explicit rotation; do not deliver or rotate an old secret automatically.'); }
      // Do not replay an individually revoked or narrower cached access token.
      // The receiving client renews from the still-valid secret when needed.
      delete credentials.access_token;
      delete credentials.expires_at;
      credentials.profile = existing.profile ?? undefined;
      credentials.source_id = existing.sourceId ?? undefined;
      return { grant: existing, before: existing, dry_run: false, credentials, credential_action: 'recovered_private_handoff' };
    }
    const sourceId = input.sourceId ?? existing?.sourceId ?? 'default';
    const patch = input.patch ?? {};
    const profile = input.profile ?? 'memory-writer';
    // An omitted profile on an update is not a regrant. Rebuilding a profile
    // here would add write to readers and replace customized operation ceilings.
    const regrant = !existing || input.profile !== undefined;
    const resolved: GrantPatch = regrant ? resolveGrantProfile({ profile, sourceId, existing,
      staticToken: !adapter.renewable,
      federatedRead: patch.federatedRead,
      boundTools: patch.boundTools ?? undefined,
      boundSlugPrefixes: patch.boundSlugPrefixes !== undefined ? patch.boundSlugPrefixes
        : existing?.boundSlugPrefixes ?? (profile === 'coding-agent' ? [`agents/${input.name}/`] : undefined),
      delegatedSlugPrefixes: patch.delegatedSlugPrefixes,
      delegatedNamespace: patch.delegatedNamespace,
    }) : {};
    Object.assign(resolved, patch, input.sourceId === undefined ? {} : { sourceId });
    if (regrant && adapter.connection === 'thin-cli') resolved.surface = 'full';
    if (existing) {
      const result = await rescopeClientGrantInTransaction(tx, existing.clientId, resolved,
        { actor, expectedRevision: input.expectedRevision, dryRun: input.dryRun });
      return { grant: result.after, before: result.before, dry_run: Boolean(input.dryRun), credentials: null as HarnessCredentials | null, credential_action: 'existing_credentials_preserved' };
    }
    const duplicate = await sql`SELECT client_id FROM oauth_clients WHERE client_name = ${input.name} AND deleted_at IS NULL`;
    if (duplicate.length) throw new Error(`client_already_exists: resume delivery with --resume --client ${String(duplicate[0].client_id)} --credentials-out <private-file>; no secret was rotated`);
    const prospective = { clientId: '', clientName: input.name, revision: 0, revoked: false, ...resolved } as ClientGrant;
    validateClientGrant(prospective, await grantValidationContext(tx));
    if (input.dryRun) return { grant: prospective, before: null, dry_run: true, credentials: null as HarnessCredentials | null, credential_action: 'none' };
    const provider = new GBrainOAuthProvider({ sql, transaction: fn => fn(sql) });
    const registered = await provider.registerClientManual(input.name, ['client_credentials'], prospective.scopes.join(' '), [], sourceId,
      prospective.federatedRead, 'client_secret_post', {
        boundTools: prospective.boundTools ?? undefined, boundSourceId: prospective.boundSourceId ?? undefined,
        boundBrainId: prospective.boundBrainId ?? undefined, boundSlugPrefixes: prospective.boundSlugPrefixes ?? undefined,
        boundMaxConcurrent: prospective.boundMaxConcurrent, budgetUsdPerDay: prospective.budgetUsdPerDay ?? undefined,
        delegatedSlugPrefixes: prospective.delegatedSlugPrefixes ?? undefined, delegatedNamespace: prospective.delegatedNamespace,
      }, resolved);
    if (!registered.clientSecret) throw new Error('credential_delivery_incomplete: confidential client returned no secret');
    const tokens = await provider.exchangeClientCredentials(registered.clientId, registered.clientSecret);
    const credentials: HarnessCredentials = { version: 1, mcp_url: normalized.url, issuer_url: normalized.url.replace(/\/mcp$/, ''),
      client_id: registered.clientId, client_secret: registered.clientSecret, access_token: tokens.access_token,
      expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? prospective.tokenTtlSeconds ?? 3600),
      profile, harness: adapter.id, source_id: sourceId };
    // Failure here rolls back client + token + audit. A commit failure can leave
    // an orphaned private journal, but resume first requires the live client.
    retainCredentialDelivery(credentials);
    return { grant: await readClientGrant(tx, registered.clientId), before: null, dry_run: false, credentials, credential_action: 'save_private_handoff' };
  });
}
