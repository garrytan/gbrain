import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIP } from 'node:net';

export const DEFAULT_LAN_MCP_PORT = 3131;
export const LAN_MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const LAN_MCP_MAX_BATCH_ITEMS = 64;
export const LAN_MCP_MAX_CONCURRENT_AUTH_CHECKS = 32;
export const LAN_MCP_MAX_CONCURRENT_BODY_READS = 16;
export const LAN_MCP_MAX_CONCURRENT_REQUESTS = 128;
export const LAN_MCP_BODY_IDLE_TIMEOUT_MS = 15_000;
export const LAN_MCP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Desktop shared-mode is a stricter trust boundary than the local MCP.
 * Only operations whose handlers were audited to apply the credential's
 * source scope are exposed here. The sidecar still enforces read/write
 * scopes; this list adds the source-isolation guarantee.
 */
export const SHARED_MCP_READ_TOOL_NAMES = [
  'whoami',
  'search',
  'list_pages',
  'get_page',
  'get_tags',
  'get_links',
  'get_backlinks',
  'traverse_graph',
  'get_timeline',
  'get_calibration_profile',
  'find_experts',
  'find_trajectory',
] as const;

export const SHARED_MCP_WRITE_TOOL_NAMES = [
  'put_page',
  'delete_page',
  'restore_page',
  'add_tag',
  'remove_tag',
  'add_link',
  'remove_link',
  'add_timeline_entry',
  'put_raw_data',
  'revert_version',
] as const;

export const SHARED_MCP_TOOL_NAMES = [
  ...SHARED_MCP_READ_TOOL_NAMES,
  ...SHARED_MCP_WRITE_TOOL_NAMES,
] as const;

export interface LanMcpGatewayOptions {
  bindAddress: string;
  sidecarPort: number;
  verifyBearerToken: (authorizationHeader: string) => Promise<boolean>;
  /** The production default is fixed at 3131. Passing 0 is useful in tests. */
  listenPort?: number;
}

export interface LanMcpGatewayStatus {
  running: boolean;
  bindAddress: string;
  port: number;
  mcpUrl: string;
  healthUrl: string;
  targetMcpUrl: string;
  lastError?: string;
}

const ALLOWED_PATHS = new Set(['/mcp', '/health']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);
const SOURCE_SELECTOR_KEYS = new Set(['source_id', 'sourceId']);
const SHARED_MCP_TOOL_SET = new Set<string>(SHARED_MCP_TOOL_NAMES);
const SHARED_MCP_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
  'tools/call',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const UNTRUSTED_PROXY_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

function filteredHeaders(headers: IncomingHttpHeaders, removeHost = false): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  const connectionTokens = String(headers.connection ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...UNTRUSTED_PROXY_HEADERS, ...connectionTokens]);
  if (removeHost) blocked.add('host');

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || blocked.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function jsonError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({ error: message }));
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectTreeMatches(
  root: unknown,
  predicate: (key: string | undefined, value: unknown) => boolean,
): boolean {
  const pending: Array<{ key?: string; value: unknown }> = [{ value: root }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (predicate(current.key, current.value)) return true;
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value });
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, value] of Object.entries(current.value)) pending.push({ key, value });
    }
  }
  return false;
}

function containsSourceSelector(value: unknown): boolean {
  return objectTreeMatches(value, (key) => Boolean(key && SOURCE_SELECTOR_KEYS.has(key)));
}

function containsAllSourceValue(value: unknown): boolean {
  return objectTreeMatches(value, (_key, item) => item === '__all__');
}

function enablesAllSources(value: unknown): boolean {
  return objectTreeMatches(value, (key, item) => (
    (key === 'all_sources' || key === 'allSources') && item === true
  ));
}

function blockedToolReason(request: unknown): string | undefined {
  if (!isRecord(request) || request.method !== 'tools/call' || !isRecord(request.params)) return undefined;
  const toolName = request.params.name;
  const args = request.params.arguments;
  if (typeof toolName !== 'string' || !SHARED_MCP_TOOL_SET.has(toolName)) {
    return '局域网共享未开放该工具；请在主机本地使用该能力，或等待它完成知识源隔离审计。';
  }
  if (containsSourceSelector(args) || containsAllSourceValue(args) || enablesAllSources(args)) {
    return '局域网共享禁止 Agent 自行指定或绕过知识源范围，请使用管理员分配给该凭据的可读范围。';
  }
  return undefined;
}

