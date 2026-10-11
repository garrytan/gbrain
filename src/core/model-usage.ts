/**
 * Ordinary-model capability metadata and legacy configuration compatibility.
 *
 * Config (file plane ~/.gbrain/config.json or ~/.pmbrain/config.json):
 *   model_usage.generative_enabled: boolean
 * The legacy key is retained for older clients, but ordinary model use is now
 * automatic whenever a model is configured.
 */

import type { GBrainConfig } from './config.ts';
import { loadConfig, saveConfig, writeFileConfigValue } from './config.ts';
import type { CyclePhase } from './cycle.ts';
import {
  GENERATIVE_MODEL_DISABLED_CODE,
  GENERATIVE_MODEL_DISABLED_MESSAGE,
  GenerativeModelDisabledError,
  isGenerativeModelEnabled,
} from './model-usage-gate.ts';

export {
  GENERATIVE_MODEL_DISABLED_CODE,
  GENERATIVE_MODEL_DISABLED_MESSAGE,
  GenerativeModelDisabledError,
  isGenerativeModelEnabled,
} from './model-usage-gate.ts';

export type GenerativePhaseKind = 'local' | 'generative';

export interface PhaseCapability {
  id: CyclePhase;
  requiresGenerativeModel: boolean;
  kind: GenerativePhaseKind;
  /** Short Chinese label for UI. */
  labelZh: string;
}

/**
 * Audit-backed capability map. `requiresGenerativeModel` is true when the
 * phase calls gateway.chat / subagent LLM / conversation-fact LLM paths.
 * Pure deterministic / vector / FS phases stay false.
 */
const PHASE_REQUIRES_GENERATIVE: Record<CyclePhase, boolean> = {
  lint: false,
  backlinks: false,
  sync: false,
  extract: false,
  extract_facts: false,
  resolve_symbol_edges: false,
  recompute_emotional_weight: false,
  embed: false,
  orphans: false,
  purge: false,
  // consolidate currently promotes facts→takes without LLM (embedding cosine).
  consolidate: false,
  synthesize: true,
  extract_atoms: true,
  patterns: true,
  synthesize_concepts: true,
  propose_takes: true,
  grade_takes: true,
  calibration_profile: true,
  conversation_facts_backfill: true,
  capture_entities: true,
  // Runtime is heuristic-only today (LLM path deferred); do not block local suggest.
  'schema-suggest': false,
  drift: true,
  enrich_thin: true,
};

const PHASE_LABEL_ZH: Record<CyclePhase, string> = {
  lint: '页面格式检查',
  backlinks: '反向链接',
  sync: '同步资料',
  synthesize: '综合会话与会议',
  extract: '提取链接与时间线',
  extract_facts: '同步 Facts 区域',
  extract_atoms: '抽取原子知识',
  resolve_symbol_edges: '解析符号关系',
  patterns: '发现跨文档模式',
  synthesize_concepts: '合成高级概念',
  recompute_emotional_weight: '重算情感权重',
  consolidate: '合并重复事实',
  propose_takes: '生成观点提案',
  grade_takes: '评分观点',
  calibration_profile: '认知校准画像',
  drift: '漂移检测',
  conversation_facts_backfill: '会话事实回填',
  capture_entities: '识别实体',
  enrich_thin: '补全薄弱页面',
  embed: '向量化',
  orphans: '孤立页检查',
  'schema-suggest': '结构建议',
  purge: '清理过期删除',
};

export function phaseRequiresGenerativeModel(phase: CyclePhase | string): boolean {
  return Object.prototype.hasOwnProperty.call(PHASE_REQUIRES_GENERATIVE, phase)
    && PHASE_REQUIRES_GENERATIVE[phase as CyclePhase] === true;
}

export function getPhaseCapabilities(): PhaseCapability[] {
  return (Object.keys(PHASE_REQUIRES_GENERATIVE) as CyclePhase[]).map((id) => {
    const requiresGenerativeModel = PHASE_REQUIRES_GENERATIVE[id] === true;
    return {
      id,
      requiresGenerativeModel,
      kind: requiresGenerativeModel ? 'generative' : 'local',
      labelZh: PHASE_LABEL_ZH[id] ?? id,
    };
  });
}

export function assertGenerativeModelEnabled(config?: GBrainConfig | null): void {
  if (!isGenerativeModelEnabled(config)) {
    throw new GenerativeModelDisabledError();
  }
}

export function setGenerativeModelEnabled(enabled: boolean, config?: GBrainConfig | null): GBrainConfig {
  const base = (config ?? loadConfig() ?? { engine: 'pglite' }) as GBrainConfig;
  writeFileConfigValue(base, 'model_usage.generative_enabled', enabled);
  saveConfig(base);
  return base;
}

export function listGenerativePhases(phases: readonly string[]): string[] {
  return phases.filter((p) => phaseRequiresGenerativeModel(p));
}

export function assertPhasesAllowGenerative(
  phases: readonly string[] | undefined,
  config?: GBrainConfig | null,
): void {
  if (isGenerativeModelEnabled(config)) return;
  if (!phases || phases.length === 0) {
    // Full cycle without filter includes generative phases.
    throw new GenerativeModelDisabledError();
  }
  const blocked = listGenerativePhases(phases);
  if (blocked.length > 0) {
    throw new GenerativeModelDisabledError(
      `${GENERATIVE_MODEL_DISABLED_MESSAGE}（阶段：${blocked.join(', ')}）`,
    );
  }
}

export function assertDreamPresetAllowGenerative(
  preset: 'full' | 'meeting' | 'quick' | string | null | undefined,
  config?: GBrainConfig | null,
): void {
  if (isGenerativeModelEnabled(config)) return;
  if (preset === 'full' || preset === 'meeting') {
    throw new GenerativeModelDisabledError(
      `${GENERATIVE_MODEL_DISABLED_MESSAGE}（禁止 preset: ${preset}）`,
    );
  }
}

export function generativeCapabilitySummary(config?: GBrainConfig | null) {
  const enabled = isGenerativeModelEnabled(config);
  return {
    generative_enabled: enabled,
    capabilities: {
      semantic_search: true,
      hybrid_search: true,
      vectorization: true,
      quick_maintenance: true,
      ai_deep_organize: enabled,
      ai_meeting_organize: enabled,
    },
  };
}

export function errorPayloadFromGenerativeDisabled(err: unknown): {
  code: typeof GENERATIVE_MODEL_DISABLED_CODE;
  message: string;
} | null {
  if (err instanceof GenerativeModelDisabledError) {
    return { code: err.code, message: err.message };
  }
  if (err && typeof err === 'object' && (err as { code?: string }).code === GENERATIVE_MODEL_DISABLED_CODE) {
    return {
      code: GENERATIVE_MODEL_DISABLED_CODE,
      message: (err as Error).message || GENERATIVE_MODEL_DISABLED_MESSAGE,
    };
  }
  return null;
}
