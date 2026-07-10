/**
 * AI SDK LanguageModelV2 adapter for OpenCode's persistent local server.
 *
 * OpenCode owns ChatGPT OAuth and token refresh. The adapter uses OpenCode only
 * as a structured model transport: every OpenCode session denies all tools,
 * and structured tool requests are returned to GBrain's gateway for audited
 * execution. This preserves GBrain's allow-lists, job receipts, and replay
 * semantics instead of letting a second agent write to the brain out of band.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
} from '@ai-sdk/provider';
import { AIConfigError, AITransientError } from '../errors.ts';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4097';
const DEFAULT_USERNAME = 'opencode';
const DEFAULT_PROVIDER_ID = 'openai';
const DEFAULT_AGENT = 'gbrain';
const CLEAN_CWD = join(tmpdir(), 'gbrain-opencode-server');

export interface OpenCodeServerOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  providerId?: string;
  agent?: string;
  directory?: string;
  fetch?: typeof globalThis.fetch;
}

interface OpenCodeStructuredResult {
  text: string;
  tool_calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

interface OpenCodeMessageResponse {
  info?: {
    structured?: unknown;
    error?: unknown;
    tokens?: { input?: number; output?: number; total?: number };
  };
  parts?: Array<{ type?: string; text?: string }>;
}

function normalizeModel(model: string): string {
  const prefix = 'opencode-server:';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Render the AI SDK conversation into one deterministic OpenCode prompt. */
