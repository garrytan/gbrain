/**
 * Non-owning adoption evidence for independently managed harness wiring.
 *
 * Bootstrap receipts record resources that gbrain created and may remove.
 * A project-scoped Codex MCP entry is owned by the workspace/operator, so it
 * is detected and attested here instead of being forged into that receipt.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { acquireBootstrapLock } from './lock.ts';
import { defaultRunner, type ExecResult, type ExecRunner } from './repo.ts';

export const ADOPTED_CONNECTIONS_SCHEMA_VERSION = 1;

export type AdoptedTransport = 'stdio' | 'streamable_http' | 'unknown';
export type AdoptedAuth = 'not_proven';

export interface AdoptedHarnessConnection {
  workspace: string;
  harness: 'codex';
  scope: 'project';
  server_name: string;
  transport: AdoptedTransport;
  /** Codex's `mcp get --json` does not prove an authenticated call. */
  auth: AdoptedAuth;
  effective_config_fingerprint: string;
  verification_class: 'operator_attested_runtime_call';
  verified_at: string;
}

interface AdoptedConnectionsFile {
  schema_version: 1;
  connections: AdoptedHarnessConnection[];
}

export interface CodexProjectMcpProbe {
  configured: boolean;
  cli_readable: boolean;
  enabled?: boolean;
  transport?: AdoptedTransport;
  auth?: AdoptedAuth;
  effective_config_fingerprint?: string;
  detail?: string;
}

export const CODEX_MCP_PROBE_TIMEOUT_MS = 5_000;

export function adoptedConnectionsPath(gbrainHomeDir: string): string {
  return join(gbrainHomeDir, 'bootstrap', 'adopted-connections.json');
}

export type AdoptedConnectionsState =
  | { state: 'absent' }
  | { state: 'ok'; connections: AdoptedHarnessConnection[] }
  | { state: 'newer'; schema_version: number }
  | { state: 'invalid'; reason: string };

export function readAdoptedConnectionsState(gbrainHomeDir: string): AdoptedConnectionsState {
  const path = adoptedConnectionsPath(gbrainHomeDir);
  if (!existsSync(path)) return { state: 'absent' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AdoptedConnectionsFile>;
    if (typeof parsed.schema_version === 'number' && parsed.schema_version > ADOPTED_CONNECTIONS_SCHEMA_VERSION) {
      return { state: 'newer', schema_version: parsed.schema_version };
    }
    if (parsed.schema_version !== ADOPTED_CONNECTIONS_SCHEMA_VERSION || !Array.isArray(parsed.connections)) {
      return { state: 'invalid', reason: 'missing supported schema_version or connections array' };
    }
    const connections = parsed.connections.filter((entry): entry is AdoptedHarnessConnection =>
      typeof entry === 'object' && entry !== null &&
      entry.harness === 'codex' && entry.scope === 'project' &&
      typeof entry.workspace === 'string' && isAbsolute(entry.workspace) &&
      typeof entry.server_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.server_name) &&
      entry.transport === 'streamable_http' &&
      entry.auth === 'not_proven' &&
      typeof entry.effective_config_fingerprint === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(entry.effective_config_fingerprint) &&
      entry.verification_class === 'operator_attested_runtime_call' &&
      typeof entry.verified_at === 'string' && Number.isFinite(Date.parse(entry.verified_at)),
    );
    if (connections.length !== parsed.connections.length) {
      return { state: 'invalid', reason: 'one or more connection records have an invalid shape' };
    }
    return { state: 'ok', connections };
  } catch (e) {
    return { state: 'invalid', reason: (e as Error).message };
  }
}

async function withEvidenceLock<T>(gbrainHomeDir: string, work: () => T | Promise<T>): Promise<T> {
  const bootstrapDir = join(gbrainHomeDir, 'bootstrap');
  const lockRoot = join(bootstrapDir, 'adopted-connections-lock-root');
  mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof acquireBootstrapLock>>;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await acquireBootstrapLock(lockRoot);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== 'BOOTSTRAP_IN_PROGRESS' || attempt >= 200) throw e;
      await Bun.sleep(25);
    }
  }
  try {
    return await work();
  } finally {
    handle.release();
  }
}

