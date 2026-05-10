import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchToolCall, validateParams, buildOperationContext } from './dispatch.ts';
import { OP_TIER_DEFAULT_REQUIRED, tierImplies } from '../core/access-tier.ts';
import type { AccessTier } from '../core/access-tier.ts';
import { hasScope } from '../core/scope.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';

const STDIO_SCOPES = ['read'];
const STDIO_TIER: AccessTier = 'Work';

export async function startMcpServer(engine: BrainEngine) {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape.
  const mcpOperations = operations.filter(op => !op.localOnly);
  const stdioOperations = mcpOperations.filter((op) => {
    const requiredScope = op.scope || 'read';
    if (!hasScope(STDIO_SCOPES, requiredScope)) return false;
    const requiredTier = op.tier ?? OP_TIER_DEFAULT_REQUIRED;
    return tierImplies(STDIO_TIER, requiredTier);
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(stdioOperations),
  }));

  // Dispatch tool calls via shared dispatch.ts (parity with HTTP transport).
  // MCP stdio callers are remote/untrusted; dispatch defaults remote=true.
  // The MCP SDK's response type widened in 1.29 to allow a managed-task wrapper;
  // gbrain ops are synchronous, so we return the legacy `{ content, isError? }`
  // shape and cast through `any` (the SDK accepts it via the ServerResult union).
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: params } = request.params;
    // v0.28: stdio MCP has no per-token auth (local pipe), so expose the same
    // untrusted Work/read surface to every stdio client and enforce response
    // tier filters. Operators who want owner-trust should call ops directly
    // via `gbrain call <op>` (sets remote=false in src/cli.ts).
    return dispatchToolCall(engine, name, params, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: STDIO_SCOPES,
      tier: STDIO_TIER,
      takesHoldersAllowList: ['world'],
      // v0.31: source defaults to 'default' for stdio (no per-token scope).
      // Operators who want a different source on stdio MCP should set
      // GBRAIN_SOURCE in the env or use --source via `gbrain call`.
      sourceId: process.env.GBRAIN_SOURCE || 'default',
      // v0.31 (eD3): _meta.brain_hot_memory injection so Claude Desktop /
      // Code see the brain's relevant hot memory automatically alongside
      // every tool-call response. Best-effort; absorbs errors.
      metaHook: getBrainHotMemoryMeta,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Backward compat: used by `gbrain call` command (trusted local path).
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx = buildOperationContext(engine, params, {
    remote: false,
    logger: { info: console.log, warn: console.warn, error: console.error },
  });

  return op.handler(ctx, params);
}
