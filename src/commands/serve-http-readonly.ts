import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.ts';
import { createEngine } from '../core/engine-factory.ts';
import { operations, OperationError, type Operation, type OperationContext } from '../core/operations.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { buildToolDefs } from '../mcp/tool-defs.ts';

const READONLY_OPERATION_NAMES = new Set([
  'search',
  'query',
  'get_page',
  'list_pages',
  'get_links',
  'get_backlinks',
  'get_stats',
]);

const MAX_BODY_BYTES = 5_000_000;

interface ServeReadonlyOptions {
  name: string;
  host: string;
  port: number;
  path: string;
  databaseUrl: string;
  tokenFile: string;
  poolSize: number;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface CompactMemoryResult {
  title: string;
  slug?: string;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  source_kind: 'gbrain';
  page_type?: string;
  chunk_source?: string;
}

interface TokenCache {
  mtimeMs: number;
  hashes: Buffer[];
}

let tokenCache: TokenCache | null = null;

function usage(exitCode = 1): never {
  console.error(`Usage: gbrain serve-http-readonly --name <name> --database-url <url> --token-file <path> [--host <ip>] [--port <n>] [--path /mcp] [--pool-size <n>]

Environment fallbacks:
  GBRAIN_DATABASE_URL
  ROCKAWAY_BRAIN_MCP_TOKEN_FILE
  ROCKAWAY_BRAIN_MCP_HOST
  ROCKAWAY_BRAIN_MCP_PORT
  ROCKAWAY_BRAIN_MCP_PATH
`);
  process.exit(exitCode);
}

function takeArg(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

function normalizePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized.replace(/\/+$/, '') || '/mcp';
}

function parseOptions(args: string[]): ServeReadonlyOptions {
  if (args.includes('--help') || args.includes('-h')) usage(0);

  const portRaw = takeArg(args, '--port') || process.env.ROCKAWAY_BRAIN_MCP_PORT || '8787';
  const poolRaw = takeArg(args, '--pool-size') || process.env.ROCKAWAY_BRAIN_MCP_POOL_SIZE || '5';
  const port = Number(portRaw);
  const poolSize = Number(poolRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) usage();
  if (!Number.isInteger(poolSize) || poolSize <= 0 || poolSize > 20) usage();

  const opts = {
    name: takeArg(args, '--name') || process.env.ROCKAWAY_BRAIN_MCP_NAME || 'gbrain-readonly',
    host: takeArg(args, '--host') || process.env.ROCKAWAY_BRAIN_MCP_HOST || '127.0.0.1',
    port,
    path: normalizePath(takeArg(args, '--path') || process.env.ROCKAWAY_BRAIN_MCP_PATH || '/mcp'),
    databaseUrl: takeArg(args, '--database-url') || process.env.GBRAIN_DATABASE_URL || '',
    tokenFile: takeArg(args, '--token-file') || process.env.ROCKAWAY_BRAIN_MCP_TOKEN_FILE || '',
    poolSize,
  };

  if (!opts.databaseUrl) {
    console.error('Missing Postgres database URL. Set --database-url or GBRAIN_DATABASE_URL.');
    process.exit(1);
  }
  if (!opts.tokenFile) {
    console.error('Missing token file. Set --token-file or ROCKAWAY_BRAIN_MCP_TOKEN_FILE.');
    process.exit(1);
  }

  return opts;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function parseTokenLine(line: string): Buffer | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const first = trimmed.split(/\s+/, 1)[0];
  const hashHex = first.startsWith('sha256:') ? first.slice('sha256:'.length) : null;
  if (hashHex) {
    if (!/^[a-f0-9]{64}$/i.test(hashHex)) return null;
    return Buffer.from(hashHex, 'hex');
  }
  return hashToken(first);
}

function loadTokenHashes(tokenFile: string): Buffer[] {
  if (!existsSync(tokenFile)) return [];
  const stat = statSync(tokenFile);
  if (tokenCache && tokenCache.mtimeMs === stat.mtimeMs) return tokenCache.hashes;
  const hashes = readFileSync(tokenFile, 'utf8')
    .split(/\r?\n/)
    .map(parseTokenLine)
    .filter((hash): hash is Buffer => !!hash);
  tokenCache = { mtimeMs: stat.mtimeMs, hashes };
  return hashes;
}

function isAuthorized(req: IncomingMessage, tokenFile: string): 'ok' | 'missing_tokens' | 'unauthorized' {
  const hashes = loadTokenHashes(tokenFile);
  if (hashes.length === 0) return 'missing_tokens';

  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] || '' : header);
  if (!match) return 'unauthorized';
  const presented = hashToken(match[1]);
  return hashes.some(expected =>
    expected.length === presented.length && timingSafeEqual(expected, presented),
  ) ? 'ok' : 'unauthorized';
}

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

function readonlyOperations(): Operation[] {
  return operations.filter(op => READONLY_OPERATION_NAMES.has(op.name));
}

