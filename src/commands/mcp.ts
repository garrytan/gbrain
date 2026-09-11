import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { statSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { GRANT_PROFILES, type GrantPatch, type GrantProfileId } from '../core/grants/model.ts';
import { harnessAdapter, publicHarnessMetadata } from '../core/harness/registry.ts';
import { credentialReceipt, readCredentials, writeCredentials, readPrivateText, assertSecureEndpoint } from '../core/harness/credentials.ts';
import { verifyHarnessConnection } from '../core/harness/verify.ts';
import { provisionHarnessGrant, type ProvisionGrantInput } from './mcp-provision.ts';
import { validateHarnessArguments, MCP_GRANT_ARGUMENTS } from '../core/harness/arguments.ts';

const HELP = `gbrain mcp — provision access on the host; install it inside the harness

gbrain mcp grant NAME --harness ID --profile PROFILE --source SOURCE --url URL --credentials-out FILE
gbrain mcp grant NAME --client ID --if-version N --profile PROFILE --url URL --harness ID --dry-run
gbrain mcp verify --client ID --harness ID --url URL --credentials-file FILE [--delegate]
gbrain mcp adapters | profiles

--profile defaults to memory-writer for new clients; omitted profiles preserve existing grants.
Delegation requires --bound-tools T1,T2.
--federated-read S1,S2              Explicit read sources
--bound-slug-prefixes P1/,P2/       Direct write fence
--delegated-slug-prefixes P1/,P2/   Delegated write fence
--delegated-namespace job|prefixes  Default: job namespace
--bound-max-concurrent N           Default for new clients: 1
--budget-usd-per-day USD|unlimited Default for new clients: unlimited
--token-ttl SECONDS                Override new access-token lifetime
--admin-token-file FILE            Authenticate administration on a running server
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

export function mcpNeedsEngine(args: string[]): boolean {
  return args[0] === 'grant' && !args.includes('--admin-token-file') && !args.includes('--help') && !args.includes('-h');
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
  return { name: args[1] ?? '', harness: value('--harness') ?? value('--agent') ?? 'generic', profile: value('--profile') as GrantProfileId | undefined,
    sourceId: value('--source'), url: value('--url') ?? '', clientId: value('--client'), expectedRevision, dryRun: args.includes('--dry-run'), resume: args.includes('--resume'), patch };
}

export async function runMcp(args: string[], engine?: BrainEngine): Promise<void> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  try {
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
    if (args[0] !== 'grant') throw new Error('Expected mcp grant, verify, adapters or profiles');
    const input = parseMcpGrant(args);
    if ((!input.clientId || input.resume) && !input.dryRun && !value('--credentials-out')) throw new Error('--credentials-out is required before creating a client or resuming delivery');
    // Refuse an occupied handoff destination before granting anything.
    if (!input.clientId && !input.dryRun && value('--credentials-out')) {
      try { statSync(value('--credentials-out')!); throw new Error('Credential handoff already exists; resume with --client and preserve it'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const adminFile = value('--admin-token-file');
    let result: Awaited<ReturnType<typeof provisionHarnessGrant>>;
    if (adminFile) {
      assertSecureEndpoint(input.url);
      const token = readPrivateText(adminFile).trim();
      const base = input.url.replace(/\/mcp\/?$/, '');
      const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!login.ok) throw new Error(`admin_authentication_failed: HTTP ${login.status}`);
      const cookie = login.headers.get('set-cookie')?.match(/gbrain_admin=[^;]+/)?.[0];
      if (!cookie) throw new Error('admin_authentication_failed: session cookie missing');
      const response = await fetch(`${base}/admin/api/grants`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(input) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(`${body.error ?? 'grant_failed'}: ${body.message ?? `HTTP ${response.status}`}`);
      }
      result = await response.json() as typeof result;
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
      next_action: result.dry_run ? 'Review the grant, then repeat without --dry-run.' : 'Install the private handoff inside the intended harness with gbrain connect, then run gbrain mcp verify.' }, null, args.includes('--json') ? undefined : 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: 'mcp_setup_failed', message: error instanceof Error ? error.message : 'MCP setup failed' }));
    setCliExitVerdict(1);
  }
}
