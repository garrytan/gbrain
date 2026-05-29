'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Workflow,
} from 'lucide-react'

import { api } from '@/lib/api'
import {
  buildOnboardingUrl,
  roleScopes,
  sourceOptions,
  type BrainSummary,
  type ControlPlaneMember,
  type InviteDelivery,
  type InviteDeliveryDrainResult,
  type OrgRole,
  type OrganizationSummary,
  type PlanSummary,
  type PlanUsageKey,
  type QualitySnapshot,
  type RuntimeManifest,
  type RuntimePackage,
  type RuntimeSetup,
  type SkillSummary,
  type SourceSummary,
  sanitizeSkillSummary,
} from '@/lib/saas-model'
import { ALLOWED_SCOPES_LIST, type Scope } from '@/lib/scope-constants'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

type AgentRow = {
  id: string
  name?: string
  client_name?: string
  client_id?: string
  auth_type?: 'oauth' | 'api_key'
  grant_types?: string[]
  scope?: string
  created_at?: string
  last_used_at?: string | null
  total_requests?: number
  requests_today?: number
  token_ttl?: number | null
  status?: 'active' | 'revoked'
  source_id?: string
  federated_read?: string[]
}

type RequestRow = {
  id: number
  token_name: string
  agent_name: string
  operation: string
  latency_ms: number
  status: string
  params: Record<string, unknown> | null
  error_message: string | null
  created_at: string
}

type JobsSnapshot = {
  ts_ms: number
  by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number }>
  queue_health: { waiting: number; active: number; stalled: number }
  lease_pressure_1h: number
  top_errors: Array<{ cluster: string; count: number }>
  budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }>
}

type ConnectorStatus = {
  id: string
  label: string
  category: string
  description: string
  scopes: string[]
  sourceId: string
  sourceName: string
  connected: boolean
  status: 'connected' | 'ready' | 'setup_required'
}

type IntegrationsResponse = {
  provider: string
  configured: boolean
  apiKeyConfigured: boolean
  webhookSecretConfigured: boolean
  dashboardUrl: string
  webhookUrl: string
  requiredEnv: string[]
  acceptedPayloads: string[]
  connectors: ConnectorStatus[]
}

const runtimeOrder = ['cortex_cli', 'claude_code', 'cursor', 'chatgpt', 'claude_desktop', 'perplexity']
const planMetrics: Array<[PlanUsageKey, string]> = [
  ['brains', 'Brains'],
  ['sources', 'Sources'],
  ['members', 'Members'],
  ['pending_invites', 'Pending invites'],
  ['agent_clients', 'Agent clients'],
  ['skill_policies', 'Skill policies'],
  ['requests_today', 'Requests today'],
  ['waiting_jobs', 'Waiting jobs'],
]
const planOptions = [
  { value: 'launch', label: 'Launch' },
  { value: 'team', label: 'Team' },
  { value: 'business', label: 'Business' },
  { value: 'enterprise', label: 'Enterprise' },
]
const onboardingProgressSteps: Array<{
  id: string
  title: string
  description: string
  icon: React.ElementType
}> = [
  { id: 'org', title: 'Organization', description: 'Create the tenant record', icon: Users },
  { id: 'brain', title: 'Brain', description: 'Attach a company brain', icon: Brain },
  { id: 'source', title: 'Sources', description: 'Scope writes and reads', icon: Database },
  { id: 'agent', title: 'Agent OAuth', description: 'Mint a source-scoped client', icon: KeyRound },
  { id: 'handoff', title: 'Handoff', description: 'Share the Cortex connect URL', icon: PlugZap },
  { id: 'verify', title: 'Verify', description: 'Run MCP and ingestion checks', icon: ShieldCheck },
]

function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-display tracking-normal">{title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  )
}