const ORIENTATION_TOOL_DEFS: ToolDef[] = [
  {
    name: 'memory_lookup',
    description: 'GBrain-only compact lookup helper. Use native Rockaway QMD MCP first for semantic recall, then this for canonical GBrain fallback/detail.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company, person, meeting, deal, project, workflow, topic, or CSV-row lookup text.' },
        limit: { type: 'number', description: 'Maximum compact results. Default 8, capped at 25.' },
        detail: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Retrieval depth. Default medium.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'brain_help',
    description: 'Use this when an agent is unsure how to combine native Rockaway QMD recall with this canonical GBrain MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Optional task type, for example csv, company, person, meeting, deal, project, or workflow.' },
      },
      required: [],
    },
  },
];

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function confidenceFromScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.7) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

function brainProfile(name: string) {
  if (name === 'rockaway-ventures') {
    return {
      display: 'Rockaway Ventures brain',
      boundary: 'Rockaway Ventures only. Do not query or infer from Rockaway Q / QAQ unless the user explicitly asks for cross-brain context.',
      gbrainMcp: 'rockaway-ventures',
      gbrainEndpoint: 'http://100.102.180.108:8789/rockaway-ventures/mcp',
      qmdMcp: 'rockaway-ventures-qmd',
      qmdEndpoint: 'https://clawdbot--mac-mini.taild9e247.ts.net:8445/mcp',
      qmdCollection: 'rockaway-ventures',
      examples: [
        'QMD recall: query collection rockaway-ventures for "Acme company founder investment notes"',
        'GBrain expansion: get_page({ slug: "<best slug from QMD or memory_lookup>", fuzzy: true })',
        'CSV row lookup: query="company=Acme person=Jane Example topic=Series A date=2026-06-09"',
      ],
    };
  }
  return {
    display: 'Rockaway Q / QAQ brain',
    boundary: 'Rockaway Q / QAQ only. Do not query or infer from Rockaway Ventures unless the user explicitly asks for cross-brain context.',
    gbrainMcp: 'rockaway-q',
    gbrainEndpoint: 'http://100.102.180.108:8788/rockaway-q/mcp',
    qmdMcp: 'rockaway-q-qmd',
    qmdEndpoint: 'https://clawdbot--mac-mini.taild9e247.ts.net:8444/mcp',
    qmdCollection: 'rockaway-q',
    examples: [
      'QMD recall: query collection rockaway-q for "Acme customer project latest context blockers"',
      'GBrain expansion: get_page({ slug: "<best slug from QMD or memory_lookup>", fuzzy: true })',
      'CSV row lookup: query="customer=Acme person=Jane Example topic=onboarding workflow date=2026-06-09"',
    ],
  };
}

function normalizeGbrainMemoryResult(raw: unknown): CompactMemoryResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = raw as Record<string, unknown>;
  const slug = typeof result.slug === 'string' ? result.slug : undefined;
  const title = typeof result.title === 'string' ? result.title : slug;
  if (!slug || !title) return null;
  const score = typeof result.score === 'number' ? Math.round(result.score * 100) / 100 : 0;
  return {
    title,
    slug,
    snippet: typeof result.chunk_text === 'string' ? result.chunk_text.slice(0, 1_200) : '',
    confidence: confidenceFromScore(score),
    score,
    source_kind: 'gbrain',
    page_type: typeof result.type === 'string' ? result.type : undefined,
    chunk_source: typeof result.chunk_source === 'string' ? result.chunk_source : undefined,
  };
}

