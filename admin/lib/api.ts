'use client'

type JsonBody = Record<string, unknown> | unknown[]

function redirectToLogin() {
  if (typeof window !== 'undefined') {
    window.location.href = '/admin/login'
  }
}

async function parseError(res: Response) {
  const body = await res.json().catch(() => ({}))
  return body?.error || body?.message || `HTTP ${res.status}`
}

async function apiFetch<T = any>(path: string, options?: RequestInit & { json?: JsonBody }): Promise<T> {
  const body = options?.json === undefined ? options?.body : JSON.stringify(options.json)
  const res = await fetch(path, {
    ...options,
    body,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  })

  if (res.status === 401) {
    redirectToLogin()
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    throw new Error(await parseError(res))
  }

  return res.json()
}

async function apiFetchText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin' })
  if (res.status === 401) {
    redirectToLogin()
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(await parseError(res))
  return res.text()
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', json: { token } }),
  session: () => apiFetch<{ authenticated: boolean; expiresAt: number | null }>('/admin/api/session'),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  signup: (input: { orgName: string; email: string; domain?: string }) =>
    apiFetch('/admin/api/signup', { method: 'POST', json: input }),
  orgs: () => apiFetch('/admin/api/orgs'),
  createOrg: (input: { name: string; domain?: string; ownerEmail?: string }) =>
    apiFetch('/admin/api/orgs', { method: 'POST', json: input }),
  brains: (orgId?: string) => apiFetch(`/admin/api/brains${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  createBrain: (input: { orgId?: string; name: string; publicUrl?: string; region?: string; status?: string; metadata?: Record<string, unknown> }) =>
    apiFetch('/admin/api/brains', { method: 'POST', json: input }),
  integrations: () => apiFetch('/admin/api/integrations'),
  quality: () => apiFetch('/admin/api/quality'),
  runtimeManifest: () => apiFetch('/admin/api/runtime-manifest'),
  plan: (orgId?: string) => apiFetch(`/admin/api/plan${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  updatePlan: (input: {
    orgId?: string
    planKey?: string
    status?: string
    billingCustomerId?: string | null
    billingProvider?: string | null
    billingSubscriptionId?: string | null
    billingPlanRef?: string | null
    billingCurrentPeriodEnd?: string | null
    limits?: Record<string, number | null>
  }) => apiFetch('/admin/api/plan', { method: 'POST', json: input }),
  team: (orgId?: string) => apiFetch(`/admin/api/team${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  invites: (orgId?: string) => apiFetch(`/admin/api/invites${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  createInvite: (input: { orgId?: string; email: string; role: string; sourceId: string; federatedRead: string[]; welcome?: string }) =>
    apiFetch('/admin/api/invites', { method: 'POST', json: input }),
  inviteDeliveries: (input: { orgId?: string; inviteId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (input.orgId) params.set('orgId', input.orgId)
    if (input.inviteId) params.set('inviteId', input.inviteId)
    if (input.limit) params.set('limit', String(input.limit))
    const suffix = params.toString()
    return apiFetch(`/admin/api/invite-deliveries${suffix ? `?${suffix}` : ''}`)
  },
  queueInviteDelivery: (input: { orgId?: string; inviteId?: string; email: string; onboardingUrl?: string | null; welcome?: string | null; kind?: string }) =>
    apiFetch('/admin/api/invite-deliveries', { method: 'POST', json: input }),
  claimInviteDeliveries: (input: { orgId?: string; inviteId?: string; provider?: string; statuses?: string[]; limit?: number } = {}) =>
    apiFetch('/admin/api/invite-deliveries/claim', { method: 'POST', json: input }),
  drainInviteDeliveries: (input: { orgId?: string; inviteId?: string; provider?: string; recordProvider?: string; statuses?: string[]; limit?: number } = {}) =>
    apiFetch('/admin/api/invite-deliveries/drain', { method: 'POST', json: input }),
  markInviteDelivery: (id: string, input: { status: string; provider?: string | null; providerMessageId?: string | null; lastError?: string | null }) =>
    apiFetch(`/admin/api/invite-deliveries/${encodeURIComponent(id)}/result`, { method: 'POST', json: input }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  sources: () => apiFetch('/admin/api/sources'),
  createSource: (input: { id: string; name?: string; federated?: boolean; remoteUrl?: string }) =>
    apiFetch('/admin/api/sources', { method: 'POST', json: input }),
  skills: () => apiFetch('/admin/api/skills'),
  saveSkill: (input: {
    id: string
    name: string
    owner?: string
    status?: string
    triggers?: string[]
    allowedClients?: string[]
    sourceAccess?: string[]
    description?: string
    enforcementStatus?: string
  }) => apiFetch('/admin/api/skills', { method: 'POST', json: input }),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  registerClient: (input: {
    name: string
    scopes: string
    tokenTtl?: number | null
    sourceId?: string
    federatedRead?: string[]
    grantTypes?: string[]
    redirectUris?: string[]
    tokenEndpointAuthMethod?: string
  }) => apiFetch('/admin/api/register-client', { method: 'POST', json: input }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) =>
    apiFetch('/admin/api/update-client-ttl', { method: 'POST', json: { clientId, tokenTtl } }),
  revokeClient: (clientId: string) =>
    apiFetch('/admin/api/revoke-client', { method: 'POST', json: { clientId } }),
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
}

export type Api = typeof api
