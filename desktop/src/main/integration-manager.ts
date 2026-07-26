import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupFile } from './config-manager.js';
import type { SidecarManager } from './sidecar-manager.js';

export type IntegrationClient = 'codebuddy' | 'workbuddy' | 'cursor' | 'trae' | 'claude' | 'codex' | 'qwenpaw';
export type CredentialKind = 'api_key' | 'oauth';

export interface IntegrationInfo {
  id: IntegrationClient;
  name: string;
  path: string | null;
  configured: boolean;
  automatic: boolean;
  configuredPort?: number;
  portMismatch?: boolean;
  connectionState?: 'connected' | 'saved';
}

export interface IntegrationResult {
  client: IntegrationClient;
  credentialKind: CredentialKind;
  configured: boolean;
  path: string | null;
  backup: string | null;
  snippet: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  smoke?: { toolCount: number; statsOk: boolean };
  connectionState?: 'connected' | 'saved';
}

export interface SharedIntegrationPayload {
  memberName: string;
  client: IntegrationClient;
  canWrite: boolean;
  sourceId?: string;
  federatedRead?: string[];
}

export interface SharedIntegrationResult {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  sourceId?: string;
  federatedRead: string[];
  mcpUrl: string;
  snippet: string;
}

export interface SharedSourceInfo {
  id: string;
  name: string;
  federated: boolean;
  archived: boolean;
}

export interface SharedCredentialInfo {
  id: string;
  name: string;
  credentialName: string;
  status: 'active' | 'revoked';
  scope: string;
  sourceId?: string;
  federatedRead: string[];
  lastUsedAt?: string | null;
  totalRequests: number;
}

export interface SharedAccessContext {
  mcpUrl: string;
  mainSourceId: string;
  sources: SharedSourceInfo[];
  credentials: SharedCredentialInfo[];
}

export interface SharedIntegrationSmokeResult {
  toolCount: number;
  transport: string;
  scopes: string[];
}

const CLIENT_META: Record<IntegrationClient, { name: string; path: () => string | null; automatic: boolean }> = {
  codebuddy: { name: 'CodeBuddy', path: () => join(homedir(), '.codebuddy', 'mcp.json'), automatic: true },
  workbuddy: { name: 'Workbuddy', path: () => join(homedir(), '.workbuddy', 'mcp.json'), automatic: true },
  cursor: { name: 'Cursor', path: () => join(homedir(), '.cursor', 'mcp.json'), automatic: true },
  trae: { name: 'Trae', path: () => join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Trae', 'User', 'mcp.json'), automatic: true },
  claude: { name: 'Claude', path: () => null, automatic: false },
  codex: { name: 'Codex', path: () => join(homedir(), '.codex', 'config.toml'), automatic: true },
  qwenpaw: { name: 'QwenPaw', path: () => qwenPawIntegrationPath(), automatic: true },
};

interface QwenPawPaths {
  root: string;
  legacyConfig: string;
  desktopPort: string;
  driverCard: string;
  credentials: string;
}

function qwenPawPaths(homeDirectory = homedir()): QwenPawPaths {
  const root = join(homeDirectory, '.qwenpaw');
  return {
    root,
    legacyConfig: join(root, 'config.json'),
    desktopPort: join(root, 'desktop_port'),
    driverCard: join(root, 'workspaces', 'default', 'drivers', 'mcp', 'pmbrain.yaml'),
    credentials: join(root, 'workspaces', 'default', 'credentials.yaml'),
  };
}

export function qwenPawIntegrationPath(homeDirectory = homedir()): string {
  const paths = qwenPawPaths(homeDirectory);
  return existsSync(paths.desktopPort) || existsSync(paths.driverCard)
    ? paths.driverCard
    : paths.legacyConfig;
}

export function qwenPawDriverIsConfigured(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const driver = readFileSync(path, 'utf8');
    if (!/^name:\s*pmbrain\s*$/m.test(driver)
      || !/^\s*url:\s*https?:\/\/\S+\/mcp\s*$/m.test(driver)
      || !/^\s*Authorization:\s*$/m.test(driver)) return false;
    const credentialsPath = join(dirname(path), '..', '..', 'credentials.yaml');
    if (!existsSync(credentialsPath)) return false;
    const credentials = readFileSync(credentialsPath, 'utf8');
    let inPmbrain = false;
    let inSecrets = false;
    let authorization = '';
    for (const line of credentials.split(/\r?\n/)) {
      const credentialKey = line.match(/^  ([^\s][^:]*):\s*$/)?.[1];
      if (credentialKey) {
        inPmbrain = credentialKey === 'mcp/pmbrain';
        inSecrets = false;
        continue;
      }
      if (!inPmbrain) continue;
      if (/^    secrets:\s*$/.test(line)) {
        inSecrets = true;
        continue;
      }
      if (inSecrets) {
        const match = line.match(/^      authorization:\s*([^\r\n]+)$/);
        if (match) {
          authorization = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
          break;
        }
      }
    }
    // QwenPaw 2.x may encrypt or otherwise encode persisted secrets. A
    // non-empty authorization entry means the configuration was saved; the
    // local tools API is the source of truth for whether it is connected.
    return authorization.length > 0;
  } catch {
    return false;
  }
}

