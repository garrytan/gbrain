// App-level constants
// Centralized configuration for consistent behavior

export const APP_NAME = 'Cortex Brain'
export const APP_DESCRIPTION = 'Multi-tenant knowledge management platform'

// Navigation structure - defines sidebar groups and items
export const NAVIGATION = {
  main: [
    { label: 'Overview', href: '/overview', icon: 'LayoutDashboard' },
    { label: 'Onboarding', href: '/onboarding', icon: 'Rocket' },
    { label: 'Brains', href: '/brains', icon: 'Brain' },
    { label: 'Sources', href: '/sources', icon: 'Database' },
  ],
  management: [
    { label: 'Team', href: '/team', icon: 'Users' },
    { label: 'Invites', href: '/invites', icon: 'UserPlus' },
  ],
  integrations: [
    { label: 'Composio', href: '/integrations', icon: 'PlugZap' },
    { label: 'Agents', href: '/agents', icon: 'Bot' },
    { label: 'Skills', href: '/skills', icon: 'Sparkles' },
    { label: 'Runtime', href: '/runtime', icon: 'KeyRound' },
  ],
  operations: [
    { label: 'Jobs', href: '/jobs', icon: 'Workflow' },
    { label: 'Activity', href: '/activity', icon: 'Activity' },
    { label: 'Quality', href: '/quality', icon: 'Gauge' },
  ],
} as const

// Role hierarchy for permission checks
export const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
}

// Role display labels
export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

// Status colors mapping
export const STATUS_COLORS = {
  healthy: 'bg-success text-success-foreground',
  degraded: 'bg-warning text-warning-foreground',
  unhealthy: 'bg-error text-error-foreground',
  unknown: 'bg-muted text-muted-foreground',
} as const

// Job status colors
export const JOB_STATUS_COLORS = {
  waiting: 'bg-muted text-muted-foreground',
  active: 'bg-info text-info-foreground',
  completed: 'bg-success text-success-foreground',
  failed: 'bg-error text-error-foreground',
  dead: 'bg-destructive text-destructive-foreground',
} as const

// Invite status colors
export const INVITE_STATUS_COLORS = {
  pending: 'bg-warning/10 text-warning border-warning/20',
  accepted: 'bg-success/10 text-success border-success/20',
  expired: 'bg-muted text-muted-foreground border-muted',
  revoked: 'bg-destructive/10 text-destructive border-destructive/20',
} as const

// Source type icons
export const SOURCE_TYPE_ICONS = {
  git: 'GitBranch',
  local: 'Folder',
  url: 'Globe',
} as const

// Source preset labels
export const SOURCE_PRESET_LABELS = {
  shared: 'Shared',
  customers: 'Customers',
  internal: 'Internal',
  team: 'Team',
} as const

// Token TTL options (in seconds)
export const TOKEN_TTL_OPTIONS = [
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 7200, label: '2 hours' },
  { value: 86400, label: '24 hours' },
  { value: 604800, label: '7 days' },
] as const

// Agent scopes with descriptions
export const AGENT_SCOPES = [
  { value: 'read:sources', label: 'Read Sources', description: 'Query knowledge from assigned sources' },
  { value: 'write:sources', label: 'Write Sources', description: 'Index new content to sources' },
  { value: 'read:skills', label: 'Read Skills', description: 'List available skills' },
  { value: 'execute:skills', label: 'Execute Skills', description: 'Run skills on behalf of users' },
  { value: 'read:team', label: 'Read Team', description: 'View team member information' },
  { value: 'admin:all', label: 'Admin Access', description: 'Full administrative access' },
] as const

// Environment badge colors
export const ENVIRONMENT_COLORS = {
  production: 'bg-success/10 text-success border-success/20',
  staging: 'bg-warning/10 text-warning border-warning/20',
  development: 'bg-info/10 text-info border-info/20',
} as const

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS = {
  commandMenu: 'mod+k',
  search: 'mod+/',
  newBrain: 'mod+b',
  newSource: 'mod+s',
  settings: 'mod+,',
} as const
