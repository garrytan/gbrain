export type OperationAuthSurfaceLocality = 'local' | 'remote';

export type OperationAuthPrincipalType =
  | 'local_cli'
  | 'local_mcp'
  | 'mcp_token'
  | 'oauth_client'
  | 'edge_token';

export interface OperationAuthPrincipal {
  principal_type: OperationAuthPrincipalType;
  principal_id: string;
  principal_name?: string;
  token_id?: string;
  token_name?: string;
  oauth_client_id?: string;
  oauth_client_name?: string;
  oauth_binding?: string;
  oauth_expires_at?: number;
  scopes: string[];
  surface_profile: string;
  surface_locality: OperationAuthSurfaceLocality;
  actor_type: 'cli' | 'mcp';
  actor_id: string;
}

export interface CreateTokenAuthPrincipalInput {
  tokenId?: string | null;
  tokenName: string;
  scopes?: readonly string[] | null;
  surfaceProfile: string;
  edge?: boolean;
}

export function createLocalAuthPrincipal(
  surfaceProfile: string,
  input: { principalType: 'local_cli' | 'local_mcp'; principalId: string; principalName: string; actorType: 'cli' | 'mcp'; actorId: string },
): OperationAuthPrincipal {
  return {
    principal_type: input.principalType,
    principal_id: input.principalId,
    principal_name: input.principalName,
    scopes: ['local'],
    surface_profile: surfaceProfile,
    surface_locality: 'local',
    actor_type: input.actorType,
    actor_id: input.actorId,
  };
}

export function createTokenAuthPrincipal(input: CreateTokenAuthPrincipalInput): OperationAuthPrincipal {
  const tokenName = input.tokenName || 'unknown';
  const scopes = normalizePrincipalScopes(input.scopes);
  const oauthName = oauthClientNameFromTokenName(tokenName);
  const oauthBinding = findScopeValue(scopes, 'oauth_binding:');
  const oauthExpiresAt = parseOauthExpiry(scopes);
  const oauthClientId = findScopeValue(scopes, 'oauth_client_id:');
  const isOauthToken = Boolean(oauthName && (oauthBinding || oauthExpiresAt || oauthClientId));
  const oauthClientName = isOauthToken ? oauthName : undefined;
  const principalType: OperationAuthPrincipalType = isOauthToken
    ? 'oauth_client'
    : input.edge
      ? 'edge_token'
      : 'mcp_token';
  const principalId = input.tokenId
    ? `${principalType}:${input.tokenId}`
    : oauthBinding
      ? `${principalType}:binding:${oauthBinding}`
      : `${principalType}:name:${tokenName}`;

  return {
    principal_type: principalType,
    principal_id: principalId,
    principal_name: oauthClientName ?? tokenName,
    ...(input.tokenId ? { token_id: input.tokenId } : {}),
    token_name: tokenName,
    ...(oauthClientId ? { oauth_client_id: oauthClientId } : {}),
    ...(oauthClientName ? { oauth_client_name: oauthClientName } : {}),
    ...(oauthBinding ? { oauth_binding: oauthBinding } : {}),
    ...(oauthExpiresAt ? { oauth_expires_at: oauthExpiresAt } : {}),
    scopes,
    surface_profile: input.surfaceProfile,
    surface_locality: 'remote',
    actor_type: 'mcp',
    actor_id: principalId,
  };
}

export function serializeAuthPrincipal(principal: OperationAuthPrincipal | null | undefined): string | null {
  return principal ? JSON.stringify(principal) : null;
}

function normalizePrincipalScopes(scopes: readonly string[] | null | undefined): string[] {
  return Array.from(new Set((scopes ?? [])
    .filter((scope): scope is string => typeof scope === 'string')
    .map(scope => scope.trim())
    .filter(Boolean)));
}

function oauthClientNameFromTokenName(tokenName: string): string | undefined {
  return tokenName.startsWith('oauth:') && tokenName.length > 'oauth:'.length
    ? tokenName.slice('oauth:'.length)
    : undefined;
}

function findScopeValue(scopes: readonly string[], prefix: string): string | undefined {
  const scope = scopes.find(entry => entry.startsWith(prefix));
  return scope ? scope.slice(prefix.length) : undefined;
}

function parseOauthExpiry(scopes: readonly string[]): number | undefined {
  const raw = findScopeValue(scopes, 'oauth_exp:');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}
