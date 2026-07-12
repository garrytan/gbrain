import { runCli, runCliChecked, type CliRuntime } from './cli-runner.js';

export const ADVANCED_MODEL_TIERS = ['utility', 'reasoning', 'deep', 'subagent'] as const;
export type AdvancedModelTier = typeof ADVANCED_MODEL_TIERS[number];

export interface AdvancedModelTierState {
  override: string;
  resolved: string;
  source: string;
}

export interface AdvancedModelConfig {
  tiers: Record<AdvancedModelTier, AdvancedModelTierState>;
}

export function suppliedAdvancedModelTiers(
  values: Partial<Record<AdvancedModelTier, string>>,
): AdvancedModelTier[] {
  return ADVANCED_MODEL_TIERS.filter((tier) => Object.prototype.hasOwnProperty.call(values, tier));
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

async function readOverride(runtime: CliRuntime, tier: AdvancedModelTier): Promise<string> {
  const result = await runCli(runtime, ['config', 'get', `models.tier.${tier}`]);
  if (result.code === 0) return lastOutputLine(result.stdout);
  const message = (result.stderr || result.stdout).trim();
  if (/Config key not found:/i.test(message)) return '';
  throw new Error(message || `读取 models.tier.${tier} 失败（退出码 ${result.code}）。`);
}

export async function readAdvancedModelConfig(runtime: CliRuntime): Promise<AdvancedModelConfig> {
  const reportResult = await runCliChecked(runtime, ['models', '--json']);
  const report = parseModelsJson(reportResult.stdout);
  const tiers = {} as Record<AdvancedModelTier, AdvancedModelTierState>;
  for (const tier of ADVANCED_MODEL_TIERS) {
    const entry = report.tiers?.[tier];
    tiers[tier] = {
      override: await readOverride(runtime, tier),
      resolved: entry?.resolved?.trim() || '',
      source: entry?.source?.trim() || '',
    };
  }
  return { tiers };
}

export async function writeAdvancedModelConfig(
  runtime: CliRuntime,
  values: Partial<Record<AdvancedModelTier, string>>,
): Promise<AdvancedModelConfig> {
  for (const tier of suppliedAdvancedModelTiers(values)) {
    const key = `models.tier.${tier}`;
    const next = values[tier]?.trim() ?? '';
    const current = await readOverride(runtime, tier);
    if (next === current) continue;
    if (next) await runCliChecked(runtime, ['config', 'set', key, next]);
    else if (current) await runCliChecked(runtime, ['config', 'unset', key]);
  }
  return readAdvancedModelConfig(runtime);
}
