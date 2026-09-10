import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const CAPABILITIES_URI = 'gbrain://capabilities';

/** Resources keep orientation available even on the exact seven-tool surface. */
export function installCapabilitiesResource(server: Server, describe: () => unknown | Promise<unknown>) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
    { uri: CAPABILITIES_URI, name: 'GBrain capabilities', description: 'Effective permissions and setup readiness for this connection.', mimeType: 'application/json' },
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== CAPABILITIES_URI) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource');
    return { contents: [{ uri: CAPABILITIES_URI, mimeType: 'application/json', text: JSON.stringify(await describe()) }] };
  });
}
