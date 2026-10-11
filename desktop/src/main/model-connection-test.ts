import {
  chat,
  configureGateway,
  detectEmbeddingDimensions,
  generateOcrText,
  getVisionCapability,
  resetGateway,
} from '../../../src/core/ai/gateway.ts';
import { getRecipe } from '../../../src/core/ai/recipes/index.ts';
import type { AIGatewayConfig } from '../../../src/core/ai/types.ts';

export type DesktopModelConnectionTouchpoint = 'chat' | 'embedding' | 'ocr';

export interface DesktopModelConnectionTestInput {
  provider: string;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  expectedDimensions?: number;
  touchpoint: DesktopModelConnectionTouchpoint;
}

export type DesktopModelConnectionTestResult =
  | { status: 'success'; durationMs: number; dimensions?: number }
  | { status: 'warning'; durationMs: number; dimensions: number; message: string }
  | { status: 'error'; durationMs: number; message: string };

const MODEL_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const LOCAL_MODEL_CONNECTION_TEST_TIMEOUT_MS = 120_000;
let testQueue: Promise<void> = Promise.resolve();

export function modelConnectionTestTimeoutMs(provider: string): number {
  const normalized = normalizeProvider(provider);
  return normalized === 'ollama' || normalized === 'llama-server' || (normalized === 'custom-openai' || normalized.startsWith('service-'))
    ? LOCAL_MODEL_CONNECTION_TEST_TIMEOUT_MS
    : MODEL_CONNECTION_TEST_TIMEOUT_MS;
}

function normalizeProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value === 'zeroentropy') return 'zeroentropyai';
  if (value === 'custom-openai' || value.startsWith('custom-endpoint-')) return 'custom-openai';
  return value;
}

function authEnvironmentNames(provider: string): string[] {
  const recipe = getRecipe(provider);
  if (!recipe) return [];
  return [
    ...(recipe.auth_env?.required ?? []),
    ...(recipe.auth_env?.optional ?? []),
  ].filter(name => !/_(BASE_)?URL$/.test(name));
}

function buildGatewayConfig(input: DesktopModelConnectionTestInput): { config: AIGatewayConfig; model: string } {
  const provider = normalizeProvider(input.provider);
  const modelId = input.model.trim();
  if (!provider) throw new Error('请先选择模型供应商。');
  if (!modelId) throw new Error('请先填写模型名称。');

  const baseUrl = input.baseUrl?.trim();
  if (provider === 'custom-openai' && !baseUrl) {
    throw new Error('自定义模型缺少 Base URL，请先填写接口地址。');
  }

  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of authEnvironmentNames(provider)) delete env[name];
  const apiKey = input.apiKey?.trim();
  const recipe = getRecipe(provider);
  const authName = recipe?.auth_env?.required[0]
    ?? recipe?.auth_env?.optional?.find(name => !/_(BASE_)?URL$/.test(name));
  if (apiKey && authName) env[authName] = apiKey;

  const model = `${provider}:${modelId}`;
  const config: AIGatewayConfig = {
    generative_enabled: true,
    env,
    ...(input.touchpoint === 'embedding'
      ? { embedding_model: model, embedding_dimensions: 1 }
      : input.touchpoint === 'ocr'
        ? { chat_model: model, ocr_enabled: true, ocr_model: model }
        : { chat_model: model }),
    ...(baseUrl
      ? {
          base_urls: { [provider]: baseUrl },
          touchpoint_base_urls: { [provider]: { [input.touchpoint === 'embedding' ? 'embedding' : 'chat']: baseUrl } },
        }
      : {}),
    ...(apiKey
      ? { touchpoint_api_keys: { [provider]: { [input.touchpoint === 'embedding' ? 'embedding' : 'chat']: apiKey } } }
      : {}),
  };
  return { config, model };
}

function responseBodyMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as any;
    const message = parsed?.error?.message
      ?? parsed?.message
      ?? parsed?.detail
      ?? parsed?.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (message !== undefined) return JSON.stringify(message);
  } catch {
    // Keep the provider's plain-text response below.
  }
  return value.trim().slice(0, 1200);
}

function formatConnectionError(error: unknown): string {
  const messages: string[] = [];
  const details: string[] = [];
  let status: number | undefined;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as {
      message?: unknown;
      name?: unknown;
      status?: unknown;
      statusCode?: unknown;
      responseBody?: unknown;
      cause?: unknown;
    };
    const candidateStatus = value.statusCode ?? value.status;
    if (status === undefined && typeof candidateStatus === 'number') status = candidateStatus;
    if (typeof value.message === 'string' && value.message.trim()) messages.push(value.message.trim());
    if (typeof value.name === 'string' && value.name.trim() && value.name !== 'Error') details.push(value.name.trim());
    const bodyMessage = responseBodyMessage(value.responseBody);
    if (bodyMessage) details.push(bodyMessage);
    current = value.cause;
  }

  const message = messages[0] || details[0] || '未知连接错误';
  const detail = details.find(item => !message.includes(item));
  const prefix = status === undefined ? '' : `HTTP ${status}: `;
  return `${prefix}${message}${detail ? ` · ${detail}` : ''}`.slice(0, 1800);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`连接测试超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    void operation(controller.signal).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function executeModelConnectionTest(
  input: DesktopModelConnectionTestInput,
): Promise<DesktopModelConnectionTestResult> {
  const startedAt = performance.now();
  try {
    const { config, model } = buildGatewayConfig(input);
    const timeoutMs = modelConnectionTestTimeoutMs(input.provider);
    configureGateway(config);
    if (input.touchpoint === 'chat') {
      await withTimeout(signal => chat({
        model,
        system: '这是 PMBrain 的连接测试。请只返回 OK。',
        messages: [{ role: 'user', content: '请返回 OK。' }],
        maxTokens: 8,
        abortSignal: signal,
      }), timeoutMs);
      return { status: 'success', durationMs: elapsedMs(startedAt) };
    }

    if (input.touchpoint === 'ocr') {
      if (getVisionCapability(model) === 'unsupported') {
        throw new Error(`模型 ${model} 不支持图片输入。`);
      }
      const probe = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      await withTimeout(() => generateOcrText(probe, 'image/png'), timeoutMs);
      return { status: 'success', durationMs: elapsedMs(startedAt) };
    }

    const dimensions = await withTimeout(() => detectEmbeddingDimensions(model), timeoutMs);
    const expected = input.expectedDimensions;
    if (Number.isInteger(expected) && expected! > 0 && dimensions !== expected) {
      return {
        status: 'warning',
        durationMs: elapsedMs(startedAt),
        dimensions,
        message: `连接成功，但维度不一致：配置 ${expected} 维，实际返回 ${dimensions} 维。`,
      };
    }
    return { status: 'success', durationMs: elapsedMs(startedAt), dimensions };
  } catch (error) {
    return { status: 'error', durationMs: elapsedMs(startedAt), message: formatConnectionError(error) };
  } finally {
    resetGateway();
  }
}

/** Serialize probes because the shared Core gateway is process-local. */
export function testModelConnection(
  input: DesktopModelConnectionTestInput,
): Promise<DesktopModelConnectionTestResult> {
  const result = testQueue.then(() => executeModelConnectionTest(input));
  testQueue = result.then(() => undefined, () => undefined);
  return result;
}
