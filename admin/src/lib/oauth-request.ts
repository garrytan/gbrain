// This stores only an opaque pending-request ID, never an admin credential.
// It lets a single-use magic link return to consent in the same browser tab.
const KEY = 'gbrain.pending-oauth-request';
const valid = (value: string | null): value is string => value !== null && /^[a-f0-9]{64}$/.test(value);
export function pendingOAuthRequest(): string | undefined {
  const fromUrl = new URL(window.location.href).searchParams.get('oauth_request');
  if (valid(fromUrl)) {
    try { window.sessionStorage.setItem(KEY, fromUrl); } catch { /* query remains sufficient */ }
    return fromUrl;
  }
  try {
    const saved = window.sessionStorage.getItem(KEY);
    if (valid(saved)) return saved;
  } catch { /* browser storage may be disabled */ }
  return undefined;
}
export function clearOAuthRequest(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* best effort */ }
  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_request');
  window.history.replaceState(null, '', url);
}

export function ownerLoginPrompt(mcpUrl: string, requestId?: string): string {
  const continuation = requestId ? ` --oauth-request ${requestId}` : '';
  return `Give me an owner admin login link for ${mcpUrl}. On the brain host, run gbrain mcp admin login-link --url ${mcpUrl}${continuation} using its protected owner credential. Deliver the single-use link privately and do not open it before I do.`;
}