function blockedRequestReason(request: unknown): string | undefined {
  if (!isRecord(request) || typeof request.method !== 'string') return undefined;
  if (!SHARED_MCP_METHODS.has(request.method)) {
    return '局域网共享未开放该 MCP 方法；请在主机本地使用该能力，或等待它完成安全审计。';
  }
  return blockedToolReason(request);
}

function containsMethod(payload: unknown, method: string): boolean {
  const requests = Array.isArray(payload) ? payload : [payload];
  return requests.some(request => isRecord(request) && request.method === method);
}

function filterToolsListResponse(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(filterToolsListResponse);
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) return payload;
  return {
    ...payload,
    result: {
      ...payload.result,
      tools: payload.result.tools.filter(tool => (
        isRecord(tool) && typeof tool.name === 'string' && SHARED_MCP_TOOL_SET.has(tool.name)
      )),
    },
  };
}

function filterToolsListWireResponse(body: Buffer, contentType: string | undefined): Buffer | null {
  const text = body.toString('utf8');
  if (contentType?.toLowerCase().includes('text/event-stream')) {
    let parsedEvents = 0;
    let parseFailed = false;
    const output = text.split('\n').map((line) => {
      const carriageReturn = line.endsWith('\r') ? '\r' : '';
      const content = carriageReturn ? line.slice(0, -1) : line;
      const match = content.match(/^(\s*data:\s*)(.*)$/);
      if (!match) return line;
      if (match[2].trim() === '[DONE]') return line;
      try {
        parsedEvents += 1;
        return `${match[1]}${JSON.stringify(filterToolsListResponse(JSON.parse(match[2])))}${carriageReturn}`;
      } catch {
        parseFailed = true;
        return line;
      }
    }).join('\n');
    return parseFailed || parsedEvents === 0 ? null : Buffer.from(output);
  }
  try {
    return Buffer.from(JSON.stringify(filterToolsListResponse(JSON.parse(text))));
  } catch {
    return null;
  }
}

function requestId(request: unknown): unknown {
  return isRecord(request) && Object.prototype.hasOwnProperty.call(request, 'id')
    ? request.id
    : null;
}

function rpcAccessError(id: unknown, message: string): JsonRecord {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32003,
      message,
      data: { reason: 'lan_source_scope_guard' },
    },
  };
}

function deniedRpcResponse(payload: unknown): JsonRecord | JsonRecord[] | undefined {
  if (!Array.isArray(payload)) {
    const reason = blockedRequestReason(payload);
    return reason ? rpcAccessError(requestId(payload), reason) : undefined;
  }

  if (payload.length > LAN_MCP_MAX_BATCH_ITEMS) {
    return rpcAccessError(
      null,
      `局域网 MCP 单次批处理最多允许 ${LAN_MCP_MAX_BATCH_ITEMS} 项；该批次未转发。`,
    );
  }
  if (!payload.some(request => Boolean(blockedRequestReason(request)))) return undefined;
  return rpcAccessError(
    null,
    '局域网网关检测到批次中含未开放或越权的工具调用；为避免部分执行，整个批次均未转发。',
  );
}

function writeRpcDenied(response: ServerResponse, payload: JsonRecord | JsonRecord[]): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function writeRpcParseError(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(400, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32700,
      message: '局域网 MCP 请求必须是有效的 JSON；该请求未转发。',
    },
  }));
}

async function readBodyWithLimit(
  request: IncomingMessage,
  limit: number,
  idleTimeoutMs = LAN_MCP_BODY_IDLE_TIMEOUT_MS,
): Promise<Buffer | null> {
  const contentLength = Number.parseInt(String(request.headers['content-length'] ?? ''), 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume();
    return null;
  }

  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        request.destroy();
        reject(new Error('局域网 MCP 请求体读取超时。'));
      }, idleTimeoutMs);
    };
    armTimer();
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      armTimer();
      total += buffer.byteLength;
      if (total > limit) {
        chunks.length = 0;
        request.resume();
        finish(null);
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => finish(Buffer.concat(chunks, total)));
    request.on('aborted', () => fail(new Error('客户端在请求体读取完成前断开连接。')));
    request.on('error', fail);
  });
}

function bindError(error: NodeJS.ErrnoException, address: string, port: number): Error {
  let detail = error.message;
  if (error.code === 'EADDRINUSE') detail = '该端口已被其他程序占用。';
  if (error.code === 'EADDRNOTAVAIL') detail = '所选 IP 已不在这张网卡上，请重新连接网络或重新选择。';
  if (error.code === 'EACCES') detail = '当前用户没有监听该地址或端口的权限。';
  return new Error(`无法在 ${address}:${port} 启动局域网 MCP：${detail}`, { cause: error });
}

