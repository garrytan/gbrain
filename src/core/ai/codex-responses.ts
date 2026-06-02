import type { Recipe } from './types.ts';
import type { CodexCredentialSnapshot } from './codex-auth.ts';
import {
  codexAuthAvailable,
  codexAuthFailureDetail,
  codexAuthSetupHint,
} from './codex-auth.ts';
import { AIConfigError, AIServiceError, AITransientError } from './errors.ts';
import type { ChatBlock, ChatMessage, ChatOpts, ChatResult } from './gateway.ts';

export type CodexCredential = Extract<CodexCredentialSnapshot, { ok: true }>;

export interface CodexResponsesBody {
  model: string;
  input: CodexResponsesInputMessage[];
  instructions?: string;
  stream: true;
  store: false;
  max_output_tokens?: number;
}

export interface CodexResponsesInputMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'output_text';
    text: string;
  }>;
}

export interface CodexResponsesRequest {
  url: string;
  headers: Record<string, string>;
  body: CodexResponsesBody;
  init: RequestInit;
}

export interface CodexResponsesChatInput {
  recipe: Recipe;
  modelId: string;
  opts: ChatOpts;
  credential: CodexCredentialSnapshot;
  baseURL: string;
  fetchImpl?: typeof fetch;
}

export interface CodexResponsesParseMeta {
  providerId: string;
  modelId: string;
  redactionSecrets?: Array<string | undefined>;
  abortSignal?: AbortSignal;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

interface NormalizedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

const CODEX_ORIGINATOR = 'codex_cli_rs';
const GBRAIN_CODEX_USER_AGENT = 'codex_cli_rs/0.134.0 gbrain-codex-responses';

/**
 * Codex-plan Responses support is intentionally text-only for this first
 * transport slice. Reject every known tool shape before fetch/budget side
 * effects so unsupported minion/tool-loop history cannot be silently sent to
 * the ChatGPT backend.
 */
export function assertCodexTextOnly(opts: Pick<ChatOpts, 'messages' | 'tools'>): void {
  if ((opts.tools ?? []).length > 0) {
    throw unsupportedCodexMode('tool definitions are not supported');
  }

  for (const message of opts.messages ?? []) {
    if (message.role === 'tool') {
      throw unsupportedCodexMode('role="tool" messages are not supported');
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        throw unsupportedCodexMode('tool-call history blocks are not supported');
      }
      if (block.type === 'tool-result') {
        throw unsupportedCodexMode('tool-result history blocks are not supported');
      }
      if (block.type !== 'text') {
        throw unsupportedCodexMode(`content block type "${(block as { type?: unknown }).type}" is not supported`);
      }
    }
  }
}

function unsupportedCodexMode(detail: string): AIConfigError {
  return new AIConfigError(
    `OpenAI Codex Responses chat is text-only in this release; ${detail}.`,
    'Remove tools/tool history or choose a provider whose chat touchpoint supports tools.',
  );
}

export function buildCodexResponsesBody(opts: ChatOpts, modelId: string): CodexResponsesBody {
  assertCodexTextOnly(opts);

  const instructions: string[] = [];
  if (opts.system && opts.system.trim().length > 0) instructions.push(opts.system);

  const input: CodexResponsesInputMessage[] = [];
  for (const message of opts.messages) {
    if (message.role === 'system') {
      const text = contentToText(message.content);
      if (text.trim().length > 0) instructions.push(text);
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      // assertCodexTextOnly already rejects role='tool'; this keeps the request
      // builder future-proof if ChatRole expands later.
      throw unsupportedCodexMode(`role="${message.role}" messages are not supported`);
    }

    const content = contentToTextParts(message).map((text) => ({
      type: message.role === 'assistant' ? 'output_text' as const : 'input_text' as const,
      text,
    }));
    input.push({ role: message.role, content });
  }

  return {
    model: modelId,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    stream: true,
    store: false,
    ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
  };
}

function contentToText(content: ChatMessage['content']): string {
  return contentToTextParts({ content }).join('\n');
}

function contentToTextParts(message: Pick<ChatMessage, 'content'>): string[] {
  if (typeof message.content === 'string') return [message.content];
  return message.content.map((block) => (block as Extract<ChatBlock, { type: 'text' }>).text ?? '');
}

export function buildCodexResponsesHeaders(credential: CodexCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': GBRAIN_CODEX_USER_AGENT,
    originator: CODEX_ORIGINATOR,
    ...(credential.accountId ? { 'ChatGPT-Account-ID': credential.accountId } : {}),
  };
}

export function buildCodexResponsesRequest(input: {
  baseURL: string;
  modelId: string;
  opts: ChatOpts;
  credential: CodexCredential;
}): CodexResponsesRequest {
  const body = buildCodexResponsesBody(input.opts, input.modelId);
  const headers = buildCodexResponsesHeaders(input.credential);
  const url = `${input.baseURL.replace(/\/+$/, '')}/responses`;
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: input.opts.abortSignal,
  };
  return { url, headers, body, init };
}

export async function runCodexResponsesChat(input: CodexResponsesChatInput): Promise<ChatResult> {
  assertCodexTextOnly(input.opts);
  const credential = assertCodexCredential(input.credential, input.recipe);
  const request = buildCodexResponsesRequest({
    baseURL: input.baseURL,
    modelId: input.modelId,
    opts: input.opts,
    credential,
  });
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(request.url, request.init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof AIServiceError) throw err;
    throw new AITransientError(
      `OpenAI Codex Responses request failed: ${redactCodexSecrets(errorMessage(err), [credential.accessToken, credential.accountId])}`,
    );
  }

  return parseCodexResponsesStream(response, {
    providerId: input.recipe.id,
    modelId: input.modelId,
    redactionSecrets: [credential.accessToken, credential.accountId],
    abortSignal: input.opts.abortSignal,
  });
}

