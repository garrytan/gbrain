import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations as defaultOperations, OperationError, MCP_INSTRUCTIONS } from '../core/operations.ts';
import type { Operation, OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import {
  byteLength as utf8ByteLength,
  scalarLength,
  truncateUtf8ByScalars,
} from '../core/text-offsets.ts';
import { VERSION } from '../version.ts';
import { operationToMcpTool } from './tool-schema.ts';
import {
  BudgetedStdioServerTransport,
  DEFAULT_MCP_MAX_STDIO_FRAME_BYTES,
} from './stdio-frame-budget.ts';

export const DEFAULT_MCP_MAX_RESULT_TEXT_BYTES = 24_000;
export const DEFAULT_MCP_GET_PAGE_CHAR_LIMIT = 6_000;
const MIN_MCP_MAX_RESULT_TEXT_BYTES = 512;
const MCP_RESULT_TEXT_FRAME_OVERHEAD_BYTES = 1_024;
const TRUNCATION_MARKER = '\n\n[truncated by mbrain MCP response guard]';

export type FormatMcpToolResultOptions = {
  maxResultTextBytes?: number;
};

export type McpToolCatalogOptions = {
  compact?: boolean;
};

export type McpToolCatalogProvider = {
  getTools(options?: McpToolCatalogOptions): ReturnType<typeof operationToMcpTool>[];
};

export type McpResultTextBudgetForFinalFrameOptions = {
  maxFrameBytes?: number;
};

export type McpToolExecutionClass = 'mutating' | 'heavy_read' | 'light';

export type McpToolExecutionLimiterOptions = {
  heavyReadConcurrency?: number;
};

export type McpToolExecutionLimiter = {
  run<T>(operation: Operation, task: () => Promise<T>): Promise<T>;
};

const DEFAULT_MCP_HEAVY_READ_CONCURRENCY = 2;
const HEAVY_READ_TOOL_NAMES = new Set([
  'get_page',
  'get_raw_data',
  'get_chunks',
  'search',
  'query',
  'get_note_structural_neighbors',
  'find_note_structural_path',
  'get_context_map_entry',
  'get_context_map_report',
  'get_context_map_explanation',
  'query_context_map',
  'find_context_map_path',
  'get_context_atlas_entry',
  'get_context_atlas_overview',
  'get_context_atlas_report',
  'get_atlas_orientation_card',
  'get_atlas_orientation_bundle',
  'get_broad_synthesis_route',
  'get_precision_lookup_route',
  'get_mixed_scope_bridge',
  'get_mixed_scope_disclosure',
  'get_personal_profile_lookup_route',
  'get_personal_episode_lookup_route',
  'select_retrieval_route',
  'plan_retrieval_request',
  'retrieve_context',
  'read_context',
  'reverify_code_claims',
  'get_workspace_system_card',
  'get_workspace_project_card',
  'get_workspace_orientation_bundle',
  'get_workspace_corpus_card',
  'get_skillpack',
]);

export function createMcpToolCatalogProvider(
  operations: Operation[] = defaultOperations,
): McpToolCatalogProvider {
  let compactTools: ReturnType<typeof operationToMcpTool>[] | undefined;
  let fullTools: ReturnType<typeof operationToMcpTool>[] | undefined;

  return {
    getTools({ compact = false }: McpToolCatalogOptions = {}) {
      if (compact) {
        compactTools ??= operations.map(operation => operationToMcpTool(operation, { compact: true }));
        return compactTools;
      }

      fullTools ??= operations.map(operation => operationToMcpTool(operation, { compact: false }));
      return fullTools;
    },
  };
}

export function classifyMcpToolExecution(operation: Operation): McpToolExecutionClass {
  if (operation.mutating === true) return 'mutating';
  if (HEAVY_READ_TOOL_NAMES.has(operation.name)) return 'heavy_read';
  return 'light';
}

export function createMcpToolExecutionLimiter(
  options: McpToolExecutionLimiterOptions = {},
): McpToolExecutionLimiter {
  const mutatingQueue = new McpConcurrencyQueue(1);
  const heavyReadQueue = new McpConcurrencyQueue(
    normalizeMcpConcurrencyLimit(
      options.heavyReadConcurrency ?? parseConfiguredMcpHeavyReadConcurrency(),
      DEFAULT_MCP_HEAVY_READ_CONCURRENCY,
    ),
  );

  return {
    run<T>(operation: Operation, task: () => Promise<T>): Promise<T> {
      switch (classifyMcpToolExecution(operation)) {
        case 'mutating':
          return mutatingQueue.run(task);
        case 'heavy_read':
          return heavyReadQueue.run(task);
        case 'light':
          return task();
      }
    },
  };
}

class McpConcurrencyQueue {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active += 1;
        task().then(resolve, reject).finally(() => {
          this.active -= 1;
          this.drain();
        });
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.queue.shift();
      if (!next) return;
      next();
    }
  }
}