function jsonEntry(mcpUrl: string, token: string) {
  return {
    type: 'http',
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function qwenPawEntry(mcpUrl: string, token: string) {
  return {
    name: 'PMBrain',
    description: 'PMBrain 本地知识库',
    enabled: true,
    transport: 'streamable_http',
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function formatSharedIntegrationSnippet(
  client: IntegrationClient,
  mcpUrl: string,
  token: string,
): string {
  if (client === 'codex') {
    return [
      '[mcp_servers.pmbrain]',
      `url = ${tomlString(mcpUrl)}`,
      `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    ].join('\n');
  }
  if (client === 'claude') {
    return `claude mcp add pmbrain -t http ${mcpUrl} -H ${tomlString(`Authorization: Bearer ${token}`)}`;
  }
  if (client === 'qwenpaw') {
    return JSON.stringify({ mcp: { clients: { pmbrain: qwenPawEntry(mcpUrl, token) } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { pmbrain: jsonEntry(mcpUrl, token) } }, null, 2);
}

function validateSharedMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('共享 MCP 地址无效。');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (!['http:', 'https:'].includes(url.protocol) || loopback || url.pathname !== '/mcp') {
    throw new Error('共享凭证必须使用局域网或企业网络的 /mcp 地址，不能使用本机回环地址。');
  }
  return url.toString();
}

export async function createSharedIntegration(
  sidecar: SidecarManager,
  mcpUrl: string,
  payload: SharedIntegrationPayload,
): Promise<SharedIntegrationResult> {
  const memberName = typeof payload?.memberName === 'string' ? payload.memberName.trim() : '';
  if (!memberName || memberName.length > 64 || /[\r\n:]/.test(memberName)) {
    throw new Error('成员名称需要填写、不能包含冒号，且不能超过 64 个字符。');
  }
  if (!payload?.client || !CLIENT_META[payload.client]) throw new Error(`不支持的客户端：${String(payload?.client ?? '')}`);
  const remoteUrl = validateSharedMcpUrl(mcpUrl);
  const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId.trim() || undefined : undefined;
  let federatedRead = Array.from(new Set(
    (Array.isArray(payload?.federatedRead) ? payload.federatedRead : [])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  ));
  if ([sourceId, ...federatedRead].some(value => value && /[\r\n]/.test(value))) {
    throw new Error('知识源 ID 无效。');
  }
  const canWrite = payload?.canWrite === true;
  if (canWrite && !sourceId) throw new Error('开启写入权限时必须明确选择写入知识源。');
  if (canWrite && sourceId && !federatedRead.includes(sourceId)) {
    federatedRead = [...federatedRead, sourceId];
  }
  const scopes = canWrite ? 'read write' : 'read';
  const expectedScopes = scopes.split(' ');
  const name = `shared:${memberName}:${randomUUID()}`;
  const result = await sidecar.adminRequest<{
    id: string;
    name?: string;
    token: string;
    scopes?: string[];
    sourceId?: string;
    federatedRead?: string[];
  }>('/admin/api/api-keys', {
    method: 'POST',
    body: JSON.stringify({
      name,
      scopes,
      ...(sourceId ? { sourceId } : {}),
      ...(federatedRead.length > 0 ? { federatedRead } : {}),
    }),
  });
  if (!result.token || !result.id) {
    try {
      await revokeSharedIntegration(sidecar, result.name ?? name);
    } catch (rollbackError) {
      throw new Error(
        `PMBrain 未完整返回共享 API Key，且自动撤销失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        + `。请立即在成员凭证列表中手动撤销 ${result.name ?? name}。`,
      );
    }
    throw new Error('PMBrain 未完整返回共享 API Key；可能已创建的凭证已立即撤销，请重试。');
  }
  const resolvedScopes = result.scopes ?? [];
  const sameSet = (left: string[], right: string[]) => (
    left.length === right.length && left.every(value => right.includes(value))
  );
  const resolvedFederatedRead = result.federatedRead ?? [];
  const invalidScope = !sameSet(resolvedScopes, expectedScopes);
  const invalidWriteSource = canWrite && result.sourceId !== sourceId;
  const invalidReadScope = federatedRead.length > 0 && !sameSet(resolvedFederatedRead, federatedRead);
  if (invalidScope || invalidWriteSource || invalidReadScope) {
    let rollbackError: unknown;
    try {
      await revokeSharedIntegration(sidecar, result.name ?? name);
    } catch (error) {
      rollbackError = error;
    }
    if (rollbackError) {
      throw new Error(
        `PMBrain 返回的共享凭证权限与请求不一致，且自动撤销失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        + '。请立即在成员凭证列表中手动撤销该凭证。',
      );
    }
    throw new Error('PMBrain 返回的共享凭证权限与请求不一致，已立即撤销；请检查知识源配置后重试。');
  }
  return {
    id: result.id,
    name: result.name ?? name,
    token: result.token,
    scopes: resolvedScopes,
    sourceId: result.sourceId ?? sourceId,
    federatedRead: resolvedFederatedRead,
    mcpUrl: remoteUrl,
    snippet: formatSharedIntegrationSnippet(payload.client, remoteUrl, result.token),
  };
}

function parseMcpResponse(text: string, id: number): Record<string, any> {
  const payloads = text.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .concat(text.trim().startsWith('{') ? [text.trim()] : [])
    .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
    .filter(Boolean) as Record<string, any>[];
  return payloads.find(item => item.id === id) ?? payloads[0] ?? {};
}

export async function smokeTestSharedIntegration(
  mcpUrl: string,
  token: string,
  expectedScopes: string[],
  expectedCredentialName: string,
): Promise<SharedIntegrationSmokeResult> {
  const remoteUrl = validateSharedMcpUrl(mcpUrl);
  const call = async (method: string, params: Record<string, unknown>, id: number) => {
    const response = await fetch(remoteUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`局域网 MCP ${method} 返回 HTTP ${response.status}`);
    const payload = parseMcpResponse(text, id);
    if (payload.error) throw new Error(`局域网 MCP ${method} 失败：${payload.error.message ?? '未知错误'}`);
    if (payload.result?.isError === true) {
      const detail = payload.result.content?.[0]?.text ?? '工具返回错误';
      throw new Error(`局域网 MCP ${method} 失败：${detail}`);
    }
    return payload;
  };

  await call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'pmbrain-desktop-shared-smoke', version: '1' },
  }, 1);
  const tools = await call('tools/list', {}, 2);
  const listedTools = Array.isArray(tools.result?.tools) ? tools.result.tools : [];
  const listedNames = listedTools
    .map((tool: { name?: unknown }) => typeof tool.name === 'string' ? tool.name : '')
    .filter(Boolean);
  if (!listedTools.some((tool: { name?: string }) => tool.name === 'whoami')) {
    throw new Error('局域网 MCP 未返回共享模式所需的 whoami 工具。');
  }
  const whoami = await call('tools/call', { name: 'whoami', arguments: {} }, 3);
  let identity: Record<string, unknown> = {};
  try {
    identity = JSON.parse(whoami.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  } catch {
    throw new Error('局域网 MCP whoami 返回了无法识别的身份信息。');
  }
  const scopes = Array.isArray(identity.scopes)
    ? identity.scopes.filter((value): value is string => typeof value === 'string')
    : [];
  const sameScopes = scopes.length === expectedScopes.length
    && scopes.every(scope => expectedScopes.includes(scope));
  if (!sameScopes) throw new Error('局域网 MCP 实际权限与刚创建的共享凭证不一致。');
  if (identity.transport !== 'legacy' || identity.token_name !== expectedCredentialName) {
    throw new Error('局域网 MCP 返回的身份不是刚创建的共享凭证。');
  }
  return {
    toolCount: listedNames.length,
    transport: typeof identity.transport === 'string' ? identity.transport : 'unknown',
    scopes,
  };
}

export async function getSharedAccessContext(
  sidecar: SidecarManager,
  mcpUrl: string,
): Promise<SharedAccessContext> {
  const [overview, agents] = await Promise.all([
    sidecar.adminRequest<{
      main_source_id?: string;
      sources?: Array<{ id: string; name?: string; federated?: boolean; archived?: boolean }>;
    }>('/admin/api/brain/overview'),
    sidecar.adminRequest<Array<{
      id: string;
      name: string;
      auth_type: string;
      status: 'active' | 'revoked';
      scope?: string;
      source_id?: string;
      federated_read?: string[];
      last_used_at?: string | null;
      total_requests?: number;
    }>>('/admin/api/agents'),
  ]);
  const sources = (overview.sources ?? [])
    .filter(source => source.archived !== true)
    .map(source => ({
      id: source.id,
      name: source.name?.trim() || source.id,
      federated: source.federated === true,
      archived: false,
    }));
  const mainSourceId = overview.main_source_id?.trim() || sources[0]?.id || 'default';
  const credentials = agents
    .filter(agent => agent.auth_type === 'api_key' && agent.name.startsWith('shared:'))
    .map(agent => {
      const rawName = agent.name.slice('shared:'.length);
      const parts = rawName.split(':');
      const hasGeneratedSuffix = parts.length > 1 && /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(parts.at(-1) ?? '');
      return {
        id: agent.id,
        name: hasGeneratedSuffix ? parts.slice(0, -1).join(':') : rawName,
        credentialName: agent.name,
        status: agent.status,
        scope: agent.scope ?? 'read',
        sourceId: agent.source_id,
        federatedRead: agent.federated_read ?? (agent.source_id ? [agent.source_id] : []),
        lastUsedAt: agent.last_used_at,
        totalRequests: agent.total_requests ?? 0,
      };
    });
  return { mcpUrl: validateSharedMcpUrl(mcpUrl), mainSourceId, sources, credentials };
}

export async function revokeSharedIntegration(sidecar: SidecarManager, credentialName: string): Promise<void> {
  const normalized = typeof credentialName === 'string' ? credentialName.trim() : '';
  if (!normalized.startsWith('shared:') || /[\r\n]/.test(normalized)) throw new Error('共享凭证名称无效。');
  await sidecar.adminRequest('/admin/api/api-keys/revoke', {
    method: 'POST',
    body: JSON.stringify({ name: normalized }),
  });
}

export function writeJsonIntegration(path: string, mcpUrl: string, token: string, backupRoot?: string): string | null {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${path} 不是有效 JSON，已停止写入：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const backup = backupFile(path, 'mcp', backupRoot);
  const servers = root.mcpServers && typeof root.mcpServers === 'object'
    ? { ...(root.mcpServers as Record<string, unknown>) }
    : {};
  servers.pmbrain = jsonEntry(mcpUrl, token);
  root.mcpServers = servers;
  writeTextFile(path, `${JSON.stringify(root, null, 2)}\n`);
  return backup;
}

export function writeQwenPawIntegration(path: string, mcpUrl: string, token: string, backupRoot?: string): string | null {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${path} 不是有效 JSON，已停止写入：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const backup = backupFile(path, 'mcp', backupRoot);
  const mcp = root.mcp && typeof root.mcp === 'object' && !Array.isArray(root.mcp)
    ? { ...(root.mcp as Record<string, unknown>) }
    : {};
  const clients = mcp.clients && typeof mcp.clients === 'object' && !Array.isArray(mcp.clients)
    ? { ...(mcp.clients as Record<string, unknown>) }
    : {};
  clients.pmbrain = qwenPawEntry(mcpUrl, token);
  mcp.clients = clients;
  root.mcp = mcp;
  writeTextFile(path, `${JSON.stringify(root, null, 2)}\n`);
  return backup;
}

interface QwenPawDesktopIntegrationResult {
  path: string;
  backup: string | null;
  toolCount: number;
  connected: boolean;
}

function readQwenPawDesktopPort(path: string): number {
  if (!existsSync(path)) {
    throw new Error('未检测到运行中的 QwenPaw 2.x。请先启动 QwenPaw，再点击一键接入。');
  }
  const value = readFileSync(path, 'utf8').trim();
  if (!/^\d{1,5}$/.test(value)) throw new Error('QwenPaw 本地服务端口文件无效，请重启 QwenPaw 后重试。');
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) throw new Error('QwenPaw 本地服务端口超出有效范围，请重启 QwenPaw 后重试。');
  return port;
}

async function qwenPawApiRequest(
  baseUrl: string,
  path: string,
  init: RequestInit,
  request: typeof fetch,
): Promise<Response> {
  try {
    return await request(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error('无法连接 QwenPaw 本地服务。请确认 QwenPaw 已启动，再点击一键接入。');
  }
}

export async function configureQwenPawDesktopIntegration(
  mcpUrl: string,
  token: string,
  homeDirectory = homedir(),
  backupRoot?: string,
  request: typeof fetch = fetch,
  pause: (milliseconds: number) => Promise<unknown> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<QwenPawDesktopIntegrationResult> {
  const paths = qwenPawPaths(homeDirectory);
  const port = readQwenPawDesktopPort(paths.desktopPort);
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = qwenPawEntry(mcpUrl, token);
  const existing = await qwenPawApiRequest(baseUrl, '/api/mcp/pmbrain', { method: 'GET' }, request);
  if (!existing.ok && existing.status !== 404) {
    throw new Error(`QwenPaw 本地接口检查失败（HTTP ${existing.status}），请重启 QwenPaw 后重试。`);
  }

  const driverBackup = backupFile(paths.driverCard, 'mcp', backupRoot);
  const credentialBackup = backupFile(paths.credentials, 'mcp', backupRoot);
  const updating = existing.ok;
  const response = await qwenPawApiRequest(
    baseUrl,
    updating ? '/api/mcp/pmbrain' : '/api/mcp',
    {
      method: updating ? 'PUT' : 'POST',
      body: JSON.stringify(updating ? client : { client_key: 'pmbrain', client }),
    },
    request,
  );
  if (!response.ok) {
    throw new Error(`QwenPaw 保存 PMBrain 配置失败（HTTP ${response.status}），原配置备份已保留。`);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    let tools: Response | null = null;
    try {
      tools = await qwenPawApiRequest(baseUrl, '/api/mcp/tools/pmbrain', { method: 'GET' }, request);
    } catch {
      // The configuration was already accepted by QwenPaw. Preserve that
      // state and let the UI distinguish it from a verified connection.
    }
    if (tools?.ok) {
      const payload = await tools.json().catch(() => null);
      if (!Array.isArray(payload)) throw new Error('QwenPaw 已保存配置，但返回了无法识别的 MCP 工具列表。');
      return {
        path: paths.driverCard,
        backup: driverBackup ?? credentialBackup,
        toolCount: payload.length,
        connected: true,
      };
    }
    if (attempt < 9) await pause(300);
  }
  return {
    path: paths.driverCard,
    backup: driverBackup ?? credentialBackup,
    toolCount: 0,
    connected: false,
  };
}

export async function probeQwenPawConnectionState(
  homeDirectory = homedir(),
  request: typeof fetch = fetch,
): Promise<'connected' | 'saved' | undefined> {
  const paths = qwenPawPaths(homeDirectory);
  const path = qwenPawIntegrationPath(homeDirectory);
  if (!isConfigured('qwenpaw', path)) return undefined;
  if (!existsSync(paths.desktopPort)) return 'saved';
  try {
    const port = readQwenPawDesktopPort(paths.desktopPort);
    const response = await request(`http://127.0.0.1:${port}/api/mcp/tools/pmbrain`, {
      method: 'GET',
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return 'saved';
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? 'connected' : 'saved';
  } catch {
    return 'saved';
  }
}

const CODEX_START = '# >>> PMBrain Desktop managed MCP >>>';
const CODEX_END = '# <<< PMBrain Desktop managed MCP <<<';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function writeCodexIntegration(path: string, mcpUrl: string, token: string, backupRoot?: string): string | null {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const unmanaged = /^\s*\[mcp_servers\.pmbrain\]\s*$/m.test(existing)
    && !existing.includes(CODEX_START);
  if (unmanaged) {
    throw new Error('Codex 配置里已经存在手工维护的 [mcp_servers.pmbrain]，为避免覆盖已停止写入。');
  }
  const block = [
    CODEX_START,
    '[mcp_servers.pmbrain]',
    `url = ${tomlString(mcpUrl)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    CODEX_END,
  ].join('\n');
  const expression = new RegExp(`${escapeRegExp(CODEX_START)}[\\s\\S]*?${escapeRegExp(CODEX_END)}\\s*`, 'm');
  const next = expression.test(existing)
    ? existing.replace(expression, `${block}\n`)
    : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`;
  const backup = backupFile(path, 'mcp', backupRoot);
  writeTextFile(path, next);
  return backup;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pmbrain-tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    copyFileSync(temporary, path);
  } catch (error) {
    throw new Error(`无法写入 ${path}。请关闭对应客户端后重试。${error instanceof Error ? ` ${error.message}` : ''}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isConfigured(client: IntegrationClient, path: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    const content = readFileSync(path, 'utf8');
    if (client === 'codex') return /\[mcp_servers\.pmbrain\]/.test(content);
    if (client === 'qwenpaw' && path.toLowerCase().endsWith('.yaml')) {
      return qwenPawDriverIsConfigured(path);
    }
    const parsed = JSON.parse(content) as {
      mcpServers?: Record<string, unknown>;
      mcp?: { clients?: Record<string, unknown> };
    };
    if (client === 'qwenpaw') return Boolean(parsed.mcp?.clients?.pmbrain);
    return Boolean(parsed.mcpServers?.pmbrain);
  } catch {
    return false;
  }
}

function extractPortFromUrl(urlStr: string): number | undefined {
  try {
    const url = new URL(urlStr);
    const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
    return port;
  } catch {
    return undefined;
  }
}

function readConfiguredPort(client: IntegrationClient, path: string): number | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    if (client === 'codex') {
      const content = readFileSync(path, 'utf8');
      const blockPattern = new RegExp(`${escapeRegExp(CODEX_START)}[\\s\\S]*?${escapeRegExp(CODEX_END)}`);
      const block = content.match(blockPattern)?.[0] ?? content;
      const urlMatch = block.match(/url\s*=\s*(['"])(.+?)\1/);
      return urlMatch ? extractPortFromUrl(urlMatch[2]) : undefined;
    }
    const content = readFileSync(path, 'utf8');
    if (client === 'qwenpaw' && path.toLowerCase().endsWith('.yaml')) {
      const urlMatch = content.match(/^\s*url:\s*(https?:\/\/\S+\/mcp)\s*$/m);
      return urlMatch ? extractPortFromUrl(urlMatch[1]) : undefined;
    }
    const parsed = JSON.parse(content) as {
      mcpServers?: { pmbrain?: { url?: string } };
      mcp?: { clients?: { pmbrain?: { url?: string } } };
    };
    const url = client === 'qwenpaw'
      ? parsed.mcp?.clients?.pmbrain?.url
      : parsed.mcpServers?.pmbrain?.url;
    return url ? extractPortFromUrl(url) : undefined;
  } catch {
    return undefined;
  }
}

export function listIntegrations(currentPort?: number): IntegrationInfo[] {
  return (Object.keys(CLIENT_META) as IntegrationClient[]).map((id) => {
    const meta = CLIENT_META[id];
    const path = meta.path();
    const configured = isConfigured(id, path);
    const configuredPort = configured && path ? readConfiguredPort(id, path) : undefined;
    const portMismatch = configured && currentPort !== undefined && configuredPort !== undefined && configuredPort !== currentPort;
    return { id, name: meta.name, path, automatic: meta.automatic, configured, configuredPort, portMismatch };
  });
}

export async function listIntegrationsWithConnectionState(currentPort?: number): Promise<IntegrationInfo[]> {
  const integrations = listIntegrations(currentPort);
  const qwenPaw = integrations.find(item => item.id === 'qwenpaw');
  if (qwenPaw?.configured) qwenPaw.connectionState = await probeQwenPawConnectionState();
  return integrations;
}

export function integrationConfigPath(client: IntegrationClient): string | null {
  return CLIENT_META[client].path();
}

async function createApiKey(sidecar: SidecarManager, name: string): Promise<string> {
  await sidecar.adminRequest('/admin/api/api-keys/revoke', {
    method: 'POST', body: JSON.stringify({ name }),
  }).catch(() => undefined);
  const result = await sidecar.adminRequest<{ token: string }>('/admin/api/api-keys', {
    method: 'POST', body: JSON.stringify({ name, scopes: 'admin read write' }),
  });
  if (!result.token) throw new Error('PMBrain 未返回 API Key。');
  return result.token;
}

export async function configureIntegration(
  sidecar: SidecarManager,
  client: IntegrationClient,
  credentialKind: CredentialKind,
): Promise<IntegrationResult> {
  const meta = CLIENT_META[client];
  if (!meta) throw new Error(`不支持的客户端：${client}`);
  if (client === 'qwenpaw' && credentialKind !== 'api_key') {
    throw new Error('QwenPaw 一键接入固定使用 API Key + Bearer，不支持 OAuth 授权。');
  }
  const path = meta.path();
  const credentialName = `desktop-${client}`;

  if (credentialKind === 'oauth') {
    const agents = await sidecar.adminRequest<Array<{ id: string; name: string; auth_type: string; status: string }>>('/admin/api/agents');
    for (const agent of agents) {
      if (agent.name === credentialName && agent.auth_type === 'oauth' && agent.status === 'active') {
        await sidecar.adminRequest('/admin/api/revoke-client', {
          method: 'POST', body: JSON.stringify({ clientId: agent.id }),
        });
      }
    }
    const result = await sidecar.adminRequest<{ clientId: string; clientSecret: string }>('/admin/api/register-client', {
      method: 'POST',
      body: JSON.stringify({ name: credentialName, grantTypes: ['client_credentials'], scopes: 'admin read write' }),
    });
    const snippet = JSON.stringify({
      issuer_url: `http://127.0.0.1:${sidecar.port}`,
      mcp_url: sidecar.mcpUrl,
      oauth_client_id: result.clientId,
      oauth_client_secret: result.clientSecret,
    }, null, 2);
    return {
      client, credentialKind, configured: false, path, backup: null, snippet,
      clientId: result.clientId, clientSecret: result.clientSecret,
    };
  }

  const token = await createApiKey(sidecar, credentialName);
  const smoke = await sidecar.smokeTest(token);
  const entry = { mcpServers: { pmbrain: jsonEntry(sidecar.mcpUrl, token) } };
  let snippet = JSON.stringify(entry, null, 2);
  let backup: string | null = null;
  let configured = false;
  let connectionState: IntegrationResult['connectionState'];

  if (client === 'codebuddy' || client === 'workbuddy' || client === 'cursor' || client === 'trae') {
    backup = writeJsonIntegration(path!, sidecar.mcpUrl, token);
    configured = true;
  } else if (client === 'qwenpaw') {
    const qwenPaw = qwenPawPaths();
    if (existsSync(qwenPaw.desktopPort) || existsSync(qwenPaw.driverCard)) {
      const result = await configureQwenPawDesktopIntegration(sidecar.mcpUrl, token);
      backup = result.backup;
      connectionState = result.connected ? 'connected' : 'saved';
    } else {
      backup = writeQwenPawIntegration(qwenPaw.legacyConfig, sidecar.mcpUrl, token);
      connectionState = 'saved';
    }
    snippet = JSON.stringify({ mcp: { clients: { pmbrain: qwenPawEntry(sidecar.mcpUrl, token) } } }, null, 2);
    configured = true;
  } else if (client === 'codex') {
    backup = writeCodexIntegration(path!, sidecar.mcpUrl, token);
    snippet = [
      '[mcp_servers.pmbrain]',
      `url = ${tomlString(sidecar.mcpUrl)}`,
      `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    ].join('\n');
    configured = true;
  } else {
    snippet = `claude mcp add pmbrain -t http ${sidecar.mcpUrl} -H ${tomlString(`Authorization: Bearer ${token}`)}`;
  }

  return { client, credentialKind, configured, path, backup, snippet, token, smoke, connectionState };
}
