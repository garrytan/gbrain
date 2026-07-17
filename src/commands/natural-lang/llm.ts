import type { GBrainConfig } from '../../core/config.ts';
import { isSensitiveConfigKey, redactConfigValue } from '../config.ts';
import { chat, configureGateway, isAvailable } from '../../core/ai/gateway.ts';
import type { AIGatewayConfig } from '../../core/ai/types.ts';
import { INTENT_SYSTEM_PROMPT, PMBRAIN_ACTION_TOOL } from './prompt.ts';

const INTENT_CLASSIFICATION_CHARACTERS = 4_000;

// ---------------------------------------------------------------------------
// JSON / response parsing helpers
// ---------------------------------------------------------------------------

export function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : trimmed;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    const partialIntent = body.match(/["']intent["']\s*:\s*["']([^"']+)["']/i)?.[1];
    if (partialIntent === 'capture_memory' || partialIntent === 'capture_memo') {
      return { intent: 'capture_memory' };
    }
    throw new Error('模型返回的任务格式不完整，请重新发送。');
  }
  try {
    return JSON.parse(body.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    const partialIntent = body.match(/["']intent["']\s*:\s*["']([^"']+)["']/i)?.[1];
    if (partialIntent === 'capture_memory' || partialIntent === 'capture_memo') {
      return { intent: 'capture_memory' };
    }
    throw new Error('模型返回的任务格式无法解析，请重新发送。');
  }
}

function classificationText(text: string): string {
  if (text.length <= INTENT_CLASSIFICATION_CHARACTERS) return text;
  const tailLength = 800;
  const headLength = INTENT_CLASSIFICATION_CHARACTERS - tailLength;
  return `${text.slice(0, headLength)}\n\n[中间正文已省略，仅用于识别任务；执行时仍使用完整原文]\n\n${text.slice(-tailLength)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseIntentObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  return parseJsonObject(value);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isRecord(part)) return '';
    const text = part.text ?? part.content ?? part.value;
    return typeof text === 'string' ? text : '';
  }).join('');
}

function extractIntentObjectFromOpenAiResponse(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw new Error('LLM did not return a response object');
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const parsed = parseIntentObject(fn.arguments);
    if (parsed) return parsed;
  }

  if (isRecord(message.function_call)) {
    const parsed = parseIntentObject(message.function_call.arguments);
    if (parsed) return parsed;
  }

  for (const key of ['structured_output', 'structuredOutput', 'output_parsed', 'parsed']) {
    const parsed = parseIntentObject((message as Record<string, unknown>)[key] ?? data[key]);
    if (parsed) return parsed;
  }

  const text = extractTextFromContent(message.content);
  if (text.trim()) return parseJsonObject(text);
  throw new Error('LLM did not return a planning object');
}

function extractIntentObjectFromChatResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error('LLM did not return a chat result');
  const blocks = Array.isArray(result.blocks) ? result.blocks : [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'tool-call') continue;
    if (typeof block.toolName === 'string' && block.toolName !== 'pmbrain_action') continue;
    const parsed = parseIntentObject(block.input);
    if (parsed) return parsed;
  }
  if (typeof result.text === 'string' && result.text.trim()) return parseJsonObject(result.text);
  throw new Error('LLM did not return a planning object');
}

// ---------------------------------------------------------------------------
// Gateway config builder
// ---------------------------------------------------------------------------

export function buildAdminGatewayConfig(config: GBrainConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (config.openai_api_key) envFromConfig.OPENAI_API_KEY = config.openai_api_key;
  if (config.custom_openai_api_key) envFromConfig.CUSTOM_OPENAI_API_KEY = config.custom_openai_api_key;
  if (config.mimo_api_key) envFromConfig.MIMO_API_KEY = config.mimo_api_key;
  if (config.zhipu_api_key) envFromConfig.ZHIPUAI_API_KEY = config.zhipu_api_key;
  if (config.deepseek_api_key) envFromConfig.DEEPSEEK_API_KEY = config.deepseek_api_key;
  if (config.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = config.anthropic_api_key;
  if (config.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = config.zeroentropy_api_key;
  return {
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    touchpoint_base_urls: config.provider_touchpoint_base_urls,
    touchpoint_api_keys: config.provider_touchpoint_api_keys,
    env: { ...envFromConfig, ...process.env },
  };
}

// ---------------------------------------------------------------------------
// LLM status / provider status
// ---------------------------------------------------------------------------

function getProviderStatus(config: GBrainConfig | null) {
  const chatModel = config?.chat_model ?? null;
  const provider = chatModel?.split(':')[0] ?? null;
  const providers = {
    mimo: !!config?.mimo_api_key,
    zhipu: !!config?.zhipu_api_key,
    deepseek: !!config?.deepseek_api_key,
    openai: !!config?.openai_api_key,
    anthropic: !!config?.anthropic_api_key,
    zeroentropy: !!config?.zeroentropy_api_key,
  };
  const providerKeyMap: Record<string, keyof typeof providers> = {
    mimo: 'mimo',
    zhipu: 'zhipu',
    deepseek: 'deepseek',
    openai: 'openai',
    anthropic: 'anthropic',
    zeroentropyai: 'zeroentropy',
  };
  const required = provider ? providerKeyMap[provider] : null;
  const customOpenAiBaseUrl = config?.provider_touchpoint_base_urls?.['custom-openai']?.chat
    ?? config?.provider_base_urls?.['custom-openai'];
  const hasRequired = provider === 'custom-openai'
    ? !!customOpenAiBaseUrl
    : required ? providers[required] : false;
  return {
    chat: {
      enabled: !!chatModel && hasRequired,
      chat_model: chatModel,
      provider,
      missing: !chatModel
        ? ['chat_model']
        : hasRequired
          ? []
          : provider === 'custom-openai'
            ? ['provider_touchpoint_base_urls.custom-openai.chat']
            : [`${provider}_api_key`],
    },
    providers,
  };
}

export function getAdminLlmStatus(config: GBrainConfig | null) {
  const status = getProviderStatus(config);
  return {
    enabled: status.chat.enabled,
    chatModel: status.chat.chat_model,
    provider: status.chat.provider,
    providersConfigured: status.providers,
    missing: status.chat.missing,
  };
}

// ---------------------------------------------------------------------------
// Core: call intent model (MIMO direct or AI Gateway)
// ---------------------------------------------------------------------------

export async function callIntentModel(config: GBrainConfig, text: string, attempt: number): Promise<Record<string, unknown>> {
  const taskText = classificationText(text);
  if (config.chat_model?.startsWith('mimo:') && config.mimo_api_key) {
    const model = config.chat_model.slice('mimo:'.length);
    const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.mimo_api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${attempt === 0 ? '' : '上次输出不可解析。请严格只输出 JSON 对象。\n'}用户输入：${taskText}`,
          },
        ],
        tools: [PMBRAIN_ACTION_TOOL],
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 700,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MIMO intent call failed: HTTP ${res.status} ${body.slice(0, 180)}`);
    }
    const data = await res.json() as any;
    return extractIntentObjectFromOpenAiResponse(data);
  }

  configureGateway(buildAdminGatewayConfig(config));
  if (!isAvailable('chat')) {
    throw new Error('Configured chat model is not available');
  }
  const result = await chat({
    system: INTENT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${attempt === 0 ? '' : '上次输出不可解析。请严格只输出 JSON 对象。\n'}用户输入：${taskText}`,
    }],
    tools: [{
      name: PMBRAIN_ACTION_TOOL.function.name,
      description: PMBRAIN_ACTION_TOOL.function.description,
      inputSchema: PMBRAIN_ACTION_TOOL.function.parameters,
    }],
    maxTokens: 700,
  });
  return extractIntentObjectFromChatResult(result);
}
