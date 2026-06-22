import { createHash } from 'node:crypto';
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
  label?: unknown;
  sub_label?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  actual_cost_usd?: unknown;
  projected_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
  dry_run?: unknown;
  simulated?: unknown;
  test?: unknown;
  fixture?: unknown;
}

export const MONTHLY_CHAT_MAX_USD_CONFIG_KEY = 'budget.monthly.chat_max_usd';
export const MONTHLY_MODE_CONFIG_KEY = 'budget.monthly.mode';

const DEFAULT_PROVIDER_IDS = ['anthropic', 'deepseek'] as const;

export type BudgetAuditAccountingKind =
  | 'provider_billed_candidate'
  | 'estimate_or_reservation'
  | 'fallback_or_error'
  | 'test_or_simulated'
  | 'ignored';

export interface BudgetAuditClassification {
  kind: BudgetAuditAccountingKind;
  reason: string;
}

export interface BudgetAuditQuarantineEntry {
  fingerprint: string;
  reason: string;
}

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

export function classifyBudgetAuditRow(row: BudgetAuditRecord): BudgetAuditClassification {
  const event = stringValue(row.event);
  const label = stringValue(row.label);
  const subLabel = stringValue(row.sub_label);
  const model = stringValue(row.model);
  const actualCost = finiteNumber(row.actual_cost_usd);
  const projectedCost = firstFiniteNumber(row.projected_cost_usd, row.estimated_cost_usd);

  if (isTestOrSimulatedAuditRow(row, label, subLabel, model)) {
    return { kind: 'test_or_simulated', reason: 'test_or_simulated_row' };
  }

  if (actualCost !== null && isFallbackOrErrorAuditRow(event, label, subLabel)) {
    return { kind: 'fallback_or_error', reason: 'fallback_or_error_accounting' };
  }

  if (isEstimateOrReservationAuditRow(event, actualCost, projectedCost)) {
    return { kind: 'estimate_or_reservation', reason: event ?? 'projected_cost_only' };
  }

  if (event === 'record' && actualCost !== null) {
    return { kind: 'provider_billed_candidate', reason: 'actual_provider_record' };
  }

  return { kind: 'ignored', reason: event ?? 'unclassified_row' };
}

export function budgetAuditRowFingerprint(row: BudgetAuditRecord): string {
  const stable = {
    ts: stringValue(row.ts),
    event: stringValue(row.event),
    kind: stringValue(row.kind),
    model: stringValue(row.model),
    label: stringValue(row.label),
    sub_label: stringValue(row.sub_label),
    input_tokens: finiteNumber(row.input_tokens),
    output_tokens: finiteNumber(row.output_tokens),
    actual_cost_usd: finiteNumber(row.actual_cost_usd),
    projected_cost_usd: firstFiniteNumber(row.projected_cost_usd, row.estimated_cost_usd),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function readBudgetAuditQuarantineDir(auditDir: string): Map<string, string> {
  const path = join(auditDir, 'budget-quarantine.jsonl');
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  let text = '';
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return entries;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BudgetAuditQuarantineEntry>;
      if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0) continue;
      entries.set(parsed.fingerprint, typeof parsed.reason === 'string' && parsed.reason.length > 0
        ? parsed.reason
        : 'quarantined_local_audit_row');
    } catch {
      continue;
    }
  }
  return entries;
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
  const quarantine = readBudgetAuditQuarantineDir(dirname(opts.auditPath));
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
      if (quarantine.has(budgetAuditRowFingerprint(row))) continue;
      if (classifyBudgetAuditRow(row).kind !== 'provider_billed_candidate') continue;
      if (typeof row.ts !== 'string') continue;
      const ts = new Date(row.ts);
      if (Number.isNaN(ts.getTime())) continue;
      if (monthKey(ts) !== targetMonth) continue;
      spent += row.actual_cost_usd;
    }
  }

  return spent;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim().replace(/^\$/, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function truthyAuditFlag(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function isTestOrSimulatedAuditRow(
  row: BudgetAuditRecord,
  label: string | null,
  subLabel: string | null,
  model: string | null,
): boolean {
  if (truthyAuditFlag(row.test) || truthyAuditFlag(row.fixture) || truthyAuditFlag(row.simulated) || truthyAuditFlag(row.dry_run)) {
    return true;
  }
  if (model?.startsWith('local-chat:') || model?.includes('unpriced-test-model')) return true;
  const fields = [label, subLabel].filter((value): value is string => value !== null);
  return fields.some((value) => {
    const normalized = value.toLowerCase();
    return normalized === 'test'
      || normalized === 'unit'
      || normalized.startsWith('test.')
      || normalized.startsWith('unit.')
      || normalized.endsWith('.test')
      || normalized.endsWith('.unit')
      || normalized.includes('fixture')
      || normalized.includes('simulated')
      || normalized === 'outer-test'
      || normalized === 'outer-tight';
  });
}

function isFallbackOrErrorAuditRow(
  event: string | null,
  label: string | null,
  subLabel: string | null,
): boolean {
  if (event !== 'record') return false;
  const fields = [label, subLabel].filter((value): value is string => value !== null);
  return fields.some((value) => {
    const normalized = value.toLowerCase();
    return normalized.includes('.failed.fallback')
      || normalized.includes(':failed:fallback')
      || normalized.includes('fallback_error')
      || normalized.includes('fallback-on-error')
      || normalized.includes('error_fallback');
  });
}

function isEstimateOrReservationAuditRow(
  event: string | null,
  actualCost: number | null,
  projectedCost: number | null,
): boolean {
  if (event === 'reserve'
    || event === 'reserve_denied'
    || event === 'reserve_unpriced'
    || event === 'monthly_budget_warn'
    || event === 'monthly_budget_denied'
    || event === 'runtime_denied') {
    return true;
  }
  return actualCost === null && projectedCost !== null;
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
