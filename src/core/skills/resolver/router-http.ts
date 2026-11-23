/**
 * The model picker's chat call (router.ts), made over plain HTTPS to the
 * provider: Anthropic Messages, OpenAI Responses or Google generateContent.
 * It loads no AI gateway and no SDK, so the hook lane's worker and the
 * library's Node bundle stay small and engine-free. A key comes from the
 * environment, else from the file-plane config.json keys gbrain's gateway
 * reads (anthropic_api_key, openai_api_key, google_api_key; the canonical
 * fold is src/core/ai/provider-env.ts, including the GEMINI_API_KEY alias).
 * ANTHROPIC_BASE_URL, OPENAI_BASE_URL and GOOGLE_GENERATIVE_AI_BASE_URL point
 * a provider at a proxy. A compat: model is any OpenAI-compatible endpoint
 * (Chat Completions at router_base_url), with its key read from the
 * environment variable router_api_key_env names, or no key.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PICKER_PROVIDERS = ['anthropic', 'openai', 'google', 'compat'] as const;
export type PickerProvider = (typeof PICKER_PROVIDERS)[number];
export interface PickerRequest { model: string; system: string; message: string; maxTokens: number; signal: AbortSignal; baseUrl?: string }
/** A reply; usage.input counts only uncached input tokens, and usage is null when the provider reported no token counts. */
export interface PickerReply { text: string; refused: boolean; usage: { input: number; cacheRead: number; cacheWrite: number; output: number } | null }

let testTransport: ((req: PickerRequest) => Promise<PickerReply>) | null = null;
/** Tests only: answer every picker call with `fn` (null restores the network). */
export function __setPickerTransportForTests(fn: ((req: PickerRequest) => Promise<PickerReply>) | null): void { testTransport = fn; }

const CONFIG_KEY: Record<Exclude<PickerProvider, 'compat'>, [string, string]> = {
  anthropic: ['anthropic_api_key', 'ANTHROPIC_API_KEY'],
  openai: ['openai_api_key', 'OPENAI_API_KEY'],
  google: ['google_api_key', 'GOOGLE_GENERATIVE_AI_API_KEY'],
};

export const providerOf = (model: string): PickerProvider | null => {
  const p = model.slice(0, model.indexOf(':'));
  return (PICKER_PROVIDERS as readonly string[]).includes(p) ? p as PickerProvider : null;
};

/** The key for `provider`, or null when none is configured; '' for a compat: endpoint that takes none (no keyEnv). */
export function pickerKey(provider: PickerProvider, home: string, env: NodeJS.ProcessEnv, keyEnv: string | null = null): string | null {
  if (testTransport) return 'test';
  if (provider === 'compat') return keyEnv ? env[keyEnv] || null : '';
  const [configKey, name] = CONFIG_KEY[provider];
  const fromEnv = env[name] || (provider === 'google' ? env.GEMINI_API_KEY : undefined);
  if (fromEnv) return fromEnv;
  try {
    const v = (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>)[configKey];
    return typeof v === 'string' && v ? v : null;
  } catch { return null; } // silent-read-ok: no readable config.json key means no key; the turn reports router.fallback missing_key
}

/** Usage from a provider's counts, or null unless every count is a finite number of at least 0, so a partial or malformed report settles at the reservation. */
function counts(input: unknown, output: unknown, cacheRead: unknown = 0, cacheWrite: unknown = 0): PickerReply['usage'] {
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return ok(input) && ok(output) && ok(cacheRead) && ok(cacheWrite) ? { input, cacheRead, cacheWrite, output } : null;
}

/** Anthropic models that refuse thinking 'disabled' (Opus and Fable 5.x) get adaptive thinking at low effort; checked live on 2026-11-22. */
const ANTHROPIC_ADAPTIVE = /^claude-(opus|fable)-5/;
/** Sonnet 5.5 refuses 'disabled' too; 'between_tools' is its off switch when no tools are offered (thinking-off.ts). Sonnet 5 refuses 'between_tools' and keeps 'disabled'; checked live on 2026-11-23. */
const ANTHROPIC_BETWEEN_TOOLS = /^claude-sonnet-5-5/;
/** OpenAI models that refuse reasoning effort 'none' (the 6.x Astra models and every Sol after gpt-6-sol) get 'low'; checked live on 2026-11-22. */
const OPENAI_EFFORT_LOW = /^gpt-6(\.\d+)?-astra$|^gpt-6\.\d+-sol$/;

