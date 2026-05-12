import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, MCP_INSTRUCTIONS } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { VERSION } from '../version.ts';
import { operationToMcpTool } from './tool-schema.ts';

export const DEFAULT_MCP_MAX_RESULT_TEXT_BYTES = 24_000;
export const DEFAULT_MCP_GET_PAGE_CHAR_LIMIT = 6_000;
const MIN_MCP_MAX_RESULT_TEXT_BYTES = 512;
const TRUNCATION_MARKER = '\n\n[truncated by mbrain MCP response guard]';

export type FormatMcpToolResultOptions = {
  maxResultTextBytes?: number;
};

export function prepareMcpToolParams(
  toolName: string,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const prepared = { ...(params ?? {}) };
  if (
    toolName === 'get_page'
    && prepared.full_content !== true
    && prepared.content_char_limit === undefined
  ) {
    prepared.content_char_limit = parseConfiguredMcpGetPageCharLimit();
  }
  if (
    toolName === 'put_page'
    && prepared.defer_derived === undefined
    && shouldDeferMcpPutPageDerived()
  ) {
    prepared.defer_derived = true;
  }
  return prepared;
}

function parseConfiguredMcpGetPageCharLimit(): number {
  const raw = process.env.MBRAIN_MCP_GET_PAGE_CHAR_LIMIT;
  if (!raw) return DEFAULT_MCP_GET_PAGE_CHAR_LIMIT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MCP_GET_PAGE_CHAR_LIMIT;
}

function shouldDeferMcpPutPageDerived(): boolean {
  const raw = process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED;
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function shouldCompactMcpToolSchemas(): boolean {
  const raw = process.env.MBRAIN_MCP_COMPACT_TOOL_SCHEMAS;
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function formatMcpToolResult(
  toolName: string,
  result: unknown,
  options: FormatMcpToolResultOptions = {},
): string {
  const maxResultTextBytes = normalizeMcpMaxResultTextBytes(options.maxResultTextBytes);
  const rawJson = JSON.stringify(result) ?? 'null';
  const rawBytes = byteLength(rawJson);
  if (rawBytes <= maxResultTextBytes) return rawJson;

  const guarded = buildGuardedMcpResult(toolName, rawJson, rawBytes, maxResultTextBytes);
  const guardedJson = JSON.stringify(guarded);
  if (byteLength(guardedJson) <= maxResultTextBytes) return guardedJson;

  return buildFallbackMcpResultText(toolName, rawJson, rawBytes, maxResultTextBytes);
}

function normalizeMcpMaxResultTextBytes(value?: number): number {
  const configured = value ?? parseConfiguredMcpMaxResultTextBytes();
  if (!Number.isFinite(configured)) return DEFAULT_MCP_MAX_RESULT_TEXT_BYTES;
  return Math.max(MIN_MCP_MAX_RESULT_TEXT_BYTES, Math.floor(configured));
}

function parseConfiguredMcpMaxResultTextBytes(): number {
  const raw = process.env.MBRAIN_MCP_MAX_RESULT_TEXT_BYTES
    ?? process.env.MBRAIN_MCP_MAX_RESPONSE_BYTES;
  if (!raw) return DEFAULT_MCP_MAX_RESULT_TEXT_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_MAX_RESULT_TEXT_BYTES;
}

function buildGuardedMcpResult(
  toolName: string,
  rawJson: string,
  rawBytes: number,
  maxResultTextBytes: number,
): unknown {
  const parsed = JSON.parse(rawJson) as unknown;
  if (toolName === 'get_page' && isRecord(parsed)) {
    const guardedPage = buildGuardedGetPageResult(parsed, rawBytes, maxResultTextBytes);
    if (guardedPage) return guardedPage;
  }

  let perStringBytes = Math.max(128, Math.floor(maxResultTextBytes / 4));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const truncated = truncateJsonStrings(parsed, perStringBytes);
    const withMetadata = attachMcpTruncationMetadata(toolName, truncated, rawBytes, false);
    if (byteLength(JSON.stringify(withMetadata)) <= maxResultTextBytes) {
      return withMetadata;
    }
    perStringBytes = Math.max(64, Math.floor(perStringBytes / 2));
  }

  return attachMcpTruncationMetadata(toolName, parsed, rawBytes, true);
}

function buildGuardedGetPageResult(
  page: Record<string, unknown>,
  originalResponseBytes: number,
  maxResultTextBytes: number,
): unknown | null {
  let perFieldBytes = Math.max(128, Math.floor(maxResultTextBytes / 4));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const compiledTruth = truncatePageField(page.compiled_truth, perFieldBytes);
    const timeline = truncatePageField(page.timeline, perFieldBytes);
    const continuations = buildGetPageContinuations(page.slug, compiledTruth, timeline);
    const pageWithoutContentWindow = { ...page };
    delete pageWithoutContentWindow.content_window;
    const guarded = {
      ...pageWithoutContentWindow,
      ...(compiledTruth ? { compiled_truth: compiledTruth.text } : {}),
      ...(timeline ? { timeline: timeline.text } : {}),
      _mbrain_mcp_response: {
        truncated: true,
        tool: 'get_page',
        original_response_bytes: originalResponseBytes,
        hint: mcpTruncationHint('get_page'),
        continuations,
      },
    };

    if (byteLength(JSON.stringify(guarded)) <= maxResultTextBytes) {
      return guarded;
    }
    perFieldBytes = Math.max(64, Math.floor(perFieldBytes / 2));
  }

  return null;
}