function parseConfiguredMcpHeavyReadConcurrency(): number {
  const raw = process.env.MBRAIN_MCP_HEAVY_READ_CONCURRENCY;
  if (!raw) return DEFAULT_MCP_HEAVY_READ_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MCP_HEAVY_READ_CONCURRENCY;
}

function normalizeMcpConcurrencyLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

export function mcpResultTextBudgetForFinalFrame(
  options: McpResultTextBudgetForFinalFrameOptions = {},
): number {
  const maxFrameBytes = normalizeMcpMaxStdioFrameBytes(
    options.maxFrameBytes ?? parseConfiguredMcpMaxStdioFrameBytes(),
  );
  const availableForText = Math.max(
    MIN_MCP_MAX_RESULT_TEXT_BYTES,
    maxFrameBytes - MCP_RESULT_TEXT_FRAME_OVERHEAD_BYTES,
  );
  return Math.max(MIN_MCP_MAX_RESULT_TEXT_BYTES, Math.floor(availableForText / 2));
}

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

function parseConfiguredMcpMaxStdioFrameBytes(): number {
  const raw = process.env.MBRAIN_MCP_MAX_STDIO_FRAME_BYTES;
  if (!raw) return DEFAULT_MCP_MAX_STDIO_FRAME_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MCP_MAX_STDIO_FRAME_BYTES;
}

function normalizeMcpMaxStdioFrameBytes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MCP_MAX_STDIO_FRAME_BYTES;
  return Math.max(MIN_MCP_MAX_RESULT_TEXT_BYTES, Math.floor(value));
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
    const continuations = buildGetPageContinuations(page.slug, page.content_hash, compiledTruth, timeline, {
      compiled_truth: getContentWindowMetadata(page.content_window, 'compiled_truth'),
      timeline: getContentWindowMetadata(page.content_window, 'timeline'),
    });
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

type GuardedPageWindowMetadata = {
  char_start: number;
  total_chars: number;
};

function truncatePageField(value: unknown, maxBytes: number): TruncatedPageField | null {
  if (typeof value !== 'string') return null;
  if (byteLength(value) <= maxBytes) {
    return {
      text: value,
      original_chars: scalarLength(value),
      returned_chars: scalarLength(value),
      has_more: false,
    };
  }

  const markerBytes = byteLength(TRUNCATION_MARKER);
  const prefix = truncateUtf8(value, Math.max(0, maxBytes - markerBytes));
  return {
    text: `${prefix}${TRUNCATION_MARKER}`,
    original_chars: scalarLength(value),
    returned_chars: scalarLength(prefix),
    has_more: true,
  };
}

