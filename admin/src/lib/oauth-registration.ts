export type ConnectionKind = 'machine' | 'public-pkce' | 'confidential-pkce';
export interface OAuthRegistrationDraft {
  kind: ConnectionKind;
  redirectUris: string;
  confidentialMethod: 'client_secret_post' | 'client_secret_basic';
}
export function oauthRegistrationRequest(draft: OAuthRegistrationDraft) {
  const native = draft.kind !== 'machine';
  const redirectUris = native ? draft.redirectUris.split('\n').map(uri => uri.trim()).filter(Boolean) : [];
  if (native && !redirectUris.length) throw new Error('Enter the exact redirect URI from your MCP client settings, one per line.');
  for (const uri of redirectUris) {
    try { new URL(uri); }
    catch { throw new Error('Each redirect URI must be a complete URI. Copy it exactly from your MCP client settings.'); }
  }
  return {
    grantTypes: native ? ['authorization_code', 'refresh_token'] : ['client_credentials'],
    redirectUris,
    tokenEndpointAuthMethod: draft.kind === 'public-pkce' ? 'none' : draft.kind === 'machine' ? 'client_secret_post' : draft.confidentialMethod,
  };
}
