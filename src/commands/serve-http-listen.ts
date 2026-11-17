/**
 * `foresights serve --http`'s listen step (agent operator wave H2): a taken port
 * fails the start with `serve_port_in_use` and a next step, instead of the
 * server announcing itself and holding the brain lock while serving nothing
 * (Bun runs a listen callback with `listening: false` and then emits `error`
 * to no listener). Resolves only once the socket really listens.
 *
 * `adopt`: a listener the status-only serve already bound on this port
 * (serve-http-status.ts). Recovery hands the full app to it as the request
 * handler instead of binding again, so the port is never released.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { opError } from '../core/ops/contract.ts';

export type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;
export interface AdoptableServer { server: Server; adopt(handler: HttpRequestHandler): void }

export async function listenOrRefuse(app: HttpRequestHandler & { listen(port: number, host: string): Server }, port: number, bind: string, adopt?: AdoptableServer): Promise<Server> {
  if (adopt) { adopt.adopt(app); return adopt.server; }
  const server = app.listen(port, bind);
  const failure = await new Promise<Error | null>(resolve => {
    if (server.listening) return resolve(null);
    server.once('listening', () => resolve(null));
    server.once('error', (e: Error) => resolve(e));
  });
  if (!failure) return server;
  try { server.close(); } catch { /* never listened */ }
  throw opError('serve_port_in_use', `foresights serve --http could not listen on ${bind}:${port}: ${failure.message}`,
    'Nothing was started and the brain is free again. Stop the process holding the port, or pass another --port (and point the harnesses at that URL).', {
      why: 'Another process (often an earlier foresights serve --http) already listens on that address.',
      fix: {
        argv: ['gbrain', 'serve', '--http', '--bind', bind, '--port', String(port + 1)], consent: ['persistent_install'], actor: 'user', requires_exclusive: true,
        why: 'Starts the shared server on the next port; every harness must then use that URL.',
      },
    });
}
