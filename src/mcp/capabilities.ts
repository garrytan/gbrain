import type { Server, ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { ResourceNotFoundError } from '@modelcontextprotocol/server';

export const CAPABILITIES_URI = 'gbrain://capabilities';

/** Resources keep orientation available even on the exact seven-tool surface. */
export function installCapabilitiesResource(server: Server, describe: () => unknown | Promise<unknown>) {
  server.setRequestHandler('resources/list', async () => ({
    resources: [
      { uri: CAPABILITIES_URI, name: 'GBrain capabilities', description: 'Effective permissions and setup readiness for this connection.', mimeType: 'application/json' },
    ],
  }) as ListResourcesResult);
  server.setRequestHandler('resources/read', async (request): Promise<ReadResourceResult> => {
    const uri = (request.params as { uri?: string }).uri;
    if (uri !== CAPABILITIES_URI) throw new ResourceNotFoundError(uri ?? CAPABILITIES_URI, 'Unknown resource');
    return { contents: [{ uri: CAPABILITIES_URI, mimeType: 'application/json', text: JSON.stringify(await describe()) }] };
  });
}
