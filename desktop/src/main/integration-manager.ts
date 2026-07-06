import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { backupFile } from './config-manager.js';
import type { SidecarManager } from './sidecar-manager.js';

export type IntegrationClient = 'codebuddy' | 'workbuddy' | 'cursor' | 'claude' | 'codex';
export type CredentialKind = 'api_key' | 'oauth';

export interface IntegrationInfo {
  id: IntegrationClient;
  name: string;
  path: string | null;
  configured: boolean;
  automatic: boolean;
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
}

const CLIENT_META: Record<IntegrationClient, { name: string; path: () => string | null; automatic: boolean }> = {
  codebuddy: { name: 'CodeBuddy', path: () => join(homedir(), '.codebuddy', 'mcp.json'), automatic: true },
  workbuddy: { name: 'Workbuddy', path: () => join(homedir(), '.workbuddy', 'mcp.json'), automatic: true },
  cursor: { name: 'Cursor', path: () => join(homedir(), '.cursor', 'mcp.json'), automatic: true },
  claude: { name: 'Claude', path: () => null, automatic: false },
  codex: { name: 'Codex', path: () => join(homedir(), '.codex', 'config.toml'), automatic: true },
};

function jsonEntry(mcpUrl: string, token: string) {
  return {
    type: 'http',
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
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
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
    return Boolean(parsed.mcpServers?.pmbrain);
  } catch {
    return false;
  }
}

export function listIntegrations(): IntegrationInfo[] {
  return (Object.keys(CLIENT_META) as IntegrationClient[]).map((id) => {
    const meta = CLIENT_META[id];
    const path = meta.path();
    return { id, name: meta.name, path, automatic: meta.automatic, configured: isConfigured(id, path) };
  });
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

  if (client === 'codebuddy' || client === 'workbuddy' || client === 'cursor') {
    backup = writeJsonIntegration(path!, sidecar.mcpUrl, token);
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

  return { client, credentialKind, configured, path, backup, snippet, token, smoke };
}
