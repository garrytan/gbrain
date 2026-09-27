import {
  BrainOverviewResponseSchema,
  BrainPageChunksResponseSchema,
  BrainFactDetailResponseSchema,
  BrainFactsResponseSchema,
  BrainPageDetailResponseSchema,
  BrainPagesResponseSchema,
  KnowledgeGraphGlobalResponseSchema,
  KnowledgeGraphMetaResponseSchema,
  KnowledgeGraphMissingLinksResponseSchema,
  KnowledgeGraphNeighborhoodResponseSchema,
  KnowledgeGraphSearchResponseSchema,
  DreamOverviewResponseSchema,
  DreamRunResponseSchema,
  DreamScheduleResponseSchema,
  DreamSettingsResponseSchema,
  GenerativeUsageResponseSchema,
  ImportRunResponseSchema,
  ImportUploadRunResponseSchema,
  LlmStatusResponseSchema,
  SetDefaultSourceResponseSchema,
  SourceAddResponseSchema,
  AdvisorAdminResponseSchema,
  AdvisorApplyResponseSchema,
} from '../../shared/contracts/index.ts';
import type {
  AdvisorAdminResponse,
  AdvisorApplyResponse,
  BrainOverviewResponse,
  BrainPageChunksResponse,
  BrainFactDetailResponse,
  BrainFactsResponse,
  BrainPageDetailResponse,
  BrainPagesResponse,
  KnowledgeGraphGlobalResponse,
  KnowledgeGraphMetaResponse,
  KnowledgeGraphMissingLinksResponse,
  KnowledgeGraphNeighborhoodResponse,
  KnowledgeGraphSearchResponse,
  DreamOverviewResponse,
  DreamRunResponse,
  DreamScheduleResponse,
  DreamSettingsResponse,
  GenerativeUsageResponse,
  ImportRunResponse,
  ImportRunRequest,
  ImportUploadOptions,
  ImportUploadRunResponse,
  LlmStatusResponse,
  SetDefaultSourceResponse,
  SourceAddResponse,
} from '../../shared/contracts/index.ts';

interface ContractParser { parse(value: unknown): unknown }
import { productFetch } from './lib/product-fetch';

const BASE = '';