function uniqueMemoryResults(results: CompactMemoryResult[], limit: number): CompactMemoryResult[] {
  const seen = new Set<string>();
  const out: CompactMemoryResult[] = [];
  for (const result of results) {
    const key = result.slug || result.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}

async function gbrainMemoryLookup(
  engine: BrainEngine,
  config: GBrainConfig,
  queryText: string,
  limit: number,
  detail: string,
): Promise<CompactMemoryResult[]> {
  const queryOp = operations.find(op => op.name === 'query');
  if (!queryOp) return [];
  const ctx: OperationContext = {
    engine,
    config,
    logger: {
      info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
    },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
  const rawResults = await queryOp.handler(ctx, {
    query: queryText,
    limit,
    expand: detail !== 'low',
    detail: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
  });
  if (!Array.isArray(rawResults)) return [];
  return rawResults.map(normalizeGbrainMemoryResult).filter((result): result is CompactMemoryResult => !!result);
}

async function handleOrientationTool(
  engine: BrainEngine,
  config: GBrainConfig,
  name: string,
  toolName: string,
  params: Record<string, unknown>,
) {
  const profile = brainProfile(name);

  if (toolName === 'brain_help') {
    const task = typeof params.task === 'string' && params.task.trim() ? params.task.trim() : 'general lookup';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          brain: profile.display,
          access: 'read-only',
          task,
          boundary: profile.boundary,
          retrieval_order: [
            `Use native QMD MCP ${profile.qmdMcp} first: status -> query(collections: ["${profile.qmdCollection}"]) -> get(best result).`,
            `Use GBrain MCP ${profile.gbrainMcp} second for canonical expansion: get_page, get_links, get_backlinks, get_stats.`,
            'Use memory_lookup on this GBrain endpoint only as a compact GBrain fallback when native QMD is unavailable or weak.',
          ],
          qmd_mcp: {
            name: profile.qmdMcp,
            endpoint: profile.qmdEndpoint,
            collection: profile.qmdCollection,
            tools: ['status', 'query', 'get', 'multi_get'],
          },
          gbrain_mcp: {
            name: profile.gbrainMcp,
            endpoint: profile.gbrainEndpoint,
            tools: ['memory_lookup', 'search', 'query', 'get_page', 'list_pages', 'get_links', 'get_backlinks', 'get_stats'],
          },
          csv_recipe: {
            input: 'For each row, extract company/person/topic/date or the closest available fields.',
            query_template: 'company=<company> person=<person> topic=<topic> date=<date>',
            output_columns: ['row_id', 'query', 'qmd_paths', 'gbrain_pages', 'confidence', 'summary', 'recommended_next_step'],
          },
          examples: profile.examples,
        }, null, 2),
      }],
    };
  }

  if (toolName === 'memory_lookup') {
    if (typeof params.query !== 'string' || !params.query.trim()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: 'query must be a non-empty string' }, null, 2) }], isError: true };
    }
    const queryText = params.query.trim();
    const limit = clampNumber(params.limit, 8, 1, 25);
    const detail = params.detail === 'low' || params.detail === 'high' ? params.detail : 'medium';
    const results = await gbrainMemoryLookup(engine, config, queryText, limit, detail);
    const compact = uniqueMemoryResults(results, limit);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          brain: profile.display,
          boundary: profile.boundary,
          query: queryText,
          detail,
          source: 'gbrain',
          result_count: compact.length,
          results: compact,
          recommended_next_step: compact.some(result => result.slug)
            ? 'Call get_page with the best high/medium confidence slug when canonical detail is needed.'
            : `Use native QMD MCP ${profile.qmdMcp} for semantic recall if this GBrain fallback is weak.`,
          warnings: ['memory_lookup is now GBrain-only; native QMD recall is exposed through the separate team QMD MCP.'],
        }, null, 2),
      }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown orientation tool: ${toolName}` }, null, 2) }],
    isError: true,
  };
}

function makeMcpServer(engine: BrainEngine, config: GBrainConfig, name: string): Server {
  const allowed = readonlyOperations();
  const byName = new Map(allowed.map(op => [op.name, op]));
  const orientationToolNames = new Set(ORIENTATION_TOOL_DEFS.map(tool => tool.name));
  const server = new Server(
    { name, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ORIENTATION_TOOL_DEFS, ...buildToolDefs(allowed)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name: toolName, arguments: params } = request.params;
    const safeParams = params || {};
    if (orientationToolNames.has(toolName)) {
      return handleOrientationTool(engine, config, name, toolName, safeParams);
    }

    const op = byName.get(toolName);
    if (!op) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', message: `Tool is not available on this read-only endpoint: ${toolName}` }, null, 2) }],
        isError: true,
      };
    }

    const validationError = validateParams(op, safeParams);
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    const ctx: OperationContext = {
      engine,
      config,
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    };

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

  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

export async function runServeHttpReadonly(args: string[]): Promise<void> {
  const opts = parseOptions(args);
  const config: GBrainConfig = { engine: 'postgres', database_url: opts.databaseUrl };
  const engine = await createEngine({ engine: 'postgres', database_url: opts.databaseUrl });
  await engine.connect({ engine: 'postgres', database_url: opts.databaseUrl, poolSize: opts.poolSize } as Parameters<typeof engine.connect>[0]);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${opts.host}:${opts.port}`}`);
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok', name: opts.name, path: opts.path });
        return;
      }
      if (url.pathname !== opts.path) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const auth = isAuthorized(req, opts.tokenFile);
      if (auth === 'missing_tokens') {
        sendJson(res, 503, { error: 'missing_tokens', message: `No token hashes configured in ${opts.tokenFile}` });
        return;
      }
      if (auth === 'unauthorized') {
        sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        return;
      }

      const body = await readBody(req);
      const mcpServer = makeMcpServer(engine, config, opts.name);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      res.on('close', () => {
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
      });
      await transport.handleRequest(req, res, body);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message }, id: null });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, resolve);
  });

  process.stderr.write(`[gbrain] ${opts.name} read-only MCP listening on http://${opts.host}:${opts.port}${opts.path}\n`);

  const shutdown = async () => {
    process.stderr.write(`[gbrain] shutting down ${opts.name} read-only MCP\n`);
    httpServer.close();
    await engine.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
