import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { SkillResources } from './skill-resources.ts';

export const CAPABILITIES_URI = 'gbrain://capabilities';
export const MCP_ADMIN_GUIDE_URL = 'https://github.com/garrytan/gbrain/blob/master/docs/mcp/ADMIN.md';

/** Orientation only: never infer owner authority from an MCP scope or inspect
 * credentials. HTTP callers supply their configured resource URL; stdio has
 * no HTTP admin endpoint to advertise. */
export function mcpAdministrationGuidance(mcpUrl?: string) {
  let adminUrl: string | undefined;
  if (mcpUrl) {
    try {
      const endpoint = new URL(mcpUrl);
      if (['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password
        && !endpoint.search && !endpoint.hash && /\/mcp\/?$/.test(endpoint.pathname)) {
        endpoint.pathname = endpoint.pathname.replace(/\/mcp\/?$/, '/admin/');
        adminUrl = endpoint.toString();
      }
    } catch { /* No configured valid HTTP endpoint: publish guidance only. */ }
  }
  return {
    authentication: 'separate_owner_credential' as const,
    oauth_admin_scope_grants_owner_access: false,
    ...(adminUrl ? { admin_url: adminUrl } : {}),
    guide: MCP_ADMIN_GUIDE_URL,
    next_action: 'Ask the server-hosting harness or a separately authorized administrator to run gbrain mcp admin login-link against the configured server URL using --admin-token-file or GBRAIN_ADMIN_BOOTSTRAP_TOKEN. An MCP access token or client secret cannot substitute.',
    oauth_connection: 'Start OAuth in the native client. Its PKCE verifier stays there. Preserve oauth_request when requesting an owner login link; expired requests require restarting the native connection.',
  };
}

/** Resources keep orientation available even on the exact seven-tool surface. */
export function installCapabilitiesResource(server: Server, describe: () => unknown | Promise<unknown>, skills?: SkillResources) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
    { uri: CAPABILITIES_URI, name: 'GBrain capabilities', description: 'Effective permissions and setup readiness for this connection.', mimeType: 'application/json' },
    ...(await skills?.list() ?? []),
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== CAPABILITIES_URI) {
      if (skills) return skills.read(request.params.uri);
      throw new McpError(ErrorCode.InvalidParams, 'Unknown resource');
    }
    return { contents: [{ uri: CAPABILITIES_URI, mimeType: 'application/json', text: JSON.stringify(await describe()) }] };
  });
}
