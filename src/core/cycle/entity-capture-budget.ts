import { splitProviderModelId } from '../model-id.ts';
import { serviceNeedsApiKey } from '../../../shared/model-services.ts';

export const DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY = 5;
export const DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS = 1_000_000;
export const DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS = 200_000;
export const ENTITY_CAPTURE_CANDIDATE_LIMIT = 60;

export type CaptureStopReason = 'completed' | 'tokens' | 'cost' | 'failure' | 'ingest_validation' | 'relation_failure' | 'aborted' | 'user_stop' | 'service_shutdown' | 'model_unavailable'|'truncated'|'parse'|'timeout'|'network'|'rate_limit'|'provider_5xx';

import { CJK_PLAIN_MENTION_BLOCKLIST } from '../pmbrain-adapters/mention-policy.ts';
export { CJK_PLAIN_MENTION_BLOCKLIST };

const BLOCKED_SURFACES = new Set<string>(CJK_PLAIN_MENTION_BLOCKLIST);
const HAN_RE = /\p{Script=Han}/gu;

export interface CaptureEntityBrief {
  slug: string;
  sourceId: string;
  type: string;
  title: string;
  aliases: string[];
}

export interface CaptureUsage {
  present: boolean;
  input: number;
  output: number;
}

export function isOllamaModel(model: string, providerId: string | null | undefined): boolean {
  const provider = (providerId ?? '').toLowerCase();
  const id = model.toLowerCase();
  return provider === 'ollama' || id.startsWith('ollama:') || id.includes(':ollama:');
}

export function readEntityCaptureCostCap(stored: string | null | undefined): number | null {
  if (stored == null || stored.trim() === '') return DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY;
  if (stored.trim().toLowerCase() === 'unlimited') return null;
  const amount = Number(stored);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY;
  return amount;
}

export function parseEntityCaptureCostCapInput(raw: unknown): number | null | undefined {
  if (raw === 'unlimited') return null;
  if (raw === '1' || raw === '5' || raw === '20' || raw === 1 || raw === 5 || raw === 20) return Number(raw);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const amount = Number(raw.trim());
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return undefined;
}

export function readTokenCap(stored: string | null | undefined, fallback: number): number {
  if (stored == null || stored.trim() === '') return fallback;
  const amount = Number(stored);
  if (!Number.isInteger(amount) || amount < 1) return fallback;
  return amount;
}

export function usageFromJobResult(result: Record<string, unknown> | null | undefined): CaptureUsage {
  const tokens = result?.tokens;
  if (!tokens || typeof tokens !== 'object') return { present: false, input: 0, output: 0 };
  const record = tokens as Record<string, unknown>;
  if (record.missing === true) return { present: false, input: 0, output: 0 };
  if (typeof record.in === 'number' && Number.isFinite(record.in)
    && typeof record.out === 'number' && Number.isFinite(record.out)) {
    return { present: true, input: record.in, output: record.out };
  }
  return { present: false, input: 0, output: 0 };
}

export function captureChunkCostCny(input: {
  usage: CaptureUsage;
  inputPriceCnyPerMillion: number | null;
  outputPriceCnyPerMillion: number | null;
  ollama: boolean;
}): number | null {
  if (input.ollama) return 0;
  if (!input.usage.present) return null;
  if (input.inputPriceCnyPerMillion == null || input.outputPriceCnyPerMillion == null) return null;
  return (input.usage.input / 1_000_000) * input.inputPriceCnyPerMillion
    + (input.usage.output / 1_000_000) * input.outputPriceCnyPerMillion;
}

export function captureBudgetStop(state: {
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  usageKnown: boolean;
  costCny: number | null;
  costCapCny: number | null;
}): 'tokens' | 'cost' | null {
  if (state.usageKnown && (
    state.inputTokens >= state.maxInputTokens || state.outputTokens >= state.maxOutputTokens
  )) return 'tokens';
  if (state.costCapCny != null && state.costCny != null && state.costCny >= state.costCapCny) return 'cost';
  return null;
}