type TruncatedPageField = {
  text: string;
  original_chars: number;
  returned_chars: number;
  has_more: boolean;
};

function truncatePageField(value: unknown, maxBytes: number): TruncatedPageField | null {
  if (typeof value !== 'string') return null;
  if (byteLength(value) <= maxBytes) {
    return {
      text: value,
      original_chars: value.length,
      returned_chars: value.length,
      has_more: false,
    };
  }

  const markerBytes = byteLength(TRUNCATION_MARKER);
  const prefix = truncateUtf8(value, Math.max(0, maxBytes - markerBytes));
  return {
    text: `${prefix}${TRUNCATION_MARKER}`,
    original_chars: value.length,
    returned_chars: prefix.length,
    has_more: true,
  };
}

function buildGetPageContinuations(
  slug: unknown,
  compiledTruth: TruncatedPageField | null,
  timeline: TruncatedPageField | null,
): Record<string, unknown> {
  if (typeof slug !== 'string' || slug.length === 0) return {};
  const continuations: Record<string, unknown> = {};

  if (compiledTruth?.has_more) {
    continuations.compiled_truth = {
      tool: 'read_context',
      arguments: {
        selectors: [{
          kind: 'compiled_truth',
          slug,
          char_start: compiledTruth.returned_chars,
        }],
        token_budget: 900,
      },
      remaining_chars: compiledTruth.original_chars - compiledTruth.returned_chars,
    };
  }

  if (timeline?.has_more) {
    continuations.timeline = {
      tool: 'read_context',
      arguments: {
        selectors: [{
          kind: 'timeline_range',
          slug,
          char_start: timeline.returned_chars,
        }],
        token_budget: 900,
      },
      remaining_chars: timeline.original_chars - timeline.returned_chars,
    };
  }

  return continuations;
}

function attachMcpTruncationMetadata(
  toolName: string,
  value: unknown,
  originalResponseBytes: number,
  fallback_required: boolean,
): unknown {
  const metadata = {
    truncated: true,
    tool: toolName,
    original_response_bytes: originalResponseBytes,
    hint: mcpTruncationHint(toolName),
    ...(fallback_required ? { fallback_required } : {}),
  };

  if (isRecord(value) && !Array.isArray(value)) {
    return {
      ...value,
      _mbrain_mcp_response: metadata,
    };
  }

  return {
    _mbrain_mcp_response: metadata,
    result: value,
  };
}

