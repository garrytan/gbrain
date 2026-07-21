import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildApiKeyAgentContent,
  buildApiKeyJsonConfig,
  buildOAuthAgentContent,
  buildOAuthJsonConfig,
  MCP_CLIENTS,
} from '../admin/src/lib/mcp-config.ts';

describe('Admin MCP handoff content', () => {
  test('matches the desktop-supported client list and names the generic option clearly', () => {
    expect(MCP_CLIENTS.map(item => item.label)).toEqual([
      'CodeBuddy', 'Workbuddy', 'Cursor', 'Claude', 'Codex', '通用 Agent',
    ]);
  });

  test('generates directly usable API key content without placeholders', () => {
    const content = buildApiKeyAgentContent('universal', 'http://localhost:3132', 'pmbrain_secret');
    expect(content).toContain('http://localhost:3132/mcp');
    expect(content).toContain('Authorization: Bearer pmbrain_secret');
    expect(content).not.toContain('PASTE_');
  });

  test('generates complete OAuth handoff content', () => {
    const content = buildOAuthAgentContent('codex', 'http://localhost:3132', {
      clientId: 'client-id', clientSecret: 'client-secret',
    });
    expect(content).toContain('Client ID：client-id');
    expect(content).toContain('Client Secret：client-secret');
    expect(content).toContain('client_credentials');
  });

  test('downloads directly usable JSON only while the real credential is available', () => {
    const apiKeyConfig = JSON.parse(buildApiKeyJsonConfig('http://localhost:3132', 'pmbrain_secret'));
    expect(apiKeyConfig.mcpServers.pmbrain.headers.Authorization).toBe('Bearer pmbrain_secret');
    const oauthConfig = JSON.parse(buildOAuthJsonConfig('http://localhost:3132', {
      clientId: 'client-id', clientSecret: 'client-secret',
    }));
    expect(oauthConfig.pmbrain.server_url).toBe('http://localhost:3132/mcp');
    expect(oauthConfig.pmbrain.auth).toMatchObject({
      grant_type: 'client_credentials', client_id: 'client-id', client_secret: 'client-secret',
    });
  });

  test('restores the original client tabs and labels existing downloads as templates', () => {
    const agents = readFileSync(join(process.cwd(), 'admin/src/pages/Agents.tsx'), 'utf8');
    expect(agents).toContain("{ id: 'json', label: 'JSON' }");
    expect(agents).toContain('下载 JSON 模板');
    expect(agents).toContain('下载可用 JSON');
    expect(agents).toContain('已有凭证的密钥不会再次显示');
  });

  test('all Admin copy buttons use the shared feedback component', () => {
    const agents = readFileSync(join(process.cwd(), 'admin/src/pages/Agents.tsx'), 'utf8');
    const consolePage = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
    const clipboard = readFileSync(join(process.cwd(), 'admin/src/lib/clipboard.tsx'), 'utf8');
    expect(agents).toContain('<CopyButton value={content} />');
    expect(consolePage).toContain('<CopyButton className="pm-ghost" value={value} />');
    expect(clipboard).toContain("status === 'copied' ? '已复制'");
    expect(clipboard).toContain("document.execCommand('copy')");
  });

  test('keeps credential actions visible and simplifies the MCP page hierarchy', () => {
    const agents = readFileSync(join(process.cwd(), 'admin/src/pages/Agents.tsx'), 'utf8');
    const consolePage = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
    const styles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
    expect(agents.match(/className="modal credential-modal"/g)?.length).toBe(4);
    expect(agents.match(/className="credential-modal-actions"/g)?.length).toBe(4);
    expect(styles).toContain('max-height: calc(100dvh - 32px)');
    expect(styles).toContain('.credential-modal-body');
    expect(consolePage.indexOf('<h1 className="title-with-info">')).toBeLessThan(consolePage.indexOf('<AgentsPage'));
    expect(consolePage.indexOf('<AgentsPage')).toBeLessThan(consolePage.indexOf('className="mcp-tunnel-details"'));
    expect(consolePage).not.toContain('className="mcp-connection-details"');
    expect(consolePage).not.toContain('<h2>连接状态</h2>');
    expect(agents).toContain("{visibleAgents.filter(a => a.status === 'active').length} 个活跃凭证");
    expect(agents).not.toContain('/ 共 {agents.length} 个');
  });

  test('resets drawer focus before registration and keeps the selected MCP endpoint stable', () => {
    const agents = readFileSync(join(process.cwd(), 'admin/src/pages/Agents.tsx'), 'utf8');
    const openRegister = agents.slice(agents.indexOf('const openRegister'), agents.indexOf('const loadOverview'));
    const credentialsModal = agents.slice(agents.indexOf('function CredentialsModal'), agents.indexOf('function AgentDrawer'));

    expect(openRegister.indexOf('setSelectedAgent(null)')).toBeLessThan(openRegister.indexOf('setShowRegister(true)'));
    expect(agents).toContain('function useCredentialNameFocus');
    expect(agents).toContain('input.focus({ preventScroll: true })');
    expect(agents).toContain("const timers = [0, 60, 200]");
    expect(agents).toContain("window.addEventListener('focus', focusIfNeeded)");
    expect(agents.match(/useCredentialNameFocus\(nameInputRef\)/g)?.length).toBe(2);
    expect(agents.match(/ref=\{nameInputRef\}/g)?.length).toBe(2);
    expect(agents).toContain("| { usage: 'shared'; sharedIp: string }");
    expect(credentialsModal).toContain('credentials.sharedIp');
    expect(credentialsModal).not.toContain('api.desktopState()');
  });

  test('only exposes a validated desktop IPv4 address to shared MCP configuration', () => {
    const server = readFileSync(join(process.cwd(), 'src/commands/serve-http.ts'), 'utf8');
    expect(server).toContain("import { isIP } from 'node:net'");
    expect(server).toContain('isIP(configuredSharedIp) === 4');
  });

  test('keeps API Key and OAuth creation controls aligned with equivalent MCP options', () => {
    const agents = readFileSync(join(process.cwd(), 'admin/src/pages/Agents.tsx'), 'utf8');
    const api = readFileSync(join(process.cwd(), 'admin/src/api.ts'), 'utf8');
    const styles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
    const createActions = agents.slice(agents.indexOf('className="agents-create-actions"'), agents.indexOf('className="agents-create-actions"') + 420);
    const apiKeyModal = agents.slice(agents.indexOf('function ApiKeyCreateModal'), agents.indexOf('function ApiKeyTokenModal'));
    const apiKeyTokenModal = agents.slice(agents.indexOf('function ApiKeyTokenModal'), agents.indexOf('function RegisterModal'));

    expect(createActions.match(/className="btn btn-primary"/g)?.length).toBe(2);
    expect(styles).toContain('.agents-create-actions { display: flex; flex-wrap: nowrap; gap: 8px; }');
    expect(apiKeyModal).toContain('<McpUsageField');
    expect(apiKeyModal).toContain('<ScopeFields');
    expect(apiKeyModal).toContain("['admin', 'read', 'write'].includes(scope)");
    expect(apiKeyModal).toContain('scopes: selectedScopes');
    expect(api).toContain('scopes?: string[]');
    expect(apiKeyTokenModal).toContain('token.sharedIp');
  });
});
