import { AIConfigError, AITransientError } from '../errors.ts';
import type { ChatBlock, ChatMessage, ChatResult, ChatToolDef } from '../gateway.ts';
import { defaultTokenStore, redactTokenLike, type TokenStore } from './token-store.ts';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';

let _tokenStoreForTests: TokenStore | null = null;
let _fetchForTests: typeof fetch | null = null;

/** @internal test seam; production callers leave this unset. */
export function __setOpenAICodexTokenStoreForTests(store: TokenStore | null): void {
  _tokenStoreForTests = store;
}

/** @internal test seam; production callers leave this unset. */
export function __setOpenAICodexFetchForTests(fetchImpl: typeof fetch | null): void {
  _fetchForTests = fetchImpl;
}

export interface OpenAICodexAdapterOpts {
  model: string;
  tokenStore?: TokenStore;
  fetchImpl?: typeof fetch;
  baseURL?: string;
  abortSignal?: AbortSignal;
}

export interface OpenAICodexChatOpts extends OpenAICodexAdapterOpts {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Tool definitions for function calling (subagent tool loop). */
  tools?: ChatToolDef[];
}

export interface OpenAICodexJsonOpts<T> extends OpenAICodexAdapterOpts {
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface OpenAICodexJsonResult<T> {
  object: T;
  text: string;
  usage: ChatResult['usage'];
  model: string;
  providerId: 'openai-codex';
  providerMetadata?: Record<string, unknown>;
}

function normalizeBaseURL(baseURL?: string): string {
  return (baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function getAccessToken(tokenStore?: TokenStore): Promise<string> {
  const token = await (tokenStore ?? _tokenStoreForTests ?? defaultTokenStore()).get();
  if (!token?.access_token) {
    throw new AIConfigError(
      'OpenAI Codex chat requires ChatGPT OAuth login.',
      'Run `gbrain providers login openai-codex`, then `gbrain providers refresh openai-codex`.',
    );
  }
  return token.access_token;
}

function contentToInputText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function buildInput(system: string | undefined, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (system && system.trim()) {
    input.push({ role: 'system', content: [{ type: 'input_text', text: system }] });
  }
  for (const message of messages) {
    if (message.role === 'tool') continue;
    const isAssistant = message.role === 'assistant';

    // Structured blocks (assistant tool-calls, tool-results) must map to the
    // Responses API's top-level item shapes, NOT nested message content. The
    // subagent tool loop replays history as blocks: assistant turns carry
    // `tool-call` blocks, and tool outputs come back as `tool-result` blocks.
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          if (!block.text) continue;
          input.push({
            role: isAssistant ? 'assistant' : 'user',
            content: [{ type: isAssistant ? 'output_text' : 'input_text', text: block.text }],
          });
        } else if (block.type === 'tool-call') {
          // Assistant function call — replayed so the model sees its own prior
          // tool invocation. `arguments` MUST be a JSON string per the API.
          input.push({
            type: 'function_call',
            call_id: block.toolCallId,
            name: block.toolName,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === 'tool-result') {
          // Tool execution result fed back into the next turn.
          const out = typeof block.output === 'string' ? block.output : JSON.stringify(block.output ?? '');
          input.push({
            type: 'function_call_output',
            call_id: block.toolCallId,
            output: out,
          });
        }
      }
      continue;
    }

    // Plain string content.
    const text = contentToInputText(message.content);
    if (!text) continue;
    // The Codex Responses API validates content-part types by role: assistant
    // turns must use `output_text` (they represent prior model output), while
    // user/system turns use `input_text`. Sending `input_text` for an assistant
    // turn returns HTTP 400, which breaks every multi-turn path (think, dream,
    // subagent history replay).
    input.push({
      role: isAssistant ? 'assistant' : 'user',
      content: [{ type: isAssistant ? 'output_text' : 'input_text', text }],
    });
  }
  return input;
}

/** Map GBrain tool defs to the Responses API `tools` shape. */
function buildTools(tools: ChatToolDef[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

/**
 * Extract assistant tool-call blocks from a Responses API body. Function calls
 * surface as top-level `output` items with `type: 'function_call'`, carrying
 * `call_id`, `name`, and a JSON-string `arguments` field.
 */
function extractToolCalls(body: any): Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> {
  const calls: Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (item?.type === 'function_call' || (typeof item?.name === 'string' && item?.call_id)) {
      const rawArgs = item.arguments ?? item.input ?? '{}';
      let parsed: unknown;
      try {
        parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
      } catch {
        parsed = rawArgs; // keep raw string if not valid JSON — handler can decide
      }
      calls.push({
        type: 'tool-call',
        toolCallId: String(item.call_id ?? item.id ?? `call_${calls.length}`),
        toolName: String(item.name),
        input: parsed,
      });
    }
  }
  return calls;
}

function extractOutputText(body: any): string {
  if (typeof body?.output_text === 'string') return body.output_text;
  const chunks: string[] = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (typeof item?.text === 'string') chunks.push(item.text);
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
      if (typeof part?.content === 'string') chunks.push(part.content);
    }
  }
  return chunks.join('');
}

function normalizeUsage(raw: any): ChatResult['usage'] {
  const usage = raw && typeof raw === 'object' ? raw : {};
  return {
    input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0),
    cache_read_tokens: Number(usage.cache_read_tokens ?? usage.cacheReadInputTokens ?? 0),
    cache_creation_tokens: Number(usage.cache_creation_tokens ?? usage.cacheCreationInputTokens ?? 0),
  };
}