function assertCodexCredential(snapshot: CodexCredentialSnapshot, recipe: Recipe): CodexCredential {
  if (snapshot.ok && codexAuthAvailable(snapshot)) return snapshot;
  if (snapshot.ok) {
    throw new AIConfigError(
      `${recipe.name} chat is unavailable: Codex auth expired (source=${snapshot.source}, expires_at=${snapshot.expiresAt}).`,
      codexAuthSetupHint(snapshot),
    );
  }
  throw new AIConfigError(
    `${recipe.name} chat is unavailable: ${codexAuthFailureDetail(snapshot)}`,
    codexAuthSetupHint(snapshot),
  );
}

export async function parseCodexResponsesStream(
  response: Response,
  meta: CodexResponsesParseMeta,
): Promise<ChatResult> {
  const secrets = meta.redactionSecrets ?? [];

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const redacted = redactCodexSecrets(body || response.statusText || 'upstream error', secrets);
    const message = `OpenAI Codex Responses returned HTTP ${response.status}: ${redacted}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new AIConfigError(message, 'Refresh Codex auth or choose a different chat provider.');
    }
    throw new AITransientError(message);
  }

  if (!response.body) {
    throw new AITransientError('OpenAI Codex Responses returned an empty streaming body.');
  }

  const textParts: string[] = [];
  let usage: NormalizedUsage | undefined;
  let responseId: string | undefined;
  let completed = false;
  let eventCount = 0;

  await readSseStream(response.body, (event) => {
    if (meta.abortSignal?.aborted) throw abortError();
    if (!event.data || event.data === '[DONE]') return;
    eventCount++;

    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      throw new AITransientError(
        `OpenAI Codex Responses stream returned malformed JSON for event "${event.event}": ${redactCodexSecrets(errorMessage(err), secrets)}`,
      );
    }

    const type = typeof payload?.type === 'string' ? payload.type : event.event;
    responseId = responseId ?? stringValue(payload?.response?.id) ?? stringValue(payload?.id);

    const eventUsage = normalizeUsage(payload?.response?.usage ?? payload?.usage);
    if (eventUsage) usage = eventUsage;

    if (type === 'response.output_text.delta') {
      if (typeof payload?.delta === 'string') textParts.push(payload.delta);
      return;
    }

    if (type === 'response.completed') {
      completed = true;
      return;
    }

    const streamError = extractStreamError(type, payload);
    if (streamError) {
      throw new AITransientError(
        `OpenAI Codex Responses stream error (${streamError.code ?? type}): ${redactCodexSecrets(streamError.message, secrets)}`,
      );
    }
  });

  const text = textParts.join('');
  const normalizedUsage = usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };

  return {
    text,
    blocks: text.length > 0 ? [{ type: 'text', text }] : [],
    stopReason: completed ? 'end' : 'other',
    usage: normalizedUsage,
    model: `${meta.providerId}:${meta.modelId}`,
    providerId: meta.providerId,
    providerMetadata: {
      codex: {
        stream: true,
        ...(responseId ? { response_id: responseId } : {}),
        event_count: eventCount,
      },
    },
  };
}

async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, onEvent);
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim().length > 0) onEvent(parseSseEvent(buffer));
  } finally {
    reader.releaseLock();
  }
}

function drainSseBuffer(buffer: string, onEvent: (event: ParsedSseEvent) => void): string {
  let normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (true) {
    const idx = normalized.indexOf('\n\n');
    if (idx === -1) return normalized;
    const raw = normalized.slice(0, idx);
    normalized = normalized.slice(idx + 2);
    if (raw.trim().length > 0) onEvent(parseSseEvent(raw));
  }
}

function parseSseEvent(raw: string): ParsedSseEvent {
  let event = 'message';
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return { event, data: data.join('\n') };
}

function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, any>;
  const input = numberValue(usage.input_tokens)
    ?? numberValue(usage.inputTokens)
    ?? numberValue(usage.prompt_tokens)
    ?? numberValue(usage.promptTokens)
    ?? 0;
  const output = numberValue(usage.output_tokens)
    ?? numberValue(usage.outputTokens)
    ?? numberValue(usage.completion_tokens)
    ?? numberValue(usage.completionTokens)
    ?? 0;
  const cacheRead = numberValue(usage.cache_read_tokens)
    ?? numberValue(usage.cacheReadTokens)
    ?? numberValue(usage.input_tokens_details?.cached_tokens)
    ?? 0;
  const cacheCreation = numberValue(usage.cache_creation_tokens)
    ?? numberValue(usage.cacheCreationTokens)
    ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
  };
}

function extractStreamError(type: string, payload: any): { message: string; code?: string } | null {
  const error = payload?.error ?? payload?.response?.error;
  if (error || type === 'error' || type.endsWith('.error') || type === 'response.failed') {
    const message =
      stringValue(error?.message)
      ?? stringValue(payload?.message)
      ?? stringValue(payload?.response?.status_details?.error?.message)
      ?? JSON.stringify(payload);
    const code = stringValue(error?.code) ?? stringValue(payload?.code);
    return { message: message ?? 'unknown Codex stream error', ...(code ? { code } : {}) };
  }
  return null;
}

export function redactCodexSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, 'Bearer [REDACTED]');
  out = out.replace(/((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]');
  return out;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
    || err instanceof Error && err.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
