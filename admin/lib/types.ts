// Cortex Brain - Type Definitions
// Every type exists for a clear reason: to model the Cortex multi-tenant knowledge system

export type Environment = 'production' | 'staging' | 'development'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type SourceType = 'git' | 'local' | 'url'

export type SourcePreset = 'shared' | 'customers' | 'internal' | 'team'

// Organization - the top-level tenant
export interface Organization {
  id: string
  name: string
  slug: string
  logoUrl?: string
  createdAt: Date
  environment: Environment
}

// Brain - a knowledge base instance
export interface Brain {
  id: string
  orgId: string
  name: string
  url: string
  supabaseProject: string
  supabaseRegion: string
  railwayServices: RailwayService[]
  health: HealthStatus
  healthDetails: HealthIndicator[]
  region: string
  createdAt: Date
}

export interface RailwayService {
  name: string
  status: 'running' | 'stopped' | 'deploying' | 'failed'
  url?: string
}

export interface HealthIndicator {
  name: string
  status: HealthStatus
  message?: string
  lastChecked: Date
}

// Source - a knowledge source (repo, folder, URL)
export interface Source {
  id: string
  brainId: string
  name: string
  type: SourceType
  preset: SourcePreset
  path: string // repo URL, local path, or external URL
  branch?: string
  federated: boolean
  pageCount: number
  lastSync: Date | null
  syncFailures: number
  webhookSecret?: string
  contextualRetrieval: 'auto' | 'always' | 'never'
  folderConventions: FolderConvention[]
}

export interface FolderConvention {
  pattern: string
  action: 'include' | 'exclude'
  reason?: string
}

// Team member
export interface Member {
  id: string
  orgId: string
  userId: string
  name: string
  email: string
  avatarUrl?: string
  role: Role
  defaultSource: string | null
  readableSources: string[]
  status: 'active' | 'suspended'
  lastActive: Date
  joinedAt: Date
}

// Invite
export interface Invite {
  id: string
  orgId: string
  email: string
  role: Role
  writeSource: string | null
  federatedReadSources: string[]
  expiresAt: Date
  status: InviteStatus
  invitedBy: string
  createdAt: Date
  acceptedAt?: Date
}

// OAuth Client (Agent)
export interface Agent {
  id: string
  orgId: string
  name: string
  clientId: string
  scopes: AgentScope[]
  writeSource: string
  federatedReadSources: string[]
  tokenTtl: number // seconds
  requestsToday: number
  lastUsed: Date | null
  revoked: boolean
  createdAt: Date
}

export type AgentScope = 
  | 'read:sources'
  | 'write:sources'
  | 'read:skills'
  | 'execute:skills'
  | 'read:team'
  | 'admin:all'

// Skill
export interface Skill {
  id: string
  orgId: string
  name: string
  description: string
  triggers: string[]
  allowedClients: string[] | null // null = all clients
  allowedRoles: Role[] | null // null = all roles
  sourceAccess: string[] // source IDs
  cron?: string
  lastRun: Date | null
  ownerId: string
  schema: SkillSchema
  createdAt: Date
}

export interface SkillSchema {
  input: Record<string, unknown>
  output: Record<string, unknown>
}

// Job
export interface Job {
  id: string
  orgId: string
  brainId: string
  name: string
  type: JobType
  status: JobStatus
  progress: number // 0-100
  sourceId: string | null
  sourceName?: string
  budgetOwner: string
  startedAt: Date | null
  completedAt: Date | null
  duration: number | null // ms
  payload: Record<string, unknown>
  error?: string
  retries: number
}

export type JobType = 
  | 'sync'
  | 'embed'
  | 'reindex'
  | 'cleanup'
  | 'skill_execution'
  | 'health_check'

// Request log entry
export interface RequestLog {
  id: string
  orgId: string
  agentId: string
  agentName: string
  sourceId: string | null
  sourceName: string | null
  operation: RequestOperation
  status: 'success' | 'error' | 'rate_limited'
  timestamp: Date
  duration: number // ms
  metadata?: Record<string, unknown>
}

export type RequestOperation =
  | 'query'
  | 'index'
  | 'delete'
  | 'skill_call'
  | 'health'
  | 'config'

// Activity log for API monitoring
export type ActivityLogStatus = 'success' | 'error' | 'pending'

export interface ActivityLog {
  id: string
  timestamp: Date
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  endpoint: string
  status: ActivityLogStatus
  statusCode: number
  duration: number // ms
  agentId: string | null
  metadata?: Record<string, unknown>
}

// Dashboard stats
export interface DashboardStats {
  brainHealth: number // 0-100
  totalPages: number
  activeAgents: number
  requestsToday: number
  requestsTrend: number // percentage change
  sourceCount: number
  queuedJobs: number
  staleEmbeddings: number
  syncFailures: number
}

export interface RequestsOverTime {
  date: string
  requests: number
}

export interface JobsByType {
  type: JobType
  count: number
}

// Activity feed item
export interface ActivityItem {
  id: string
  type: 'source_synced' | 'member_joined' | 'agent_created' | 'skill_run' | 'job_failed' | 'health_changed'
  title: string
  description?: string
  timestamp: Date
  metadata?: Record<string, unknown>
}

// Onboarding state
export interface OnboardingState {
  currentStep: number
  completedSteps: number[]
  orgName?: string
  orgSlug?: string
  brainName?: string
  brainRegion?: string
  supabaseConnected: boolean
  railwayConnected: boolean
  providersConfigured: string[]
  firstSourceAdded: boolean
  firstInviteSent: boolean
  healthVerified: boolean
}

// Provider keys configuration
export interface ProviderConfig {
  provider: 'zeroentropy' | 'anthropic' | 'openai'
  configured: boolean
  lastTested: Date | null
  testStatus: 'success' | 'failed' | null
}

// Settings
export interface Settings {
  publicUrl: string
  corsOrigins: string[]
  trustProxy: boolean
  directPoolEnabled: boolean
  poolSize: number
  bootstrapTokenSet: boolean
  providers: ProviderConfig[]
}
