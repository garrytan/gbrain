/**
 * `--db-proxy http://[user:pass@]host:port`: every postgres.js pool opens its
 * socket through an HTTP CONNECT tunnel instead of dialling the database
 * directly, for networks whose only route out is an HTTP proxy. The proxy
 * resolves the database hostname; TLS still runs end to end inside the tunnel.
 *
 * Explicit flag only: `http_proxy` and friends are deliberately not read,
 * because env-trust treats them as an injection vector.
 */
import net from 'node:net';
import { getCliOptions } from './cli-options.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

export function getDbProxy(): URL | null {
  return getCliOptions().dbProxy ?? null;
}

/** Opens a socket to `host:port` through `proxy`'s CONNECT tunnel; resolves once the proxy answers 2xx. */
export function connectThroughProxy(proxy: URL, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    let header = Buffer.alloc(0);
    const fail = (message: string) => {
      cleanup();
      socket.destroy();
      reject(new Error(`--db-proxy ${proxy.host}: ${message}`));
    };
    const timer = setTimeout(() => fail(`no CONNECT reply within ${CONNECT_TIMEOUT_MS / 1000}s`), CONNECT_TIMEOUT_MS);
    const onError = (e: Error) => fail(e.message);
    const onClose = () => fail('closed the connection before answering CONNECT');
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end === -1) {
        if (header.length > MAX_RESPONSE_HEADER_BYTES) fail('CONNECT reply header too large');
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(header.subarray(0, end).toString('latin1'));
      if (!status || status[1]![0] !== '2') {
        fail(`refused CONNECT to ${host}:${port} (${header.subarray(0, header.indexOf('\r\n')).toString('latin1') || 'no status line'})`);
        return;
      }
      cleanup();
      const rest = header.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      // postgres.js reads these for TLS SNI and error messages.
      Object.assign(socket, { host, port });
      resolve(socket);
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', () => {
      const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
  });
}

/** The connected socket a postgres.js pool should use: tunnelled when `--db-proxy` is set, direct otherwise. */
export async function openDbSocket(options: { host: string[]; port: number[]; path?: string | false }): Promise<net.Socket> {
  const proxy = getDbProxy();
  if (proxy && !options.path) return connectThroughProxy(proxy, options.host[0]!, options.port[0]!);
  const socket = options.path ? net.connect(options.path) : net.connect(options.port[0]!, options.host[0]!);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
