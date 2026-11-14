/** Real bridge, synthetic SDK boundaries. R2 requires one process per serial file. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { GBrainConfig } from '../src/core/config.ts';
import type { OperationMeta } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

type Handler = (request?: any) => Promise<any>;
const servers: FakeServer[] = [];
const transports: FakeStdioTransport[] = [];
class FakeServer {
  handlers = new Map<unknown, Handler>();
  connect = mock(async (_transport: FakeStdioTransport) => {});
  constructor(readonly identity: unknown, readonly options: unknown) { servers.push(this); }
  setRequestHandler(schema: unknown, handler: Handler) { this.handlers.set(schema, handler); }
}
class FakeStdioTransport {
  onclose?: () => void;
  constructor() { transports.push(this); }
}

const localFallback = mock((): never => { throw new Error('local fallback must never run'); });
const localHandler = mock(async () => localFallback());
const operations: OperationMeta[] = [
  { name: 'read_example', description: 'Synthetic read', scope: 'read', localOnly: false,
    params: { slug: { type: 'string', required: true }, limit: { type: 'number', default: 3 } }, outputRedaction: 'no_stored_text' },
  { name: 'implicit_remote_example', description: 'Synthetic implicit remote', params: {}, outputRedaction: 'no_stored_text' },
  { name: 'local_only_example', description: 'Synthetic local only', localOnly: true, params: {}, outputRedaction: 'no_stored_text' },
  { name: 'cli_only_example', description: 'Synthetic CLI only', cliOnly: { argv: ['gbrain', 'example'] }, params: {}, outputRedaction: 'no_stored_text' },
];
const config: GBrainConfig = {
  engine: 'postgres',
  remote_mcp: {
    issuer_url: 'https://bridge.example', mcp_url: 'https://bridge.example/mcp',
    oauth_client_id: 'synthetic-client', oauth_client_secret: 'synthetic-secret',
  },
};
let remoteResult: unknown;
let remoteFailure: unknown;
const callRemoteTool = mock(async (_config: GBrainConfig, _name: string, _params: unknown) => {
  if (remoteFailure !== undefined) throw remoteFailure;
  return remoteResult;
});

mock.module('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: FakeServer }));
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: FakeStdioTransport }));
mock.module('../src/core/operation-manifest.generated.ts', () => ({ OPERATION_MANIFEST: operations }));
mock.module('../src/core/mcp-client.ts', () => ({ callRemoteTool }));
mock.module('../src/mcp/dispatch.ts', () => ({
  dispatchToolCall: localFallback, validateParams: localFallback, buildOperationContext: localFallback,
}));
mock.module('../src/core/facts/meta-hook.ts', () => ({ getBrainHotMemoryMeta: localFallback }));
mock.module('../src/core/engine-factory.ts', () => ({ createEngine: localFallback }));

let startRemoteMcpBridge: typeof import('../src/mcp/server.ts').startRemoteMcpBridge;
beforeAll(async () => {
  ({ startRemoteMcpBridge } = await import('../src/mcp/server.ts'));
});
afterAll(() => { mock.restore(); });

const signalNames = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const stdinNames = ['end', 'close'] as const;
type Listener = (...args: any[]) => void;
let signalBaseline: Map<string, Listener[]>;
let stdinBaseline: Map<string, Listener[]>;
let exitSpy: ReturnType<typeof spyOn<typeof process, 'exit'>>;
let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let connectSpy: ReturnType<typeof spyOn<typeof Bun, 'connect'>>;
let listenSpy: ReturnType<typeof spyOn<typeof Bun, 'listen'>>;
let serveSpy: ReturnType<typeof spyOn<typeof Bun, 'serve'>>;

beforeEach(() => {
  servers.length = 0;
  transports.length = 0;
  callRemoteTool.mockClear();
  localHandler.mockClear();
  localFallback.mockClear();
  remoteResult = { content: [{ type: 'text', text: 'synthetic response' }], _meta: { synthetic: { source_id: 'alpha' } } };
  remoteFailure = undefined;
  signalBaseline = new Map(signalNames.map(name => [name, process.listeners(name)]));
  stdinBaseline = new Map(stdinNames.map(name => [name, process.stdin.listeners(name)]));
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(localFallback, { preconnect: localFallback }));
  connectSpy = spyOn(Bun, 'connect').mockImplementation(localFallback);
  listenSpy = spyOn(Bun, 'listen').mockImplementation(localFallback);
  serveSpy = spyOn(Bun, 'serve').mockImplementation(localFallback);
});

function signalListeners(name: typeof signalNames[number]) {
  return process.listeners(name).filter(listener => !signalBaseline.get(name)!.includes(listener));
}
function stdinListeners(name: typeof stdinNames[number]) {
  return process.stdin.listeners(name).filter(listener => !stdinBaseline.get(name)!.includes(listener));
}

afterEach(() => {
  try {
    expect(localHandler).not.toHaveBeenCalled();
    expect(localFallback).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(serveSpy).not.toHaveBeenCalled();
  } finally {
    for (const name of signalNames) {
      for (const listener of signalListeners(name)) process.removeListener(name, listener);
    }
    for (const name of stdinNames) {
      for (const listener of stdinListeners(name)) process.stdin.removeListener(name, listener);
    }
    for (const transport of transports) transport.onclose = undefined;
    mock.restore();
  }
  for (const name of signalNames) expect(process.listeners(name)).toEqual(signalBaseline.get(name)!);
  for (const name of stdinNames) expect(process.stdin.listeners(name)).toEqual(stdinBaseline.get(name)!);
});

async function boot(mcpStdio?: string) {
  const before = process.env.MCP_STDIO;
  await withEnv({ MCP_STDIO: mcpStdio }, () => startRemoteMcpBridge(config));
  expect(process.env.MCP_STDIO).toBe(before);
  expect(servers).toHaveLength(1);
  expect(transports).toHaveLength(1);
  expect(servers[0].connect).toHaveBeenCalledTimes(1);
  expect(servers[0].connect).toHaveBeenCalledWith(transports[0]);
  expect(exitSpy).not.toHaveBeenCalled();
  return servers[0];
}

function handler(server: FakeServer, schema: unknown): Handler {
  const registered = server.handlers.get(schema);
  expect(registered).toBeDefined();
  return registered!;
}

describe('native remote MCP bridge routing and forwarding', () => {
  test('selects STDIO and advertises only non-local operations through the real mapper', async () => {
    const server = await boot();
    expect(server.identity).toMatchObject({ name: 'gbrain', version: expect.any(String) });
    expect(server.options).toEqual({ capabilities: { tools: {} } });
    expect(server.handlers.size).toBe(2);
    const result = await handler(server, ListToolsRequestSchema)();
    expect(result.tools).toEqual([
      { name: 'read_example', description: 'Synthetic read', inputSchema: {
        type: 'object', properties: { slug: { type: 'string' }, limit: { type: 'number', default: 3 } }, required: ['slug'],
      } },
      { name: 'implicit_remote_example', description: 'Synthetic implicit remote', inputSchema: {
        type: 'object', properties: {}, required: [],
      } },
    ]);
    expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain('local_only_example');
    expect(callRemoteTool).not.toHaveBeenCalled();
  });

  test('forwards the exact config, name and supplied argument object without local validation', async () => {
    const server = await boot();
    const params = { slug: 'example/page', limit: 0, nested: { flag: false, values: [1, null] }, extra: 'unchanged' };
    const result = await handler(server, CallToolRequestSchema)({ params: { name: 'read_example', arguments: params } });
    expect(callRemoteTool).toHaveBeenCalledTimes(1);
    expect(callRemoteTool.mock.calls[0][0]).toBe(config);
    expect(callRemoteTool.mock.calls[0][1]).toBe('read_example');
    expect(callRemoteTool.mock.calls[0][2]).toBe(params);
    expect(result).toBe(remoteResult);
    expect(params).toEqual({ slug: 'example/page', limit: 0, nested: { flag: false, values: [1, null] }, extra: 'unchanged' });
  });

  for (const [label, params] of [
    ['absent', { name: 'read_example' }],
    ['undefined', { name: 'read_example', arguments: undefined }],
    ['null', { name: 'read_example', arguments: null }],
  ] as const) {
    test(`${label} arguments default to an empty object`, async () => {
      const server = await boot();
      const result = await handler(server, CallToolRequestSchema)({ params });
      expect(callRemoteTool).toHaveBeenCalledTimes(1);
      expect(callRemoteTool).toHaveBeenCalledWith(config, 'read_example', {});
      expect(result).toBe(remoteResult);
    });
  }

  test('preserves a supplied empty object by identity', async () => {
    const server = await boot();
    const params = {};
    await handler(server, CallToolRequestSchema)({ params: { name: 'read_example', arguments: params } });
    expect(callRemoteTool.mock.calls[0][2]).toBe(params);
  });

  for (const value of [false, 0, '']) {
    test(`the handler does not default non-nullish arguments ${JSON.stringify(value)}`, async () => {
      // Drive the registered handler directly to pin the nullish-only default.
      // SDK request-schema validation is outside this bridge unit's boundary.
      const server = await boot();
      await handler(server, CallToolRequestSchema)({ params: { name: 'read_example', arguments: value } });
      expect(callRemoteTool).toHaveBeenCalledTimes(1);
      expect(callRemoteTool.mock.calls[0][2]).toBe(value);
    });
  }

  test('preserves remote permission-error results without a local fallback', async () => {
    remoteResult = { isError: true, content: [{ type: 'text', text: 'permission_denied: source not granted' }], _meta: { code: 'permission_denied' } };
    const server = await boot();
    const result = await handler(server, CallToolRequestSchema)({ params: { name: 'read_example', arguments: {} } });
    expect(result).toBe(remoteResult);
    expect(result.isError).toBe(true);
    expect(callRemoteTool).toHaveBeenCalledTimes(1);
  });

  for (const code of ['permission_denied', 'transport_error']) {
    test(`propagates rejected ${code} promises unchanged without local fallback`, async () => {
      remoteFailure = Object.assign(new Error(`synthetic ${code}`), { code });
      const server = await boot();
      await expect(handler(server, CallToolRequestSchema)({ params: { name: 'read_example', arguments: {} } }))
        .rejects.toBe(remoteFailure);
      expect(callRemoteTool).toHaveBeenCalledTimes(1);
    });
  }
});

const shutdownReasons = ['stdin end', 'stdin close', 'transport close', ...signalNames] as const;
type ShutdownReason = typeof shutdownReasons[number];
function fire(reason: ShutdownReason) {
  if (reason === 'transport close') {
    expect(transports[0].onclose).toBeFunction();
    transports[0].onclose!();
  } else if (reason === 'stdin end' || reason === 'stdin close') {
    for (const listener of stdinListeners(reason === 'stdin end' ? 'end' : 'close')) listener();
  } else {
    // Invoke only bridge listeners, never signal handlers owned by the runner.
    for (const listener of signalListeners(reason)) listener(reason);
  }
}

describe('native remote MCP bridge lifecycle', () => {
  for (const reason of shutdownReasons) {
    test(`${reason} shuts down once with MCP_STDIO unset`, async () => {
      await boot();
      for (const name of stdinNames) expect(stdinListeners(name)).toHaveLength(1);
      for (const name of signalNames) expect(signalListeners(name)).toHaveLength(1);
      fire(reason);
      for (const other of shutdownReasons) fire(other);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(`[gbrain-remote-bridge] shutdown: ${reason}\n`);
    });
  }

  for (const reason of ['transport close', ...signalNames] as const) {
    test(`MCP_STDIO=1 ignores stdin EOF but retains one-shot ${reason} shutdown`, async () => {
      await boot('1');
      for (const name of stdinNames) expect(stdinListeners(name)).toHaveLength(0);
      for (const name of signalNames) expect(signalListeners(name)).toHaveLength(1);
      fire('stdin end');
      fire('stdin close');
      expect(exitSpy).not.toHaveBeenCalled();
      fire(reason);
      for (const other of shutdownReasons) fire(other);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(`[gbrain-remote-bridge] shutdown: ${reason}\n`);
    });
  }
});