export interface CaptureServiceRecord {
  id?: string;
  provider?: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export interface CaptureModelRef {
  model: string;
  source: string;
}

export type CaptureModelChoice =
  | { ok: true; model: string; source: string }
  | { ok: false; model: string | null; source: string | null; reason: 'provider_disabled' | 'missing_key' | 'unconfigured' };

function captureProvider(model: string): string {
  return (splitProviderModelId(model).provider ?? '').toLowerCase();
}

function serviceProvider(service: CaptureServiceRecord): string {
  return (service.provider || service.id || '').toLowerCase();
}

export function captureServiceReady(
  services: CaptureServiceRecord[] | null | undefined,
  model: string,
): { ready: true } | { ready: false; reason: 'provider_disabled' | 'missing_key' } {
  if (!services || services.length === 0) return { ready: true };
  const provider = captureProvider(model);
  const matched = services.filter(service => serviceProvider(service) === provider);
  if (matched.length === 0) return { ready: true };
  const enabled = matched.filter(service => service.enabled === true);
  if (enabled.length === 0) return { ready: false, reason: 'provider_disabled' };
  const usable = enabled.find(service => {
    const baseUrl = service.baseUrl ?? '';
    if (!serviceNeedsApiKey(provider, baseUrl)) return true;
    return (service.apiKey ?? '').trim().length > 0;
  });
  if (!usable) return { ready: false, reason: 'missing_key' };
  return { ready: true };
}

export function selectReadyCaptureModel(input: {
  explicit: CaptureModelRef | null;
  candidates: CaptureModelRef[];
  services: CaptureServiceRecord[] | null | undefined;
}): CaptureModelChoice {
  if (input.explicit?.model.trim()) {
    const model = input.explicit.model.trim();
    const ready = captureServiceReady(input.services, model);
    if (!ready.ready) return { ok: false, model, source: input.explicit.source, reason: ready.reason };
    return { ok: true, model, source: input.explicit.source };
  }
  let last: { model: string; source: string; reason: 'provider_disabled' | 'missing_key' } | null = null;
  for (const candidate of input.candidates) {
    const model = candidate.model.trim();
    if (!model) continue;
    const ready = captureServiceReady(input.services, model);
    if (ready.ready) return { ok: true, model, source: candidate.source };
    last = { model, source: candidate.source, reason: ready.reason };
  }
  if (last) return { ok: false, model: last.model, source: last.source, reason: last.reason };
  return { ok: false, model: null, source: null, reason: 'unconfigured' };
}

const STOP_REASON_TEXT: Record<CaptureStopReason, string> = {
  truncated:'模型输出被截断，失败页面可继续',
  parse:'模型输出解析失败，失败页面可继续',
  timeout:'模型请求超时',
  network:'模型网络请求失败',
  rate_limit:'模型服务限流',
  provider_5xx:'模型服务端故障',
  completed: '已完成',
  tokens: 'Token 到上限',
  cost: '费用到上限',
  failure: '模型调用失败',
  ingest_validation: '实体落库验收失败',
  relation_failure: '关系对账失败',
  aborted: '操作已中止',
  user_stop: '用户停止',
  service_shutdown: '本地服务关闭，任务可继续',
  model_unavailable: '实体识别模型不可用',
};

export function captureReportLine(input: {
  model: string | null;
  pagesProcessed: number;
  pagesRemaining: number;
  entitiesCreated: number;
  relationsCreated: number;
  costCny: number | null;
  costCapCny: number | null;
  ollama: boolean;
  stopReason: CaptureStopReason;
  integrity?: {
    recognized: number;
    linked: number;
    isolated: number;
    unlinkedMentions: number;
  };
}): string {
  const cost = input.ollama
    ? '0 元（本地模型）'
    : input.costCny == null ? '未统计' : `${input.costCny} 元`;
  const cap = input.costCny==null&&!input.ollama&&input.costCapCny!=null ? '金额上限无法核算，未生效；按 Token 限制'
    : input.costCapCny == null ? '不限制' : `${input.costCapCny} 元`;
  const base = `使用模型 ${input.model ?? '未选择'}。已处理 ${input.pagesProcessed} 页，剩余 ${input.pagesRemaining} 页。创建实体 ${input.entitiesCreated}。新增关系 ${input.relationsCreated}。费用 ${cost} / ${cap}。停止原因：${STOP_REASON_TEXT[input.stopReason]}。`;
  if (!input.integrity) return base;
  const gap = input.integrity;
  return `${base}关系检查：识别实体 ${gap.recognized}，已关联 ${gap.linked}，孤立实体 ${gap.isolated}，未关联提及 ${gap.unlinkedMentions}。`;
}

interface PricedModel {
  id?: string;
  inputPrice?: number;
  outputPrice?: number;
  inputPriceCny?: number;
  outputPriceCny?: number;
}

export function readModelCnyPrices(
  services: Array<{ provider?: string; models?: PricedModel[] }>,
  model: string,
  providerId: string | null | undefined,
): { input: number | null; output: number | null } {
  const colon = model.indexOf(':');
  const bare = colon > 0 ? model.slice(colon + 1) : model;
  const provider = (providerId ?? (colon > 0 ? model.slice(0, colon) : '')).toLowerCase();
  for (const service of services) {
    if (provider && (service.provider ?? '').toLowerCase() !== provider) continue;
    for (const item of service.models ?? []) {
      if (item.id !== bare && item.id !== model) continue;
      return { input: finitePrice(item.inputPriceCny), output: finitePrice(item.outputPriceCny) };
    }
  }
  return { input: null, output: null };
}

function finitePrice(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function hanCount(text: string): number {
  HAN_RE.lastIndex = 0;
  return Array.from(text.matchAll(HAN_RE)).length;
}

function mentionableSurface(surface: string): boolean {
  const han = hanCount(surface);
  if (han > 0) return han >= 2;
  return surface.length >= 4;
}

export function rankCaptureCandidates(
  text: string,
  entities: CaptureEntityBrief[],
  opts: { limit?: number; sourceId?: string } = {},
): CaptureEntityBrief[] {
  const cap = Math.min(100, Math.max(1, opts.limit ?? ENTITY_CAPTURE_CANDIDATE_LIMIT));
  const haystack = text.normalize('NFKC').toLowerCase();
  const preferred = opts.sourceId ?? '';
  const ranked = entities.flatMap(entity => {
    let score = 0;
    const surfaces = [entity.title, ...entity.aliases];
    for (const raw of surfaces) {
      const surface = raw.normalize('NFKC').trim();
      if (!mentionableSurface(surface)) continue;
      if (!haystack.includes(surface.toLowerCase())) continue;
      score += BLOCKED_SURFACES.has(surface) ? 20 : 100 + surface.length;
    }
    if (score <= 0) return [];
    const sameSource = preferred !== '' && entity.sourceId === preferred ? 1 : 0;
    return [{ entity, score, sameSource }];
  });
  ranked.sort((a, b) => b.score - a.score || b.sameSource - a.sameSource || a.entity.slug.localeCompare(b.entity.slug));
  return ranked.slice(0, cap).map(item => item.entity);
}

export function deltaCaptureNeedles(
  before: CaptureEntityBrief[],
  after: CaptureEntityBrief[],
): Array<{ sourceId: string; needle: string }> {
  const previous = new Map(before.map(entity => [`${entity.sourceId}\0${entity.slug}`, entity]));
  const needles: Array<{ sourceId: string; needle: string }> = [];
  const seen = new Set<string>();
  const add = (sourceId: string, needle: string) => {
    const normalized = needle.normalize('NFKC').trim();
    if (!mentionableSurface(normalized)) return;
    const key = `${sourceId}\0${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    needles.push({ sourceId, needle: normalized });
  };
  for (const entity of after) {
    const old = previous.get(`${entity.sourceId}\0${entity.slug}`);
    if (!old) {
      add(entity.sourceId, entity.title);
      if (entity.slug.includes('/')) add(entity.sourceId, entity.slug);
      for (const alias of entity.aliases) add(entity.sourceId, alias);
      continue;
    }
    if (entity.title.normalize('NFKC').trim().toLowerCase() !== old.title.normalize('NFKC').trim().toLowerCase()) {
      add(entity.sourceId, entity.title);
    }
    const oldAliases = new Set(old.aliases.map(alias => alias.normalize('NFKC').trim().toLowerCase()));
    for (const alias of entity.aliases) {
      if (!oldAliases.has(alias.normalize('NFKC').trim().toLowerCase())) add(entity.sourceId, alias);
    }
  }
  return needles;
}