function buildFallbackMcpResultText(
  toolName: string,
  rawJson: string,
  rawBytes: number,
  maxResultTextBytes: number,
): string {
  const metadata = {
    truncated: true,
    tool: toolName,
    original_response_bytes: rawBytes,
    fallback: true,
    hint: mcpTruncationHint(toolName),
  };
  const emptyEnvelope = { _mbrain_mcp_response: metadata, partial_json: '' };
  const emptyBytes = byteLength(JSON.stringify(emptyEnvelope));
  let partialBudget = Math.max(0, maxResultTextBytes - emptyBytes - 32);
  let partialJson = truncateUtf8(rawJson, partialBudget);

  while (partialBudget > 0) {
    const text = JSON.stringify({ _mbrain_mcp_response: metadata, partial_json: partialJson });
    if (byteLength(text) <= maxResultTextBytes) return text;
    partialBudget = Math.floor(partialBudget * 0.75);
    partialJson = truncateUtf8(rawJson, partialBudget);
  }

  const minimal = JSON.stringify({ _mbrain_mcp_response: metadata, partial_json: '' });
  if (byteLength(minimal) <= maxResultTextBytes) return minimal;

  return JSON.stringify({
    _mbrain_mcp_response: {
      truncated: true,
      tool: toolName,
      fallback: true,
    },
  });
}

function truncateJsonStrings(value: unknown, maxStringBytes: number): unknown {
  if (typeof value === 'string') {
    if (byteLength(value) <= maxStringBytes) return value;
    const markerBytes = byteLength(TRUNCATION_MARKER);
    return `${truncateUtf8(value, Math.max(0, maxStringBytes - markerBytes))}${TRUNCATION_MARKER}`;
  }

  if (Array.isArray(value)) {
    return value.map(entry => truncateJsonStrings(entry, maxStringBytes));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, truncateJsonStrings(entry, maxStringBytes)]),
    );
  }

  return value;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function mcpTruncationHint(toolName: string): string {
  switch (toolName) {
    case 'get_page':
      return 'Use read_context with a bounded token_budget or a narrower selector to read the remaining page content.';
    case 'read_context':
      return 'Lower token_budget, max_selectors, or include_timeline; follow continuation_selector for additional bounded reads.';
    case 'get_skillpack':
      return 'Request a narrower skillpack section instead of the full document.';
    default:
      return 'Request a narrower result, reduce limits, or raise MBRAIN_MCP_MAX_RESULT_TEXT_BYTES intentionally.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

export async function startMcpServer(engine: BrainEngine | Promise<BrainEngine>) {
  const enginePromise = Promise.resolve(engine);
  enginePromise.catch(() => {
    // Keep startup failures reportable through the MCP request path instead of
    // surfacing as an unhandled promise before the first tool call arrives.
  });
  const server = new Server(
    { name: 'mbrain', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  // Generate tool definitions from operations
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map(operation => operationToMcpTool(operation, {
      compact: shouldCompactMcpToolSchemas(),
    })),
  }));

  // Dispatch tool calls to operation handlers
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    try {
      const resolvedEngine = await enginePromise;
      const ctx: OperationContext = {
        engine: resolvedEngine,
        config: loadConfig() || DEFAULT_RUNTIME_CONFIG,
        logger: {
          info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
          warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
          error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
        },
        dryRun: !!(params?.dry_run),
        scheduleBackground: (description, task) => {
          setTimeout(() => {
            task().catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              process.stderr.write(`[warn] ${description} failed: ${message}\n`);
            });
          }, 0);
        },
      };
      const result = await op.handler(ctx, prepareMcpToolParams(name, params));
      return { content: [{ type: 'text', text: formatMcpToolResult(name, result) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return { content: [{ type: 'text', text: formatMcpToolResult(name, e.toJSON()) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Backward compat: used by `mbrain call` command
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const ctx: OperationContext = {
    engine,
    config: loadConfig() || DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: !!(params?.dry_run),
  };

  return op.handler(ctx, params);
}
