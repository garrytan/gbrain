import { AIConfigError, AITransientError } from '../errors.ts';
import type { ChatBlock, ChatMessage, ChatResult } from '../gateway.ts';
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
    const text = contentToInputText(message.content);
    if (!text) continue;
    input.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'input_text', text }],
    });
  }
  return input;
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
      aggregate.output.push(event.item);
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
  const body = await postResponses({
    model: opts.model,
    tokenStore: opts.tokenStore,
    fetchImpl: opts.fetchImpl,
    baseURL: opts.baseURL,
    abortSignal: opts.abortSignal,
    body: {
      instructions: opts.system ?? 'You are a concise assistant.',
      input: buildInput(undefined, opts.messages),
    },
  });

  const text = extractOutputText(body);
  const blocks: ChatBlock[] = text ? [{ type: 'text', text }] : [];
  return {
    text,
    blocks,
    stopReason: mapStopReason(body),
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
