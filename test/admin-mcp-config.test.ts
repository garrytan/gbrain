import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApiKeyAgentContent, buildOAuthAgentContent, MCP_CLIENTS } from '../admin/src/lib/mcp-config.ts';

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
    expect(consolePage.indexOf('<AgentsPage')).toBeLessThan(consolePage.indexOf('className="mcp-connection-details"'));
    expect(consolePage).not.toContain('<h2>连接状态</h2>');
    expect(agents).toContain("{visibleAgents.filter(a => a.status === 'active').length} 个活跃凭证");
    expect(agents).not.toContain('/ 共 {agents.length} 个');
  });
});
