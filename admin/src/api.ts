const BASE = '';

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // No token cache to retry from. Redirect to login.
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey: (name: string) => apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
};
