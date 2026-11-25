/**
 * A Git smart-HTTP remote on 127.0.0.1 for tests that clone over a real network transport: `git http-backend` (the CGI
 * that ships with Git) behind a small `Bun.serve` bridge, over TLS with a throwaway self-signed certificate, so a clone
 * runs the https transport gbrain's URL policy allows (src/core/git-remote.ts `parseRemoteUrl`: https only). No external
 * network is used. A client trusts the server by `GIT_SSL_CAINFO=<caFile>`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitSmartHttpServer {
  /** The base URL: `https://127.0.0.1:<port>`; a repository `<name>.git` under the served root is at `${url}/<name>.git`. */
  url: string;
  /** The PEM certificate a client passes as `GIT_SSL_CAINFO`. */
  caFile: string;
  /** Requests served, as `METHOD path?query`, in arrival order. */
  requests: string[];
  stop(): Promise<void>;
}

/** The directory `git http-backend` is installed in. */
function execPath(): string {
  return execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
}

/** Runs one CGI request through `git http-backend` and answers the response it wrote. */
async function cgi(root: string, request: Request, requests: string[]): Promise<Response> {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method, PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ''), CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length),
    REMOTE_ADDR: '127.0.0.1', SERVER_PROTOCOL: 'HTTP/1.1', GATEWAY_INTERFACE: 'CGI/1.1',
  };
  const encoding = request.headers.get('content-encoding');
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  const child = spawn(join(execPath(), 'git-http-backend'), [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end(body);
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  const out = Buffer.concat(chunks);
  // CGI output: header lines, a blank line, the body.
  const split = out.indexOf('\r\n\r\n') >= 0 ? out.indexOf('\r\n\r\n') : out.indexOf('\n\n');
  const gap = out.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
  if (split < 0) return new Response('bad gateway', { status: 502 });
  const headers = new Headers();
  let status = 200;
  for (const line of out.subarray(0, split).toString('utf8').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200; else headers.append(name, value);
  }
  return new Response(out.subarray(split + gap), { status, headers });
}

/** Serves every bare repository under `root` over https on 127.0.0.1 (an OS-chosen port) until `stop()`. */
export async function serveGitOverHttps(root: string): Promise<GitSmartHttpServer> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-http-'));
  mkdirSync(root, { recursive: true });
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert: Bun.file(certFile), key: Bun.file(keyFile) }, fetch: request => cgi(root, request, requests) });
  return { url: `https://127.0.0.1:${server.port}`, caFile: certFile, requests,
    async stop() { await server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