export async function writeAdoptedConnection(
  gbrainHomeDir: string,
  connection: AdoptedHarnessConnection,
): Promise<void> {
  await withEvidenceLock(gbrainHomeDir, () => {
    const path = adoptedConnectionsPath(gbrainHomeDir);
    const state = readAdoptedConnectionsState(gbrainHomeDir);
    if (state.state === 'newer') {
      throw new Error(
        `the adopted-connections file was written by a newer gbrain (schema_version ${state.schema_version}) — upgrade gbrain before adopting`,
      );
    }
    let prior: AdoptedHarnessConnection[] = [];
    if (state.state === 'ok') prior = state.connections;
    if (state.state === 'invalid') {
      const backup = `${path}.broken-${Date.now()}-${randomUUID()}`;
      renameSync(path, backup);
      console.error(`WARNING: adopted-connection evidence was unreadable; backed it up to ${backup} before writing a fresh file.`);
    }
    const retained = prior.filter((entry) => !(
      entry.workspace === connection.workspace &&
      entry.harness === connection.harness &&
      entry.scope === connection.scope &&
      entry.server_name === connection.server_name
    ));
    const file: AdoptedConnectionsFile = {
      schema_version: ADOPTED_CONNECTIONS_SCHEMA_VERSION,
      connections: [...retained, connection],
    };
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CodexProjectConfigState =
  | { state: 'absent' }
  | { state: 'readable'; names: string[] }
  | { state: 'unreadable'; detail: string };

/** Names declared by exact `[mcp_servers.<name>]` project tables. */
export function readCodexProjectConfig(workspaceDir: string): CodexProjectConfigState {
  const path = join(workspaceDir, '.codex', 'config.toml');
  if (!existsSync(path)) return { state: 'absent' };
  try {
    const names = new Set<string>();
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*\[\s*mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line);
      const raw = match?.[1] ?? match?.[2] ?? match?.[3];
      if (raw) names.add(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
    if (names.size === 0 && /\bmcp_servers\b/.test(readFileSync(path, 'utf8'))) {
      return { state: 'unreadable', detail: 'contains MCP server syntax this gbrain version cannot safely classify' };
    }
    return { state: 'readable', names: [...names].sort() };
  } catch (e) {
    return { state: 'unreadable', detail: (e as Error).message };
  }
}

export function codexProjectMcpNames(workspaceDir: string): string[] {
  const state = readCodexProjectConfig(workspaceDir);
  return state.state === 'readable' ? state.names : [];
}

export function hasCodexProjectMcpTable(workspaceDir: string, serverName: string): boolean {
  // Keep a direct escaped-table fallback for unusual-but-valid bare names;
  // normal names are returned by the structural line parser above.
  if (codexProjectMcpNames(workspaceDir).includes(serverName)) return true;
  try {
    const raw = readFileSync(join(workspaceDir, '.codex', 'config.toml'), 'utf8');
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\.${escapeRegExp(serverName)}\\s*\\]\\s*(?:#.*)?$`, 'm').test(raw);
  } catch {
    return false;
  }
}

function transportFromCodexJson(value: unknown): AdoptedTransport {
  if (typeof value !== 'object' || value === null) return 'unknown';
  const record = value as Record<string, unknown>;
  const transport = record.transport;
  if (typeof transport === 'object' && transport !== null) {
    const kind = (transport as Record<string, unknown>).type;
    if (kind === 'stdio') return 'stdio';
    if (kind === 'streamable_http' || kind === 'http') return 'streamable_http';
  }
  if (typeof record.url === 'string') return 'streamable_http';
  if (typeof record.command === 'string') return 'stdio';
  return 'unknown';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedHeaderNames(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const record = recordValue(value);
    return record ? Object.keys(record).map((name) => name.toLowerCase()) : [];
  }))].sort();
}

function normalizedStringSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return [...new Set(value as string[])].sort();
}

function endpointProjection(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const endpoint = new URL(value);
    return {
      scheme: endpoint.protocol.slice(0, -1).toLowerCase(),
      host: endpoint.hostname.toLowerCase(),
      port: endpoint.port,
      path: endpoint.pathname,
    };
  } catch {
    return undefined;
  }
}