function mapStopReason(raw: any): ChatResult['stopReason'] {
  const reason = raw?.finish_reason ?? raw?.finishReason ?? raw?.status;
  if (reason === 'tool_calls' || reason === 'tool-calls') return 'tool_calls';
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens') return 'length';
  if (reason === 'refusal') return 'refusal';
  if (reason === 'content_filter' || reason === 'content-filter') return 'content_filter';
  if (reason === 'completed' || reason === 'complete' || reason === 'stop' || reason === undefined) return 'end';
  return 'other';
}

function parseResponsesEventStream(streamText: string): any {
  const aggregate: any = { output_text: '', output: [], usage: undefined, status: undefined };
  for (const frame of streamText.split(/\n\n+/)) {
    const dataLines = frame
      .split(/\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())
      .filter(line => line && line !== '[DONE]');
    if (dataLines.length === 0) continue;
    let event: any;
    try {
      event = JSON.parse(dataLines.join('\n'));
    } catch {
      continue;
    }
    const type = event.type ?? event.event;
    if (typeof event.delta === 'string') aggregate.output_text += event.delta;
    if (typeof event.text === 'string' && /delta/.test(String(type))) aggregate.output_text += event.text;
    if (typeof event.output_text === 'string') aggregate.output_text += event.output_text;
    if (event.response && typeof event.response === 'object') {
      if (!aggregate.model && event.response.model) aggregate.model = event.response.model;
      if (event.response.usage) aggregate.usage = event.response.usage;
      if (event.response.status) aggregate.status = event.response.status;
      const text = extractOutputText(event.response);
      if (text) aggregate.output_text = text;
    }
    if (event.item && typeof event.item === 'object') {
      // Function-call items stream as a pair: `output_item.added` (empty args)
      // then `output_item.done` (complete args), both carrying the same
      // `call_id`. Dedupe by call_id so we keep only the final, fully-formed
      // call — otherwise the tool loop sees a phantom duplicate invocation.
      const item = event.item as any;
      const callId = item?.call_id;
      if (callId) {
        const existingIdx = aggregate.output.findIndex((o: any) => o?.call_id === callId);
        if (existingIdx >= 0) {
          aggregate.output[existingIdx] = item; // latest (done) wins
        } else {
          aggregate.output.push(item);
        }
      } else {
        aggregate.output.push(item);
      }
    }
    if (event.usage) aggregate.usage = event.usage;
  }
  return aggregate;
}

async function postResponses(params: {
  model: string;
  body: Record<string, unknown>;
  tokenStore?: TokenStore;
  fetchImpl?: typeof fetch;
  baseURL?: string;
  abortSignal?: AbortSignal;
}): Promise<any> {
  const token = await getAccessToken(params.tokenStore);
  const fetcher = params.fetchImpl ?? _fetchForTests ?? fetch;
  const url = `${normalizeBaseURL(params.baseURL)}/codex/responses`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'OpenAI-Beta': 'responses_http',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: params.model,
        store: false,
        stream: true,
        ...params.body,
      }),
      signal: params.abortSignal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AITransientError(`OpenAI Codex response transport failed: ${redactTokenLike(msg)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const msg = `OpenAI Codex response returned HTTP ${response.status}: ${redactTokenLike(text)}`;
    if (response.status === 401 || response.status === 403) {
      throw new AIConfigError(msg, 'Run `gbrain providers login openai-codex` to refresh ChatGPT OAuth.');
    }
    throw new AITransientError(msg);
  }

  try {
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
      return parseResponsesEventStream(text);
    }
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AITransientError(`OpenAI Codex response returned malformed JSON: ${msg}`);
  }
}

export async function openAICodexChat(opts: OpenAICodexChatOpts): Promise<ChatResult> {
  const tools = buildTools(opts.tools);
  const body = await postResponses({
    model: opts.model,
    tokenStore: opts.tokenStore,
    fetchImpl: opts.fetchImpl,
    baseURL: opts.baseURL,
    abortSignal: opts.abortSignal,
    body: {
      instructions: opts.system ?? 'You are a concise assistant.',
      input: buildInput(undefined, opts.messages),
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    },
  });

  const text = extractOutputText(body);
  const toolCalls = extractToolCalls(body);
  const blocks: ChatBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const call of toolCalls) blocks.push(call);

  // When the model emits tool calls, the stop reason MUST be 'tool_calls' so
  // the gateway tool loop continues. Codex's stream status is 'completed' even
  // on a function-call turn, so infer from the presence of tool-call blocks.
  const stopReason: ChatResult['stopReason'] = toolCalls.length > 0 ? 'tool_calls' : mapStopReason(body);

  return {
    text,
    blocks,
    stopReason,
    usage: normalizeUsage(body?.usage),
    model: `openai-codex:${opts.model}`,
    providerId: 'openai-codex',
    providerMetadata: { openaiCodex: body },
  };
}

export async function openAICodexJson<T>(opts: OpenAICodexJsonOpts<T>): Promise<OpenAICodexJsonResult<T>> {
  const body = await postResponses({
    model: opts.model,
    tokenStore: opts.tokenStore,
    fetchImpl: opts.fetchImpl,
    baseURL: opts.baseURL,
    abortSignal: opts.abortSignal,
    body: {
      instructions: 'Return only a JSON object that conforms to the supplied schema.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: opts.prompt }] }],
      text: {
        format: {
          type: 'json_schema',
          name: opts.schemaName,
          schema: opts.schema,
          strict: true,
        },
      },
    },
  });

  const text = extractOutputText(body).trim();
  try {
    return {
      object: JSON.parse(text) as T,
      text,
      usage: normalizeUsage(body?.usage),
      model: `openai-codex:${opts.model}`,
      providerId: 'openai-codex',
      providerMetadata: { openaiCodex: body },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AITransientError(`OpenAI Codex JSON response could not be parsed: ${msg}`);
  }
}
