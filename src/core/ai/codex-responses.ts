import type { ChatBlock, ChatMessage, ChatOpts, ChatResult, ChatToolDef } from './gateway.ts';
import type { AIGatewayConfig } from './types.ts';
import { AIConfigError, AITransientError } from './errors.ts';
import { codexRequestHeaders, resolveCodexRuntimeCredentials } from './codex-oauth.ts';

interface CodexResponsesItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  call_id?: string;
  id?: string;
  arguments?: unknown;
  input?: unknown;
  status?: string;
}

interface CodexStreamEvent {
  type?: string;
  response?: unknown;
  item?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function messageTextContent(text: string, role: 'user' | 'assistant'): Record<string, unknown> {
  return {
    role,
    content: [
      {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      },
    ],
  };
}

function systemMessageText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content.trim();
  return msg.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

function codexInstructions(opts: ChatOpts): string {
  const parts: string[] = [];
  if (opts.system?.trim()) parts.push(opts.system.trim());
  for (const msg of opts.messages) {
    if (msg.role !== 'system') continue;
    const text = systemMessageText(msg);
    if (text) parts.push(text);
  }
  return parts.join('\n\n') || 'You are a helpful assistant.';
}

function chatBlocksToCodexInput(blocks: ChatBlock[], role: ChatMessage['role']): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (text) {
    const messageRole = role === 'assistant' ? 'assistant' : 'user';
    items.push(messageTextContent(text, messageRole));
  }

  if (role === 'assistant') {
    for (const block of blocks) {
      if (block.type !== 'tool-call') continue;
      items.push({
        type: 'function_call',
        call_id: block.toolCallId,
        name: block.toolName,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      });
    }
  } else {
    for (const block of blocks) {
      if (block.type !== 'tool-result') continue;
      items.push({
        type: 'function_call_output',
        call_id: block.toolCallId,
        output: stringifyToolOutput(block.output),
      });
    }
  }

  return items;
}

export function chatMessagesToCodexResponsesInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        input.push(messageTextContent(msg.content, role));
      }
      continue;
    }
    input.push(...chatBlocksToCodexInput(msg.content, msg.role));
  }
  return input;
}

function codexTools(tools: ChatToolDef[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: tool.inputSchema,
  }));
}

function extractMessageText(item: CodexResponsesItem): string {
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) continue;
    const type = rec.type;
    const text = rec.text;
    if ((type === 'output_text' || type === 'text') && typeof text === 'string') {
      parts.push(text);
    }
  }
  return parts.join('');
}

function normalizeCodexOutput(payload: Record<string, unknown>): { blocks: ChatBlock[]; finish: ChatResult['stopReason'] } {
  const blocks: ChatBlock[] = [];
  const output = payload.output;
  const items = Array.isArray(output) ? output as CodexResponsesItem[] : [];

  if (items.length === 0 && typeof payload.output_text === 'string' && payload.output_text.trim()) {
    blocks.push({ type: 'text', text: payload.output_text.trim() });
  }

  let sawIncomplete = payload.status === 'incomplete';
  for (const item of items) {
    const type = item.type;
    const status = typeof item.status === 'string' ? item.status : '';
    if (['queued', 'in_progress', 'incomplete'].includes(status)) sawIncomplete = true;

    if (type === 'message') {
      const text = extractMessageText(item);
      if (text) blocks.push({ type: 'text', text });
      continue;
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      const toolName = typeof item.name === 'string' ? item.name : '';
      if (!toolName) continue;
      const toolCallId = typeof item.call_id === 'string' && item.call_id.trim()
        ? item.call_id.trim()
        : typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `call_${blocks.length}`;
      blocks.push({
        type: 'tool-call',
        toolCallId,
        toolName,
        input: parseToolInput(type === 'custom_tool_call' ? item.input : item.arguments),
      });
    }
  }

  if (blocks.some(b => b.type === 'tool-call')) return { blocks, finish: 'tool_calls' };
  if (sawIncomplete) return { blocks, finish: 'length' };
  return { blocks, finish: 'end' };
}

function parseSseDataEvents(body: string): CodexStreamEvent[] {
  const events: CodexStreamEvent[] = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice('data: '.length));
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const event = asRecord(parsed);
      if (event) events.push(event as CodexStreamEvent);
    } catch {
      // Ignore malformed stream chunks; the completed/error events still
      // decide whether the provider response is usable.
    }
  }
  return events;
}

function normalizeCodexResponseBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  const output: CodexResponsesItem[] = [];
  let finalResponse: Record<string, unknown> | null = null;
  let terminalStatus: string | null = null;
  let terminalError: unknown = null;
  for (const event of parseSseDataEvents(body)) {
    const type = typeof event.type === 'string' ? event.type : '';
    const response = asRecord(event.response);
    if (response && (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete')) {
      finalResponse = response;
      terminalStatus = typeof response.status === 'string' ? response.status : terminalStatus;
      terminalError = response.error ?? terminalError;
    }

    if (type === 'response.output_item.done') {
      const item = asRecord(event.item);
      if (item) output.push(item as CodexResponsesItem);
    }
  }

  const base = finalResponse ? { ...finalResponse } : {};
  base.output = output;
  if (terminalStatus && typeof base.status !== 'string') base.status = terminalStatus;
  if (terminalError && base.error === undefined) base.error = terminalError;
  return base;
}

function responseErrorMessage(payload: unknown, status: number): string {
  const obj = asRecord(payload);
  const detail = obj?.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return `Codex Responses request failed: ${detail.trim()}`;
  }
  const errValue = obj?.error;
  if (typeof errValue === 'string' && errValue.trim()) {
    return `Codex Responses request failed: ${errValue.trim()}`;
  }
  const err = asRecord(obj?.error);
  const nested = err?.message;
  if (typeof nested === 'string' && nested.trim()) {
    return `Codex Responses request failed: ${nested.trim()}`;
  }
  const message = obj?.message;
  if (typeof message === 'string' && message.trim()) {
    return `Codex Responses request failed: ${message.trim()}`;
  }
  return `Codex Responses request failed with status ${status}.`;
}

export async function codexResponsesChat(
  cfg: AIGatewayConfig,
  modelId: string,
  opts: ChatOpts,
): Promise<ChatResult> {
  const creds = await resolveCodexRuntimeCredentials(cfg.env);
  const baseURL = (cfg.base_urls?.['openai-codex']?.trim() || creds.baseURL).replace(/\/+$/, '');
  const payload: Record<string, unknown> = {
    model: modelId,
    instructions: codexInstructions(opts),
    input: chatMessagesToCodexResponsesInput(opts.messages),
    store: false,
    stream: true,
    parallel_tool_calls: true,
  };
  const tools = codexTools(opts.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  let response: Response;
  try {
    response = await fetch(`${baseURL}/responses`, {
      method: 'POST',
      headers: codexRequestHeaders(creds.accessToken),
      body: JSON.stringify(payload),
      signal: opts.abortSignal,
    });
  } catch (err) {
    throw new AITransientError('Codex Responses request failed before a response was received.', err);
  }

  let responseBody = '';
  try {
    responseBody = await response.text();
  } catch {
    responseBody = '';
  }
  const json = normalizeCodexResponseBody(responseBody);

  if (!response.ok) {
    const message = responseErrorMessage(json, response.status);
    if (response.status === 401 || response.status === 403) {
      throw new AIConfigError(
        message,
        'Re-authenticate with `hermes auth openai-codex` or `hermes auth`.',
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AITransientError(message);
    }
    throw new AIConfigError(message, 'Check the Codex model id and account access.');
  }

  if (!json) {
    throw new AITransientError('Codex Responses request returned invalid JSON.');
  }
  if (json.status === 'failed' || json.status === 'cancelled') {
    throw new AIConfigError(responseErrorMessage(json, response.status), 'Check the Codex model id and account access.');
  }

  const { blocks, finish } = normalizeCodexOutput(json);
  const usage = asRecord(json.usage);
  return {
    text: blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(''),
    blocks,
    stopReason: finish,
    usage: {
      input_tokens: Number(usage?.input_tokens ?? usage?.inputTokens ?? 0),
      output_tokens: Number(usage?.output_tokens ?? usage?.outputTokens ?? 0),
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: `openai-codex:${modelId}`,
    providerId: 'openai-codex',
    providerMetadata: { source: creds.source, refreshed: creds.refreshed },
  };
}
