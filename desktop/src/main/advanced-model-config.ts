import { runCli, runCliChecked, type CliRuntime } from './cli-runner.js';

export const ADVANCED_MODEL_TIERS = ['utility', 'reasoning', 'deep', 'subagent'] as const;
export type AdvancedModelTier = typeof ADVANCED_MODEL_TIERS[number];

/** Dream 阶段级覆盖：优先级高于 models.tier.* 与 models.default */
export const ADVANCED_MODEL_PHASES = [
  'propose_takes',
  'grade_takes',
  'calibration_profile',
] as const;
export type AdvancedModelPhase = typeof ADVANCED_MODEL_PHASES[number];

export const ADVANCED_PHASE_CONFIG_KEYS: Record<AdvancedModelPhase, string> = {
  propose_takes: 'models.propose_takes',
  grade_takes: 'models.grade_takes',
  calibration_profile: 'models.calibration_profile',
};

export interface AdvancedModelRouteState {
  override: string;
  resolved: string;
  source: string;
}

export type AdvancedModelTierState = AdvancedModelRouteState;

export interface AdvancedModelConfig {
  tiers: Record<AdvancedModelTier, AdvancedModelRouteState>;
  phases: Record<AdvancedModelPhase, AdvancedModelRouteState>;
}

/** 高级保存载荷：只提交调用方显式给出的字段（空字符串表示清除覆盖）。 */
export interface AdvancedModelWriteInput {
  tiers?: Partial<Record<AdvancedModelTier, string>>;
  phases?: Partial<Record<AdvancedModelPhase, string>>;
}

export function suppliedAdvancedModelTiers(
  values: Partial<Record<AdvancedModelTier, string>>,
): AdvancedModelTier[] {
  return ADVANCED_MODEL_TIERS.filter((tier) => Object.prototype.hasOwnProperty.call(values, tier));
}

export function suppliedAdvancedModelPhases(
  values: Partial<Record<AdvancedModelPhase, string>>,
): AdvancedModelPhase[] {
  return ADVANCED_MODEL_PHASES.filter((phase) => Object.prototype.hasOwnProperty.call(values, phase));
}

interface ModelsJsonReport {
  tiers?: Partial<Record<AdvancedModelTier, { resolved?: string; source?: string }>>;
}

function lastOutputLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

export function parseModelsJson(value: string): ModelsJsonReport {
  const output = value.trim();
  if (!output) throw new Error('PMBrain 没有返回模型路由信息。');
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  const json = start >= 0 && end >= start ? output.slice(start, end + 1) : output;
  try {
    return JSON.parse(json) as ModelsJsonReport;
  } catch (error) {
    throw new Error(`无法解析模型路由信息：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readConfigOverride(runtime: CliRuntime, key: string): Promise<string> {
  const result = await runCli(runtime, ['config', 'get', key]);
  if (result.code === 0) return lastOutputLine(result.stdout);
  const message = (result.stderr || result.stdout).trim();
  if (/Config key not found:/i.test(message)) return '';
  throw new Error(message || `读取 ${key} 失败（退出码 ${result.code}）。`);
}

async function writeConfigOverride(runtime: CliRuntime, key: string, next: string, current: string): Promise<void> {
  const normalized = next.trim();
  if (normalized === current) return;
  if (normalized) await runCliChecked(runtime, ['config', 'set', key, normalized]);
  else if (current) await runCliChecked(runtime, ['config', 'unset', key]);
}

export async function readAdvancedModelConfig(runtime: CliRuntime): Promise<AdvancedModelConfig> {
  const reportResult = await runCliChecked(runtime, ['models', '--json']);
  const report = parseModelsJson(reportResult.stdout);
  const tiers = {} as Record<AdvancedModelTier, AdvancedModelRouteState>;
  for (const tier of ADVANCED_MODEL_TIERS) {
    const entry = report.tiers?.[tier];
    tiers[tier] = {
      override: await readConfigOverride(runtime, `models.tier.${tier}`),
      resolved: entry?.resolved?.trim() || '',
      source: entry?.source?.trim() || '',
    };
  }

  // Dream 阶段默认挂在 reasoning tier；无阶段覆盖时展示继承解析结果。
  const reasoningResolved = tiers.reasoning.resolved;
  const reasoningSource = tiers.reasoning.source || 'models.tier.reasoning';
  const phases = {} as Record<AdvancedModelPhase, AdvancedModelRouteState>;
  for (const phase of ADVANCED_MODEL_PHASES) {
    const key = ADVANCED_PHASE_CONFIG_KEYS[phase];
    const override = await readConfigOverride(runtime, key);
    if (override) {
      phases[phase] = {
        override,
        resolved: override,
        source: key,
      };
    } else {
      phases[phase] = {
        override: '',
        resolved: reasoningResolved,
        source: reasoningSource ? `${reasoningSource}（继承）` : '继承推理任务/普通模型',
      };
    }
  }

  return { tiers, phases };
}

export async function writeAdvancedModelConfig(
  runtime: CliRuntime,
  values: AdvancedModelWriteInput,
): Promise<AdvancedModelConfig> {
  const tierValues = values.tiers ?? {};
  for (const tier of suppliedAdvancedModelTiers(tierValues)) {
    const key = `models.tier.${tier}`;
    const next = tierValues[tier] ?? '';
    const current = await readConfigOverride(runtime, key);
    await writeConfigOverride(runtime, key, next, current);
  }

  const phaseValues = values.phases ?? {};
  for (const phase of suppliedAdvancedModelPhases(phaseValues)) {
    const key = ADVANCED_PHASE_CONFIG_KEYS[phase];
    const next = phaseValues[phase] ?? '';
    const current = await readConfigOverride(runtime, key);
    await writeConfigOverride(runtime, key, next, current);
  }

  return readAdvancedModelConfig(runtime);
}