function ErrorBanner({ error }: { error?: string | null }) {
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

function StatusBadge({ status }: { status?: string | null }) {
  const normalized = (status || 'unknown').toLowerCase()
  const tone =
    normalized.includes('active') || normalized.includes('online') || normalized.includes('healthy') || normalized.includes('connected') || normalized.includes('passing')
      ? 'bg-success/10 text-success border-success/20'
      : normalized.includes('revoked') || normalized.includes('failed') || normalized.includes('error') || normalized.includes('dead')
        ? 'bg-error/10 text-error border-error/20'
        : 'bg-warning/10 text-warning border-warning/20'
  return (
    <Badge variant="outline" className={cn('capitalize', tone)}>
      {normalized.replace(/_/g, ' ')}
    </Badge>
  )
}

function CodeBlock({ value, minHeight = false }: { value: string; minHeight?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  const fallbackCopy = (text: string) => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  const copy = async () => {
    let copiedWithClipboard = false
    try {
      if (navigator.clipboard?.writeText && navigator.permissions?.query) {
        const permission = await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })
        if (permission.state === 'granted') {
          await navigator.clipboard.writeText(value)
          copiedWithClipboard = true
        }
      }
    } catch {
      copiedWithClipboard = false
    }
    if (!copiedWithClipboard) {
      fallbackCopy(value)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="relative min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/40 p-3">
      <pre className={cn('max-w-full overflow-x-auto pr-20 font-mono text-xs leading-relaxed text-muted-foreground', minHeight && 'min-h-32')}>
        {value}
      </pre>
      <Button type="button" size="sm" variant="secondary" className="absolute right-2 top-2 gap-1" onClick={copy}>
        <Copy data-icon="inline-start" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function EmptyRows({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  )
}

function OnboardingStepRail({
  completed,
  currentId,
}: {
  completed: Set<string>
  currentId: string
}) {
  const completedCount = onboardingProgressSteps.filter((step) => completed.has(step.id)).length
  const progress = Math.round((completedCount / onboardingProgressSteps.length) * 100)

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Setup path</CardTitle>
        <CardDescription>Same workflow for a human admin or an onboarding agent.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress value={progress} />
        <div className="flex flex-col gap-1">
          {onboardingProgressSteps.map((step) => {
            const Icon = step.icon
            const isComplete = completed.has(step.id)
            const isCurrent = step.id === currentId

            return (
              <div
                key={step.id}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 transition-colors',
                  isCurrent && 'bg-accent',
                  !isCurrent && !isComplete && 'opacity-60',
                )}
              >
                <div
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full border',
                    isComplete && 'border-primary bg-primary text-primary-foreground',
                    isCurrent && !isComplete && 'border-primary text-primary',
                  )}
                >
                  {isComplete ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{step.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{step.description}</div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function useBrowserOrigin() {
  const [origin, setOrigin] = React.useState('')

  React.useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  return origin
}

function normalizeSourceId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

function formatAge(ts?: string | null) {
  if (!ts) return 'Never'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return date.toLocaleDateString()
}

function formatTimestamp(ts?: string | null) {
  if (!ts) return 'not set'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

function fallbackManifest(): RuntimeManifest {
  const baseUrl = ''
  return {
    schema: 'cortex.runtime-manifest.v1',
    generated_at: 'local',
    product: { name: 'Cortex Company Brain', package: 'cortex', version: 'local' },
    tenant: { org_id: null, brain_id: null, email: null, role: null },
    endpoints: {
      base_url: baseUrl,
      mcp_url: `${baseUrl}/mcp`,
      token_url: `${baseUrl}/token`,
      oauth_authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      oauth_protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      runtime_manifest: `${baseUrl}/runtime-manifest.json`,
      runtime_package: `${baseUrl}/runtime-package.json`,
    },
    onboarding: {
      onboarding_url: `${baseUrl}/admin/onboarding?invite=<invite-payload>`,
      client_id: null,
      source_id: 'default',
      federated_read: ['default'],
      scopes: ['read', 'write'],
      secret_delivery: 'shown_once_out_of_band',
      connect_command: `cortex connect '${baseUrl}/admin/onboarding?invite=<invite-payload>' --client-secret '<one-time-secret>'`,
      env_connect_command: `CORTEX_REMOTE_CLIENT_SECRET='<one-time-secret>' cortex connect '${baseUrl}/admin/onboarding?invite=<invite-payload>'`,
    },
    runtimes: {},
    packages: {},
    agent_parity: {
      principle: 'Every tenant action available in the console has an agent-callable MCP operation.',
      operations: [],
    },
    skill_policy: {
      annotation_keys: ['_skill_id', 'skill_id', '_meta.skill_id'],
      enforcement: 'Runtime adapters pass skill ids so dispatch can enforce persisted policies.',
    },
  }
}

function runtimeSnippet(runtime: RuntimeSetup): string {
  if (runtime.command) return runtime.command
  if (runtime.config) return JSON.stringify(runtime.config, null, 2)
  if (runtime.connector) return JSON.stringify(runtime.connector, null, 2)
  return runtime.notes.join('\n')
}

function packageSnippet(pkg: RuntimePackage): string {
  return [
    pkg.install,
    '',
    `Artifact: ${pkg.artifact}`,
    `Supports: ${pkg.supported_runtimes.join(', ')}`,
    '',
    ...pkg.verification,
  ].join('\n')
}

export function LoginPage() {
  const [token, setToken] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await api.login(token)
      window.location.href = '/admin/overview/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Brain />
          </div>
          <CardTitle>Cortex admin</CardTitle>
          <CardDescription>Enter the bootstrap token to manage tenants, brains, agents, and integrations.</CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="token">Bootstrap token</Label>
              <Input id="token" value={token} onChange={(event) => setToken(event.target.value)} autoFocus />
            </div>
            <ErrorBanner error={error} />
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button className="w-full gap-2" disabled={loading || !token.trim()}>
              {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
              Sign in
            </Button>
            <Button className="w-full" variant="ghost" asChild>
              <Link href="/signup">Create a tenant</Link>
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  )
}

export function SignupPage() {
  const [orgName, setOrgName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [domain, setDomain] = React.useState('')
  const [result, setResult] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      setResult(await api.signup({ orgName, email, domain }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed')
    } finally {
      setLoading(false)
    }
  }

  const clientId = result?.clientId || result?.client_id || ''
  const clientSecret = result?.clientSecret || result?.client_secret || ''
  const connectCommand = result?.connectCommand || (result?.onboarding_url && clientSecret
    ? `cortex connect '${result.onboarding_url}' --client-secret '${clientSecret}'`
    : '')

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Brain />
          </div>
          <CardTitle>Create a Cortex tenant</CardTitle>
          <CardDescription>Generate the onboarding URL an agent can open to register the organization and connect.</CardDescription>
        </CardHeader>
        {!result ? (
          <form onSubmit={submit}>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="org">Organization</Label>
                <Input id="org" value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="Company name" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Work email</Label>
                <Input id="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <Label htmlFor="domain">Domain</Label>
                <Input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="company.com" />
              </div>
              <div className="md:col-span-2">
                <ErrorBanner error={error} />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3 sm:flex-row">
              <Button className="w-full gap-2 sm:w-auto" disabled={loading || !orgName.trim() || !email.trim()}>
                {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}
                Create tenant
              </Button>
              <Button variant="outline" asChild>
                <Link href="/docs">Agent docs</Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link href="/login">Admin login</Link>
              </Button>
            </CardFooter>
          </form>
        ) : (
          <CardContent className="flex flex-col gap-4">
            <StatusBadge status="connected" />
            <CodeBlock value={result.onboarding_url || ''} />
            {connectCommand ? <CodeBlock value={connectCommand} /> : null}
            {clientId ? <CodeBlock value={clientId} /> : null}
            {clientSecret ? <CodeBlock value={clientSecret} /> : null}
            <Alert>
              <AlertDescription>{result.secret_notice || 'Save the secret now. It cannot be shown again.'}</AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Card>
    </main>
  )
}

export function RootRedirectPage() {
  const router = useRouter()

  React.useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '')
    const [raw, hashQuery] = hash.split('?')
    const known = new Set([
      'overview',
      'brains',
      'sources',
      'team',
      'invites',
      'agents',
      'skills',
      'jobs',
      'activity',
      'integrations',
      'runtime',
      'quality',
      'settings',
      'onboarding',
      'docs',
      'login',
      'signup',
    ])
    const query = hashQuery ? `?${hashQuery}` : window.location.search
    router.replace(raw && known.has(raw) ? `/${raw}${query}` : '/overview')
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      Loading Cortex...
    </main>
  )
}

export function DocsPage() {
  const browserOrigin = useBrowserOrigin()
  const baseUrl = browserOrigin || 'https://<tenant-host>'
  const signupPayload = JSON.stringify({
    orgName: 'Company name',
    email: 'owner@company.com',
    domain: 'company.com',
  }, null, 2)

  const signupCurl = `curl -X POST '${baseUrl}/admin/api/signup' \\
  -H 'content-type: application/json' \\
  -d '${signupPayload.replace(/'/g, "'\\''")}'`

  const inviteCurl = `curl '${baseUrl}/runtime-manifest.json'

# After signup or invite, connect the hosted tenant. The URL contains client id
# and source scope; the one-time secret is delivered out of band.
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'`

  const mcpCurl = `curl -X POST '${baseUrl}/token' \\
  -H 'content-type: application/x-www-form-urlencoded' \\
  -d 'grant_type=client_credentials&client_id=<client-id>&client_secret=<client-secret>&scope=read%20write'

curl -X POST '${baseUrl}/mcp' \\
  -H 'authorization: Bearer <access-token>' \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list","params":{}}'`

  const agentChecklist = [
    'Open the Cortex docs URL and create or join a tenant.',
    'Save the one-time client secret immediately; it is never shown again.',
    'Use the onboarding URL with cortex connect so the runtime stays thin and hosted.',
    'Create team, repo, department, or connector boundaries as sources inside the first company brain.',
    'Create another brain only for a hard database, region, lifecycle, backup, or compliance boundary.',
    'Use Composio connectors or webhooks to ingest third-party systems into explicit sources.',
    'Register each teammate, runtime, or automation as its own OAuth client with one write source and a federated-read list.',
    'Promote skills only after their allowed clients and source access are explicit.',
  ]

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:py-12">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <Button variant="ghost" className="w-fit px-0" asChild>
              <Link href="/signup"><ArrowRight className="rotate-180" data-icon="inline-start" /> Back to signup</Link>
            </Button>
            <Badge variant="outline" className="w-fit">Agent onboarding</Badge>
            <h1 className="text-display tracking-normal">Cortex setup docs for humans and agents</h1>
            <p className="text-base leading-7 text-muted-foreground">
              Send this page to an MCP-compatible agent. It can create an organization, receive an onboarding URL,
              connect to the hosted brain, invite users, register scoped clients, and start seeding sources.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-md border bg-card p-4 text-sm">
            <span className="text-muted-foreground">Public docs URL</span>
            <CodeBlock value={`${baseUrl}/admin/docs/`} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>1. Create tenant</CardTitle>
              <CardDescription>Public signup returns org, brain, owner client, onboarding URL, and one-time secret.</CardDescription>
            </CardHeader>
            <CardContent><CodeBlock value={signupCurl} minHeight /></CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>2. Connect runtime</CardTitle>
              <CardDescription>Install or configure a thin client against the hosted MCP endpoint.</CardDescription>
            </CardHeader>
            <CardContent><CodeBlock value={inviteCurl} minHeight /></CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>3. Verify MCP</CardTitle>
              <CardDescription>Exchange OAuth credentials, then list Cortex tools from the hosted endpoint.</CardDescription>
            </CardHeader>
            <CardContent><CodeBlock value={mcpCurl} minHeight /></CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Company-brain model</CardTitle>
              <CardDescription>Follow the Cortex tenant hierarchy from the company-brain guide.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Layer</TableHead>
                    <TableHead>Use it for</TableHead>
                    <TableHead>Rule</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Organization</TableCell>
                    <TableCell>Tenant, billing, domain, members, invites, and plan limits.</TableCell>
                    <TableCell>One customer company per organization.</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Brain</TableCell>
                    <TableCell>Hard database and deployment boundary.</TableCell>
                    <TableCell>Start with one; add more for hard isolation only.</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Source</TableCell>
                    <TableCell>Team, repo, customer, department, or connector boundary inside a brain.</TableCell>
                    <TableCell>Use sources for normal team and sub-brain shape.</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Agent client</TableCell>
                    <TableCell>OAuth credential for one teammate, automation, or runtime.</TableCell>
                    <TableCell>One write source; explicit federated-read list.</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Skill policy</TableCell>
                    <TableCell>Which clients can run which capabilities against which sources.</TableCell>
                    <TableCell>Draft, test, then promote with source access locked down.</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agent checklist</CardTitle>
              <CardDescription>Minimum flow before handing Cortex to a teammate or external runtime.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {agentChecklist.map((item) => (
                <div key={item} className="flex items-start gap-2 text-sm leading-6">
                  <CheckCircle2 className="mt-0.5 text-success" />
                  <span>{item}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Console paths</CardTitle>
              <CardDescription>Every console action has an agent-callable equivalent.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <KeyValue label="Signup" value={`${baseUrl}/admin/signup/`} />
              <KeyValue label="Agent signup API" value={`${baseUrl}/admin/api/signup`} />
              <KeyValue label="Compatibility signup API" value={`${baseUrl}/api/signup`} />
              <KeyValue label="Onboarding" value={`${baseUrl}/admin/onboarding?invite=<invite-payload>`} />
              <KeyValue label="Runtime manifest" value={`${baseUrl}/runtime-manifest.json`} />
              <KeyValue label="Runtime package" value={`${baseUrl}/runtime-package.json`} />
              <KeyValue label="MCP" value={`${baseUrl}/mcp`} />
              <KeyValue label="Composio webhook" value={`${baseUrl}/webhooks/composio`} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Seeding guidance</CardTitle>
              <CardDescription>Make the first query feel specific before broad rollout.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm leading-6 text-muted-foreground">
              <p>Create one shared source, one team or customer source, and one restricted source before inviting the first users.</p>
              <p>Seed each teammate source with a profile page, priority list, useful links, recent meetings, and two or three recognizable examples.</p>
              <p>Verify isolation with two scoped clients before broad access: a query in one source should not reveal content from another unless federated-read allows it.</p>
            </CardContent>
            <CardFooter className="flex flex-col gap-3 sm:flex-row">
              <Button asChild><Link href="/signup">Create tenant</Link></Button>
              <Button variant="outline" asChild><Link href="/runtime">Runtime setup</Link></Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </main>
  )
}

export function OverviewPage() {
  const browserOrigin = useBrowserOrigin()
  const [stats, setStats] = React.useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 })
  const [health, setHealth] = React.useState({ expiring_soon: 0, error_rate: '0%' })
  const [events, setEvents] = React.useState<any[]>([])
  const [sseStatus, setSseStatus] = React.useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  React.useEffect(() => {
    const load = () => {
      api.stats().then(setStats).catch(() => undefined)
      api.health().then(setHealth).catch(() => undefined)
    }
    load()
    const interval = window.setInterval(load, 30000)
    const es = new EventSource('/admin/events')
    es.onopen = () => setSseStatus('connected')
    es.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data)
        setEvents((prev) => [next, ...prev].slice(0, 20))
      } catch {
        // ignore malformed event payloads
      }
    }
    es.onerror = () => setSseStatus('disconnected')
    return () => {
      window.clearInterval(interval)
      es.close()
    }
  }, [])

  const readiness = [
    ['Hosted MCP endpoint', true],
    ['OAuth client credentials', true],
    ['Source-scoped team invites', true],
    ['Composio ingestion webhook', true],
  ] as const

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Hosted Cortex control plane for tenants, brains, source-scoped agents, ingestion, and live usage."
        action={<Button asChild><Link href="/onboarding">Open onboarding</Link></Button>}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Connected agents" value={stats.connected_agents} icon={<Bot />} />
        <MetricCard title="Requests today" value={stats.requests_today} icon={<Activity />} />
        <MetricCard title="Active tokens" value={stats.active_tokens} icon={<KeyRound />} />
        <MetricCard title="Error rate" value={health.error_rate} icon={<ShieldCheck />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
            <CardDescription>
              Stream status: <span className={cn(sseStatus === 'connected' && 'text-success', sseStatus === 'disconnected' && 'text-error')}>{sseStatus}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
                  <EmptyRows colSpan={5} label={sseStatus === 'connected' ? 'No requests yet.' : 'Connecting to live events...'} />
                ) : events.map((event, index) => (
                  <TableRow key={`${event.timestamp}-${index}`}>
                    <TableCell className="font-mono text-xs">{event.agent}</TableCell>
                    <TableCell className="font-mono text-xs">{event.operation}</TableCell>
                    <TableCell>{String(event.scopes || '').split(',').map((scope: string) => <Badge key={scope} variant="outline" className="mr-1">{scope.trim()}</Badge>)}</TableCell>
                    <TableCell>{event.latency_ms} ms</TableCell>
                    <TableCell><StatusBadge status={event.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>SaaS readiness</CardTitle>
              <CardDescription>YC demo-critical platform pieces.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {readiness.map(([label, done]) => (
                <div key={label} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className={done ? 'text-success' : 'text-muted-foreground'} />
                  {label}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Agent contract</CardTitle>
              <CardDescription>Remote clients discover Cortex over MCP OAuth.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <KeyValue label="MCP" value={browserOrigin ? `${browserOrigin}/mcp` : '/mcp'} />
              <KeyValue label="Token" value={browserOrigin ? `${browserOrigin}/token` : '/token'} />
              <KeyValue label="Expiring soon" value={String(health.expiring_soon)} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ title, value, icon }: { title: string; value: React.ReactNode; icon: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tracking-normal">{value}</div>
      </CardContent>
    </Card>
  )
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(6.5rem,0.45fr)_minmax(0,1fr)] items-start gap-3">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{value}</span>
    </div>
  )
}

export function OnboardingPage() {
  const browserOrigin = useBrowserOrigin()
  const params = useSearchParams()
  const [mounted, setMounted] = React.useState(false)
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [orgName, setOrgName] = React.useState('')
  const [domain, setDomain] = React.useState('')
  const [ownerEmail, setOwnerEmail] = React.useState('')
  const [brainName, setBrainName] = React.useState('Company Brain')
  const [agentName, setAgentName] = React.useState('')
  const [role, setRole] = React.useState<OrgRole>('member')
  const [writeSource, setWriteSource] = React.useState('default')
  const [org, setOrg] = React.useState<OrganizationSummary | null>(null)
  const [brain, setBrain] = React.useState<BrainSummary | null>(null)
  const [inviteUrl, setInviteUrl] = React.useState('')
  const [client, setClient] = React.useState<{ clientId: string; clientSecret?: string } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const decodedInvite = React.useMemo(() => {
    if (!mounted) return null
    const raw = params.get('invite')
    if (!raw) return null
    try {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
      const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0))
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return { error: 'Could not decode invite payload' }
    }
  }, [mounted, params])

  React.useEffect(() => {
    if (decodedInvite) {
      const invite = decodedInvite as Record<string, unknown>
      const sourceId = typeof invite.source_id === 'string'
        ? invite.source_id
        : (typeof invite.write_source === 'string' ? invite.write_source : 'default')
      setSources(sourceOptions([]))
      setWriteSource(sourceId)
      if (typeof invite.org === 'string') setOrgName(invite.org)
      if (typeof invite.domain === 'string') setDomain(invite.domain)
      if (typeof invite.email === 'string') setOwnerEmail(invite.email)
      if (typeof invite.brain === 'string') setBrainName(invite.brain)
      if (typeof invite.role === 'string' && ['owner', 'admin', 'member', 'viewer'].includes(invite.role)) {
        setRole(invite.role as OrgRole)
      }
      if (typeof invite.client_id === 'string') setClient({ clientId: invite.client_id })
      setInviteUrl(window.location.href)
      return
    }

    setSources(sourceOptions([]))
    setWriteSource('default')
  }, [decodedInvite])

  const allSources = sourceOptions(sources)
  const inviteFederatedRead = Array.isArray((decodedInvite as Record<string, unknown> | null)?.federated_read)
    ? ((decodedInvite as Record<string, unknown>).federated_read as unknown[]).map((value) => String(value)).filter(Boolean)
    : []
  const readableSources = inviteFederatedRead.length > 0
    ? inviteFederatedRead
    : Array.from(new Set([writeSource, ...allSources.filter((source) => source.federated).map((source) => source.id)]))
  const payload = {
    org: orgName,
    org_id: org?.id,
    domain,
    brain: brainName,
    brain_id: brain?.id,
    role,
    source_id: writeSource,
    write_source: writeSource,
    federated_read: readableSources,
    server_url: browserOrigin ? `${browserOrigin}/mcp` : '/mcp',
    token_url: browserOrigin ? `${browserOrigin}/token` : '/token',
    scopes: roleScopes[role],
    client_id: client?.clientId,
  }
  const connectCommand = inviteUrl
    ? `cortex connect '${inviteUrl}' --client-secret '${client?.clientSecret || '<one-time-secret>'}'`
    : ''
  const completedOnboardingSteps = new Set<string>([
    org ? 'org' : '',
    brain ? 'brain' : '',
    readableSources.length > 0 ? 'source' : '',
    client ? 'agent' : '',
    inviteUrl ? 'handoff' : '',
    org && brain && client && inviteUrl ? 'verify' : '',
  ].filter(Boolean))
  const currentOnboardingStep = onboardingProgressSteps.find((step) => !completedOnboardingSteps.has(step.id))?.id ?? 'verify'

  const createOrgAndBrain = async () => {
    setLoading(true)
    setError('')
    try {
      const orgResult = await api.createOrg({ name: orgName, domain, ownerEmail })
      const createdOrg = orgResult.org as OrganizationSummary
      const createdBrain = await api.createBrain({ orgId: createdOrg.id, name: brainName, publicUrl: window.location.origin, status: 'online' }) as BrainSummary
      setOrg(createdOrg)
      setBrain(createdBrain)
      setInviteUrl(buildOnboardingUrl({ ...payload, org_id: createdOrg.id, brain_id: createdBrain.id }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create organization')
    } finally {
      setLoading(false)
    }
  }

  const registerAgent = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.registerClient({
        name: agentName,
        scopes: roleScopes[role],
        tokenTtl: 604800,
        sourceId: writeSource,
        federatedRead: readableSources,
      })
      setClient({ clientId: result.clientId, clientSecret: result.clientSecret })
      setInviteUrl(buildOnboardingUrl({ ...payload, client_id: result.clientId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register agent')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Onboarding"
        description="Create the tenant shape, bind an agent to source-scoped OAuth, and hand off a single Cortex URL."
        action={
          <>
            <Button variant="outline" onClick={createOrgAndBrain} disabled={loading || !orgName.trim() || !ownerEmail.trim() || !brainName.trim()}>Create org</Button>
            <Button onClick={registerAgent} disabled={loading || !agentName.trim()}>Create agent client</Button>
          </>
        }
      />
      <ErrorBanner error={error} />

      <div className="grid gap-4 xl:grid-cols-[300px_1fr]">
        <OnboardingStepRail completed={completedOnboardingSteps} currentId={currentOnboardingStep} />
        <div className="flex flex-col gap-4">
          {(inviteUrl || client) ? (
            <Card>
              <CardHeader>
                <CardTitle>Onboarding handoff</CardTitle>
                <CardDescription>Give this to the registering agent or teammate.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {connectCommand ? <CodeBlock value={connectCommand} /> : null}
                {inviteUrl ? <CodeBlock value={inviteUrl} /> : null}
                {client?.clientId ? <CodeBlock value={client.clientId} /> : null}
                {client?.clientSecret ? <CodeBlock value={client.clientSecret} /> : null}
              </CardContent>
            </Card>
          ) : null}

          {decodedInvite ? (
            <Card>
              <CardHeader>
                <CardTitle>Incoming invite payload</CardTitle>
                <CardDescription>This is what an agent receives from the onboarding link.</CardDescription>
              </CardHeader>
              <CardContent><CodeBlock value={JSON.stringify(decodedInvite, null, 2)} /></CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader>
                <CardTitle>Tenant setup</CardTitle>
                <CardDescription>Organizations can own multiple brains; teams usually start with one brain and multiple sources.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <Field label="Organization" id="onboarding-org-name"><Input value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="Company name" /></Field>
                <Field label="Domain" id="onboarding-domain"><Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="company.com" /></Field>
                <Field label="Owner email" id="onboarding-owner-email"><Input value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@company.com" /></Field>
                <Field label="Brain name" id="onboarding-brain-name"><Input value={brainName} onChange={(event) => setBrainName(event.target.value)} /></Field>
                <Field label="Agent name" id="onboarding-agent-name"><Input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="agent-runtime" /></Field>
                <Field label="Write source">
                  <Select value={writeSource} onValueChange={setWriteSource}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{allSources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="Role">
                  <Select value={role} onValueChange={(value) => setRole(value as OrgRole)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['owner', 'admin', 'member', 'viewer'] as OrgRole[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Access contract</CardTitle>
                <CardDescription>OAuth scope, write source, federated reads, and hosted MCP endpoint.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <KeyValue label="Scopes" value={roleScopes[role]} />
                <KeyValue label="Write source" value={writeSource} />
                <KeyValue label="Federated read" value={readableSources.join(', ')} />
                <KeyValue label="MCP" value={browserOrigin ? `${browserOrigin}/mcp` : '/mcp'} />
              </CardContent>
              <CardFooter>
                <Button variant="outline" className="w-full" onClick={() => setInviteUrl(buildOnboardingUrl(payload))}>Generate onboarding URL</Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children, id }: { label: string; children: React.ReactNode; id?: string }) {
  const control = id && React.isValidElement<{ id?: string }>(children)
    ? React.cloneElement(children, { id: children.props.id ?? id })
    : children

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  )
}

export function BrainsPage() {
  const browserOrigin = useBrowserOrigin()
  const [orgs, setOrgs] = React.useState<OrganizationSummary[]>([])
  const [brains, setBrains] = React.useState<BrainSummary[]>([])
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [name, setName] = React.useState('')
  const [region, setRegion] = React.useState('')
  const [orgId, setOrgId] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(() => {
    api.orgs().then((rows: OrganizationSummary[]) => {
      setOrgs(rows)
      setOrgId((current) => current || rows[0]?.id || '')
    }).catch(() => undefined)
    api.brains().then((rows: BrainSummary[]) => setBrains(rows)).catch(() => undefined)
    api.sources().then((rows: SourceSummary[]) => setSources(rows)).catch(() => setSources(sourceOptions([])))
  }, [])

  React.useEffect(load, [load])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await api.createBrain({ orgId: orgId || undefined, name, publicUrl: window.location.origin, region, status: 'online' })
      setName('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create brain')
    } finally {
      setLoading(false)
    }
  }

  const allSources = sourceOptions(sources)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Brains" description="Brains are hard isolation boundaries; sources are team and corpus boundaries inside a brain." />
      <ErrorBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Create brain</CardTitle><CardDescription>Use separate brains for data residency, lifecycle, or customer isolation.</CardDescription></CardHeader>
        <form onSubmit={create}>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Field label="Name" id="brain-name"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Company Brain" /></Field>
            <Field label="Region" id="brain-region"><Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="us-west-2" /></Field>
            <Field label="Organization">
              <Select value={orgId || 'default'} onValueChange={(value) => setOrgId(value === 'default' ? '' : value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default organization</SelectItem>
                  {orgs.map((org) => <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
          <CardFooter><Button disabled={loading || !name.trim()}>{loading ? 'Creating...' : 'Create brain'}</Button></CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>Brain registry</CardTitle><CardDescription>{brains.length} deployed brain boundary.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>URL</TableHead><TableHead>Sources</TableHead><TableHead>Pages</TableHead><TableHead>Region</TableHead></TableRow></TableHeader>
            <TableBody>
              {brains.length === 0 ? <EmptyRows colSpan={6} label="No brains created yet." /> : brains.map((brain) => (
                <TableRow key={brain.id}>
                  <TableCell className="font-medium">{brain.name}</TableCell>
                  <TableCell><StatusBadge status={brain.status} /></TableCell>
                  <TableCell className="max-w-xs break-all font-mono text-xs">{brain.public_url || browserOrigin}</TableCell>
                  <TableCell>{allSources.length}</TableCell>
                  <TableCell>{allSources.reduce((sum, source) => sum + (source.page_count || 0), 0)}</TableCell>
                  <TableCell>{brain.region || 'default'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export function SourcesPage() {
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [remoteUrl, setRemoteUrl] = React.useState('')
  const [federated, setFederated] = React.useState(true)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(() => {
    api.sources().then((rows: SourceSummary[]) => setSources(rows)).catch(() => setSources(sourceOptions([])))
  }, [])
  React.useEffect(load, [load])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const sourceId = normalizeSourceId(id || name)
    if (!sourceId) {
      setError('Source id required')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.createSource({ id: sourceId, name: name || sourceId, federated, remoteUrl: remoteUrl || undefined })
      setId('')
      setName('')
      setRemoteUrl('')
      setFederated(true)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create source')
    } finally {
      setLoading(false)
    }
  }

  const allSources = sourceOptions(sources)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Sources" description="Team, repo, customer, and tool-ingestion boundaries inside a Cortex brain." />
      <ErrorBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Add source</CardTitle><CardDescription>Bind future agents and skills to this source id.</CardDescription></CardHeader>
        <form onSubmit={submit}>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Display name" id="source-display-name"><Input value={name} onChange={(event) => { setName(event.target.value); if (!id) setId(normalizeSourceId(event.target.value)) }} placeholder="Engineering" /></Field>
            <Field label="Source id" id="source-id"><Input value={id} onChange={(event) => setId(normalizeSourceId(event.target.value))} placeholder="engineering" /></Field>
            <Field label="Remote URL" id="source-remote-url"><Input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/company/wiki.git" /></Field>
            <label className="flex items-center gap-2 self-end text-sm"><Checkbox checked={federated} onCheckedChange={(value) => setFederated(Boolean(value))} /> Include in federated search</label>
          </CardContent>
          <CardFooter><Button disabled={loading}>{loading ? 'Adding...' : 'Add source'}</Button></CardFooter>
        </form>
      </Card>
      <Card>
        <CardHeader><CardTitle>Source registry</CardTitle><CardDescription>{allSources.length} source-scoped memory partitions.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Federated</TableHead><TableHead>Pages</TableHead><TableHead>Remote</TableHead><TableHead>Last sync</TableHead></TableRow></TableHeader>
            <TableBody>
              {allSources.map((source) => (
                <TableRow key={source.id}>
                  <TableCell><div className="font-medium">{source.name}</div><div className="font-mono text-xs text-muted-foreground">{source.id}</div></TableCell>
                  <TableCell><StatusBadge status={source.federated ? 'connected' : 'isolated'} /></TableCell>
                  <TableCell>{source.page_count || 0}</TableCell>
                  <TableCell className="max-w-xs break-all font-mono text-xs">{source.remote_url || source.local_path || 'managed by API'}</TableCell>
                  <TableCell>{source.last_sync_at ? new Date(source.last_sync_at).toLocaleString() : 'not synced'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export function TeamPage({ invitesOnly = false }: { invitesOnly?: boolean }) {
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [members, setMembers] = React.useState<ControlPlaneMember[]>([])
  const [invites, setInvites] = React.useState<any[]>([])
  const [deliveries, setDeliveries] = React.useState<InviteDelivery[]>([])
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<OrgRole>('member')
  const [writeSource, setWriteSource] = React.useState('default')
  const [readableSources, setReadableSources] = React.useState<string[]>(['default'])
  const [welcome, setWelcome] = React.useState('Your Cortex brain is ready. Connect your agent with the link below.')
  const [handoff, setHandoff] = React.useState<{ url: string; clientId?: string; clientSecret?: string; deliveryStatus?: string } | null>(null)
  const [error, setError] = React.useState('')
  const [deliveryNotice, setDeliveryNotice] = React.useState('')
  const [deliveryBusy, setDeliveryBusy] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(() => {
    api.sources().then((rows: SourceSummary[]) => {
      const options = sourceOptions(rows)
      setSources(rows)
      setWriteSource((current) => current || options[0]?.id || 'default')
      setReadableSources(options.filter((source) => source.federated).map((source) => source.id))
    }).catch(() => setSources(sourceOptions([])))
    api.team().then((rows: ControlPlaneMember[]) => setMembers(rows)).catch(() => undefined)
    api.invites().then((rows: any[]) => setInvites(rows)).catch(() => undefined)
    api.inviteDeliveries({ limit: 25 }).then((rows: InviteDelivery[]) => setDeliveries(rows)).catch(() => undefined)
  }, [])
  React.useEffect(load, [load])

  const allSources = sourceOptions(sources)
  const toggleReadable = (sourceId: string) => {
    setReadableSources((prev) => prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId])
  }

  const invite = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim()) {
      setError('Email required')
      return
    }
    setLoading(true)
    setError('')
    try {
      const effectiveReads = Array.from(new Set([writeSource, ...readableSources]))
      const result = await api.createInvite({ email: email.trim(), role, sourceId: writeSource, federatedRead: effectiveReads, welcome })
      setHandoff({ url: result.onboardingUrl, clientId: result.clientId, clientSecret: result.clientSecret, deliveryStatus: result.inviteDelivery?.status })
      setEmail('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create invite')
    } finally {
      setLoading(false)
    }
  }

  const claimDeliveryBatch = async () => {
    setDeliveryBusy('claim')
    setDeliveryNotice('')
    setError('')
    try {
      const claimed = await api.claimInviteDeliveries({ limit: 10 }) as InviteDelivery[]
      setDeliveryNotice(claimed.length ? `Claimed ${claimed.length} delivery record${claimed.length === 1 ? '' : 's'} for processing.` : 'No queued delivery records to claim.')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not claim delivery records')
    } finally {
      setDeliveryBusy('')
    }
  }

  const markDelivery = async (row: InviteDelivery, status: 'sent' | 'failed') => {
    setDeliveryBusy(`${status}:${row.id}`)
    setDeliveryNotice('')
    setError('')
    try {
      await api.markInviteDelivery(row.id, {
        status,
        provider: row.provider,
        providerMessageId: status === 'sent' ? `console-${row.id}` : null,
        lastError: status === 'failed' ? 'Marked failed from Cortex console.' : null,
      })
      setDeliveryNotice(status === 'sent' ? `Marked ${row.email} as sent.` : `Marked ${row.email} as failed.`)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update delivery record')
    } finally {
      setDeliveryBusy('')
    }
  }

  const drainDeliveryBatch = async () => {
    setDeliveryBusy('drain')
    setDeliveryNotice('')
    setError('')
    try {
      const result = await api.drainInviteDeliveries({ limit: 10 }) as InviteDeliveryDrainResult
      if (!result.configured) {
        setDeliveryNotice(result.message || `Email provider is not configured. Required: ${result.required_env.join(', ')}`)
      } else if (result.claimed === 0) {
        setDeliveryNotice('No queued delivery records to send.')
      } else {
        setDeliveryNotice(`Sent ${result.sent} delivery record${result.sent === 1 ? '' : 's'} with ${result.provider}; ${result.failed} failed.`)
      }
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send delivery records')
    } finally {
      setDeliveryBusy('')
    }
  }

  const handoffCommand = handoff?.clientId ? `cortex connect '${handoff.url}' --client-secret '${handoff.clientSecret || '<one-time-secret>'}'` : ''

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={invitesOnly ? 'Invites' : 'Team'} description="Invite people and agents with source-scoped OAuth clients and a single onboarding URL." />
      <ErrorBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Create invite</CardTitle><CardDescription>Each invite can provision a Cortex OAuth client for the teammate or registering agent.</CardDescription></CardHeader>
        <form onSubmit={invite}>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Email" id="invite-email"><Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" /></Field>
            <Field label="Role">
              <Select value={role} onValueChange={(value) => setRole(value as OrgRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(['owner', 'admin', 'member', 'viewer'] as OrgRole[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Write source">
              <Select value={writeSource} onValueChange={setWriteSource}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{allSources.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Welcome message" id="invite-welcome-message"><Input value={welcome} onChange={(event) => setWelcome(event.target.value)} /></Field>
            <div className="flex flex-col gap-2 md:col-span-2">
              <Label>Readable sources</Label>
              <div className="flex flex-wrap gap-2">
                {allSources.map((source) => (
                  <label key={source.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox checked={readableSources.includes(source.id)} onCheckedChange={() => toggleReadable(source.id)} />
                    {source.name}
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
          <CardFooter><Button disabled={loading}>{loading ? 'Creating...' : 'Create invite and agent client'}</Button></CardFooter>
        </form>
      </Card>

      {handoff ? (
        <Card>
          <CardHeader><CardTitle>Invite handoff</CardTitle><CardDescription>Send this URL or command to the registering agent.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CodeBlock value={handoff.url} />
            {handoffCommand ? <CodeBlock value={handoffCommand} /> : null}
            {handoff.clientId ? <CodeBlock value={handoff.clientId} /> : null}
            {handoff.clientSecret ? <CodeBlock value={handoff.clientSecret} /> : null}
            {handoff.deliveryStatus ? <Badge variant="outline">Delivery {handoff.deliveryStatus}</Badge> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{invitesOnly ? 'Pending invites' : 'Members'}</CardTitle><CardDescription>{invitesOnly ? invites.length : members.length} rows in the control plane.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Write source</TableHead>
                <TableHead>Readable sources</TableHead>
                <TableHead>Status</TableHead>
                {invitesOnly ? <TableHead>Delivery</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invitesOnly ? invites : members).length === 0 ? <EmptyRows colSpan={invitesOnly ? 6 : 5} label="No rows yet." /> : (invitesOnly ? invites : members).map((row: any) => (
                <TableRow key={row.id || row.email}>
                  <TableCell>{row.email}</TableCell>
                  <TableCell><Badge variant="outline">{row.role}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{row.source_id || row.writeSource}</TableCell>
                  <TableCell>{(row.federated_read || row.readableSources || []).map((source: string) => <Badge key={source} variant="outline" className="mr-1">{source}</Badge>)}</TableCell>
                  <TableCell><StatusBadge status={row.status || 'invited'} /></TableCell>
                  {invitesOnly ? <TableCell><StatusBadge status={row.delivery_status || 'not_queued'} /></TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {invitesOnly ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Delivery outbox</CardTitle>
              <CardDescription>{deliveries.length} recent invite delivery records.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="gap-2" onClick={claimDeliveryBatch} disabled={Boolean(deliveryBusy)}>
                {deliveryBusy === 'claim' ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                Claim batch
              </Button>
              <Button type="button" className="gap-2" onClick={drainDeliveryBatch} disabled={Boolean(deliveryBusy)}>
                {deliveryBusy === 'drain' ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
                Send batch
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {deliveryNotice ? <Alert className="mb-4"><AlertDescription>{deliveryNotice}</AlertDescription></Alert> : null}
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Kind</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {deliveries.length === 0 ? <EmptyRows colSpan={6} label="No delivery records yet." /> : deliveries.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.email}</TableCell>
                    <TableCell><Badge variant="outline">{row.kind.replace(/_/g, ' ')}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{row.provider}</TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell>{formatAge(row.updated_at)}</TableCell>
                    <TableCell>
                      {row.status === 'sending' ? (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" disabled={Boolean(deliveryBusy)} onClick={() => markDelivery(row, 'sent')}>Mark sent</Button>
                          <Button size="sm" variant="ghost" disabled={Boolean(deliveryBusy)} onClick={() => markDelivery(row, 'failed')}>Mark failed</Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{row.status === 'sent' ? 'Delivered' : 'Claim first'}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

export function AgentsPage() {
  const [agents, setAgents] = React.useState<AgentRow[]>([])
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [name, setName] = React.useState('yc-demo-agent')
  const [scopes, setScopes] = React.useState<Record<Scope, boolean>>(() => Object.fromEntries(ALLOWED_SCOPES_LIST.map((scope) => [scope, scope === 'read' || scope === 'write'])) as Record<Scope, boolean>)
  const [sourceId, setSourceId] = React.useState('default')
  const [federatedRead, setFederatedRead] = React.useState<string[]>(['default'])
  const [ttl, setTtl] = React.useState('604800')
  const [hideRevoked, setHideRevoked] = React.useState(true)
  const [credentials, setCredentials] = React.useState<{ clientId: string; clientSecret: string } | null>(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(() => {
    api.agents().then((rows: AgentRow[]) => setAgents(rows)).catch(() => undefined)
    api.sources().then((rows: SourceSummary[]) => {
      const options = sourceOptions(rows)
      setSources(options)
      setSourceId((current) => current || options[0]?.id || 'default')
      setFederatedRead(options.filter((source) => source.federated).map((source) => source.id))
    }).catch(() => setSources(sourceOptions([])))
  }, [])
  React.useEffect(load, [load])

  const register = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const selectedScopes = Object.entries(scopes).filter(([, enabled]) => enabled).map(([scope]) => scope).join(' ')
      const result = await api.registerClient({
        name,
        scopes: selectedScopes,
        tokenTtl: ttl === '0' ? 315360000 : Number(ttl),
        sourceId,
        federatedRead: Array.from(new Set([sourceId, ...federatedRead])),
      })
      setCredentials({ clientId: result.clientId, clientSecret: result.clientSecret })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register client')
    } finally {
      setLoading(false)
    }
  }

  const visibleAgents = agents.filter((agent) => !hideRevoked || agent.status !== 'revoked')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Tenant-scoped OAuth clients for teammates, AI runtimes, and operator agents."
        action={<label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox checked={hideRevoked} onCheckedChange={(value) => setHideRevoked(Boolean(value))} /> Hide revoked</label>}
      />
      <ErrorBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Register agent client</CardTitle><CardDescription>Creates a Cortex client id and one-time secret.</CardDescription></CardHeader>
        <form onSubmit={register}>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <Field label="Agent name" id="agent-client-name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Token lifetime">
              <Select value={ttl} onValueChange={setTtl}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3600">1 hour</SelectItem>
                  <SelectItem value="86400">24 hours</SelectItem>
                  <SelectItem value="604800">7 days</SelectItem>
                  <SelectItem value="2592000">30 days</SelectItem>
                  <SelectItem value="0">No expiry</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Write source">
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{sourceOptions(sources).map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <div className="flex flex-col gap-2">
              <Label>Scopes</Label>
              <div className="flex flex-wrap gap-2">
                {ALLOWED_SCOPES_LIST.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox checked={scopes[scope]} onCheckedChange={(value) => setScopes((prev) => ({ ...prev, [scope]: Boolean(value) }))} />
                    {scope}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 lg:col-span-2">
              <Label>Federated read sources</Label>
              <div className="flex flex-wrap gap-2">
                {sourceOptions(sources).map((source) => (
                  <label key={source.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox checked={federatedRead.includes(source.id)} onCheckedChange={() => setFederatedRead((prev) => prev.includes(source.id) ? prev.filter((id) => id !== source.id) : [...prev, source.id])} />
                    {source.name}
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
          <CardFooter><Button disabled={loading || !name.trim()}>{loading ? 'Registering...' : 'Register client'}</Button></CardFooter>
        </form>
      </Card>
      {credentials ? (
        <Card>
          <CardHeader><CardTitle>Client credentials</CardTitle><CardDescription>Copy the secret now; Cortex will not show it again.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CodeBlock value={credentials.clientId} />
            <CodeBlock value={credentials.clientSecret} />
            <CodeBlock value={`CORTEX_REMOTE_CLIENT_SECRET='${credentials.clientSecret}' cortex connect '${window.location.origin}/admin/onboarding?client_id=${credentials.clientId}'`} />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Registered clients</CardTitle><CardDescription>{visibleAgents.length} visible clients.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Scopes</TableHead><TableHead>Status</TableHead><TableHead>Requests</TableHead><TableHead>Last used</TableHead></TableRow></TableHeader>
            <TableBody>
              {visibleAgents.length === 0 ? <EmptyRows colSpan={6} label="No agents registered yet." /> : visibleAgents.map((agent) => (
                <TableRow key={agent.id || agent.client_id}>
                  <TableCell><div className="font-medium">{agent.name || agent.client_name}</div><div className="font-mono text-xs text-muted-foreground">{agent.client_id}</div></TableCell>
                  <TableCell><Badge variant="outline">{agent.auth_type === 'api_key' ? 'Legacy bearer' : 'OAuth'}</Badge></TableCell>
                  <TableCell>{String(agent.scope || '').split(' ').filter(Boolean).map((scope) => <Badge key={scope} variant="outline" className="mr-1">{scope}</Badge>)}</TableCell>
                  <TableCell><StatusBadge status={agent.status || 'active'} /></TableCell>
                  <TableCell>{agent.requests_today || 0}<span className="text-muted-foreground"> / {agent.total_requests || 0}</span></TableCell>
                  <TableCell>{formatAge(agent.last_used_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export function SkillsPage() {
  const [skills, setSkills] = React.useState<SkillSummary[]>([])
  const [sources, setSources] = React.useState<SourceSummary[]>([])
  const [selected, setSelected] = React.useState<SkillSummary | null>(null)
  const [draftName, setDraftName] = React.useState('')
  const [draftTrigger, setDraftTrigger] = React.useState('')
  const [allowedClients, setAllowedClients] = React.useState('')
  const [sourceAccess, setSourceAccess] = React.useState<string[]>(['default'])
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(() => {
    api.skills().then((rows: SkillSummary[]) => {
      const cleanRows = rows.map(sanitizeSkillSummary)
      setSkills(cleanRows)
      setSelected((current) => current || cleanRows[0] || null)
    }).catch(() => undefined)
    api.sources().then((rows: SourceSummary[]) => setSources(rows)).catch(() => setSources(sourceOptions([])))
  }, [])
  React.useEffect(load, [load])

  React.useEffect(() => {
    if (!selected) return
    setAllowedClients(selected.allowedClients?.join(', ') || '')
    setSourceAccess(selected.sourceAccess?.length ? selected.sourceAccess : ['default'])
  }, [selected])

  const saveSkill = async (skill: SkillSummary) => {
    setLoading(true)
    setError('')
    try {
      const saved = sanitizeSkillSummary(await api.saveSkill({
        id: skill.id,
        name: skill.name,
        owner: skill.owner,
        status: skill.status,
        triggers: skill.triggers,
        allowedClients: skill.allowedClients,
        sourceAccess: skill.sourceAccess,
        description: skill.description,
        enforcementStatus: skill.enforcementStatus,
      }) as SkillSummary)
      setSkills((prev) => [saved, ...prev.filter((row) => row.id !== saved.id)])
      setSelected(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save skill')
    } finally {
      setLoading(false)
    }
  }

  const createDraft = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draftName.trim()) return
    await saveSkill({
      id: normalizeSourceId(draftName),
      name: draftName,
      owner: 'workspace',
      status: 'draft',
      triggers: draftTrigger.split(',').map((item) => item.trim()).filter(Boolean),
      allowedClients: [],
      sourceAccess: ['default'],
      lastRun: 'not run',
      description: 'Draft skill. Add allowed clients and source access before enabling production agents.',
      enforcementStatus: 'not_enforced',
      persisted: true,
    })
    setDraftName('')
    setDraftTrigger('')
  }

  const saveAccessPolicy = async () => {
    if (!selected) return
    await saveSkill({
      ...selected,
      status: allowedClients.trim() ? 'installed' : selected.status,
      allowedClients: allowedClients.split(',').map((item) => item.trim()).filter(Boolean),
      sourceAccess: sourceAccess.length ? sourceAccess : ['default'],
      enforcementStatus: allowedClients.trim() ? 'enforced' : 'not_enforced',
    })
  }

  const allSources = sourceOptions(sources)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Skills" description="Agent capabilities with triggers, source access, and client allowlists enforced for annotated MCP calls." />
      <ErrorBanner error={error} />
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader><CardTitle>Create skill draft</CardTitle><CardDescription>Start a capability and promote it after policy is attached.</CardDescription></CardHeader>
          <form onSubmit={createDraft}>
            <CardContent className="flex flex-col gap-4">
              <Field label="Skill name" id="skill-name"><Input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Customer Brief" /></Field>
              <Field label="Triggers" id="skill-triggers"><Input value={draftTrigger} onChange={(event) => setDraftTrigger(event.target.value)} placeholder="brief customer, prep account" /></Field>
            </CardContent>
            <CardFooter><Button disabled={loading || !draftName.trim()}>{loading ? 'Saving...' : 'Create draft'}</Button></CardFooter>
          </form>
        </Card>
        <Card>
          <CardHeader><CardTitle>Skill catalog</CardTitle><CardDescription>{skills.length} persisted skills.</CardDescription></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Skill</TableHead><TableHead>Status</TableHead><TableHead>Allowed clients</TableHead><TableHead>Sources</TableHead><TableHead>Enforcement</TableHead></TableRow></TableHeader>
              <TableBody>
                {skills.length === 0 ? <EmptyRows colSpan={5} label="No skills yet." /> : skills.map((skill) => (
                  <TableRow key={skill.id} onClick={() => setSelected(skill)} className="cursor-pointer">
                    <TableCell><div className="font-medium">{skill.name}</div><div className="text-xs text-muted-foreground">{skill.description}</div></TableCell>
                    <TableCell><StatusBadge status={skill.status} /></TableCell>
                    <TableCell className="max-w-[18rem] whitespace-normal break-all">{skill.allowedClients?.length ? skill.allowedClients.join(', ') : 'not set'}</TableCell>
                    <TableCell className="max-w-[16rem] whitespace-normal">{(skill.sourceAccess || []).map((source) => <Badge key={source} variant="outline" className="mb-1 mr-1">{source}</Badge>)}</TableCell>
                    <TableCell><StatusBadge status={skill.enforcementStatus} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      {selected ? (
        <Card>
          <CardHeader><CardTitle>Policy: {selected.name}</CardTitle><CardDescription>Promotion means allowed clients and source access are explicit.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Allowed client ids" id="skill-allowed-client-ids"><Input value={allowedClients} onChange={(event) => setAllowedClients(event.target.value)} placeholder="cortex_cl_..., exec-agent" /></Field>
            <div className="flex flex-col gap-2">
              <Label>Source access</Label>
              <div className="flex flex-wrap gap-2">
                {allSources.map((source) => (
                  <label key={source.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox checked={sourceAccess.includes(source.id)} onCheckedChange={() => setSourceAccess((prev) => prev.includes(source.id) ? prev.filter((id) => id !== source.id) : [...prev, source.id])} />
                    {source.name}
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
          <CardFooter><Button disabled={loading} onClick={saveAccessPolicy}>{loading ? 'Saving...' : 'Promote skill policy'}</Button></CardFooter>
        </Card>
      ) : null}
    </div>
  )
}

export function JobsPage() {
  const [snapshot, setSnapshot] = React.useState<JobsSnapshot | null>(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const next = await api.jobsWatch()
        if (alive) {
          setSnapshot(next)
          setError('')
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load jobs')
      }
      if (alive) timer = window.setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Jobs" description="Live ingest and maintenance queue health." />
      <ErrorBanner error={error} />
      {!snapshot ? <Card><CardContent className="p-8 text-muted-foreground">Loading jobs...</CardContent></Card> : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard title="Waiting" value={snapshot.queue_health.waiting} icon={<Workflow />} />
            <MetricCard title="Active" value={snapshot.queue_health.active} icon={<Activity />} />
            <MetricCard title="Stalled" value={snapshot.queue_health.stalled} icon={<ShieldCheck />} />
            <MetricCard title="Lease pressure" value={snapshot.lease_pressure_1h} icon={<RefreshCw />} />
          </div>
          <Card>
            <CardHeader><CardTitle>By type</CardTitle><CardDescription>Updated {new Date(snapshot.ts_ms).toLocaleTimeString()}</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Total</TableHead><TableHead>Done</TableHead><TableHead>Failed</TableHead><TableHead>Dead</TableHead></TableRow></TableHeader>
                <TableBody>
                  {snapshot.by_type.length === 0 ? <EmptyRows colSpan={5} label="No jobs in the last window." /> : snapshot.by_type.map((row) => (
                    <TableRow key={row.name}><TableCell>{row.name}</TableCell><TableCell>{row.total}</TableCell><TableCell>{row.completed}</TableCell><TableCell>{row.failed}</TableCell><TableCell>{row.dead}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

export function ActivityPage() {
  const [data, setData] = React.useState<{ rows: RequestRow[]; total: number; page: number; pages: number }>({ rows: [], total: 0, page: 1, pages: 1 })
  const [page, setPage] = React.useState(1)
  const [expanded, setExpanded] = React.useState<number | null>(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    api.requests(page).then(setData).catch((err) => setError(err instanceof Error ? err.message : 'Could not load activity'))
  }, [page])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity" description="MCP request log with agent, operation, latency, params, and status." />
      <ErrorBanner error={error} />
      <Card>
        <CardHeader><CardTitle>Request log</CardTitle><CardDescription>{data.total} total requests.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Agent</TableHead><TableHead>Operation</TableHead><TableHead>Latency</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.rows.length === 0 ? <EmptyRows colSpan={5} label="No requests yet." /> : data.rows.map((row) => (
                <React.Fragment key={row.id}>
                  <TableRow onClick={() => setExpanded(expanded === row.id ? null : row.id)} className="cursor-pointer">
                    <TableCell>{formatAge(row.created_at)}</TableCell>
                    <TableCell>{row.agent_name || row.token_name}</TableCell>
                    <TableCell className="font-mono text-xs">{row.operation}</TableCell>
                    <TableCell>{row.latency_ms} ms</TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                  </TableRow>
                  {expanded === row.id ? (
                    <TableRow>
                      <TableCell colSpan={5}><CodeBlock value={JSON.stringify({ params: row.params, error: row.error_message }, null, 2)} minHeight /></TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        <CardFooter className="justify-between">
          <span className="text-sm text-muted-foreground">Page {data.page} of {data.pages}</span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
            <Button variant="outline" disabled={page >= data.pages} onClick={() => setPage((current) => current + 1)}>Next</Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}

export function SettingsPage() {
  const [plan, setPlan] = React.useState<PlanSummary | null>(null)
  const [selectedPlan, setSelectedPlan] = React.useState('launch')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    setError('')
    try {
      const next = await api.plan() as PlanSummary
      setPlan(next)
      setSelectedPlan(next.plan_key)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load plan controls')
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const savePlan = async () => {
    if (!plan) return
    setSaving(true)
    setError('')
    try {
      const next = await api.updatePlan({ orgId: plan.org_id, planKey: selectedPlan }) as PlanSummary
      setPlan(next)
      setSelectedPlan(next.plan_key)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update plan')
    } finally {
      setSaving(false)
    }
  }

  const metricPercent = (key: PlanUsageKey) => {
    if (!plan) return 0
    const limit = plan.limits[key]
    if (limit === null || limit <= 0) return 0
    return Math.min(100, Math.round((plan.usage[key] / limit) * 100))
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Organization defaults, tenant security posture, and commercial controls for the Cortex control plane."
        action={<Button variant="outline" className="gap-2" onClick={load}><RefreshCw data-icon="inline-start" /> Refresh</Button>}
      />
      <ErrorBanner error={error} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>Tenant identity used across onboarding, invites, and agent handoffs.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Product" value="Cortex Brain" />
            <KeyValue label="Tenancy" value="Organization scoped" />
            <KeyValue label="Brains" value="Multiple per organization" />
            <KeyValue label="Plan" value={plan ? plan.plan_key : 'loading'} />
          </CardContent>
          <CardFooter>
            <Button variant="outline" asChild><Link href="/onboarding">Open onboarding</Link></Button>
          </CardFooter>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>All production access should flow through scoped OAuth clients.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Agent auth" value="MCP OAuth" />
            <KeyValue label="Secret policy" value="Shown once" />
            <KeyValue label="Source access" value="Scoped per invite" />
          </CardContent>
          <CardFooter>
            <Button variant="outline" asChild><Link href="/agents">Manage agents</Link></Button>
          </CardFooter>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Plan controls</CardTitle>
            <CardDescription>Human and agent operators share the same plan and limit contract.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-2">
              <Label>Tenant plan</Label>
              <Select value={selectedPlan} onValueChange={setSelectedPlan}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select plan" /></SelectTrigger>
                <SelectContent>
                  {planOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <KeyValue label="Status" value={plan?.status || 'loading'} />
              <KeyValue label="Billing customer" value={plan?.billing_customer_id || 'not linked'} />
              <KeyValue label="Billing provider" value={plan?.billing_provider || 'not linked'} />
              <KeyValue label="Subscription" value={plan?.billing_subscription_id || 'not linked'} />
              <KeyValue label="External plan" value={plan?.billing_plan_ref || 'not linked'} />
              <KeyValue label="Violations" value={plan?.violations.length ? plan.violations.join(', ') : 'none'} />
            </div>
          </CardContent>
          <CardFooter>
            <Button className="gap-2" disabled={!plan || saving || selectedPlan === plan.plan_key} onClick={savePlan}>
              {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Gauge data-icon="inline-start" />}
              {saving ? 'Saving...' : 'Save plan'}
            </Button>
          </CardFooter>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usage limits</CardTitle>
            <CardDescription>Hard limits are enforced before creating brains, invites, sources, clients, and skill policies.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {plan ? planMetrics.map(([key, label]) => {
              const limit = plan.limits[key]
              const usage = plan.usage[key] ?? 0
              const remaining = plan.remaining[key]
              const unlimited = limit === null
              return (
                <div key={key} className="grid gap-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {usage} / {unlimited ? 'unlimited' : limit}
                    </span>
                  </div>
                  <Progress value={unlimited ? 100 : metricPercent(key)} className="h-2" />
                  <div className="text-xs text-muted-foreground">
                    {unlimited ? 'Unlimited on this plan' : `${remaining ?? 0} remaining`}
                  </div>
                </div>
              )
            }) : <div className="text-sm text-muted-foreground">Loading tenant usage...</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Billing sync</CardTitle>
            <CardDescription>Provider webhook state that keeps tenant limits aligned with commercial status.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Current period ends" value={formatTimestamp(plan?.billing_current_period_end)} />
            <KeyValue label="Last billing event" value={plan?.billing_event_id || 'not received'} />
            <KeyValue label="Last synced" value={plan?.billing_synced_at ? formatAge(plan.billing_synced_at) : 'Never'} />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" asChild><Link href="/quality">Quality</Link></Button>
              <Button variant="outline" asChild><Link href="/integrations">Composio</Link></Button>
              <Button variant="outline" asChild><Link href="/skills">Skills</Link></Button>
              <Button variant="outline" asChild><Link href="/activity">Activity</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export function RuntimePage() {
  const [manifest, setManifest] = React.useState<RuntimeManifest>(() => fallbackManifest())
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    api.runtimeManifest().then((next: RuntimeManifest) => {
      setManifest(next)
      setError('')
    }).catch((err) => setError(err instanceof Error ? err.message : 'Could not load runtime manifest'))
  }, [])

  const manifestJson = JSON.stringify(manifest, null, 2)
  const runtimes = runtimeOrder.map((id) => manifest.runtimes[id]).filter(Boolean) as RuntimeSetup[]
  const packages = Object.values(manifest.packages || {}) as RuntimePackage[]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Runtime" description="Runtime manifest, MCP OAuth discovery, and connector setup for agents and clients." action={<Button variant="outline" onClick={() => navigator.clipboard.writeText(manifestJson)}>Copy manifest</Button>} />
      <ErrorBanner error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Hosted endpoints</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="MCP" value={manifest.endpoints.mcp_url} />
            <KeyValue label="Token" value={manifest.endpoints.token_url} />
            <KeyValue label="OAuth" value={manifest.endpoints.oauth_authorization_server} />
            <KeyValue label="Manifest" value={manifest.endpoints.runtime_manifest} />
            <KeyValue label="Package" value={manifest.endpoints.runtime_package} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Onboarding</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Client" value={manifest.onboarding.client_id || 'from invite'} />
            <KeyValue label="Write source" value={manifest.onboarding.source_id} />
            <KeyValue label="Scopes" value={manifest.onboarding.scopes.join(' ')} />
            <KeyValue label="Secret delivery" value={manifest.onboarding.secret_delivery.replace(/_/g, ' ')} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Agent parity</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Operations" value={manifest.agent_parity.operations.length || 'manifest, signup, invites, orgs, brains, skills'} />
            <KeyValue label="Skill keys" value={manifest.skill_policy.annotation_keys.join(', ')} />
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0">
        <CardHeader><CardTitle>Connect command</CardTitle></CardHeader>
        <CardContent><CodeBlock value={manifest.onboarding.connect_command} /></CardContent>
      </Card>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {runtimes.map((runtime) => (
          <Card key={runtime.id} className="min-w-0">
            <CardHeader><CardTitle>{runtime.label}</CardTitle><CardDescription>{runtime.kind}{runtime.config_path ? ` - ${runtime.config_path}` : ''}</CardDescription></CardHeader>
            <CardContent><CodeBlock value={runtimeSnippet(runtime)} /></CardContent>
          </Card>
        ))}
      </div>
      {packages.length ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          {packages.map((pkg) => (
            <Card key={pkg.id} className="min-w-0">
              <CardHeader>
                <CardTitle>{pkg.label}</CardTitle>
                <CardDescription>{pkg.kind.replace(/_/g, ' ')} - {pkg.distribution.replace(/_/g, ' ')}</CardDescription>
              </CardHeader>
              <CardContent><CodeBlock value={packageSnippet(pkg)} /></CardContent>
            </Card>
          ))}
        </div>
      ) : null}
      <Card className="min-w-0">
        <CardHeader><CardTitle>Manifest JSON</CardTitle></CardHeader>
        <CardContent><CodeBlock value={manifestJson} minHeight /></CardContent>
      </Card>
    </div>
  )
}

export function QualityPage() {
  const [quality, setQuality] = React.useState<QualitySnapshot | null>(null)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    setError('')
    try {
      setQuality(await api.quality())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load quality signals')
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const manifest = quality?.runtime_manifest ?? fallbackManifest()
  const checks = quality?.checks ?? []
  const readiness = quality?.readiness.score ?? 0
  const deployment = quality?.deployment
  const metrics = quality?.metrics ?? {
    connected_agents: 0,
    active_tokens: 0,
    requests_today: 0,
    error_rate: '0%',
    source_count: 0,
    connected_composio_connectors: 0,
    enforced_skills: 0,
    total_skills: 0,
    waiting_jobs: 0,
    active_jobs: 0,
    failed_jobs: 0,
    agent_parity_operations: manifest.agent_parity.operations.length,
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quality"
        description="Production and demo-readiness checks across deployment, onboarding, ingestion, OAuth clients, skills, jobs, and agent parity."
        action={<Button variant="outline" className="gap-2" onClick={load}><RefreshCw data-icon="inline-start" /> Refresh</Button>}
      />
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Readiness" value={`${readiness}%`} icon={<Gauge />} />
        <MetricCard title="Requests today" value={metrics.requests_today || 0} icon={<Activity />} />
        <MetricCard title="Enforced skills" value={`${metrics.enforced_skills}/${metrics.total_skills}`} icon={<Sparkles />} />
        <MetricCard title="Failed jobs" value={metrics.failed_jobs} icon={<ShieldCheck />} />
      </div>
      {deployment ? (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Production deployment</CardTitle>
                <CardDescription>These gates distinguish a useful demo tunnel from a durable SaaS tenant.</CardDescription>
              </div>
              <StatusBadge status={deployment.production_ready ? 'passing' : 'needs_attention'} />
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Database</p>
                <div className="mt-2"><StatusBadge status={deployment.database.ready ? 'passing' : 'needs_deploy'} /></div>
                <p className="mt-2 break-words text-sm text-muted-foreground">{deployment.engine_kind} / {deployment.database.provider}{deployment.database.host ? ` / ${deployment.database.host}` : ''}</p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Origin</p>
                <div className="mt-2"><StatusBadge status={deployment.public_url.ready ? 'passing' : 'needs_deploy'} /></div>
                <p className="mt-2 break-words text-sm text-muted-foreground">{deployment.public_url.origin || 'Not configured'}</p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Email</p>
                <div className="mt-2"><StatusBadge status={deployment.email.ready ? 'passing' : 'needs_setup'} /></div>
                <p className="mt-2 text-sm text-muted-foreground">{deployment.email.provider || 'No provider'} · key {deployment.email.configured ? 'set' : 'missing'} · from {deployment.email.from_configured ? 'set' : 'missing'}</p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Billing</p>
                <div className="mt-2"><StatusBadge status={deployment.billing.ready ? 'passing' : 'needs_setup'} /></div>
                <p className="mt-2 text-sm text-muted-foreground">{deployment.billing.webhook_secret_configured ? 'Webhook secret set' : 'Webhook secret missing'}</p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Secrets</p>
                <div className="mt-2"><StatusBadge status={deployment.bootstrap.ready ? 'passing' : 'needs_hardening'} /></div>
                <p className="mt-2 text-sm text-muted-foreground">token {deployment.bootstrap.token_configured ? 'set' : 'missing'} · logs {deployment.bootstrap.token_suppressed ? 'suppressed' : 'visible'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Investor demo gates</CardTitle>
          <CardDescription>Every row should be passing before a live customer or investor walkthrough.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-3">
            <Progress value={readiness} className="h-2" />
            <span className="w-12 text-right text-sm font-medium">{readiness}%</span>
          </div>
          <div className="flex flex-col gap-3 md:hidden">
            {checks.map((check) => (
              <div key={check.area} className="rounded-md border bg-muted/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{check.area}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{check.signal}</p>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader><TableRow><TableHead>Area</TableHead><TableHead>Signal</TableHead><TableHead>Status</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
              <TableBody>
                {checks.map((check) => (
                  <TableRow key={check.area}>
                    <TableCell className="font-medium">{check.area}</TableCell>
                    <TableCell>{check.signal}</TableCell>
                    <TableCell><StatusBadge status={check.status} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{check.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Promotion policy</CardTitle><CardDescription>Skills should not be available to production clients until access is explicit.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Annotation keys" value={manifest.skill_policy.annotation_keys.join(', ')} />
            <KeyValue label="Enforcement" value={manifest.skill_policy.enforcement} />
            <KeyValue label="Promoted skills" value={`${metrics.enforced_skills}`} />
          </CardContent>
          <CardFooter><Button variant="outline" asChild><Link href="/skills">Review skills</Link></Button></CardFooter>
        </Card>
        <Card>
          <CardHeader><CardTitle>Runtime contract</CardTitle><CardDescription>Agents discover the hosted Cortex control plane through these endpoints.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="MCP" value={manifest.endpoints.mcp_url} />
            <KeyValue label="Token" value={manifest.endpoints.token_url} />
            <KeyValue label="Manifest" value={manifest.endpoints.runtime_manifest} />
          </CardContent>
          <CardFooter><Button variant="outline" asChild><Link href="/runtime">Open runtime</Link></Button></CardFooter>
        </Card>
        <Card>
          <CardHeader><CardTitle>Operations</CardTitle><CardDescription>Live queue and request health for the current deployment.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <KeyValue label="Waiting" value={metrics.waiting_jobs} />
            <KeyValue label="Active" value={metrics.active_jobs} />
            <KeyValue label="Error rate" value={metrics.error_rate || '0%'} />
          </CardContent>
          <CardFooter><Button variant="outline" asChild><Link href="/jobs">Watch jobs</Link></Button></CardFooter>
        </Card>
      </div>
    </div>
  )
}

export function IntegrationsPage() {
  const [data, setData] = React.useState<IntegrationsResponse | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')

  const load = React.useCallback(() => {
    setError('')
    api.integrations().then(setData).catch((err) => setError(err instanceof Error ? err.message : 'Could not load integrations'))
  }, [])
  React.useEffect(load, [load])

  const samplePayload = JSON.stringify({
    tool: 'github',
    source_url: 'https://github.com/acme/app/pull/42',
    markdown: '# Pull request summary\n- Added onboarding link handoff\n- Updated runtime setup snippets',
    slug: 'engineering/pr-42',
  }, null, 2)
  const sampleCurl = data ? `curl -X POST '${data.webhookUrl}' \\\n  -H 'authorization: Bearer $CORTEX_COMPOSIO_WEBHOOK_SECRET' \\\n  -H 'content-type: application/json' \\\n  -d '${samplePayload.replace(/'/g, "'\\''")}'` : ''

  const createSource = async (connector: ConnectorStatus) => {
    setBusy(connector.id)
    setError('')
    try {
      await api.createSource({ id: connector.sourceId, name: connector.sourceName, federated: true })
      load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create source'
      if (message === 'source_id_taken') load()
      else setError(message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Composio"
        description="Connect third-party tools through Composio, normalize webhooks into Cortex sources, and expose the same memory to agents."
        action={
          <>
            <Button variant="outline" className="gap-2" onClick={load}><RefreshCw data-icon="inline-start" /> Refresh</Button>
            {data?.dashboardUrl ? <Button asChild><a href={data.dashboardUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" /> Open Composio</a></Button> : null}
          </>
        }
      />
      <ErrorBanner error={error} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground"><PlugZap /></div>
              <div>
                <CardTitle>Ingestion hub</CardTitle>
                <CardDescription>Tool events become source-scoped Cortex memory.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <StatusBadge status={data?.apiKeyConfigured ? 'connected' : 'setup_required'} />
            <Badge variant="outline">COMPOSIO_API_KEY</Badge>
            <StatusBadge status={data?.webhookSecretConfigured ? 'connected' : 'setup_required'} />
            <Badge variant="outline">CORTEX_COMPOSIO_WEBHOOK_SECRET</Badge>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Webhook</CardTitle><CardDescription>Configured endpoint for Composio workflows.</CardDescription></CardHeader>
          <CardContent>{data?.webhookUrl ? <CodeBlock value={data.webhookUrl} /> : <div className="text-sm text-muted-foreground">Loading...</div>}</CardContent>
        </Card>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(data?.connectors || []).map((connector) => (
          <Card key={connector.id} className="min-w-0">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div><CardTitle>{connector.label}</CardTitle><CardDescription>{connector.category}</CardDescription></div>
                <StatusBadge status={connector.connected ? 'connected' : data?.configured ? 'ready' : 'setup_required'} />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{connector.description}</p>
              <div className="flex flex-wrap gap-2">{connector.scopes.map((scope) => <Badge key={scope} variant="outline">{scope}</Badge>)}</div>
              <KeyValue label="Cortex source" value={connector.sourceId} />
            </CardContent>
            <CardFooter>
              <Button className="w-full gap-2" disabled={connector.connected || busy === connector.id} onClick={() => createSource(connector)}>
                <ShieldCheck data-icon="inline-start" />
                {connector.connected ? 'Source ready' : busy === connector.id ? 'Creating...' : 'Create Cortex source'}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Card className="min-w-0">
        <CardHeader><CardTitle>Agent-callable webhook sample</CardTitle><CardDescription>Store the secret in deployment env; the browser never reveals it.</CardDescription></CardHeader>
        <CardContent><CodeBlock value={sampleCurl || 'Loading...'} minHeight /></CardContent>
      </Card>
    </div>
  )
}
