import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { statSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { GRANT_PROFILES, type GrantPatch, type GrantProfileId } from '../core/grants/model.ts';
import { harnessAdapter, publicHarnessMetadata } from '../core/harness/registry.ts';
import { credentialReceipt, readCredentials, writeCredentials } from '../core/harness/credentials.ts';
import { verifyHarnessConnection } from '../core/harness/verify.ts';
import { provisionHarnessGrant, type ProvisionGrantInput } from './mcp-provision.ts';
import { validateHarnessArguments, MCP_GRANT_ARGUMENTS } from '../core/harness/arguments.ts';
import { createMcpAdminHttp, hasAdminCredential, McpAdminError, redactAdminValue } from './mcp-admin-http.ts';
import { runMcpAdmin } from './mcp-admin.ts';

const HELP = `gbrain mcp — provision access on the host; install it inside the harness

gbrain mcp grant NAME --harness ID --profile PROFILE --source SOURCE --url URL --credentials-out FILE
gbrain mcp grant NAME --client ID --if-version N --profile PROFILE --url URL --harness ID --dry-run
gbrain mcp verify --client ID --harness ID --url URL --credentials-file FILE [--delegate]
gbrain mcp admin --help
gbrain mcp adapters | profiles
gbrain mcp expose [--port N] [--funnel] [--surface verbs|starter|full] [--enable-dcr] [--no-tailscale] [--no-service] [--no-install] [--force] [--dry-run] [--yes] [--json]
gbrain mcp expose --status [--json]
gbrain mcp expose --remove [--yes] [--json]

expose publishes the gbrain HTTP MCP server on your Tailscale tailnet (--funnel: public, for cloud agents)
and keeps it running as a user service. Engine-free. See: gbrain mcp expose --help

--profile defaults to memory-writer for new clients; omitted profiles preserve existing grants.
New connections follow this brain's published skills within their approved read sources.
--skills follow|memory-only         Follow shared skills (new default) or use memory only; existing grants are unchanged when omitted
Following never grants skill editing, script execution, additional tools, or paid calls.
Delegation requires --bound-tools T1,T2.
--federated-read S1,S2              Explicit read sources
--bound-slug-prefixes P1/,P2/       Direct write fence
--delegated-slug-prefixes P1/,P2/   Delegated write fence
--delegated-namespace job|prefixes  Default: job namespace
--bound-max-concurrent N           Default for new clients: 1
--budget-usd-per-day USD|unlimited Default for new clients: unlimited
--token-ttl SECONDS                Override new access-token lifetime
--admin-token-file FILE            Owner credential; otherwise GBRAIN_ADMIN_BOOTSTRAP_TOKEN
--credentials-out FILE             Private credential handoff (required for creation)
--credentials-file FILE            Existing private handoff; never printed
--resume                           Recover the original private handoff for --client
--timeout-ms N                     Bound verification (default: 30000)
--delegate                         Execute a real worker check; may incur model charges
--dry-run                          Preview grant without mutation or credentials
--json                             Machine-readable redacted receipt

Next, in the intended harness environment:
gbrain connect URL --harness ID --credentials-file FILE --install
Thin CLI adapters additionally require --root ABSOLUTE-PERSISTENT-DIRECTORY.
`;

export function mcpNeedsEngine(args: string[], envToken = process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN): boolean {
  return args[0] === 'grant' && !hasAdminCredential(args, envToken) && !args.includes('--help') && !args.includes('-h');
}

export function parseMcpGrant(args: string[]): ProvisionGrantInput {
  if (args[0] !== 'grant' || !args[1] || args[1].startsWith('-')) throw new Error('Usage: gbrain mcp grant NAME [options]');
  validateHarnessArguments(args.slice(2), MCP_GRANT_ARGUMENTS);
  const value = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`); return v; };
  const list = (flag: string) => value(flag)?.split(',').map(v => v.trim()).filter(Boolean);
  const patch: GrantPatch = {};
  if (value('--federated-read') !== undefined) patch.federatedRead = list('--federated-read');
  if (value('--bound-tools') !== undefined) patch.boundTools = list('--bound-tools');
  if (value('--bound-source') !== undefined) patch.boundSourceId = value('--bound-source');
  if (value('--bound-brain') !== undefined) patch.boundBrainId = value('--bound-brain');
  if (value('--bound-slug-prefixes') !== undefined) patch.boundSlugPrefixes = value('--bound-slug-prefixes') === 'none' ? null : list('--bound-slug-prefixes');
  if (value('--delegated-slug-prefixes') !== undefined) { patch.delegatedSlugPrefixes = list('--delegated-slug-prefixes'); patch.delegatedNamespace = 'prefixes'; }
  if (value('--delegated-namespace') !== undefined) {
    const mode = value('--delegated-namespace');
    if (mode !== 'job' && mode !== 'prefixes') throw new Error('--delegated-namespace must be job or prefixes');
    patch.delegatedNamespace = mode;
  }
  if (value('--bound-max-concurrent') !== undefined) patch.boundMaxConcurrent = Number(value('--bound-max-concurrent'));
  if (value('--budget-usd-per-day') !== undefined) patch.budgetUsdPerDay = value('--budget-usd-per-day') === 'unlimited' ? null : value('--budget-usd-per-day')!;
  if (value('--token-ttl') !== undefined) patch.tokenTtlSeconds = Number(value('--token-ttl'));
  const expectedRevision = value('--if-version') === undefined ? undefined : Number(value('--if-version'));
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('--if-version must be a nonnegative integer');
  const sharedSkills = value('--skills');
  if (sharedSkills !== undefined && sharedSkills !== 'follow' && sharedSkills !== 'memory-only') throw new Error('--skills must be follow or memory-only');
  return { name: args[1] ?? '', harness: value('--harness') ?? value('--agent') ?? 'generic', profile: value('--profile') as GrantProfileId | undefined,
    sourceId: value('--source'), url: value('--url') ?? '', clientId: value('--client'), expectedRevision, dryRun: args.includes('--dry-run'), resume: args.includes('--resume'), patch, sharedSkills };
}

export async function runMcp(args: string[], engine?: BrainEngine): Promise<void> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
    if (args[0] === 'admin') { await runMcpAdmin(args.slice(1)); return; }
    if (args[0] === 'expose') {
      // Engine-free Tailscale publication (src/commands/mcp-expose.ts) — it
      // owns its own help, argument validation and exit-code mapping.
      const { runMcpExpose } = await import('./mcp-expose.ts');
      const code = await runMcpExpose(args.slice(1));
      if (code !== 0) setCliExitVerdict(code);
      return;
    }
    if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
    if (args[0] === 'adapters' || args[0] === 'profiles') validateHarnessArguments(args.slice(1), { flags: ['--json'] });
    if (args[0] === 'adapters') { console.log(JSON.stringify(publicHarnessMetadata(), null, 2)); return; }
    if (args[0] === 'profiles') { console.log(JSON.stringify({ profiles: GRANT_PROFILES, default: 'memory-writer', delegation_spending: 'unlimited', concurrency: 1 }, null, 2)); return; }
    if (args[0] === 'verify') {
      validateHarnessArguments(args.slice(1), { values: ['--client', '--harness', '--url', '--credentials-file', '--timeout-ms'], flags: ['--delegate', '--json'], aliases: { '--agent': '--harness' } });
      const path = value('--credentials-file');
      if (!path) throw new Error('--credentials-file is required');
      const c = readCredentials(path);
      if (value('--client') && value('--client') !== c.client_id) throw new Error('Client does not match the private credential handoff');
      if (value('--url') && value('--url')!.replace(/\/$/, '') !== c.mcp_url) throw new Error('Endpoint does not match the private credential handoff');
      if (value('--harness') ?? value('--agent')) c.harness = harnessAdapter((value('--harness') ?? value('--agent'))!).id;
      const timeoutMs = value('--timeout-ms') === undefined ? 30_000 : Number(value('--timeout-ms'));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error('--timeout-ms must be between 100 and 300000');
      const report = await verifyHarnessConnection(c, { delegate: args.includes('--delegate'), timeoutMs });
      console.log(JSON.stringify(report, null, args.includes('--json') ? undefined : 2));
      if (report.status !== 'passed') setCliExitVerdict(report.status === 'failed' ? 1 : 2);
      return;
    }
    if (args[0] !== 'grant') throw new Error('Expected mcp admin, grant, verify, adapters, profiles or expose');
    const input = parseMcpGrant(args);
    if ((!input.clientId || input.resume) && !input.dryRun && !value('--credentials-out')) throw new Error('--credentials-out is required before creating a client or resuming delivery');
    // Refuse an occupied handoff destination before granting anything.
    if (!input.clientId && !input.dryRun && value('--credentials-out')) {
      try { statSync(value('--credentials-out')!); throw new Error('Credential handoff already exists; resume with --client and preserve it'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const adminFile = value('--admin-token-file');
    let result: Awaited<ReturnType<typeof provisionHarnessGrant>>;
    if (hasAdminCredential(args)) {
      const admin = createMcpAdminHttp({ url: input.url, adminTokenFile: adminFile });
      result = await admin.request('/admin/api/grants', { method: 'POST', body: input,
        mutation: !input.dryRun && !input.resume,
        nextAction: input.clientId ? `gbrain mcp admin client ${input.clientId} --url ${admin.base}` : `gbrain mcp admin clients --url ${admin.base}`,
      }) as typeof result;
    } else {
      if (!engine) throw new Error('Run on the brain host or supply --admin-token-file for authenticated server administration');
      result = await provisionHarnessGrant(engine, input, 'local-cli');
    }
    if (result.credentials) {
      try { writeCredentials(value('--credentials-out')!, result.credentials); }
      catch { throw new Error(`credential_delivery_incomplete: client ${result.grant.clientId} exists; repeat with --resume --client ${result.grant.clientId} --credentials-out <private-file>. Do not create a duplicate or rotate its secret automatically.`); }
    }
    console.log(JSON.stringify({ status: result.dry_run ? 'preview' : 'granted', grant: result.grant, before: result.before,
      spending: result.grant.budgetUsdPerDay === null ? { mode: 'unlimited' } : { mode: 'daily_cap', usd: result.grant.budgetUsdPerDay },
      credentials: result.credentials ? credentialReceipt(result.credentials) : result.credential_action,
      credential_file: result.credentials ? value('--credentials-out') : null,
      next_action: result.dry_run ? 'Review the grant, then repeat without --dry-run.' : result.credentials
        ? 'Install the private handoff inside the intended harness with gbrain connect, then run gbrain mcp verify.'
        : 'Grant updated; inspect effective access with gbrain mcp admin client. Restrictions apply immediately. Newly added scopes require fresh authorization in the native client or a new machine token; existing credentials are preserved.' }, null, args.includes('--json') ? undefined : 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: error instanceof McpAdminError ? error.code : 'mcp_setup_failed',
      message: redactAdminValue(error instanceof Error ? error.message : 'MCP setup failed', [process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN ?? '']),
      ...(error instanceof McpAdminError && error.outcome ? { outcome: error.outcome } : {}),
      ...(error instanceof McpAdminError && error.nextAction ? { next_action: error.nextAction } : {}),
      ...(error instanceof McpAdminError && error.httpStatus ? { http_status: error.httpStatus } : {}),
      ...(error instanceof McpAdminError && error.retryAfter ? { retry_after: error.retryAfter } : {}) }));
    setCliExitVerdict(1);
  }
}
