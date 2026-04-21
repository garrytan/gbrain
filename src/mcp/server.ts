import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { Operation, OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';

/** Validate required params exist and have the expected type */
function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

export async function startMcpServer(engine: BrainEngine) {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Generate tool definitions from operations
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map(op => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, {
            type: v.type === 'array' ? 'array' : v.type,
            ...(v.description ? { description: v.description } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.items ? { items: { type: v.items.type } } : {}),
          }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    })),
  }));

  // Dispatch tool calls to operation handlers
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    const ctx: OperationContext = {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
      dryRun: !!(params?.dry_run),
      // MCP stdio callers are remote/untrusted; enforce strict file confinement.
      remote: true,
    };

    const safeParams = params || {};
    const validationError = validateParams(op, safeParams);
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    try {
      const result = await op.handler(ctx, safeParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Backward compat: used by `gbrain call` command
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx: OperationContext = {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: !!(params?.dry_run),
    // Backing path for `gbrain call` CLI command — trusted local invocation.
    remote: false,
  };

  return op.handler(ctx, params);
}
