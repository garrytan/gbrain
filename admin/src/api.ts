const BASE = '';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly outcome?: 'failed' | 'unknown') { super(message); }
}

export function mutationOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return true;
  if (cause.outcome) return cause.outcome === 'unknown';
  return cause.status >= 500 || cause.status === 408;
}

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
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 401) window.location.hash = '#login';
    const retry = res.status === 429 ? ` Wait ${res.headers.get('retry-after') || '60'} seconds before retrying.` : '';
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    const remedy = typeof body?.next_action === 'string' ? ` ${body.next_action}` : '';
    const outcome = body?.outcome === 'unknown' || body?.outcome === 'failed' ? body.outcome : undefined;
    throw new ApiError(message + remedy + retry, res.status, outcome);
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
  clientDetails: (clientId: string) => apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}`),
  clientSetup: (clientId: string, harness: string, flow?: string) => {
    const query = new URLSearchParams({ harness });
    if (flow) query.set('flow', flow);
    return apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}/setup?${query}`);
  },
  clientLifecycle: (clientId: string, body: Record<string, unknown>) => apiFetch(`/admin/api/clients/${encodeURIComponent(clientId)}/lifecycle`, { method: 'POST', body: JSON.stringify(body) }),
  registerClient: (body: Record<string, unknown>) => apiFetch('/admin/api/register-client', { method: 'POST', body: JSON.stringify(body) }),
  recoverClient: (clientId: string, harness?: string, flow?: string) => apiFetch('/admin/api/recover-client', { method: 'POST', body: JSON.stringify({ clientId, harness, flow }) }),
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
