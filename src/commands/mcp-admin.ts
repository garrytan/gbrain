import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { assertNoSymlinks } from '../core/agent-install/state.ts';
import { writeCredentials } from '../core/harness/credentials.ts';
import { validateOAuthClientSetup, writeOAuthClientSetup } from '../core/harness/oauth-setup.ts';
import { harnessAdapter } from '../core/harness/registry.ts';
import { normalizeScopesInput } from '../core/scope.ts';
import { GRANT_PROFILES } from '../core/grants/model.ts';
import { createMcpAdminHttp, McpAdminError, redactAdminValue, type McpAdminHttpOptions } from './mcp-admin-http.ts';

const HELP = `gbrain mcp admin — administer a running server with owner credentials

gbrain mcp admin login-link [--oauth-request ID]
gbrain mcp admin clients
gbrain mcp admin client ID
gbrain mcp admin register NAME --redirect-uri URI [--redirect-uri URI ...]
gbrain mcp admin setup ID --harness ID [--flow authorization-code|client-credentials]
gbrain mcp admin invalidate-tokens|revoke|delete ID [--yes --if-version N]
gbrain mcp admin attest CLIENT_ID --attest-actor qm|none [--attest-ops LIST] [--dry-run]
gbrain mcp admin members [--all]
gbrain mcp admin member-add ID [--name NAME] [--email ADDR] [--groups G1,G2]
gbrain mcp admin member-set ID --email ADDR|none
gbrain mcp admin member-disable|member-enable ID
gbrain mcp admin links [--member ID]
gbrain mcp admin link MEMBER --qm CANONICAL_ID [--dry-run]
gbrain mcp admin link --email ADDR --qm CANONICAL_ID [--dry-run]
gbrain mcp admin unlink --qm CANONICAL_ID [--dry-run]
gbrain mcp admin memory-proposals list [--source SOURCE] [--cursor CURSOR]
gbrain mcp admin memory-proposals show REQUEST_ID
gbrain mcp admin memory-proposals approve REQUEST_ID [--dry-run]
gbrain mcp admin memory-proposals deny REQUEST_ID --reason TEXT [--dry-run]

--url URL                          Running server URL or /mcp endpoint (required)
--admin-token-file FILE            Private owner credential; otherwise GBRAIN_ADMIN_BOOTSTRAP_TOKEN
--harness ID                       Setup instructions for this harness (default: generic)
--flow FLOW                        Required when an existing client supports both flows
--token-endpoint-auth-method METHOD none (default), client_secret_post, client_secret_basic
--source SOURCE                    New registration write source (default: default); memory-proposals list: only this source
--cursor CURSOR                    memory-proposals list: the next_cursor of the previous page (50 a page, oldest first)
--reason TEXT                      memory-proposals deny: 1 to 500 characters the proposer reads on its receipt
--federated-read S1,S2              New registration read sources
--scopes SCOPES                    New registration scopes (default: read)
--profile PROFILE                  Apply a named access profile during registration
--credentials-out FILE             Explicit private export; required for confidential registration
--dry-run                          Preview registration or lifecycle consequences
--yes --if-version N               Apply reviewed lifecycle action; otherwise preview only
--attest-actor qm|none             Grant or clear the right to name the person a call serves (x-qm-actor)
--attest-ops LIST                  Operations an attested call may run (default get_write_request,memory_recall,memory_write)
--qm ID                            A canonical person id from the trusted system
--email ADDR                       A member's declared email (case-folded, unique); link finds the member by it
--timeout-ms N                     Request timeout, 100..300000 (default: 30000)
--json                             Structured result; credentials stay in private exports

Registration creates authorization_code and refresh_token grants. The native client
initiates OAuth and owns its PKCE verifier. For machine access use gbrain mcp grant.
Setup returns metadata and instructions; add --credentials-out for a private export.
Login links are single-use: deliver the link to the owner without fetching it.
OAuth admin scope does not grant owner administration authority.
`;

