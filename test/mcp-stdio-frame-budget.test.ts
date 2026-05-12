import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { operations } from '../src/core/operations.ts';
import {
  BudgetedStdioServerTransport,
  DEFAULT_MCP_MAX_STDIO_FRAME_BYTES,
  DEFAULT_MCP_TOOL_LIST_FRAME_BYTES,
  fitMcpStdioMessageToBudget,
  measureMcpStdioFrameBytes,
  selectMcpStdioFrameBudget,
  serializeMcpStdioFrame,
} from '../src/mcp/stdio-frame-budget.ts';
import { operationToMcpTool } from '../src/mcp/tool-schema.ts';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function readWrittenFrame(stdout: PassThrough): string {
  const chunk = stdout.read();
  if (!chunk) throw new Error('Expected stdout frame');
  return chunk.toString('utf-8');
}

const originalMaxFrameBytes = process.env.MBRAIN_MCP_MAX_STDIO_FRAME_BYTES;
const originalToolListFrameBytes = process.env.MBRAIN_MCP_TOOL_LIST_FRAME_BYTES;

afterEach(() => {
  restoreEnv('MBRAIN_MCP_MAX_STDIO_FRAME_BYTES', originalMaxFrameBytes);
  restoreEnv('MBRAIN_MCP_TOOL_LIST_FRAME_BYTES', originalToolListFrameBytes);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('MCP stdio final-frame budget', () => {
  test('measures the exact JSON-RPC line including trailing newline', () => {
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    } satisfies JSONRPCMessage;

    const serialized = serializeMcpStdioFrame(message);

    expect(serialized).toBe(`${JSON.stringify(message)}\n`);
    expect(measureMcpStdioFrameBytes(message)).toBe(byteLength(serialized));
  });

  test('captures escaping overhead beyond the inner tool text bytes', () => {
    const text = `"quoted"\n`.repeat(512);
    const message = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text }] },
    } satisfies JSONRPCMessage;

    expect(measureMcpStdioFrameBytes(message)).toBeGreaterThan(byteLength(text));
    expect(serializeMcpStdioFrame(message)).toContain('\\n');
    expect(serializeMcpStdioFrame(message)).toContain('\\"quoted\\"');
  });
});

describe('MCP stdio budget enforcement', () => {
  test('uses a larger compatibility budget for tools/list results', () => {
    delete process.env.MBRAIN_MCP_TOOL_LIST_FRAME_BYTES;
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    } satisfies JSONRPCMessage;

    expect(selectMcpStdioFrameBudget(message)).toBe(DEFAULT_MCP_TOOL_LIST_FRAME_BYTES);
  });

  test('fits the full tools/list catalog within the default tool-list frame budget', () => {
    delete process.env.MBRAIN_MCP_TOOL_LIST_FRAME_BYTES;
    const message = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        tools: operations.map(operation => operationToMcpTool(operation, { compact: false })),
      },
    } satisfies JSONRPCMessage;
    const frameBytes = measureMcpStdioFrameBytes(message);

    expect(selectMcpStdioFrameBudget(message)).toBe(DEFAULT_MCP_TOOL_LIST_FRAME_BYTES);
    expect(frameBytes).toBeLessThanOrEqual(DEFAULT_MCP_TOOL_LIST_FRAME_BYTES);
    expect(DEFAULT_MCP_TOOL_LIST_FRAME_BYTES - frameBytes).toBeGreaterThanOrEqual(16_000);
    expect(fitMcpStdioMessageToBudget(message)).toBe(message);
  });

  test('uses the default final-frame budget for tool call results', () => {
    delete process.env.MBRAIN_MCP_MAX_STDIO_FRAME_BYTES;
    const message = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    } satisfies JSONRPCMessage;

    expect(selectMcpStdioFrameBudget(message)).toBe(DEFAULT_MCP_MAX_STDIO_FRAME_BYTES);
  });

  test('replaces oversized response frames with a bounded JSON-RPC error', () => {
    const oversized = {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
    } satisfies JSONRPCMessage;

    const fitted = fitMcpStdioMessageToBudget(oversized, { maxFrameBytes: 512 });

    expect(measureMcpStdioFrameBytes(fitted)).toBeLessThanOrEqual(512);
    expect('error' in fitted).toBe(true);
    expect((fitted as any).id).toBe(3);
    expect((fitted as any).error.message).toContain('MBrain MCP stdio frame exceeded byte budget');
    expect((fitted as any).error.data.original_frame_bytes).toBeGreaterThan(512);
  });

  test('falls back to a minimal error if metadata would exceed the budget', () => {
    const oversized = {
      jsonrpc: '2.0',
      id: `request-${'x'.repeat(90)}`,
      error: {
        code: -32603,
        message: 'x'.repeat(10_000),
      },
    } satisfies JSONRPCMessage;

    const fitted = fitMcpStdioMessageToBudget(oversized, { maxFrameBytes: 256 });

    expect(measureMcpStdioFrameBytes(fitted)).toBeLessThanOrEqual(256);
    expect((fitted as any).error.data).toBeUndefined();
  });

  test('throws when even the minimal replacement response cannot fit the budget', () => {
    const oversized = {
      jsonrpc: '2.0',
      id: `request-${'x'.repeat(1_000)}`,
      result: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
    } satisfies JSONRPCMessage;

    expect(() => fitMcpStdioMessageToBudget(oversized, { maxFrameBytes: 256 })).toThrow(
      'MBrain MCP stdio frame exceeded byte budget',
    );
  });

  test('does not rewrite oversized server-originated requests as error responses', () => {
    const oversized = {
      jsonrpc: '2.0',
      id: 6,
      method: 'sampling/createMessage',
      params: { payload: 'x'.repeat(5_000) },
    } satisfies JSONRPCMessage;

    expect(() => fitMcpStdioMessageToBudget(oversized, { maxFrameBytes: 256 })).toThrow(
      'MBrain MCP stdio frame exceeded byte budget',
    );
  });
});

describe('BudgetedStdioServerTransport', () => {
  test('writes small frames unchanged', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new BudgetedStdioServerTransport(stdin, stdout, { maxFrameBytes: 512 });
    const message = {
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    } satisfies JSONRPCMessage;

    await transport.send(message);

    expect(readWrittenFrame(stdout)).toBe(serializeMcpStdioFrame(message));
  });

  test('writes bounded replacement frames for oversized responses', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new BudgetedStdioServerTransport(stdin, stdout, { maxFrameBytes: 512 });
    const oversized = {
      jsonrpc: '2.0',
      id: 5,
      result: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
    } satisfies JSONRPCMessage;

    await transport.send(oversized);

    const frame = readWrittenFrame(stdout);
    const parsed = JSON.parse(frame) as JSONRPCMessage;
    expect(byteLength(frame)).toBeLessThanOrEqual(512);
    expect(parsed).toEqual(fitMcpStdioMessageToBudget(oversized, { maxFrameBytes: 512 }));
    expect('error' in parsed).toBe(true);
  });

  test('rejects oversized notifications without writing to stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new BudgetedStdioServerTransport(stdin, stdout, { maxFrameBytes: 512 });
    const oversized = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { payload: 'x'.repeat(5_000) },
    } satisfies JSONRPCMessage;

    await expect(transport.send(oversized)).rejects.toThrow('MBrain MCP stdio frame exceeded byte budget');

    expect(stdout.read()).toBeNull();
  });
});
