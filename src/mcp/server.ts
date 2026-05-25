import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchToolCall, validateParams, buildOperationContext } from './dispatch.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';

/**
 * Wire a new MCP `Server` to the given transport, registering tool defs +
 * dispatch handlers against the shared engine. Pure construction — does NOT
 * install process-wide stdio shutdown hooks (the caller decides whether
 * those apply: yes for the primary stdio path in `startMcpServer`, no for
 * per-connection socket transports created by the multiplexer).
 *
 * Trust boundary: handler always dispatches with `remote: true` — see
 * AGENTS.md trust-boundary section. The multiplexer reuses this verbatim,
 * so a client coming in via Unix socket gets the same untrusted treatment
 * as a stdio client (which is correct: Claude Code's child claude-code-spawn
 * sessions are the same trust class as the parent Claude.app session).
 */
export async function startMcpServerWithTransport(
  engine: BrainEngine,
  transport: Transport,
): Promise<Server> {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(operations),
  }));

  // Dispatch tool calls via shared dispatch.ts (parity with HTTP transport).
  // MCP stdio callers are remote/untrusted; dispatch defaults remote=true.
  // The MCP SDK's response type widened in 1.29 to allow a managed-task wrapper;
  // gbrain ops are synchronous, so we return the legacy `{ content, isError? }`
  // shape and cast through `any` (the SDK accepts it via the ServerResult union).
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: params } = request.params;
    // v0.28: stdio MCP has no per-token auth (local pipe). Default the
    // takes-holder allow-list to ['world'] so agent-facing callers don't
    // see private hunches via takes_list / takes_search / query. Operators
    // who want stdio to see everything should call ops directly via
    // `gbrain call <op>` (sets remote=false in src/cli.ts).
    return dispatchToolCall(engine, name, params, {
      remote: true,
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

  await server.connect(transport);
  return server;
}

export async function startMcpServer(engine: BrainEngine) {
  const transport = new StdioServerTransport();
  await startMcpServerWithTransport(engine, transport);
  // Process-wide shutdown handling (SIGTERM/SIGINT/SIGHUP, stdin EOF,
  // parent-process watchdog, cleanup deadline) is installed by the caller
  // via installStdioLifecycle() in src/commands/serve.ts. That lifecycle
  // is strictly a superset of the per-server hooks that used to live here
  // — and crucially, it also closes the multiplexer (src/mcp/multiplexer.ts)
  // before engine.disconnect(), which the inline version did not. Keeping
  // both led to two concurrent shutdown chains racing on engine.disconnect()
  // and surfacing "PGlite is closing" cleanup errors when shutdown was
  // triggered by stdin-end (bash background, stdin-half-close gateways).
}

// Backward compat: used by `gbrain call` command (trusted local path).
// v0.31.8 (D22): accept opts.sourceId so `gbrain call --source X <op> <json>`
// can scope the op handler to that source. resolveSourceId() in call.ts is
// the upstream resolver; this layer just passes the resolved id through.
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
  opts?: { sourceId?: string },
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx = buildOperationContext(engine, params, {
    remote: false,
    logger: { info: console.log, warn: console.warn, error: console.error },
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
  });

  return op.handler(ctx, params);
}
