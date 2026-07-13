export type McpClientId = 'codebuddy' | 'workbuddy' | 'cursor' | 'claude' | 'codex' | 'universal';

export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; label: string }> = [
  { id: 'codebuddy', label: 'CodeBuddy' },
  { id: 'workbuddy', label: 'Workbuddy' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'universal', label: '通用 Agent' },
];

function jsonConfig(origin: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      pmbrain: {
        type: 'http',
        url: `${origin}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

export function buildApiKeyAgentContent(client: McpClientId, origin: string, token: string): string {
  if (client === 'codex') {
    return [
      '请把下面配置合并到 Codex 的 ~/.codex/config.toml，并验证 PMBrain MCP 可以连接：',
      '',
      '[mcp_servers.pmbrain]',
      `url = "${origin}/mcp"`,
      `http_headers = { Authorization = "Bearer ${token}" }`,
    ].join('\n');
  }
  if (client === 'claude') {
    return [
      '请在终端执行下面命令，把 PMBrain MCP 接入 Claude，并验证连接：',
      '',
      `claude mcp add pmbrain -t http ${origin}/mcp -H "Authorization: Bearer ${token}"`,
    ].join('\n');
  }
  if (client === 'universal') {
    return [
      '请把 PMBrain MCP 接入你当前运行的 Agent。',
      `MCP 地址：${origin}/mcp`,
      `认证 Header：Authorization: Bearer ${token}`,
      '请直接完成配置并验证；如果不能自动写入，请明确告诉我应粘贴到哪个配置文件。',
    ].join('\n');
  }
  const label = MCP_CLIENTS.find(item => item.id === client)?.label ?? client;
  return [
    `请把下面配置合并到 ${label} 的 MCP 配置文件，并验证 PMBrain 可以连接：`,
    '',
    jsonConfig(origin, token),
  ].join('\n');
}

export function buildOAuthAgentContent(client: McpClientId, origin: string, credentials: { clientId: string; clientSecret: string }): string {
  const label = client === 'universal' ? '当前 Agent' : MCP_CLIENTS.find(item => item.id === client)?.label ?? client;
  return [
    `请为 ${label} 配置 PMBrain OAuth MCP，并完成连接验证。`,
    `MCP 地址：${origin}/mcp`,
    `OAuth Issuer：${origin}`,
    `Client ID：${credentials.clientId}`,
    `Client Secret：${credentials.clientSecret}`,
    'Grant Type：client_credentials',
    '请直接完成配置；如果客户端不支持 OAuth MCP，请明确说明并建议改用 API Key。',
  ].join('\n');
}