export function isPgliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 423 && candidate.code === 'pglite_busy';
}

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch<T = any>(path: string, options?: RequestInit, schema?: ContractParser): Promise<T> {
  const res = await productFetch(`${BASE}${path}`, {
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
    const error = new Error(body.error || `HTTP ${res.status}`) as Error & { status?: number; code?: string };
    error.status = res.status;
    error.code = typeof body.code === 'string' ? body.code : undefined;
    throw error;
  }
  const payload: unknown = await res.json();
  return (schema ? schema.parse(payload) : payload) as T;
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await productFetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function apiUploadFile<T>(path: string, file: File, schema: ContractParser): Promise<T> {
  const res = await productFetch(`${BASE}${path}`, {
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
  return schema.parse(await res.json()) as T;
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  brainOverview: (includeSourceGitStatus = false) => apiFetch<BrainOverviewResponse>(
    `/admin/api/brain/overview${includeSourceGitStatus ? '?source_git_status=1' : ''}`,
    undefined,
    BrainOverviewResponseSchema,
  ),
  advisor: () => apiFetch<AdvisorAdminResponse>('/admin/api/advisor', undefined, AdvisorAdminResponseSchema),
  applyAdvisor: (dispatchId: string) => apiFetch<AdvisorApplyResponse>(
    '/admin/api/advisor/apply',
    { method: 'POST', body: JSON.stringify({ dispatch_id: dispatchId }) },
    AdvisorApplyResponseSchema,
  ),
  theme: () => apiFetch('/admin/api/theme'),
  docs: () => apiFetch('/admin/api/docs'),
  brainPages: (qs = '') => apiFetch<BrainPagesResponse>(`/admin/api/brain/pages${qs}`, undefined, BrainPagesResponseSchema),
  brainFacts: (qs = '') => apiFetch<BrainFactsResponse>(`/admin/api/brain/facts${qs}`, undefined, BrainFactsResponseSchema),
  brainFact: (id: number) => apiFetch<BrainFactDetailResponse>(`/admin/api/brain/facts/${id}`, undefined, BrainFactDetailResponseSchema),
  knowledgeGraphMeta: (sourceId?: string) => {
    const query = new URLSearchParams();
    if (sourceId && sourceId !== 'all') query.set('sourceId', sourceId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiFetch<KnowledgeGraphMetaResponse>(`/admin/api/knowledge-graph/meta${suffix}`, undefined, KnowledgeGraphMetaResponseSchema);
  },
  knowledgeGraphGlobal: (sourceId?: string, relationType = 'all') => {
    const query = new URLSearchParams();
    if (sourceId && sourceId !== 'all') query.set('sourceId', sourceId);
    if (relationType !== 'all') query.set('relationType', relationType);
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiFetch<KnowledgeGraphGlobalResponse>(`/admin/api/knowledge-graph/global${suffix}`, undefined, KnowledgeGraphGlobalResponseSchema);
  },
  knowledgeGraphIsolated: (sourceId?: string) => {
    const query = new URLSearchParams();
    if (sourceId && sourceId !== 'all') query.set('sourceId', sourceId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiFetch<KnowledgeGraphGlobalResponse>(`/admin/api/knowledge-graph/isolated${suffix}`, undefined, KnowledgeGraphGlobalResponseSchema);
  },
  knowledgeGraphMissing: (sourceId?: string) => {
    const query = new URLSearchParams();
    if (sourceId && sourceId !== 'all') query.set('sourceId', sourceId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiFetch<KnowledgeGraphMissingLinksResponse>(`/admin/api/knowledge-graph/missing${suffix}`, undefined, KnowledgeGraphMissingLinksResponseSchema);
  },
  knowledgeGraphSearch: (queryText: string, sourceId?: string, limit = 12) => {
    const query = new URLSearchParams({ q: queryText, limit: String(limit) });
    if (sourceId && sourceId !== 'all') query.set('sourceId', sourceId);
    return apiFetch<KnowledgeGraphSearchResponse>(`/admin/api/knowledge-graph/search?${query.toString()}`, undefined, KnowledgeGraphSearchResponseSchema);
  },
  knowledgeGraphNeighborhood: (sourceId: string, slug: string, relationType = 'all', limit = 30) => {
    const query = new URLSearchParams({ sourceId, slug, limit: String(limit) });
    if (relationType !== 'all') query.set('relationType', relationType);
    return apiFetch<KnowledgeGraphNeighborhoodResponse>(`/admin/api/knowledge-graph/neighborhood?${query.toString()}`, undefined, KnowledgeGraphNeighborhoodResponseSchema);
  },
  brainPage: (sourceId: string, slug: string, includeDeleted = false) =>
    apiFetch<BrainPageDetailResponse>(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}${includeDeleted ? '?includeDeleted=1' : ''}`, undefined, BrainPageDetailResponseSchema),
  brainPageChunks: (sourceId: string, slug: string, includeDeleted = false) =>
    apiFetch<BrainPageChunksResponse>(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/chunks${includeDeleted ? '?includeDeleted=1' : ''}`, undefined, BrainPageChunksResponseSchema),
  deleteBrainPage: (sourceId: string, slug: string) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/delete`, { method: 'POST' }),
  restoreBrainPage: (sourceId: string, slug: string) =>
    apiFetch(`/admin/api/brain/pages/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}/restore`, { method: 'POST' }),
  llmStatus: () => apiFetch<LlmStatusResponse>('/admin/api/llm/status', undefined, LlmStatusResponseSchema),
  previewIntent: (text: string) => apiFetch('/admin/api/intent/preview', { method: 'POST', body: JSON.stringify({ text }) }),
  executeIntent: (previewId: string, confirmed = false) =>
    apiFetch('/admin/api/intent/execute', { method: 'POST', body: JSON.stringify({ previewId, confirmed }) }),
  startThinkRun: (question: string) =>
    apiFetch('/admin/api/think-runs', { method: 'POST', body: JSON.stringify({ question }) }),
  knowledgeSearch: (body: { query: string; mode: 'keyword' | 'semantic'; limit?: number }) =>
    apiFetch('/admin/api/knowledge-search', { method: 'POST', body: JSON.stringify(body) }),
  startCaptureRun: (content: string, sourceId?: string) =>
    apiFetch('/admin/api/capture-runs', { method: 'POST', body: JSON.stringify({ content, sourceId }) }),
  runs: () => apiFetch('/admin/api/runs'),
  run: (id: string) => apiFetch(`/admin/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => apiFetch(`/admin/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  startActionRun: (action: string, extra?: { catchUp?: boolean; forceReembed?: boolean }) =>
    apiFetch('/admin/api/runs/action', { method: 'POST', body: JSON.stringify({ action, ...extra }) }),
  searchIndexHealth: () => apiFetch<{
    ok: boolean;
    engine: string;
    repairable?: boolean;
    busy?: boolean;
    message?: string;
  }>('/admin/api/search-index-health'),
  repairSearchIndex: () => apiFetch<{
    status: 'ok' | 'repaired' | 'failed' | 'database_unusable';
    rebuilt: string[];
    message: string;
  }>('/admin/api/search-index-repair', { method: 'POST' }),
  taskCenter: () => apiFetch('/admin/api/task-center'),
  terminatePgliteOwner: (pid: number) => apiFetch('/admin/api/pglite-owner/terminate', {
    method: 'POST',
    body: JSON.stringify({ pid }),
  }),
  startImportRun: (body: ImportRunRequest) =>
    apiFetch<ImportRunResponse>('/admin/api/import-runs', { method: 'POST', body: JSON.stringify(body) }, ImportRunResponseSchema),
  startImportUploadRun: (file: File, options: ImportUploadOptions) => {
    const query = new URLSearchParams({
      autoEmbed: options.autoEmbed ? '1' : '0',
      structuredDocuments: options.structuredDocuments ? '1' : '0',
      documentOcr: options.documentOcr ? '1' : '0',
      workers: String(options.workers),
    });
    if (options.sourceId) query.set('sourceId', options.sourceId);
    return apiUploadFile<ImportUploadRunResponse>(`/admin/api/import-upload-runs?${query.toString()}`, file, ImportUploadRunResponseSchema);
  },
  startMarkdownExportRun: (rootPath: string) =>
    apiFetch('/admin/api/export-runs', { method: 'POST', body: JSON.stringify({ rootPath }) }),
  dreamOverview: () => apiFetch<DreamOverviewResponse>('/admin/api/dream/overview', undefined, DreamOverviewResponseSchema),
  dreamSettings: () => apiFetch<DreamSettingsResponse>('/admin/api/dream/settings', undefined, DreamSettingsResponseSchema),
  saveDreamSettings: (body: { outputDir: string; dualWrite: boolean; includeUncommitted: boolean }) =>
    apiFetch<DreamSettingsResponse>('/admin/api/dream/settings', { method: 'POST', body: JSON.stringify(body) }, DreamSettingsResponseSchema),
  dreamSchedule: () => apiFetch<DreamScheduleResponse>('/admin/api/dream/schedule', undefined, DreamScheduleResponseSchema),
  saveDreamSchedule: (body: { enabled: boolean; time: string }) =>
    apiFetch<DreamScheduleResponse>('/admin/api/dream/schedule', { method: 'POST', body: JSON.stringify(body) }, DreamScheduleResponseSchema),
  generativeUsage: () => apiFetch<GenerativeUsageResponse>('/admin/api/model-usage/generative', undefined, GenerativeUsageResponseSchema),
  saveGenerativeUsage: (enabled: boolean) =>
    apiFetch<GenerativeUsageResponse>('/admin/api/model-usage/generative', { method: 'POST', body: JSON.stringify({ enabled }) }, GenerativeUsageResponseSchema),
  startDreamRun: (body: { phase?: string; preset?: 'full' | 'meeting' | 'quick'; sourceId?: string; allSources?: boolean; maxPages?: number; drainProposals?: boolean; windowSeconds?: number; dryRun: boolean; input?: string; date?: string; from?: string; to?: string; timeoutMs?: number }) =>
    apiFetch<DreamRunResponse>('/admin/api/dream-runs', { method: 'POST', body: JSON.stringify(body) }, DreamRunResponseSchema),
  breakDreamLock: (id: string, holderPid: number) =>
    apiFetch(`/admin/api/dream/locks/${encodeURIComponent(id)}/break`, { method: 'POST', body: JSON.stringify({ holderPid }) }),
  cancelJob: (id: number) =>
    apiFetch(`/admin/api/jobs/${encodeURIComponent(String(id))}/cancel`, { method: 'POST' }),
  startSupervisor: () =>
    apiFetch('/admin/api/jobs/supervisor/start', { method: 'POST' }),
  stopSupervisor: () =>
    apiFetch('/admin/api/jobs/supervisor/stop', { method: 'POST' }),
  addSource: (body: { id?: string; path: string; name?: string; federated: boolean }) =>
    apiFetch<SourceAddResponse>('/admin/api/sources', { method: 'POST', body: JSON.stringify(body) }, SourceAddResponseSchema),
  initializeSourceGit: (id: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/git/init`, { method: 'POST', body: '{}' }),
  commitSourceGit: (id: string, message: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/git/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  setDefaultSource: (sourceId: string) =>
    apiFetch<SetDefaultSourceResponse>('/admin/api/sources/default', { method: 'POST', body: JSON.stringify({ sourceId }) }, SetDefaultSourceResponseSchema),
  archiveSource: (id: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  restoreSource: (id: string) =>
    apiFetch(`/admin/api/sources/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  connectors: (provider?: string) =>
    apiFetch(`/admin/api/connectors${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
  connectorSync: (body: { provider: string; full?: boolean; dry_run?: boolean }) =>
    apiFetch('/admin/api/connectors/sync', { method: 'POST', body: JSON.stringify(body) }),
  connectorAuth: (body: { provider: string; cookie?: string; token?: string }) =>
    apiFetch('/admin/api/connectors/auth', { method: 'POST', body: JSON.stringify(body) }),
  connectorLogout: (provider: string) =>
    apiFetch('/admin/api/connectors/logout', { method: 'POST', body: JSON.stringify({ provider }) }),
  setConnectorAutoSync: (provider: string, enabled: boolean) =>
    apiFetch('/admin/api/connectors/auto-sync', { method: 'POST', body: JSON.stringify({ provider, enabled }) }),
  waiting: (limit = 20) =>
    apiFetch(`/admin/api/waiting?limit=${encodeURIComponent(String(limit))}`),
  closeWaiting: (body: { id: number; status: 'done' | 'dropped'; note?: string }) =>
    apiFetch('/admin/api/waiting/close', { method: 'POST', body: JSON.stringify(body) }),
  scanWaiting: (lanes?: Array<'gmail' | 'meeting' | 'conversation'>) =>
    apiFetch('/admin/api/waiting/scan', { method: 'POST', body: JSON.stringify(lanes ? { lanes } : {}) }),
  waitingSettings: () => apiFetch('/admin/api/waiting/settings'),
  setWaitingAutomation: (enabled: boolean) =>
    apiFetch('/admin/api/waiting/settings', { method: 'POST', body: JSON.stringify({ enabled }) }),
  chronicleDay: (date?: string) =>
    apiFetch(`/admin/api/chronicle/day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  chronicleOnThisDay: (date?: string) =>
    apiFetch(`/admin/api/chronicle/on-this-day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  chronicleStatus: () => apiFetch('/admin/api/chronicle/status'),
  enableChronicle: () => apiFetch('/admin/api/chronicle/enable', { method: 'POST' }),
  setChronicleEnabled: (enabled: boolean) =>
    apiFetch('/admin/api/chronicle/settings', { method: 'POST', body: JSON.stringify({ enabled }) }),
  organizeChronicleHistory: () => apiFetch('/admin/api/chronicle/history', { method: 'POST' }),
  hideChronicleEvent: (slug: string) =>
    apiFetch('/admin/api/chronicle/hide', { method: 'POST', body: JSON.stringify({ slug }) }),
  ontology: (entity: string) =>
    apiFetch(`/admin/api/ontology?entity=${encodeURIComponent(entity)}`),
  entityIdentity: (query?: { entity_id?: string; slug?: string }) => {
    const params = new URLSearchParams();
    if (query?.entity_id) params.set('entity_id', query.entity_id);
    if (query?.slug) params.set('slug', query.slug);
    const suffix = params.size ? `?${params.toString()}` : '';
    return apiFetch(`/admin/api/entity-identity${suffix}`);
  },
  linkEntityIdentity: (body: { entity_id: string; slug: string; source_id: string; canonical?: boolean }) =>
    apiFetch('/admin/api/entity-identity/link', { method: 'POST', body: JSON.stringify(body) }),
  people: (query = '') =>
    apiFetch(`/admin/api/people${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  peopleCard: (entityId: string) =>
    apiFetch(`/admin/api/people/card?entity_id=${encodeURIComponent(entityId)}`),
  mergePeople: (members: Array<{ source_id: string; slug: string; title?: string }>) =>
    apiFetch('/admin/api/people/merge', { method: 'POST', body: JSON.stringify({ members }) }),
  rejectPeople: (body: { left: { source_id: string; slug: string }; right: { source_id: string; slug: string } }) =>
    apiFetch('/admin/api/people/reject', { method: 'POST', body: JSON.stringify(body) }),
  unlinkPeople: (body: { entity_id: string; source_id: string; slug: string }) =>
    apiFetch('/admin/api/people/unlink', { method: 'POST', body: JSON.stringify(body) }),
  googleStatus: () => apiFetch('/admin/api/google/status'),
  googleConnect: (body: { account?: string; paste?: boolean; code?: string; client_json?: string }) =>
    apiFetch('/admin/api/google/connect', { method: 'POST', body: JSON.stringify(body) }),
  addGoogleSource: (body: { account: string; id?: string }) =>
    apiFetch('/admin/api/google/source', { method: 'POST', body: JSON.stringify(body) }),
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
