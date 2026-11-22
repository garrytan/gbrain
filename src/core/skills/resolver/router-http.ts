/**
 * The model picker's chat call (router.ts), made over plain HTTPS to the
 * provider: Anthropic Messages, OpenAI Responses or Google generateContent.
 * It loads no AI gateway and no SDK, so the hook lane's worker and the
 * library's Node bundle stay small and engine-free. A key comes from the
 * environment, else from the file-plane config.json keys gbrain's gateway
 * reads (anthropic_api_key, openai_api_key, google_api_key; the canonical
 * fold is src/core/ai/provider-env.ts, including the GEMINI_API_KEY alias).
 * ANTHROPIC_BASE_URL, OPENAI_BASE_URL and GOOGLE_GENERATIVE_AI_BASE_URL point
 * a provider at a proxy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PICKER_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type PickerProvider = (typeof PICKER_PROVIDERS)[number];
export interface PickerRequest { model: string; system: string; message: string; maxTokens: number; signal: AbortSignal }
/** A reply; usage.input counts only uncached input tokens. */
export interface PickerReply { text: string; refused: boolean; usage: { input: number; cacheRead: number; cacheWrite: number; output: number } }

let testTransport: ((req: PickerRequest) => Promise<PickerReply>) | null = null;
/** Tests only: answer every picker call with `fn` (null restores the network). */
export function __setPickerTransportForTests(fn: ((req: PickerRequest) => Promise<PickerReply>) | null): void { testTransport = fn; }

const CONFIG_KEY: Record<PickerProvider, [string, string]> = {
  anthropic: ['anthropic_api_key', 'ANTHROPIC_API_KEY'],
  openai: ['openai_api_key', 'OPENAI_API_KEY'],
  google: ['google_api_key', 'GOOGLE_GENERATIVE_AI_API_KEY'],
};

export const providerOf = (model: string): PickerProvider | null => {
  const p = model.slice(0, model.indexOf(':'));
  return (PICKER_PROVIDERS as readonly string[]).includes(p) ? p as PickerProvider : null;
};

/** The key for `provider`, or null when none is configured. */
export function pickerKey(provider: PickerProvider, home: string, env: NodeJS.ProcessEnv): string | null {
  if (testTransport) return 'test';
  const [configKey, name] = CONFIG_KEY[provider];
  const fromEnv = env[name] || (provider === 'google' ? env.GEMINI_API_KEY : undefined);
  if (fromEnv) return fromEnv;
  try {
    const v = (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>)[configKey];
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

const base = (env: NodeJS.ProcessEnv, name: string, fallback: string) => (env[name] || fallback).replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`provider answered HTTP ${res.status}`);
  return await res.json() as Record<string, any>;
}

/** One picker call. Throws on a network or HTTP error and on an abort. */
export async function pickerChat(req: PickerRequest, key: string, env: NodeJS.ProcessEnv): Promise<PickerReply> {
  if (testTransport) return testTransport(req);
  const provider = providerOf(req.model);
  const model = req.model.slice(req.model.indexOf(':') + 1);
  if (provider === 'anthropic') {
    const j = await post(`${base(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com')}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model, max_tokens: req.maxTokens, thinking: { type: 'disabled' },
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: req.message }],
    }, req.signal);
    const u = j.usage ?? {};
    return { text: (j.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(''), refused: j.stop_reason === 'refusal',
      usage: { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 } };
  }
  if (provider === 'openai') {
    const j = await post(`${base(env, 'OPENAI_BASE_URL', 'https://api.openai.com')}/v1/responses`, { authorization: `Bearer ${key}` }, {
      model, instructions: req.system, input: req.message, max_output_tokens: req.maxTokens, reasoning: { effort: 'none' },
    }, req.signal);
    const u = j.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const text = (j.output ?? []).flatMap((o: any) => o?.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text).join('');
    return { text, refused: (j.output ?? []).some((o: any) => (o?.content ?? []).some((c: any) => c?.type === 'refusal')), usage: { input: Math.max(0, (u.input_tokens ?? 0) - cached), cacheRead: cached, cacheWrite: 0, output: u.output_tokens ?? 0 } };
  }
  const j = await post(`${base(env, 'GOOGLE_GENERATIVE_AI_BASE_URL', 'https://generativelanguage.googleapis.com')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, {
    systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.message }] }],
    generationConfig: { maxOutputTokens: req.maxTokens, temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' } },
  }, req.signal);
  const u = j.usageMetadata ?? {};
  const cand = j.candidates?.[0];
  const cached = u.cachedContentTokenCount ?? 0;
  return { text: (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join(''), refused: cand?.finishReason === 'SAFETY' || Boolean(j.promptFeedback?.blockReason),
    usage: { input: Math.max(0, (u.promptTokenCount ?? 0) - cached), cacheRead: cached, cacheWrite: 0, output: u.candidatesTokenCount ?? 0 } };
}
