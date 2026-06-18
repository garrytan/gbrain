import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { splitProviderModelId } from '../model-id.ts';

export type MonthlyBudgetMode = 'warn' | 'block';

export interface MonthlyBudgetCap {
  /** Monthly USD ceiling for scoped cloud chat providers. */
  maxCostUsd: number;
  /** Warn logs an audit event and proceeds; block throws before the call. */
  mode: MonthlyBudgetMode;
  /**
   * Provider ids counted against this cap. Defaults to Anthropic + DeepSeek,
   * the current Claude + routine-workhorse posture.
   */
  providerIds?: readonly string[];
}

export interface MonthlyBudgetStatus {
  month: string;
  spentUsd: number;
  projectedUsd: number;
  afterUsd: number;
  capUsd: number;
  mode: MonthlyBudgetMode;
  providerIds: readonly string[];
}

export interface MonthlyBudgetReadOpts {
  auditPath: string;
  now?: Date;
  providerIds?: readonly string[];
}

interface BudgetAuditRecord {
  ts?: unknown;
  event?: unknown;
  kind?: unknown;
  model?: unknown;
  actual_cost_usd?: unknown;
}

export const MONTHLY_CHAT_MAX_USD_CONFIG_KEY = 'budget.monthly.chat_max_usd';
export const MONTHLY_MODE_CONFIG_KEY = 'budget.monthly.mode';

const DEFAULT_PROVIDER_IDS = ['anthropic', 'deepseek'] as const;

export function parseMonthlyBudgetMode(raw: string | null | undefined): MonthlyBudgetMode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return raw === 'warn' || raw === 'block' ? raw : undefined;
}

export function parseMonthlyBudgetMaxUsd(raw: string | null | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function resolveMonthlyBudgetCapFromEngine(
  engine: { getConfig(key: string): Promise<string | null | undefined> },
): Promise<MonthlyBudgetCap | undefined> {
  let rawMax: string | null | undefined;
  let rawMode: string | null | undefined;
  try {
    rawMax = await engine.getConfig(MONTHLY_CHAT_MAX_USD_CONFIG_KEY);
    rawMode = await engine.getConfig(MONTHLY_MODE_CONFIG_KEY);
  } catch {
    return undefined;
  }
  const maxCostUsd = parseMonthlyBudgetMaxUsd(rawMax);
  if (maxCostUsd === undefined) return undefined;
  return {
    maxCostUsd,
    mode: parseMonthlyBudgetMode(rawMode) ?? 'block',
  };
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function providerForMonthlyBudget(modelId: string): string | null {
  const { provider, model } = splitProviderModelId(modelId);
  if (provider) return provider;
  if (model.startsWith('claude-')) return 'anthropic';
  return null;
}

export function isModelInMonthlyBudgetScope(
  modelId: string,
  providerIds: readonly string[] = DEFAULT_PROVIDER_IDS,
): boolean {
  const provider = providerForMonthlyBudget(modelId);
  return provider !== null && providerIds.includes(provider);
}

function budgetAuditFilesForDir(auditPath: string): string[] {
  const dir = dirname(auditPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl') && (name.startsWith('budget-') || name === 'budget.jsonl'))
    .map((name) => join(dir, name));
}

function parseAuditLine(line: string): BudgetAuditRecord | null {
  try {
    const parsed = JSON.parse(line) as BudgetAuditRecord;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function readMonthlyChatSpendUsd(opts: MonthlyBudgetReadOpts): number {
  const targetMonth = monthKey(opts.now ?? new Date());
  const providerIds = opts.providerIds ?? DEFAULT_PROVIDER_IDS;
  let spent = 0;

  for (const file of budgetAuditFilesForDir(opts.auditPath)) {
    let text = '';
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const row = parseAuditLine(line);
      if (!row) continue;
      if (row.event !== 'record' || row.kind !== 'chat') continue;
      if (typeof row.model !== 'string' || !isModelInMonthlyBudgetScope(row.model, providerIds)) continue;
      if (typeof row.actual_cost_usd !== 'number' || !Number.isFinite(row.actual_cost_usd)) continue;
      if (typeof row.ts !== 'string') continue;
      const ts = new Date(row.ts);
      if (Number.isNaN(ts.getTime())) continue;
      if (monthKey(ts) !== targetMonth) continue;
      spent += row.actual_cost_usd;
    }
  }

  return spent;
}

export function evaluateMonthlyBudget(
  cap: MonthlyBudgetCap,
  opts: MonthlyBudgetReadOpts & { projectedUsd: number },
): MonthlyBudgetStatus | null {
  const providerIds = cap.providerIds ?? DEFAULT_PROVIDER_IDS;
  if (!Number.isFinite(cap.maxCostUsd) || cap.maxCostUsd < 0) return null;
  if (!Number.isFinite(opts.projectedUsd) || opts.projectedUsd < 0) return null;
  const spentUsd = readMonthlyChatSpendUsd({ ...opts, providerIds });
  return {
    month: monthKey(opts.now ?? new Date()),
    spentUsd,
    projectedUsd: opts.projectedUsd,
    afterUsd: spentUsd + opts.projectedUsd,
    capUsd: cap.maxCostUsd,
    mode: cap.mode,
    providerIds,
  };
}
