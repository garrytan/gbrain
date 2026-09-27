import { mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { assertNoSymlinks } from '../agent-install/state.ts';
import { assertSecureEndpoint, readPrivateText } from './credentials.ts';
import { harnessAdapter } from './registry.ts';
import { normalizeMcpUrl, validateToken } from '../mcp-registration.ts';

export type ClientFlow = 'authorization-code' | 'client-credentials';
/** Explicit allowlist. Never serialize the SDK client: its client_secret is a hash. */
export interface OAuthClientMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  client_secret_expires_at?: number;
}
export interface OAuthClientSetup {
  kind: 'oauth-client-setup'; version: 1; flow: 'authorization-code';
  mcp_url: string; issuer_url: string; scopes: string[]; harness: string;
  client: OAuthClientMetadata & { client_secret?: string };
  instructions: string[];
}
export interface MachineClientSetup extends Omit<OAuthClientSetup, 'kind' | 'flow'> {
  kind: 'machine-client-setup'; flow: 'client-credentials';
}

export function clientMetadata(row: Record<string, unknown>): OAuthClientMetadata {
  return { client_id: String(row.client_id), client_name: String(row.client_name ?? row.client_id),
    redirect_uris: Array.isArray(row.redirect_uris) ? row.redirect_uris.filter((v): v is string => typeof v === 'string') : [],
    grant_types: Array.isArray(row.grant_types) ? row.grant_types.filter((v): v is string => typeof v === 'string') : [],
    token_endpoint_auth_method: String(row.token_endpoint_auth_method ?? 'client_secret_post'),
    ...(Number(row.client_secret_expires_at) > 0 ? { client_secret_expires_at: Number(row.client_secret_expires_at) } : {}) };
}

export function selectClientFlow(client: OAuthClientMetadata, requested?: unknown): ClientFlow {
  const native = client.grant_types.includes('authorization_code');
  const machine = client.grant_types.includes('client_credentials');
  if (requested !== undefined && typeof requested !== 'string') throw new Error('invalid_flow: select authorization-code or client-credentials');
  const flow = typeof requested === 'string' ? requested.replace(/_/g, '-') : undefined;
  if (!flow && native && machine) throw new Error('flow_required: mixed-grant clients require --flow authorization-code|client-credentials');
  const selected = flow ?? (native ? 'authorization-code' : 'client-credentials');
  if ((selected !== 'authorization-code' || !native) && (selected !== 'client-credentials' || !machine)) {
    throw new Error('invalid_flow: this registration does not support the selected flow');
  }
  return selected as ClientFlow;
}

export function buildClientSetup(client: OAuthClientMetadata, endpoint: string, scopes: string[], harness = 'generic', requestedFlow?: unknown): OAuthClientSetup | MachineClientSetup {
  const normalized = normalizeMcpUrl(endpoint);
  if (!normalized.ok) throw new Error('Invalid configured MCP endpoint');
  assertSecureEndpoint(normalized.url);
  const adapter = harnessAdapter(harness);
  const flow = selectClientFlow(client, requestedFlow);
  const instructions = flow === 'authorization-code' ? [
    `In ${adapter.label}, use manual native OAuth setup for ${normalized.url}. Enter the registered client ID and exact callback URI; choose ${client.token_endpoint_auth_method}.`,
    client.token_endpoint_auth_method === 'none' ? 'Public PKCE needs no client secret.' : 'Export the confidential setup to a private file and enter its client secret only in the native OAuth configuration.',
    'Start authorization in the native client using S256 PKCE. The server administrator must approve the request in the owner panel. An OAuth admin scope is not owner authority.',
    'If this harness does not expose native OAuth client configuration for this method, follow its manual OAuth instructions or use a separate machine registration. Do not install this file with gbrain connect.',
    'Registration and a downloaded setup file do not verify a connection. Complete authorization and an allowed MCP call in the intended harness.',
  ] : [
    'Explicitly export the private machine handoff, then install it inside the intended harness with gbrain connect using --credentials-file.',
    `Follow https://github.com/garrytan/gbrain/blob/master/${adapter.guide} for ${adapter.label}; honor its supported installation method.`,
    'Run gbrain mcp verify and separately observe an allowed MCP call in the intended harness before claiming that harness is connected.',
  ];
  return { kind: flow === 'authorization-code' ? 'oauth-client-setup' : 'machine-client-setup', version: 1, flow,
    mcp_url: normalized.url, issuer_url: normalized.url.replace(/\/mcp$/, ''), scopes: [...scopes], harness: adapter.id,
    client: clientMetadata(client as unknown as Record<string, unknown>), instructions } as OAuthClientSetup | MachineClientSetup;
}

export function validateOAuthClientSetup(value: unknown): OAuthClientSetup {
  if (!value || typeof value !== 'object') throw new Error('Invalid OAuth client setup');
  const v = value as Record<string, unknown>;
  const c = v.client as Record<string, unknown> | undefined;
  if (v.kind !== 'oauth-client-setup' || v.version !== 1 || v.flow !== 'authorization-code' || !c
    || typeof c.client_id !== 'string' || !c.client_id || typeof c.client_name !== 'string'
    || !Array.isArray(c.redirect_uris) || !c.redirect_uris.length || !c.redirect_uris.every(x => typeof x === 'string')
    || !Array.isArray(c.grant_types) || !c.grant_types.every(x => typeof x === 'string')
    || typeof c.token_endpoint_auth_method !== 'string' || !['none', 'client_secret_post', 'client_secret_basic'].includes(c.token_endpoint_auth_method)
    || typeof v.mcp_url !== 'string' || typeof v.issuer_url !== 'string' || typeof v.harness !== 'string'
    || !Array.isArray(v.scopes) || !v.scopes.every(x => typeof x === 'string')) throw new Error('Unsupported or incomplete OAuth client setup');
  const setup = buildClientSetup(clientMetadata(c), v.mcp_url, v.scopes, v.harness, 'authorization-code') as OAuthClientSetup;
  if (v.issuer_url.replace(/\/$/, '') !== setup.issuer_url) throw new Error('OAuth issuer does not match endpoint');
  if (c.client_secret !== undefined) {
    if (c.token_endpoint_auth_method === 'none' || typeof c.client_secret !== 'string' || !validateToken(c.client_secret).ok) throw new Error('Invalid confidential OAuth setup');
    setup.client.client_secret = c.client_secret;
  }
  return setup;
}

export function writeOAuthClientSetup(path: string, value: OAuthClientSetup): void {
  const setup = validateOAuthClientSetup(value);
  const target = resolve(path);
  assertNoSymlinks(target);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    if (!lstatSync(target).isFile()) throw new Error('Setup destination must be a regular file');
    const existing = validateOAuthClientSetup(JSON.parse(readPrivateText(target, 65_536)));
    if (existing.client.client_id !== setup.client.client_id || existing.mcp_url !== setup.mcp_url) throw new Error('Setup destination belongs to another connection');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  atomicWriteTextFile(target, `${JSON.stringify(setup, null, 2)}\n`, { forceMode: 0o600 });
}