function buildGetPageContinuations(
  slug: unknown,
  contentHash: unknown,
  compiledTruth: TruncatedPageField | null,
  timeline: TruncatedPageField | null,
  windows: {
    compiled_truth?: GuardedPageWindowMetadata;
    timeline?: GuardedPageWindowMetadata;
  } = {},
): Record<string, unknown> {
  if (typeof slug !== 'string' || slug.length === 0) return {};
  const continuations: Record<string, unknown> = {};

  const compiledContinuation = continuationWindow(compiledTruth, windows.compiled_truth);
  if (compiledContinuation) {
    continuations.compiled_truth = {
      tool: 'read_context',
      arguments: {
        selectors: [{
          kind: 'compiled_truth',
          slug,
          char_start: compiledContinuation.next_char_start,
          ...(typeof contentHash === 'string' && contentHash.length > 0 ? { content_hash: contentHash } : {}),
        }],
        token_budget: 900,
      },
      remaining_chars: compiledContinuation.remaining_chars,
    };
  }

  const timelineContinuation = continuationWindow(timeline, windows.timeline);
  if (timelineContinuation) {
    continuations.timeline = {
      tool: 'read_context',
      arguments: {
        selectors: [{
          kind: 'timeline_range',
          slug,
          char_start: timelineContinuation.next_char_start,
          ...(typeof contentHash === 'string' && contentHash.length > 0 ? { content_hash: contentHash } : {}),
        }],
        token_budget: 900,
      },
      remaining_chars: timelineContinuation.remaining_chars,
    };
  }

  return continuations;
}

function getContentWindowMetadata(value: unknown, field: 'compiled_truth' | 'timeline'): GuardedPageWindowMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const fieldWindow = value[field];
  if (!isRecord(fieldWindow)) return undefined;
  const charStart = fieldWindow.char_start;
  const totalChars = fieldWindow.total_chars;
  if (typeof charStart !== 'number' || !Number.isFinite(charStart) || charStart < 0) return undefined;
  if (typeof totalChars !== 'number' || !Number.isFinite(totalChars) || totalChars < 0) return undefined;
  return {
    char_start: Math.floor(charStart),
    total_chars: Math.floor(totalChars),
  };
}

function continuationWindow(
  field: TruncatedPageField | null,
  window: GuardedPageWindowMetadata | undefined,
): { next_char_start: number; remaining_chars: number } | undefined {
  if (!field) return undefined;
  const charStart = window?.char_start ?? 0;
  const totalChars = window?.total_chars ?? field.original_chars;
  const nextCharStart = charStart + field.returned_chars;
  if (nextCharStart >= totalChars) return undefined;
  return {
    next_char_start: nextCharStart,
    remaining_chars: totalChars - nextCharStart,
  };
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
  return truncateUtf8ByScalars(text, maxBytes);
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
      return 'Request a narrower result, reduce limits, or intentionally raise MBRAIN_MCP_MAX_RESULT_TEXT_BYTES for default MCP result text budgeting or MBRAIN_MCP_MAX_STDIO_FRAME_BYTES for MCP stdio.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function byteLength(text: string): number {
  return utf8ByteLength(text);
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
  const toolCatalog = createMcpToolCatalogProvider();
  const toolExecutionLimiter = createMcpToolExecutionLimiter();

  // Generate tool definitions from operations
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolCatalog.getTools({ compact: shouldCompactMcpToolSchemas() }),
  }));

  // Dispatch tool calls to operation handlers
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = defaultOperations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    try {
      const result = await toolExecutionLimiter.run(op, async () => {
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
        };
        return op.handler(ctx, prepareMcpToolParams(name, params));
      });
      return {
        content: [{
          type: 'text',
          text: formatMcpToolResult(name, result, {
            maxResultTextBytes: mcpResultTextBudgetForFinalFrame(),
          }),
        }],
      };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return {
          content: [{
            type: 'text',
            text: formatMcpToolResult(name, e.toJSON(), {
              maxResultTextBytes: mcpResultTextBudgetForFinalFrame(),
            }),
          }],
          isError: true,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  const transport = new BudgetedStdioServerTransport();
  await server.connect(transport);
}

// Backward compat: used by `mbrain call` command
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = defaultOperations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const ctx: OperationContext = {
    engine,
    config: loadConfig() || DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: !!(params?.dry_run),
  };

  return op.handler(ctx, params);
}
