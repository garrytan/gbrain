import type { Readable, Writable } from 'node:stream';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MCP_MAX_STDIO_FRAME_BYTES = 24_000;
export const DEFAULT_MCP_TOOL_LIST_FRAME_BYTES = 128_000;
export const DEFAULT_MCP_MAX_STDIO_REQUEST_BYTES = 256_000;
const MIN_MCP_STDIO_FRAME_BYTES = 256;
const MIN_MCP_STDIO_REQUEST_BYTES = 128;

export type McpStdioFrameBudgetOptions = {
  maxFrameBytes?: number;
  toolListFrameBytes?: number;
  maxRequestBytes?: number;
};

export class BudgetedStdioServerTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private buffer = Buffer.alloc(0);
  private discardingOversizedLine = false;
  private oversizedLineReported = false;
  private started = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    private readonly options: McpStdioFrameBudgetOptions = {},
  ) {}

  start(): Promise<void> {
    if (this.started) {
      throw new Error('BudgetedStdioServerTransport already started! If using Server class, note that connect() calls start() automatically.');
    }
    this.started = true;
    this.stdin.on('data', this.onData);
    this.stdin.on('error', this.onInputError);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.stdin.off('data', this.onData);
    this.stdin.off('error', this.onInputError);
    if (this.stdin.listenerCount('data') === 0) {
      this.stdin.pause();
    }
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const frame = serializeMcpStdioFrame(fitMcpStdioMessageToBudget(message, this.options));
    await new Promise<void>(resolve => {
      if (this.stdout.write(frame)) {
        resolve();
      } else {
        this.stdout.once('drain', resolve);
      }
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.processIncomingChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };

  private readonly onInputError = (error: Error): void => {
    this.onerror?.(error);
  };

  private processIncomingChunk(chunk: Buffer): void {
    const maxRequestBytes = selectMcpStdioRequestBudget(this.options);
    let offset = 0;

    while (offset < chunk.length) {
      if (this.discardingOversizedLine) {
        const newlineIndex = chunk.indexOf(0x0a, offset);
        if (newlineIndex === -1) return;
        this.discardingOversizedLine = false;
        this.oversizedLineReported = false;
        offset = newlineIndex + 1;
        continue;
      }

      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.subarray(offset, segmentEnd);
      if (this.buffer.length + segment.length > maxRequestBytes) {
        this.buffer = Buffer.alloc(0);
        this.reportOversizedInboundLine(maxRequestBytes);
        if (newlineIndex === -1) {
          this.discardingOversizedLine = true;
          return;
        }
        this.oversizedLineReported = false;
        offset = newlineIndex + 1;
        continue;
      }

      this.buffer = this.buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([this.buffer, segment]);
      if (newlineIndex === -1) return;

      const line = stripTrailingCarriageReturn(this.buffer).toString('utf-8');
      this.buffer = Buffer.alloc(0);
      this.deliverInboundLine(line);
      offset = newlineIndex + 1;
    }
  }

  private deliverInboundLine(line: string): void {
    try {
      const parsed = JSONRPCMessageSchema.parse(JSON.parse(line));
      this.onmessage?.(parsed);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private reportOversizedInboundLine(maxRequestBytes: number): void {
    if (this.oversizedLineReported) return;
    this.oversizedLineReported = true;
    void this.send(buildRequestBudgetError(maxRequestBytes)).catch(error => {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
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

export function selectMcpStdioRequestBudget(
  options: McpStdioFrameBudgetOptions = {},
): number {
  return normalizeRequestBudget(
    options.maxRequestBytes
      ?? parseBudgetEnv('MBRAIN_MCP_MAX_STDIO_REQUEST_BYTES', DEFAULT_MCP_MAX_STDIO_REQUEST_BYTES),
  );
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

function normalizeRequestBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MCP_MAX_STDIO_REQUEST_BYTES;
  return Math.max(MIN_MCP_STDIO_REQUEST_BYTES, Math.floor(value));
}

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d) {
    return buffer.subarray(0, buffer.length - 1);
  }
  return buffer;
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

function buildRequestBudgetError(maxRequestBytes: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    error: {
      code: -32700,
      message: 'MBrain MCP stdio request exceeded byte budget',
      data: {
        max_request_bytes: maxRequestBytes,
      },
    },
  };
}