export class LanMcpGateway {
  private readonly bindAddress: string;
  private readonly configuredPort: number;
  private readonly sidecarPort: number;
  private readonly verifyBearerToken: (authorizationHeader: string) => Promise<boolean>;
  private server?: Server;
  private activeRequests = new Set<ClientRequest>();
  private activeInboundRequests = 0;
  private activeAuthChecks = 0;
  private activeBodyReads = 0;
  private activePort?: number;
  private lastError?: string;

  constructor(options: LanMcpGatewayOptions) {
    if (isIP(options.bindAddress) !== 4) {
      throw new Error(`局域网 MCP 只支持明确的 IPv4 地址：${options.bindAddress}`);
    }
    if (!Number.isInteger(options.sidecarPort) || options.sidecarPort < 1 || options.sidecarPort > 65535) {
      throw new Error(`无效的本机 PMBrain 端口：${options.sidecarPort}`);
    }
    const listenPort = options.listenPort ?? DEFAULT_LAN_MCP_PORT;
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
      throw new Error(`无效的局域网 MCP 端口：${listenPort}`);
    }
    this.bindAddress = options.bindAddress;
    this.sidecarPort = options.sidecarPort;
    this.verifyBearerToken = options.verifyBearerToken;
    this.configuredPort = listenPort;
  }

  async start(): Promise<LanMcpGatewayStatus> {
    if (this.server?.listening) return this.getStatus();

    const server = createServer((request, response) => {
      if (this.activeInboundRequests >= LAN_MCP_MAX_CONCURRENT_REQUESTS) {
        request.resume();
        jsonError(response, 503, '局域网 MCP 当前请求过多，请稍后重试。');
        return;
      }
      this.activeInboundRequests += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeInboundRequests = Math.max(0, this.activeInboundRequests - 1);
      };
      response.once('finish', release);
      response.once('close', release);
      void this.handleRequest(request, response).catch(() => {
        jsonError(response, 400, '局域网 MCP 请求未能完整读取。');
      });
    });
    server.maxConnections = LAN_MCP_MAX_CONCURRENT_REQUESTS;
    server.headersTimeout = 10_000;
    server.requestTimeout = LAN_MCP_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(bindError(error, this.bindAddress, this.configuredPort));
        };
        const onListening = () => {
          server.off('error', onError);
          if (this.server !== server) {
            server.close(() => reject(new Error('局域网 MCP 启动已取消。')));
            return;
          }
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.configuredPort, this.bindAddress);
      });
    } catch (error) {
      if (this.server === server) this.server = undefined;
      this.activePort = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.stop();
      throw new Error('局域网 MCP 已监听，但无法读取实际端口。');
    }
    this.activePort = address.port;
    this.lastError = undefined;
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    for (const request of this.activeRequests) request.destroy();
    this.activeRequests.clear();
    if (!server) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        server.off('close', finish);
        server.off('error', finish);
        resolve();
      };
      server.once('close', finish);
      server.once('error', finish);
      if (server.listening) {
        server.close(finish);
        server.closeAllConnections?.();
      } else {
        server.once('listening', () => {
          if (server.listening) {
            server.close(finish);
            server.closeAllConnections?.();
          } else {
            finish();
          }
        });
      }
    });
  }

  getStatus(): LanMcpGatewayStatus {
    const port = this.activePort ?? this.configuredPort;
    const baseUrl = `http://${this.bindAddress}:${port}`;
    return {
      running: Boolean(this.server?.listening),
      bindAddress: this.bindAddress,
      port,
      mcpUrl: `${baseUrl}/mcp`,
      healthUrl: `${baseUrl}/health`,
      targetMcpUrl: `http://127.0.0.1:${this.sidecarPort}/mcp`,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://pmbrain.local').pathname;
    } catch {
      jsonError(response, 400, '请求地址无效。');
      return;
    }

    if (!ALLOWED_PATHS.has(pathname)) {
      jsonError(response, 404, '局域网入口只提供 /mcp 和 /health。');
      return;
    }
    const method = request.method?.toUpperCase() ?? '';
    if (!ALLOWED_METHODS.has(method)) {
      response.setHeader('allow', [...ALLOWED_METHODS].join(', '));
      jsonError(response, 405, '局域网 MCP 只接受 GET、POST 和 DELETE。');
      return;
    }
    if (pathname === '/health' && method !== 'GET') {
      response.setHeader('allow', 'GET');
      jsonError(response, 405, '局域网健康检查只接受 GET。');
      return;
    }
    if (pathname === '/mcp') {
      const authorizationHeader = String(request.headers.authorization ?? '').trim();
      if (!/^Bearer\s+\S+$/i.test(authorizationHeader)) {
        request.resume();
        jsonError(response, 401, '局域网 MCP 需要有效的 Bearer API Key。');
        return;
      }
      if (this.activeAuthChecks >= LAN_MCP_MAX_CONCURRENT_AUTH_CHECKS) {
        request.resume();
        jsonError(response, 503, '局域网 MCP 当前正在验证的凭证过多，请稍后重试。');
        return;
      }
      this.activeAuthChecks += 1;
      let validToken = false;
      try {
        validToken = await this.verifyBearerToken(authorizationHeader);
      } catch {
        request.resume();
        jsonError(response, 503, '本机 PMBrain 暂时无法验证共享凭证，请稍后重试。');
        return;
      } finally {
        this.activeAuthChecks = Math.max(0, this.activeAuthChecks - 1);
      }
      if (!validToken) {
        request.resume();
        jsonError(response, 401, 'Bearer API Key 无效或已撤销。');
        return;
      }
    }

    if (pathname === '/mcp' && method === 'POST') {
      if (this.activeBodyReads >= LAN_MCP_MAX_CONCURRENT_BODY_READS) {
        request.resume();
        jsonError(response, 503, '局域网 MCP 当前正在读取的请求过多，请稍后重试。');
        return;
      }
      this.activeBodyReads += 1;
      let body: Buffer | null;
      try {
        body = await readBodyWithLimit(request, LAN_MCP_MAX_BODY_BYTES);
      } finally {
        this.activeBodyReads = Math.max(0, this.activeBodyReads - 1);
      }
      if (body === null) {
        jsonError(response, 413, `请求体过大，局域网 MCP 上限为 ${LAN_MCP_MAX_BODY_BYTES} 字节。`);
        return;
      }
      let filterTools = false;
      try {
        const text = body.toString('utf8');
        const payload = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        const denied = deniedRpcResponse(payload);
        if (denied) {
          writeRpcDenied(response, denied);
          return;
        }
        filterTools = containsMethod(payload, 'tools/list');
      } catch {
        writeRpcParseError(response);
        return;
      }
      this.proxyRequest(request, response, body, filterTools);
      return;
    }

    this.proxyRequest(request, response);
  }

  private proxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
    body?: Buffer,
    filterTools = false,
  ): void {
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: this.sidecarPort,
      method: request.method,
      path: request.url,
      headers: filteredHeaders(request.headers, true),
    });
    if (filterTools) {
      upstream.setTimeout(LAN_MCP_BODY_IDLE_TIMEOUT_MS, () => {
        upstream.destroy(new Error('本机 PMBrain 工具列表响应超时。'));
      });
    }
    this.activeRequests.add(upstream);

    upstream.on('response', (upstreamResponse) => {
      if (filterTools) {
        const chunks: Buffer[] = [];
        let total = 0;
        let overflow = false;
        upstreamResponse.on('data', (chunk) => {
          if (overflow) return;
          const value = Buffer.from(chunk);
          total += value.byteLength;
          if (total > LAN_MCP_MAX_BODY_BYTES) {
            overflow = true;
            chunks.length = 0;
            return;
          }
          chunks.push(value);
        });
        upstreamResponse.on('end', () => {
          if (overflow) {
            jsonError(response, 502, '本机 PMBrain 返回的工具列表过大，共享请求已拒绝。');
            return;
          }
          const original = Buffer.concat(chunks, total);
          const contentType = Array.isArray(upstreamResponse.headers['content-type'])
            ? upstreamResponse.headers['content-type'][0]
            : upstreamResponse.headers['content-type'];
          const output = filterToolsListWireResponse(original, contentType);
          if (!output) {
            jsonError(response, 502, '本机 PMBrain 返回了无法安全过滤的工具列表，共享请求已拒绝。');
            return;
          }
          const headers = filteredHeaders(upstreamResponse.headers);
          delete headers['content-length'];
          headers['content-length'] = String(output.byteLength);
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          response.end(output);
        });
        upstreamResponse.on('error', () => {
          if (!response.writableEnded) response.destroy();
        });
        return;
      }
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        filteredHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', () => {
        if (!response.writableEnded) response.destroy();
      });
    });
    upstream.on('error', () => {
      jsonError(response, 502, '无法连接本机 PMBrain MCP，请确认桌面服务正在运行。');
    });
    upstream.on('close', () => this.activeRequests.delete(upstream));
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    if (body) upstream.end(body);
    else request.pipe(upstream);
  }
}