type Flow = 'authorization-code' | 'client-credentials';
interface AdminArgs {
  command: string;
  sub?: string;
  target?: string;
  values: Map<string, string[]>;
  flags: Set<string>;
}
const common = ['--url', '--admin-token-file', '--timeout-ms'];
const commandValues: Record<string, string[]> = {
  'login-link': ['--oauth-request'], clients: [], client: [],
  register: ['--redirect-uri', '--token-endpoint-auth-method', '--source', '--federated-read', '--scopes', '--profile', '--credentials-out', '--harness'],
  setup: ['--harness', '--flow', '--credentials-out'],
  'invalidate-tokens': ['--if-version'], revoke: ['--if-version'], delete: ['--if-version'],
  attest: ['--attest-actor', '--attest-ops'], members: [], 'member-add': ['--name', '--groups', '--email'], 'member-set': ['--email'], 'member-disable': [], 'member-enable': [],
  links: ['--member'], link: ['--qm', '--email'], unlink: ['--qm'], 'memory-proposals': [],
};
/** GST-2407: memory-proposals takes a subcommand; show, approve and deny take exactly one request id. */
const proposalValues: Record<string, string[]> = { list: ['--source', '--cursor'], show: [], approve: [], deny: ['--reason'] };
const untargeted = ['login-link', 'clients', 'members', 'links', 'unlink'];
const previewable = ['register', 'invalidate-tokens', 'revoke', 'delete', 'attest', 'link', 'unlink'];

