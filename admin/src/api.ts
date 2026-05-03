const BASE = '';

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // Try auto-reauth with saved token before giving up
    const saved = localStorage.getItem('gbrain_admin_token');
    if (saved && !path.includes('/login')) {
      try {
        const reauth = await fetch(`${BASE}/admin/login`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: saved }),
        });
        if (reauth.ok) {
          // Retry the original request
          const retry = await fetch(`${BASE}${path}`, {
            ...options, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...options?.headers },
          });
          if (retry.ok) return retry.json();
        }
      } catch {}
      // Reauth failed — token is stale
      localStorage.removeItem('gbrain_admin_token');
    }
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