export function renderOpenCodePrompt(prompt: LanguageModelV2Prompt): {
  systemText: string;
  conversationText: string;
} {
  const systemParts: string[] = [];
  const conversation: string[] = [];

  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      const text = msg.content
        .map(part => part.type === 'text' ? part.text : `[file ${part.mediaType ?? 'unknown'}]`)
        .join('\n');
      conversation.push(`User: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      const text = msg.content.map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'reasoning') return '';
        if (part.type === 'tool-call') return `[tool_use ${part.toolName}(${part.input})]`;
        if (part.type === 'tool-result') return `[tool_result ${outputToText(part.output)}]`;
        return '';
      }).filter(Boolean).join('\n');
      if (text) conversation.push(`Assistant: ${text}`);
      continue;
    }
    if (msg.role === 'tool') {
      const text = msg.content
        .map(part => `[tool_result ${outputToText(part.output)}]`)
        .join('\n');
      conversation.push(`User: ${text}`);
    }
  }

  return { systemText: systemParts.join('\n\n'), conversationText: conversation.join('\n\n') };
}

function functionTools(
  tools: ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool> | undefined,
): LanguageModelV2FunctionTool[] {
  return (tools ?? []).filter((tool): tool is LanguageModelV2FunctionTool => tool.type === 'function');
}

function toolInstructions(tools: LanguageModelV2FunctionTool[]): string {
  if (tools.length === 0) {
    return 'No tools are available. Return the final answer in text and an empty tool_calls array.';
  }
  const specs = tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  return [
    'GBrain owns tool execution. Do not use any OpenCode tools.',
    'Return only one JSON object with exactly these fields: text (string) and tool_calls (array).',
    'If a GBrain tool is required, return it in tool_calls and leave text empty.',
    'If the task is complete, return prose in text and an empty tool_calls array.',
    'Available GBrain tools:',
    JSON.stringify(specs),
  ].join('\n\n');
}

function outputSchema(tools: LanguageModelV2FunctionTool[]): Record<string, unknown> {
  const names = tools.map(tool => tool.name);
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      tool_calls: {
        type: 'array',
        ...(names.length === 0 ? { maxItems: 0 } : {}),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: names.length > 0 ? { type: 'string', enum: names } : { type: 'string' },
            input: { type: 'object', additionalProperties: true },
          },
          required: ['id', 'name', 'input'],
          additionalProperties: false,
        },
      },
    },
    required: ['text', 'tool_calls'],
    additionalProperties: false,
  };
}

function parseStructuredResult(
  payload: OpenCodeMessageResponse,
  allowPlainText = false,
): OpenCodeStructuredResult {
  let value = payload.info?.structured;
  let rawText = '';
  if (!value) {
    rawText = payload.parts?.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim() ?? '';
    let text = rawText;
    if (text) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) text = text.slice(firstBrace, lastBrace + 1);
      try { value = JSON.parse(text); } catch { /* handled below */ }
    }
  }

  if (!value || typeof value !== 'object') {
    if (allowPlainText && rawText) return { text: rawText, tool_calls: [] };
    throw new AITransientError('OpenCode server returned no structured response.');
  }
  const obj = value as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text : '';
  if (!Array.isArray(obj.tool_calls)) {
    throw new AITransientError('OpenCode structured response omitted tool_calls.');
  }
  const toolCalls = obj.tool_calls.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AITransientError(`OpenCode returned malformed tool call at index ${index}.`);
    }
    const call = entry as Record<string, unknown>;
    if (typeof call.name !== 'string' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
      throw new AITransientError(`OpenCode returned malformed tool call at index ${index}.`);
    }
    return {
      id: typeof call.id === 'string' && call.id ? call.id : `toolu_opencode_${index}`,
      name: call.name,
      input: call.input as Record<string, unknown>,
    };
  });
  return { text, tool_calls: toolCalls };
}

export class OpenCodeServerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'opencode-server';
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly providerId: string;
  private readonly agent: string;
  private readonly directory: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(modelId: string, options: OpenCodeServerOptions = {}) {
    this.modelId = normalizeModel(modelId);
    this.baseUrl = (options.baseUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, '');
    this.username = options.username ?? DEFAULT_USERNAME;
    this.password = options.password ?? '';
    this.providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
    this.agent = options.agent ?? DEFAULT_AGENT;
    this.directory = options.directory ?? CLEAN_CWD;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    mkdirSync(this.directory, { recursive: true });
    try { new URL(this.baseUrl); } catch {
      throw new AIConfigError(`Invalid OpenCode server URL: ${this.baseUrl}`);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    }
    return headers;
  }

  private isStructuredOutputError(payload: OpenCodeMessageResponse): boolean {
    const error = payload.info?.error;
    return Boolean(
      error &&
      typeof error === 'object' &&
      (error as Record<string, unknown>).name === 'StructuredOutputError',
    );
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AITransientError(`OpenCode server request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.ok) return response;
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    const message = `OpenCode server HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new AIConfigError(message, 'Check the OpenCode server URL, password, and ChatGPT OAuth login.');
    }
    throw new AITransientError(message);
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
    warnings: never[];
  }> {
    const tools = functionTools(options.tools);
    const knownToolNames = new Set(tools.map(tool => tool.name));
    const { systemText, conversationText } = renderOpenCodePrompt(options.prompt);
    const directory = encodeURIComponent(this.directory);
    let sessionId: string | null = null;

    try {
      const sessionResponse = await this.request(`/session?directory=${directory}`, {
        method: 'POST',
        body: JSON.stringify({
          title: `GBrain ${this.modelId}`,
          model: { id: this.modelId, providerID: this.providerId },
          permission: [{ permission: '*', pattern: '*', action: 'deny' }],
        }),
      }, options.abortSignal);
      const session = await sessionResponse.json() as { id?: string };
      if (!session.id) throw new AITransientError('OpenCode server did not return a session id.');
      sessionId = session.id;

      const messagePath = `/session/${encodeURIComponent(sessionId)}/message?directory=${directory}`;
      const baseMessage = {
        model: { providerID: this.providerId, modelID: this.modelId },
        agent: this.agent,
        system: [systemText, toolInstructions(tools)].filter(Boolean).join('\n\n'),
        parts: [{ type: 'text', text: conversationText }],
      };
      let response = await this.request(messagePath, {
        method: 'POST',
        body: JSON.stringify({
          ...baseMessage,
          format: { type: 'json_schema', schema: outputSchema(tools), retryCount: 2 },
        }),
      }, options.abortSignal);
      let payload = await response.json() as OpenCodeMessageResponse;
      let retryUsage: { input?: number; output?: number; total?: number } | undefined;
      if (this.isStructuredOutputError(payload)) {
        retryUsage = payload.info?.tokens;
        response = await this.request(messagePath, {
          method: 'POST',
          body: JSON.stringify({
            ...baseMessage,
            format: { type: 'text' },
            parts: [{
              type: 'text',
              text: `${conversationText}\n\nIMPORTANT: Return only the required JSON object. Do not return prose or markdown outside it.`,
            }],
          }),
        }, options.abortSignal);
        payload = await response.json() as OpenCodeMessageResponse;
      }
      if (payload.info?.error) {
        throw new AITransientError(`OpenCode assistant error: ${JSON.stringify(payload.info.error).slice(0, 500)}`);
      }
      // Plain text is safe only when GBrain offered no tools. Tool-capable turns
      // must retain the validated JSON boundary so OpenCode cannot bypass the
      // gateway's tool allowlist or argument validation.
      const result = parseStructuredResult(payload, tools.length === 0);
      for (const call of result.tool_calls) {
        if (!knownToolNames.has(call.name)) {
          throw new AITransientError(`OpenCode requested unknown GBrain tool "${call.name}".`);
        }
      }

      const content: LanguageModelV2Content[] = [];
      if (result.text) content.push({ type: 'text', text: result.text });
      for (const call of result.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: JSON.stringify(call.input),
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });

      const inputTokens = (payload.info?.tokens?.input ?? 0) + (retryUsage?.input ?? 0);
      const outputTokens = (payload.info?.tokens?.output ?? 0) + (retryUsage?.output ?? 0);
      const totalTokens = (payload.info?.tokens?.total ?? 0) + (retryUsage?.total ?? 0) ||
        (inputTokens + outputTokens || undefined);
      return {
        content,
        finishReason: result.tool_calls.length > 0 ? 'tool-calls' : 'stop',
        usage: { inputTokens, outputTokens, totalTokens },
        warnings: [],
      };
    } finally {
      if (sessionId) {
        await this.request(`/session/${encodeURIComponent(sessionId)}?directory=${directory}`, {
          method: 'DELETE',
        }, AbortSignal.timeout(5_000)).catch(() => {});
      }
    }
  }

  async doStream(): Promise<never> {
    throw new Error('OpenCode server adapter does not support streaming; use doGenerate.');
  }
}
