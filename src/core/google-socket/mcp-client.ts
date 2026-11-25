/**
 * A small stateless client for Google's Workspace MCP servers on protocol
 * 2026-07-28 (`@modelcontextprotocol/sdk` 1.32.2 does not speak it). Every
 * request is one JSON-RPC POST carrying `MCP-Protocol-Version` and
 * `Mcp-Method` headers, which Google requires (-32020 without them).
 *
 * A tool call can come back `resultType: "input_required"` with Google's
 * approval prompt (a form elicitation) and an opaque `requestState`; the call
 * is answered by repeating it with `inputResponses` and that state. This
 * client never chooses an answer: the broker passes one only with an owner's
 * verdict.
 */
import { GOOGLE_MCP_PROTOCOL_VERSION, type GoogleServer } from './protocol.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpTool { name: string; description?: string; inputSchema?: unknown }

export interface PendingPrompt {
  message: string;
  choices: string[];
  /** The form field the choice goes in, and the key of the input request it answers. */
  field: string;
  inputKey: string;
  requestState: unknown;
}

export type ToolCallOutcome =
  | { kind: 'complete'; result: Record<string, unknown>; isError: boolean; text: string }
  | { kind: 'input_required'; prompt: PendingPrompt };

/** Thrown when the request may have reached Google but no usable answer came back. */
export class McpTransportError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly retryAfterS?: number) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export const googleMcpUrl = (server: GoogleServer): string => `https://${server}mcp.googleapis.com/mcp/v1`;

let nextId = 1;

async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('text/event-stream')
    ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).pop() ?? ''
    : text;
  try { return JSON.parse(payload) as Record<string, unknown>; }
  catch { throw new McpTransportError(`Google answered HTTP ${res.status} with a body that is not JSON-RPC`, res.status); }
}

function promptFrom(result: Record<string, unknown>): PendingPrompt | null {
  const requests = result.inputRequests;
  if (typeof requests !== 'object' || requests === null) return null;
  for (const [inputKey, req] of Object.entries(requests as Record<string, unknown>)) {
    const params = (req as { params?: Record<string, unknown> })?.params ?? {};
    const props = ((params.requestedSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<string, { enum?: unknown; oneOf?: unknown }>;
    for (const [field, schema] of Object.entries(props)) {
      const choices = Array.isArray(schema.enum) ? schema.enum
        : Array.isArray(schema.oneOf) ? (schema.oneOf as Array<{ const?: unknown }>).map(o => o.const) : [];
      const named = choices.filter((c): c is string => typeof c === 'string');
      if (named.length > 0) return { message: String(params.message ?? ''), choices: named, field, inputKey, requestState: result.requestState };
    }
  }
  return null;
}

export class GoogleMcpClient {
  constructor(private readonly fetchImpl: FetchImpl = fetch, private readonly urlFor: (server: GoogleServer) => string = googleMcpUrl) {}

  private async rpc(server: GoogleServer, method: string, params: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    const id = nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.urlFor(server), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': GOOGLE_MCP_PROTOCOL_VERSION,
          'mcp-method': method,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new McpTransportError(`no answer from ${server}mcp.googleapis.com (${(error as Error).name})`, null);
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new McpTransportError('Google is throttling this project (HTTP 429)', 429, Number.isFinite(after) && after > 0 ? after : 60);
    }
    const body = await readJsonRpc(res);
    const error = body.error as { code?: number; message?: string } | undefined;
    if (error) throw new McpTransportError(`Google refused ${method}: ${error.code ?? '?'} ${error.message ?? ''}`.trim(), res.status);
    if (!res.ok) throw new McpTransportError(`Google answered ${method} with HTTP ${res.status}`, res.status);
    if (body.id !== id || !body.result || typeof body.result !== 'object') throw new McpTransportError(`Google answered ${method} without a matching result; the call may have taken effect`, null);
    return body.result as Record<string, unknown>;
  }

  /** Google serves tools/list without a token. */
  async listTools(server: GoogleServer): Promise<McpTool[]> {
    const result = await this.rpc(server, 'tools/list', {});
    return Array.isArray(result.tools) ? (result.tools as McpTool[]) : [];
  }

  async callTool(server: GoogleServer, token: string, name: string, args: Record<string, unknown>,
    answer?: { prompt: PendingPrompt; choice: string }): Promise<ToolCallOutcome> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (answer) {
      params.inputResponses = { [answer.prompt.inputKey]: { action: 'accept', content: { [answer.prompt.field]: answer.choice } } };
      params.requestState = answer.prompt.requestState;
    }
    const result = await this.rpc(server, 'tools/call', params, token);
    if (result.resultType === 'input_required') {
      const prompt = promptFrom(result);
      if (!prompt) throw new McpTransportError('Google asked for input in a shape this broker does not read', 200);
      return { kind: 'input_required', prompt };
    }
    const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
    return { kind: 'complete', result, isError: result.isError === true, text: content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') };
  }
}

/** Tells Google's terminal refusals apart from an ordinary tool failure. */
export function toolErrorReason(text: string): 'user_denied' | 'admin_policy' | 'challenge_pending' | 'tool_failed' {
  if (/\b(denied|declined|rejected)\b.*\buser\b|\buser\b.*\b(denied|declined|rejected)\b/i.test(text)) return 'user_denied';
  if (/\badmin(istrator)?\b|\bpolicy\b/i.test(text)) return 'admin_policy';
  if (/\bchallenge\b|\bverif(y|ication)\b/i.test(text)) return 'challenge_pending';
  return 'tool_failed';
}
