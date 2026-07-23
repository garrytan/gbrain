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

async function apiUploadFile(path: string, file: File) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-PMBrain-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (res.status === 401) {
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
  brainOverview: () => apiFetch('/admin/api/brain/overview'),
  theme: () => apiFetch('/admin/api/theme'),
  docs: () => apiFetch('/admin/api/docs'),
  brainPages: (qs = '') => apiFetch(`/admin/api/brain/pages${qs}`),
  brainPage: (sourceId: string, slug: string, includeDeleted = false) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}${includeDeleted ? '?includeDeleted=1' : ''}`),
  brainPageChunks: (sourceId: string, slug: string, includeDeleted = false) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/chunks${includeDeleted ? '?includeDeleted=1' : ''}`),
  deleteBrainPage: (sourceId: string, slug: string) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/delete`, { method: 'POST' }),
  restoreBrainPage: (sourceId: string, slug: string) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/restore`, { method: 'POST' }),
  llmStatus: () => apiFetch('/admin/api/llm/status'),
  previewIntent: (text: string) => apiFetch('/admin/api/intent/preview', { method: 'POST', body: JSON.stringify({ text }) }),
  executeIntent: (previewId: string, confirmed = false) =>
    apiFetch('/admin/api/intent/execute', { method: 'POST', body: JSON.stringify({ previewId, confirmed }) }),
  startThinkRun: (question: string) =>
    apiFetch('/admin/api/think-runs', { method: 'POST', body: JSON.stringify({ question }) }),
  startCaptureRun: (content: string, sourceId?: string) =>
    apiFetch('/admin/api/capture-runs', { method: 'POST', body: JSON.stringify({ content, sourceId }) }),
  runs: () => apiFetch('/admin/api/runs'),
  run: (id: string) => apiFetch(`/admin/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => apiFetch(`/admin/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  startActionRun: (action: string) => apiFetch('/admin/api/runs/action', { method: 'POST', body: JSON.stringify({ action }) }),
  startImportRun: (body: { path: string; sourceId?: string; includeOffice: boolean; includeImages: boolean; autoEmbed: boolean; workers: number }) =>
    apiFetch('/admin/api/import-runs', { method: 'POST', body: JSON.stringify(body) }),
  startImportUploadRun: (file: File, options: { sourceId?: string; autoEmbed: boolean; workers: number }) => {
    const query = new URLSearchParams({
      autoEmbed: options.autoEmbed ? '1' : '0',
      workers: String(options.workers),
    });
    if (options.sourceId) query.set('sourceId', options.sourceId);
    return apiUploadFile(`/admin/api/import-upload-runs?${query.toString()}`, file);
  },
  startMarkdownExportRun: (rootPath: string) =>
    apiFetch('/admin/api/export-runs', { method: 'POST', body: JSON.stringify({ rootPath }) }),
  importSettings: () => apiFetch('/admin/api/import/settings'),
  saveImportSettings: (thresholdKb: number) =>
    apiFetch('/admin/api/import/settings', { method: 'POST', body: JSON.stringify({ thresholdKb }) }),
  dreamOverview: () => apiFetch('/admin/api/dream/overview'),
  dreamSettings: () => apiFetch('/admin/api/dream/settings'),
  saveDreamSettings: (body: { outputDir: string; dualWrite: boolean }) =>
    apiFetch('/admin/api/dream/settings', { method: 'POST', body: JSON.stringify(body) }),
  startDreamRun: (body: { phase?: string; preset?: 'full' | 'meeting' | 'quick'; sourceId?: string; maxPages?: number; drainProposals?: boolean; windowSeconds?: number; dryRun: boolean; input?: string; date?: string; from?: string; to?: string; timeoutMs?: number }) =>
    apiFetch('/admin/api/dream-runs', { method: 'POST', body: JSON.stringify(body) }),
  breakDreamLock: (id: string, holderPid: number) =>
    apiFetch(`/admin/api/dream/locks/${encodeURIComponent(id)}/break`, { method: 'POST', body: JSON.stringify({ holderPid }) }),
  cancelJob: (id: number) =>
    apiFetch(`/admin/api/jobs/${encodeURIComponent(String(id))}/cancel`, { method: 'POST' }),
  startSupervisor: () =>
    apiFetch('/admin/api/jobs/supervisor/start', { method: 'POST' }),
  stopSupervisor: () =>
    apiFetch('/admin/api/jobs/supervisor/stop', { method: 'POST' }),
  addSource: (body: { id?: string; path: string; name?: string; federated: boolean }) =>
    apiFetch('/admin/api/sources', { method: 'POST', body: JSON.stringify(body) }),
  setDefaultSource: (sourceId: string) =>
    apiFetch('/admin/api/sources/default', { method: 'POST', body: JSON.stringify({ sourceId }) }),
  archiveSource: (id: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  restoreSource: (id: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  desktopState: () => apiFetch('/admin/api/desktop-state'),
  createApiKey: (name: string, options?: { scopes?: string[]; sourceId?: string; federatedRead?: string[] }) =>
    apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name, ...options }) }),
  updateAgentSourceScope: (body: { id: string; authType: 'oauth' | 'api_key'; sourceId: string; federatedRead: string[] }) =>
    apiFetch('/admin/api/agents/source-scope', { method: 'POST', body: JSON.stringify(body) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  takeProposals: (status = 'pending') =>
    apiFetch(`/admin/api/take-proposals?status=${encodeURIComponent(status)}`),
  acceptTakeProposal: (id: number) =>
    apiFetch(`/admin/api/take-proposals/${encodeURIComponent(String(id))}/accept`, { method: 'POST' }),
  rejectTakeProposal: (id: number) =>
    apiFetch(`/admin/api/take-proposals/${encodeURIComponent(String(id))}/reject`, { method: 'POST' }),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  chatGptTunnelStatus: (binaryPath?: string) =>
    apiFetch(`/admin/api/chatgpt-tunnel/status${binaryPath ? `?binaryPath=${encodeURIComponent(binaryPath)}` : ''}`),
  setupChatGptTunnel: (body: { tunnelId: string; runtimeApiKey?: string; binaryPath: string }) =>
    apiFetch('/admin/api/chatgpt-tunnel/setup', { method: 'POST', body: JSON.stringify(body) }),
  doctorChatGptTunnel: (binaryPath: string) =>
    apiFetch('/admin/api/chatgpt-tunnel/doctor', { method: 'POST', body: JSON.stringify({ binaryPath }) }),
  startChatGptTunnel: (binaryPath: string) =>
    apiFetch('/admin/api/chatgpt-tunnel/start', { method: 'POST', body: JSON.stringify({ binaryPath }) }),
  stopChatGptTunnel: () => apiFetch('/admin/api/chatgpt-tunnel/stop', { method: 'POST' }),
};