function explicitAuthProjection(...values: unknown[]): { present: boolean; mechanism?: string } {
  const knownMechanisms = new Set(['none', 'oauth', 'bearer', 'basic', 'api_key']);
  for (const value of values) {
    const raw = typeof value === 'string' ? value : recordValue(value)?.type;
    if (typeof raw !== 'string') continue;
    const normalized = raw.toLowerCase().replaceAll('-', '_');
    return knownMechanisms.has(normalized)
      ? { present: true, mechanism: normalized }
      : { present: true };
  }
  return { present: values.some((value) => value !== undefined && value !== null) };
}

/**
 * Hash an allowlisted structural projection only. Secret-bearing values,
 * query strings, fragments, URL userinfo, and unknown fields never enter the
 * digest, so this cannot become an offline secret verifier.
 */
export function fingerprintCodexEffectiveConfig(value: unknown): string {
  const record = recordValue(value) ?? {};
  const transport = recordValue(record.transport) ?? {};
  const staticHeaderNames = normalizedHeaderNames(record.http_headers, transport.http_headers);
  const envHeaderNames = normalizedHeaderNames(record.env_http_headers, transport.env_http_headers);
  const endpoint = endpointProjection(transport.url ?? record.url);
  const enabledTools = normalizedStringSet(record.enabled_tools ?? transport.enabled_tools);
  const disabledTools = normalizedStringSet(record.disabled_tools ?? transport.disabled_tools);
  const startupTimeout = record.startup_timeout_sec ?? transport.startup_timeout_sec;
  const toolTimeout = record.tool_timeout_sec ?? transport.tool_timeout_sec;
  const projection: Record<string, unknown> = {
    enabled: record.enabled !== false,
    transport: transportFromCodexJson(value),
    auth: {
      ...explicitAuthProjection(record.auth, transport.auth),
      bearer_token_env_present: typeof (transport.bearer_token_env_var ?? record.bearer_token_env_var) === 'string',
      authorization_header_present: [...staticHeaderNames, ...envHeaderNames].includes('authorization'),
    },
    static_header_names: staticHeaderNames,
    env_header_names: envHeaderNames,
  };
  if (endpoint) projection.endpoint = endpoint;
  if (typeof startupTimeout === 'number' && Number.isFinite(startupTimeout)) {
    projection.startup_timeout_sec = startupTimeout;
  }
  if (typeof toolTimeout === 'number' && Number.isFinite(toolTimeout)) {
    projection.tool_timeout_sec = toolTimeout;
  }
  if (enabledTools) projection.enabled_tools = enabledTools;
  if (disabledTools) projection.disabled_tools = disabledTools;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(projection))).digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}

async function runCodexCancellable(argv: string[], timeoutMs: number): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: process.env });
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
      forceKill = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }, 250);
    } catch { /* already exited */ }
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(''),
    proc.exited,
  ]);
  clearTimeout(timeout);
  clearTimeout(forceKill);
  return timedOut
    ? { code: 124, stdout, stderr: stderr || `timeout after ${timeoutMs}ms` }
    : { code, stdout, stderr };
}

export async function probeCodexProjectMcp(
  workspaceDir: string,
  serverName: string,
  runner: ExecRunner = defaultRunner,
  opts: { timeoutMs?: number } = {},
): Promise<CodexProjectMcpProbe> {
  if (!hasCodexProjectMcpTable(workspaceDir, serverName)) {
    return { configured: false, cli_readable: false };
  }
  const argv = ['codex', '-C', workspaceDir, 'mcp', 'get', serverName, '--json'];
  const result = runner === defaultRunner
    ? await runCodexCancellable(argv, opts.timeoutMs ?? CODEX_MCP_PROBE_TIMEOUT_MS)
    : await runner(argv);
  if (result.code !== 0) {
    return {
      configured: true,
      cli_readable: false,
      detail: result.code === 127
        ? 'codex CLI not available'
        : result.code === 124
          ? 'Codex effective-config probe timed out'
          : 'Codex could not read the effective project MCP entry',
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const enabled = typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).enabled === false
      ? false
      : true;
    return {
      configured: true,
      cli_readable: true,
      enabled,
      transport: transportFromCodexJson(parsed),
      auth: 'not_proven',
      effective_config_fingerprint: fingerprintCodexEffectiveConfig(parsed),
      ...(enabled ? {} : { detail: 'the effective Codex MCP entry is disabled' }),
    };
  } catch {
    return { configured: true, cli_readable: false, detail: 'Codex returned invalid JSON for the effective MCP entry' };
  }
}
