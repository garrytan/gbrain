import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { GrantError, grantFromRow, type ClientGrant } from '../grants/model.ts';
import { GBrainOAuthProvider } from '../oauth-provider.ts';
import { buildClientSetup, clientMetadata, type OAuthClientSetup } from './oauth-setup.ts';
import { recoverCredentialDelivery } from './delivery.ts';
import type { HarnessCredentials } from './credentials.ts';
import { InvalidClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

// All nonsecret client/grant columns, explicitly selected for inspection. A future
// secret-bearing schema field cannot accidentally become an API response.
export const CLIENT_INSPECTION_COLUMNS = `client_id, client_name, redirect_uris, grant_types,
  token_endpoint_auth_method, client_id_issued_at, client_secret_expires_at, created_at, deleted_at,
  scope, source_id, federated_read, bound_slug_prefixes, allowed_operations, bound_tools,
  bound_source_id, bound_brain_id, delegated_slug_prefixes, delegated_namespace,
  bound_max_concurrent, budget_usd_per_day, surface, surface_set_by, token_ttl,
  grant_profile, grant_revision, grant_repair_reasons`;

export async function inspectOAuthClient(engine: BrainEngine, clientId: string) {
  const [row] = await engine.executeRaw(`SELECT ${CLIENT_INSPECTION_COLUMNS} FROM oauth_clients WHERE client_id = $1`, [clientId]);
  if (!row) throw new GrantError('client_not_found', 'Client no longer exists; inspect the client list');
  return { client: clientMetadata(row), grant: grantFromRow(row) };
}

export async function clientSetup(engine: BrainEngine, clientId: string, endpoint: string, harness = 'generic', flow?: unknown) {
  const { client, grant } = await inspectOAuthClient(engine, clientId);
  if (grant.revoked) throw new GrantError('invalid_grant', 'Client is revoked. Inspect its registration; create a new client only when replacement is intended.');
  assertSecretNotExpired(client.token_endpoint_auth_method, client.client_secret_expires_at);
  const setup = buildClientSetup(client, endpoint, grant.scopes, harness, flow);
  return { setup, grant, instructions: setup.instructions, status: 'registered' as const };
}

/** Explicit owner export only. Serialize with rotation/deletion; journal data is
 * never authority and a cached access token is never re-delivered. */
export type ClientSetupExport = { clientId: string; name: string; grant: ClientGrant; clientSecret?: string } & (
  { oauthSetup: OAuthClientSetup; credentials?: never } | { credentials: HarnessCredentials; oauthSetup?: never }
);
function assertSecretNotExpired(method: unknown, expiration: unknown): void {
  if (method !== 'none' && Number(expiration) > 0 && Number(expiration) <= Math.floor(Date.now() / 1000)) {
    throw new GrantError('invalid_grant', 'Client secret expired. Inspect the registration and arrange explicit owner-side replacement; repeating a download cannot renew it.');
  }
}
export async function recoverClientSetup(engine: BrainEngine, clientId: string, endpoint: string, harness = 'generic', flow?: unknown): Promise<ClientSetupExport> {
  return engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
    if (!row) throw new GrantError('client_not_found', 'Client no longer exists');
    const grant = grantFromRow(row);
    if (grant.revoked) throw new GrantError('client_not_found', 'Client is revoked; credentials cannot be exported');
    assertSecretNotExpired(row.token_endpoint_auth_method, row.client_secret_expires_at);
    const setup = buildClientSetup(clientMetadata(row), endpoint, grant.scopes, harness, flow);
    const base = { clientId, name: grant.clientName, grant };
    if (setup.kind === 'oauth-client-setup' && setup.client.token_endpoint_auth_method === 'none') return { ...base, oauthSetup: setup };
    const retained = recoverCredentialDelivery(clientId, setup.mcp_url);
    try {
      if (!retained.client_secret) throw new InvalidClientError('missing secret');
      await new GBrainOAuthProvider({ sql }).verifyConfidentialClientSecret(clientId, retained.client_secret);
    } catch (error) {
      if (!(error instanceof InvalidClientError)) throw error;
      throw new Error('credential_delivery_stale: retained credentials no longer match this client. Use the private output from explicit rotation; never rotate merely to download again.');
    }
    if (setup.kind === 'oauth-client-setup') {
      const oauthSetup: OAuthClientSetup = { ...setup, client: { ...setup.client, client_secret: retained.client_secret } };
      return { ...base, clientSecret: retained.client_secret, oauthSetup };
    }
    const credentials: HarnessCredentials = { version: 1, mcp_url: setup.mcp_url, issuer_url: setup.issuer_url,
      client_id: clientId, client_secret: retained.client_secret, harness: setup.harness,
      token_endpoint_auth_method: setup.client.token_endpoint_auth_method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post',
      source_id: grant.sourceId ?? undefined, profile: grant.profile ?? undefined };
    return { ...base, clientSecret: retained.client_secret, credentials };
  });
}
