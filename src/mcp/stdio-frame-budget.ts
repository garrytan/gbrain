import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MCP_MAX_STDIO_FRAME_BYTES = 24_000;
export const DEFAULT_MCP_TOOL_LIST_FRAME_BYTES = 128_000;
const MIN_MCP_STDIO_FRAME_BYTES = 256;

export type McpStdioFrameBudgetOptions = {
  maxFrameBytes?: number;
  toolListFrameBytes?: number;
};

export class BudgetedStdioServerTransport implements Transport {
  private readonly transport: StdioServerTransport;

  constructor(
    stdin?: Readable,
    stdout?: Writable,
    private readonly options: McpStdioFrameBudgetOptions = {},
  ) {
    this.transport = new StdioServerTransport(stdin, stdout);
  }

  get onclose(): Transport['onclose'] {
    return this.transport.onclose;
  }

  set onclose(handler: Transport['onclose']) {
    this.transport.onclose = handler;
  }

  get onerror(): Transport['onerror'] {
    return this.transport.onerror;
  }

  set onerror(handler: Transport['onerror']) {
    this.transport.onerror = handler;
  }

  get onmessage(): Transport['onmessage'] {
    return this.transport.onmessage as Transport['onmessage'];
  }

  set onmessage(handler: Transport['onmessage']) {
    this.transport.onmessage = handler as ((message: JSONRPCMessage) => void) | undefined;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await this.transport.send(fitMcpStdioMessageToBudget(message, this.options));
  }
}

export function serializeMcpStdioFrame(message: JSONRPCMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function measureMcpStdioFrameBytes(message: JSONRPCMessage): number {
  return Buffer.byteLength(serializeMcpStdioFrame(message), 'utf-8');
}

export function selectMcpStdioFrameBudget(
  message: JSONRPCMessage,
  options: McpStdioFrameBudgetOptions = {},
): number {
  const rawBudget = isToolListResult(message)
    ? options.toolListFrameBytes
      ?? parseBudgetEnv('MBRAIN_MCP_TOOL_LIST_FRAME_BYTES', DEFAULT_MCP_TOOL_LIST_FRAME_BYTES)
    : options.maxFrameBytes
      ?? parseBudgetEnv('MBRAIN_MCP_MAX_STDIO_FRAME_BYTES', DEFAULT_MCP_MAX_STDIO_FRAME_BYTES);
  return normalizeBudget(rawBudget);
}

export function fitMcpStdioMessageToBudget(
  message: JSONRPCMessage,
  options: McpStdioFrameBudgetOptions = {},
): JSONRPCMessage {
  const maxFrameBytes = selectMcpStdioFrameBudget(message, options);
  const originalFrameBytes = measureMcpStdioFrameBytes(message);
  if (originalFrameBytes <= maxFrameBytes) return message;

  if (!isJsonRpcResponse(message)) {
    throw new Error(`MBrain MCP stdio frame exceeded byte budget: ${originalFrameBytes} > ${maxFrameBytes}`);
  }

  const id = getResponseId(message);
  if (id === undefined) {
    throw new Error(`MBrain MCP stdio frame exceeded byte budget: ${originalFrameBytes} > ${maxFrameBytes}`);
  }

  const detailed = buildFrameBudgetError(id, maxFrameBytes, originalFrameBytes, true);
  if (measureMcpStdioFrameBytes(detailed) <= maxFrameBytes) return detailed;
  const minimal = buildFrameBudgetError(id, maxFrameBytes, originalFrameBytes, false);
  if (measureMcpStdioFrameBytes(minimal) <= maxFrameBytes) return minimal;
  throw new Error(`MBrain MCP stdio frame exceeded byte budget: ${originalFrameBytes} > ${maxFrameBytes}`);
}

function parseBudgetEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MCP_MAX_STDIO_FRAME_BYTES;
  return Math.max(MIN_MCP_STDIO_FRAME_BYTES, Math.floor(value));
}

function isToolListResult(message: JSONRPCMessage): boolean {
  return 'result' in message
    && typeof message.result === 'object'
    && message.result !== null
    && Array.isArray((message.result as any).tools);
}

function isJsonRpcResponse(message: JSONRPCMessage): boolean {
  return 'result' in message || 'error' in message;
}

function getResponseId(message: JSONRPCMessage): RequestId | undefined {
  return 'id' in message ? message.id : undefined;
}

function buildFrameBudgetError(
  id: RequestId,
  maxFrameBytes: number,
  originalFrameBytes: number,
  includeData: boolean,
): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'MBrain MCP stdio frame exceeded byte budget',
      ...(includeData ? {
        data: {
          max_frame_bytes: maxFrameBytes,
          original_frame_bytes: originalFrameBytes,
        },
      } : {}),
    },
  };
}
