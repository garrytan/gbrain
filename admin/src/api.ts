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
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  oauthRequest: (id: string) => apiFetch(`/admin/api/oauth-requests/${encodeURIComponent(id)}`),
  decideOAuthRequest: (id: string, decision: 'approve' | 'deny', csrf: string) =>
    apiFetch(`/admin/api/oauth-requests/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision, csrf }) }),
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  agentsSpend: () => apiFetch('/admin/api/agents/spend'),
  sources: () => apiFetch('/admin/api/sources'),
  grantCatalog: () => apiFetch('/admin/api/grant-catalog'),
  clientGrant: (clientId: string) => apiFetch(`/admin/api/grants/${encodeURIComponent(clientId)}`),
  registerClient: (body: Record<string, unknown>) => apiFetch('/admin/api/register-client', { method: 'POST', body: JSON.stringify(body) }),
  recoverClient: (clientId: string) => apiFetch('/admin/api/recover-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  updateClientGrant: (clientId: string, body: Record<string, unknown>) => apiFetch('/admin/api/rescope-client', { method: 'POST', body: JSON.stringify({ ...body, clientId }) }),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey(keyName: string) {
    return apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name: keyName }) });
  },
  revokeApiKey(keyName: string) {
    return apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name: keyName }) });
  },
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  rescopeClient: (clientId: string, sourceId: string, federatedRead: string[]) =>
    apiFetch('/admin/api/rescope-client', {
      method: 'POST',
      body: JSON.stringify({ clientId, sourceId, federatedRead }),
    }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
};