/** True when `model` (provider:id) reasons before it answers, so its reasoning tokens count against the output cap. */
export function pickerReasons(model: string): boolean {
  const provider = providerOf(model);
  const id = model.slice(model.indexOf(':') + 1);
  return provider === 'anthropic' ? ANTHROPIC_ADAPTIVE.test(id) : provider === 'openai' && OPENAI_EFFORT_LOW.test(id);
}

function anthropicThinking(model: string): Record<string, unknown> {
  if (ANTHROPIC_ADAPTIVE.test(model)) return { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
  if (ANTHROPIC_BETWEEN_TOOLS.test(model)) return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  return { thinking: { type: 'disabled' } };
}

const BASE_URL_ENV: Record<Exclude<PickerProvider, 'compat'>, string> = { anthropic: 'ANTHROPIC_BASE_URL', openai: 'OPENAI_BASE_URL', google: 'GOOGLE_GENERATIVE_AI_BASE_URL' };

/** True when `provider` is answered by the provider itself: not a compat: endpoint, and no base-URL override pointing it at a proxy that may bill. */
export const firstParty = (provider: PickerProvider | null, env: NodeJS.ProcessEnv): boolean => provider !== null && provider !== 'compat' && !env[BASE_URL_ENV[provider]];

const base = (env: NodeJS.ProcessEnv, name: string, fallback: string) => (env[name] || fallback).replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');

/** A provider's HTTP error answer, with its status. */
export class PickerHttpError extends Error {
  constructor(readonly status: number) { super(`provider answered HTTP ${status}`); }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!res.ok) throw new PickerHttpError(res.status);
  return await res.json() as Record<string, any>;
}

/** One picker call. Throws on a network or HTTP error and on an abort. */
export async function pickerChat(req: PickerRequest, key: string, env: NodeJS.ProcessEnv): Promise<PickerReply> {
  if (testTransport) return testTransport(req);
  const provider = providerOf(req.model);
  const model = req.model.slice(req.model.indexOf(':') + 1);
  if (provider === 'anthropic') {
    const j = await post(`${base(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com')}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model, max_tokens: req.maxTokens, ...anthropicThinking(model),
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: req.message }],
    }, req.signal);
    const u = j.usage;
    return { text: (j.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(''), refused: j.stop_reason === 'refusal',
      usage: counts(u?.input_tokens, u?.output_tokens, u?.cache_read_input_tokens ?? 0, u?.cache_creation_input_tokens ?? 0) };
  }
  if (provider === 'compat') {
    const j = await post(`${(req.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, {
      model, max_tokens: req.maxTokens, temperature: 0, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.message }],
    }, req.signal);
    const u = j.usage;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const choice = j.choices?.[0];
    return { text: typeof choice?.message?.content === 'string' ? choice.message.content : '', refused: choice?.finish_reason === 'content_filter' || Boolean(choice?.message?.refusal),
      usage: counts(u?.prompt_tokens - cached, u?.completion_tokens, cached) };
  }
  if (provider === 'openai') {
    const j = await post(`${base(env, 'OPENAI_BASE_URL', 'https://api.openai.com')}/v1/responses`, { authorization: `Bearer ${key}` }, {
      model, instructions: req.system, input: req.message, max_output_tokens: req.maxTokens, reasoning: { effort: OPENAI_EFFORT_LOW.test(model) ? 'low' : 'none' },
    }, req.signal);
    const u = j.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const text = (j.output ?? []).flatMap((o: any) => o?.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text).join('');
    return { text, refused: (j.output ?? []).some((o: any) => (o?.content ?? []).some((c: any) => c?.type === 'refusal')), usage: counts(u?.input_tokens - cached, u?.output_tokens, cached) };
  }
  const j = await post(`${base(env, 'GOOGLE_GENERATIVE_AI_BASE_URL', 'https://generativelanguage.googleapis.com')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, {
    systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.message }] }],
    generationConfig: { maxOutputTokens: req.maxTokens, temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' } },
  }, req.signal);
  const u = j.usageMetadata;
  const cand = j.candidates?.[0];
  const cached = u?.cachedContentTokenCount ?? 0;
  return { text: (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join(''), refused: cand?.finishReason === 'SAFETY' || Boolean(j.promptFeedback?.blockReason),
    usage: counts(u?.promptTokenCount - cached, u?.candidatesTokenCount + (u?.thoughtsTokenCount ?? 0), cached) };
}