export function parseMcpAdmin(args: string[]): AdminArgs {
  const command = args[0];
  if (!command || !Object.hasOwn(commandValues, command)) throw new McpAdminError('invalid_admin_command', `Expected one of: ${Object.keys(commandValues).join(', ')}. Use mcp admin --help.`);
  const proposals = command === 'memory-proposals';
  const sub = proposals ? args[1] : undefined;
  if (proposals && !Object.hasOwn(proposalValues, sub ?? '')) throw new McpAdminError('invalid_admin_command', 'memory-proposals takes list, show, approve or deny.');
  const at = proposals ? 2 : 1;
  const targeted = proposals ? sub !== 'list' : !untargeted.includes(command) && !(command === 'link' && args[1]?.startsWith('-'));
  const target = targeted ? args[at] : undefined;
  if (targeted && (!target || target.startsWith('-'))) throw new McpAdminError('missing_target', `${proposals ? `memory-proposals ${sub}` : command} requires ${proposals ? 'a request ID' : command === 'register' ? 'a name' : command.startsWith('member') || command === 'link' ? 'a member ID' : 'a client ID'}.`);
  const allowedValues = new Set([...common, ...(proposals ? proposalValues[sub!]! : commandValues[command])]);
  const lifecycle = ['invalidate-tokens', 'revoke', 'delete'].includes(command);
  const preview = proposals ? sub === 'approve' || sub === 'deny' : previewable.includes(command);
  const allowedFlags = new Set(['--json', ...(preview ? ['--dry-run'] : []), ...(lifecycle ? ['--yes'] : []), ...(command === 'members' ? ['--all'] : [])]);
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = targeted ? at + 1 : at; i < args.length; i++) {
    const flag = args[i];
    if (allowedFlags.has(flag)) {
      if (flags.has(flag)) throw new McpAdminError('invalid_arguments', `Duplicate argument: ${flag}`);
      flags.add(flag);
    } else if (allowedValues.has(flag)) {
      if (values.has(flag) && flag !== '--redirect-uri') throw new McpAdminError('invalid_arguments', `Duplicate argument: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new McpAdminError('invalid_arguments', `${flag} requires a value.`);
      values.set(flag, [...(values.get(flag) ?? []), value]);
    } else throw new McpAdminError('invalid_arguments', `Unknown administration argument: ${flag}. Use --help.`);
  }
  if (!values.has('--url')) throw new McpAdminError('invalid_arguments', '--url is required. Point it at the existing running server.');
  if (flags.has('--yes') && flags.has('--dry-run')) throw new McpAdminError('invalid_arguments', 'Choose --dry-run or --yes, not both.');
  if (flags.has('--yes') && !values.has('--if-version')) throw new McpAdminError('revision_required', 'Preview the action first, then apply with --yes --if-version <reviewed-revision>.');
  return { command, ...(sub === undefined ? {} : { sub }), target, values, flags };
}

type AdminClient = ReturnType<typeof createMcpAdminHttp>;
const list = (raw: string | undefined) => raw === undefined ? undefined : raw.split(',').map(s => s.trim()).filter(Boolean);

/** GST-1094 gap 4: the attest right, members and canonical-id links, over the owner session (serve-http-access.ts). */
const ACCESS_COMMANDS: Record<string, (client: AdminClient, parsed: AdminArgs, value: (flag: string) => string | undefined) => Promise<unknown>> = {
  attest: (client, parsed, value) => {
    const actor = value('--attest-actor');
    const ops = value('--attest-ops');
    if (actor === undefined && ops === undefined) throw new McpAdminError('invalid_arguments', 'attest needs --attest-actor qm|none and/or --attest-ops <list>.');
    const dryRun = parsed.flags.has('--dry-run');
    return client.request('/admin/api/access/attest', { method: 'POST', mutation: !dryRun, nextAction: `gbrain mcp admin client ${parsed.target} --url ${client.base}`, body: {
      clientId: parsed.target, dryRun, ...(actor === undefined ? {} : { attestActor: actor === 'none' ? null : actor }), ...(ops === undefined ? {} : { attestOps: list(ops) }) } });
  },
  members: (client, parsed) => client.request(`/admin/api/access/members${parsed.flags.has('--all') ? '?all=1' : ''}`),
  'member-add': (client, parsed, value) => client.request('/admin/api/access/members', { method: 'POST', mutation: true, nextAction: `gbrain mcp admin members --url ${client.base}`,
    body: { action: 'add', id: parsed.target, ...(value('--name') === undefined ? {} : { name: value('--name') }), ...(value('--email') === undefined ? {} : { email: value('--email') }),
      ...(value('--groups') === undefined ? {} : { groups: list(value('--groups')) }) } }),
  'member-set': (client, parsed, value) => {
    const email = value('--email');
    if (email === undefined) throw new McpAdminError('invalid_arguments', 'member-set needs --email <addr>|none.');
    return client.request('/admin/api/access/members', { method: 'POST', mutation: true, nextAction: `gbrain mcp admin members --url ${client.base}`, body: { action: 'set', id: parsed.target, email: email === 'none' ? null : email } });
  },
  'member-disable': (client, parsed) => client.request('/admin/api/access/members', { method: 'POST', mutation: true, nextAction: `gbrain mcp admin members --url ${client.base}`, body: { action: 'disable', id: parsed.target } }),
  'member-enable': (client, parsed) => client.request('/admin/api/access/members', { method: 'POST', mutation: true, nextAction: `gbrain mcp admin members --url ${client.base}`, body: { action: 'enable', id: parsed.target } }),
  links: (client, _parsed, value) => client.request(`/admin/api/access/member-links${value('--member') ? `?member=${encodeURIComponent(value('--member')!)}` : ''}`),
  link: (client, parsed, value) => linkRequest(client, parsed, value, 'link'),
  unlink: (client, parsed, value) => linkRequest(client, parsed, value, 'unlink'),
  'memory-proposals': (client, parsed, value) => {
    if (parsed.sub === 'list') {
      const query = new URLSearchParams({ ...(value('--source') === undefined ? {} : { source: value('--source')! }), ...(value('--cursor') === undefined ? {} : { cursor: value('--cursor')! }) });
      return client.request(`/admin/api/memory-proposals${query.size ? `?${query}` : ''}`);
    }
    const path = `/admin/api/memory-proposals/${encodeURIComponent(parsed.target!)}`;
    if (parsed.sub === 'show') return client.request(path);
    const reason = value('--reason');
    if (parsed.sub === 'deny' && reason === undefined) throw new McpAdminError('invalid_arguments', 'deny needs --reason TEXT: the proposer reads it on its receipt.');
    const dryRun = parsed.flags.has('--dry-run');
    return client.request(path, { method: 'POST', mutation: !dryRun, nextAction: `gbrain mcp admin memory-proposals show ${parsed.target} --url ${client.base}`,
      body: { action: parsed.sub, dryRun, ...(reason === undefined ? {} : { reason }) } });
  },
};

function linkRequest(client: AdminClient, parsed: AdminArgs, value: (flag: string) => string | undefined, action: 'link' | 'unlink'): Promise<unknown> {
  const externalId = value('--qm');
  if (externalId === undefined) throw new McpAdminError('invalid_arguments', `${action} needs --qm <canonical id>.`);
  const email = value('--email');
  if (action === 'link' && (email === undefined) === (parsed.target === undefined)) throw new McpAdminError('invalid_arguments', 'link needs a member ID or --email <addr>, not both.');
  const dryRun = parsed.flags.has('--dry-run');
  return client.request('/admin/api/access/member-links', { method: 'POST', mutation: !dryRun, nextAction: `gbrain mcp admin links --url ${client.base}`,
    body: { action, externalId, dryRun, ...(action === 'link' ? (email === undefined ? { member: parsed.target } : { email }) : {}) } });
}

function destinationAvailable(path: string): void {
  const target = resolve(path);
  assertNoSymlinks(target);
  try { lstatSync(target); throw new McpAdminError('credential_destination_exists', 'The credential destination already exists. Choose a new private output file.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function saveExport(path: string, result: Record<string, unknown>): void {
  if (result.oauthSetup) {
    const setup = validateOAuthClientSetup(result.oauthSetup);
    if (setup.client.token_endpoint_auth_method !== 'none' && !setup.client.client_secret) throw new Error('Confidential export is missing its client secret');
    writeOAuthClientSetup(path, setup);
  }
  else if (result.credentials) writeCredentials(path, result.credentials as Parameters<typeof writeCredentials>[1]);
  else throw new Error('Server did not return a private setup export');
}

function flowValue(value: string | undefined): Flow | undefined {
  if (value === undefined) return undefined;
  const flow = value.replace(/_/g, '-');
  if (flow !== 'authorization-code' && flow !== 'client-credentials') throw new McpAdminError('invalid_flow', '--flow must be authorization-code or client-credentials.');
  return flow;
}

export async function runMcpAdmin(args: string[], dependencies: Pick<McpAdminHttpOptions, 'fetchImpl' | 'bootstrapToken'> = {}): Promise<void> {
  let sanitize = (message: string) => String(redactAdminValue(message, [dependencies.bootstrapToken ?? process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN ?? '']));
  let stage = 'input'; let endpoint: string | undefined; let clientId: string | undefined;
  try {
    if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
    const parsed = parseMcpAdmin(args);
    stage = parsed.command;
    if (!['register', 'link', 'memory-proposals'].includes(parsed.command) && !parsed.command.startsWith('member')) clientId = parsed.target;
    const value = (flag: string) => parsed.values.get(flag)?.[0];
    const json = parsed.flags.has('--json');
    const print = (result: unknown) => console.log(sanitize(JSON.stringify(redactAdminValue(result), null, json ? undefined : 2)));
    const client = createMcpAdminHttp({ url: value('--url')!, adminTokenFile: value('--admin-token-file'),
      timeoutMs: value('--timeout-ms') === undefined ? undefined : Number(value('--timeout-ms')), ...dependencies });
    sanitize = client.sanitize;
    endpoint = client.base;
    const inspect = parsed.target && parsed.command !== 'register'
      ? `gbrain mcp admin client ${parsed.target} --url ${client.base}`
      : `gbrain mcp admin clients --url ${client.base}`;
    const path = `/admin/api/clients/${encodeURIComponent(parsed.target ?? '')}`;
    if (parsed.command === 'login-link') {
      const link = await client.loginLink(value('--oauth-request'));
      console.log(JSON.stringify({ status: 'login_link', ...link, next_action: 'Open this single-use link in the owner browser. Do not fetch it to test it.' }, null, json ? undefined : 2));
      return;
    }
    if (parsed.command === 'clients' || parsed.command === 'client') {
      print(await client.request(parsed.command === 'clients' ? '/admin/api/clients' : path));
      return;
    }
    if (parsed.command in ACCESS_COMMANDS) {
      const result = await ACCESS_COMMANDS[parsed.command]!(client, parsed, value);
      print(result);
      if (parsed.sub === 'approve' && (result as { outcome?: string }).outcome === 'failed') setCliExitVerdict(1);
      return;
    }
    if (parsed.command === 'register') {
      const redirects = parsed.values.get('--redirect-uri') ?? [];
      if (!redirects.length) throw new McpAdminError('redirect_uri_required', 'Native OAuth registration requires at least one --redirect-uri supplied by the client harness.');
      const method = value('--token-endpoint-auth-method') ?? 'none';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new McpAdminError('invalid_auth_method', 'Choose none, client_secret_post, or client_secret_basic.');
      const dryRun = parsed.flags.has('--dry-run');
      const output = value('--credentials-out');
      if (!dryRun && method !== 'none' && !output) throw new McpAdminError('credential_destination_required', 'Confidential registration requires --credentials-out <private-file> before creating the client.');
      if (!dryRun && output) destinationAvailable(output);
      const profile = value('--profile');
      if (profile !== undefined && !(GRANT_PROFILES as readonly string[]).includes(profile)) throw new McpAdminError('invalid_profile', `Choose a profile from: ${GRANT_PROFILES.join(', ')}.`);
      const harness = harnessAdapter(value('--harness') ?? 'generic').id;
      const result = await client.request('/admin/api/register-client', { method: 'POST', mutation: !dryRun, nextAction: inspect, body: {
        name: parsed.target, grantTypes: ['authorization_code', 'refresh_token'], redirectUris: redirects, tokenEndpointAuthMethod: method, dryRun, harness,
        ...(value('--source') === undefined ? {} : { source: value('--source') }),
        ...(profile === undefined ? {} : { profile }),
        ...(value('--scopes') === undefined ? {} : { scopes: normalizeScopesInput(value('--scopes')) }),
        ...(value('--federated-read') === undefined ? {} : { federatedRead: value('--federated-read')!.split(',').map(s => s.trim()).filter(Boolean) }),
      } });
      if (!dryRun && typeof result.clientId !== 'string') throw new McpAdminError('admin_outcome_unknown', 'Registration returned no client identifier. Inspect the existing client list before another registration.', 'unknown', inspect);
      if (!dryRun) clientId = result.clientId as string;
      if (!dryRun && output) {
        try { saveExport(output, result); }
        catch { throw new McpAdminError('credential_delivery_incomplete', `Registration completed for client ${String(result.clientId)} but its private export could not be saved. Recover setup into a new private file; do not repeat registration.`, undefined,
          `gbrain mcp admin setup ${String(result.clientId)} --harness ${harness} --flow authorization-code --credentials-out <private-file> --url ${client.base}`); }
      }
      const { clientSecret: _secret, credentials: _credentials, ...safe } = result;
      print({ status: dryRun ? 'preview' : 'registered', ...safe, ...(output && !dryRun ? { credential_file: output } : {}) });
      return;
    }
    if (parsed.command === 'setup') {
      const harness = harnessAdapter(value('--harness') ?? 'generic').id;
      const flow = flowValue(value('--flow'));
      const query = new URLSearchParams({ harness, ...(flow === undefined ? {} : { flow }) });
      const result = await client.request(`${path}/setup?${query}`);
      const output = value('--credentials-out');
      if (output) {
        const exported = await client.request('/admin/api/recover-client', { method: 'POST', body: { clientId: parsed.target, harness, ...(flow === undefined ? {} : { flow }) } });
        try { saveExport(output, exported); }
        catch { throw new McpAdminError('credential_delivery_incomplete', 'The private setup export could not be saved. Choose a private output file for this registration and repeat setup.', undefined, inspect); }
      }
      print({ ...result, ...(output ? { credential_file: output } : {}) });
      return;
    }
    const expectedRevision = value('--if-version') === undefined ? undefined : Number(value('--if-version'));
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new McpAdminError('invalid_revision', '--if-version must be a nonnegative integer from a fresh preview.');
    const apply = parsed.flags.has('--yes');
    const result = await client.request(`${path}/lifecycle`, { method: 'POST', mutation: apply, nextAction: inspect,
      body: { action: parsed.command, dryRun: !apply, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(apply ? { yes: true } : {}) } });
    print(result);
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', reason: error instanceof McpAdminError ? error.code : 'mcp_admin_failed',
      stage, ...(endpoint ? { endpoint } : {}), ...(clientId ? { client_id: sanitize(clientId) } : {}),
      message: sanitize(error instanceof Error ? error.message : 'Administration failed'),
      outcome: error instanceof McpAdminError && error.outcome ? error.outcome : 'failed',
      ...(error instanceof McpAdminError && error.nextAction ? { next_action: sanitize(error.nextAction) } : {}),
      ...(error instanceof McpAdminError && error.httpStatus ? { http_status: error.httpStatus } : {}),
      ...(error instanceof McpAdminError && error.retryAfter ? { retry_after: error.retryAfter } : {}) }));
    setCliExitVerdict(1);
  }
}
