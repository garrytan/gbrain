/**
 * Local budget ledger readback.
 *
 * Reads GBrain's budget audit JSONL files and optionally compares them with a
 * local provider receipt export. No DB, no provider API, no secrets.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveAuditDir } from '../core/audit-week-file.ts';
import {
  budgetAuditRowFingerprint,
  classifyBudgetAuditRow,
  providerForMonthlyBudget,
  readBudgetAuditQuarantineDir,
  type BudgetAuditAccountingKind,
} from '../core/budget/monthly-cap.ts';

export type BudgetProviderFilter = 'anthropic' | 'deepseek' | 'all';

export interface BudgetReconcileArgs {
  days: number;
  provider: BudgetProviderFilter;
  json: boolean;
  externalReceiptsPath: string | null;
  outPath: string | null;
  maxDeltaUsd: number | null;
  now: Date;
}

interface SpendRecord {
  ts: string;
  event: string | null;
  model: string | null;
  provider: string | null;
  label: string | null;
  subLabel: string | null;
  costUsd: number;
  projectedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sourceFile: string;
}

export interface BudgetSpendSummary {
  records: number;
  cost_usd: number;
  projected_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  estimated_input_tokens: number;
  max_output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  by_model: Array<{ model: string; records: number; cost_usd: number }>;
  by_label: Array<{ label: string; records: number; cost_usd: number }>;
}

export interface BudgetExcludedSpendSummary extends BudgetSpendSummary {
  by_kind: Array<{ kind: BudgetAuditAccountingKind; records: number; cost_usd: number; projected_cost_usd: number }>;
  by_reason: Array<{ reason: string; records: number; cost_usd: number; projected_cost_usd: number }>;
}

export interface BudgetNonBilledSummary {
  estimates: BudgetSpendSummary;
  fallback_error: BudgetSpendSummary;
  test_simulated: BudgetSpendSummary;
}

export interface BudgetReconcileReport {
  schema_version: 1;
  window: { since: string; until: string; days: number };
  provider: BudgetProviderFilter;
  internal: BudgetSpendSummary & { audit_dir: string; files_read: string[] };
  non_billed_internal: BudgetNonBilledSummary;
  excluded_internal: BudgetExcludedSpendSummary;
  external: (BudgetSpendSummary & { path: string }) | null;
  comparison: {
    external_provided: boolean;
    delta_usd: number | null;
    within_one_cent: boolean | null;
    max_delta_usd: number | null;
    gate_passed: boolean | null;
  };
}

const HELP = `gbrain budget reconcile - local budget ledger readback

USAGE
  gbrain budget reconcile [--days N] [--provider anthropic|deepseek|all]
                           [--external-receipts PATH] [--max-delta-usd N]
                           [--out PATH] [--json]

WHAT IT DOES
  Reads ~/.gbrain/audit/budget-*.jsonl (or GBRAIN_AUDIT_DIR), separates provider
  billed-candidate usage from estimates, fallback/error accounting, and test or
  simulated rows. With --external-receipts, compares billed candidates against a
  local JSON/JSONL provider receipt export. It never calls Anthropic or any provider.

EXAMPLES
  gbrain budget reconcile --days 7
  gbrain budget reconcile --days 7 --external-receipts ~/Downloads/anthropic-usage.jsonl
  gbrain budget reconcile --days 7 --external-receipts ~/Downloads/anthropic-usage.jsonl --max-delta-usd 0.05
  gbrain budget reconcile --days 7 --json --out .context/budget-reconcile.json
`;

export async function runBudget(args: string[]): Promise<number> {
  const sub = args[0] ?? 'reconcile';
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub !== 'reconcile') {
    process.stderr.write(`Unknown budget subcommand: ${sub}\n\n${HELP}`);
    return 2;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: BudgetReconcileArgs;
  try {
    parsed = parseBudgetReconcileArgs(args.slice(1));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 2;
  }

  const report = buildBudgetReconcileReport(parsed);
  if (parsed.outPath) {
    const out = resolve(parsed.outPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    if (!parsed.json) process.stdout.write(`Wrote receipt: ${out}\n\n`);
  }
  process.stdout.write(parsed.json ? JSON.stringify(report, null, 2) + '\n' : formatBudgetReconcileText(report));
  return report.comparison.gate_passed === false ? 1 : 0;
}

export function parseBudgetReconcileArgs(args: string[], now = new Date()): BudgetReconcileArgs {
  let days = 7;
  let provider: BudgetProviderFilter = 'anthropic';
  let json = false;
  let externalReceiptsPath: string | null = null;
  let outPath: string | null = null;
  let maxDeltaUsd: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--days': {
        const raw = args[++i];
        if (!raw || !/^\d+$/.test(raw)) throw new Error('--days must be a positive integer');
        days = Number(raw);
        if (days <= 0) throw new Error('--days must be a positive integer');
        break;
      }
      case '--provider': {
        const raw = args[++i];
        if (raw !== 'anthropic' && raw !== 'deepseek' && raw !== 'all') {
          throw new Error('--provider must be anthropic, deepseek, or all');
        }
        provider = raw;
        break;
      }
      case '--external-receipts':
      case '--anthropic-receipts': {
        const raw = args[++i];
        if (!raw) throw new Error(`${a} requires a path`);
        externalReceiptsPath = raw;
        break;
      }
      case '--out': {
        const raw = args[++i];
        if (!raw) throw new Error('--out requires a path');
        outPath = raw;
        break;
      }
      case '--max-delta-usd': {
        const raw = args[++i];
        const parsed = numberFrom(raw);
        if (parsed === null || parsed < 0) throw new Error('--max-delta-usd must be a non-negative number');
        maxDeltaUsd = parsed;
        break;
      }
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`Unknown budget reconcile flag: ${a}`);
    }
  }

  if (maxDeltaUsd !== null && externalReceiptsPath === null) {
    throw new Error('--max-delta-usd requires --external-receipts');
  }

  return { days, provider, json, externalReceiptsPath, outPath, maxDeltaUsd, now };
}

export function buildBudgetReconcileReport(args: BudgetReconcileArgs): BudgetReconcileReport {
  const until = args.now;
  const since = new Date(until.getTime() - args.days * 24 * 60 * 60 * 1000);
  const auditDir = resolveAuditDir();
  const internalRead = readInternalBudgetRecords(auditDir, since, until, args.provider);
  const internalRecords = internalRead.billed;
  const externalRecords = args.externalReceiptsPath
    ? readExternalReceiptRecords(args.externalReceiptsPath, since, until, args.provider)
    : null;
  const internalSummary = summarizeRecords(internalRecords);
  const nonBilledSummary: BudgetNonBilledSummary = {
    estimates: summarizeRecords(internalRead.estimates.map((r) => r.record)),
    fallback_error: summarizeRecords(internalRead.fallbackError.map((r) => r.record)),
    test_simulated: summarizeRecords(internalRead.testSimulated.map((r) => r.record)),
  };
  const excludedSummary = summarizeExcludedRecords(internalRead.excluded);
  const externalSummary = externalRecords ? summarizeRecords(externalRecords) : null;
  const filesRead = Array.from(new Set([...internalRecords, ...internalRead.excluded.map((r) => r.record)].map((r) => r.sourceFile))).sort();

  const delta = externalSummary ? internalSummary.cost_usd - externalSummary.cost_usd : null;
  const gatePassed = args.maxDeltaUsd === null || delta === null
    ? null
    : Math.abs(delta) <= args.maxDeltaUsd;
  return {
    schema_version: 1,
    window: { since: since.toISOString(), until: until.toISOString(), days: args.days },
    provider: args.provider,
    internal: { ...internalSummary, audit_dir: auditDir, files_read: filesRead },
    non_billed_internal: nonBilledSummary,
    excluded_internal: excludedSummary,
    external: externalSummary && args.externalReceiptsPath
      ? { ...externalSummary, path: resolve(args.externalReceiptsPath) }
      : null,
    comparison: {
      external_provided: !!externalSummary,
      delta_usd: delta,
      within_one_cent: delta === null ? null : Math.abs(delta) <= 0.01,
      max_delta_usd: args.maxDeltaUsd,
      gate_passed: gatePassed,
    },
  };
}

function readInternalBudgetRecords(
  auditDir: string,
  since: Date,
  until: Date,
  provider: BudgetProviderFilter,
): {
  billed: SpendRecord[];
  estimates: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }>;
  fallbackError: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }>;
  testSimulated: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }>;
  excluded: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }>;
} {
  if (!existsSync(auditDir)) {
    return { billed: [], estimates: [], fallbackError: [], testSimulated: [], excluded: [] };
  }
  const files = readdirSync(auditDir)
    .filter((name) => name.endsWith('.jsonl') && (name.startsWith('budget-') || name === 'budget.jsonl'))
    .map((name) => join(auditDir, name));
  const quarantine = readBudgetAuditQuarantineDir(auditDir);
  const billed: SpendRecord[] = [];
  const estimates: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }> = [];
  const fallbackError: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }> = [];
  const testSimulated: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }> = [];
  const excluded: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }> = [];

  for (const file of files) {
    for (const row of readJsonRecords(file)) {
      if (row.kind !== 'chat') continue;
      const ts = timestampInWindow(row.ts, since, until);
      if (!ts) continue;
      const model = typeof row.model === 'string' ? row.model : null;
      const rowProvider = model ? providerForMonthlyBudget(model) : null;
      if (!providerMatches(rowProvider, provider, false)) continue;
      const costUsd = numberFrom(row.actual_cost_usd) ?? 0;
      const projectedCostUsd = firstNumber(row.projected_cost_usd, row.estimated_cost_usd) ?? 0;
      if (costUsd === 0 && projectedCostUsd === 0 && row.event !== 'reserve_unpriced') continue;
      const record = {
        ts,
        event: typeof row.event === 'string' ? row.event : null,
        model,
        provider: rowProvider,
        label: typeof row.label === 'string' ? row.label : null,
        subLabel: typeof row.sub_label === 'string' ? row.sub_label : null,
        costUsd,
        projectedCostUsd,
        inputTokens: numberFrom(row.input_tokens) ?? 0,
        outputTokens: numberFrom(row.output_tokens) ?? 0,
        estimatedInputTokens: numberFrom(row.estimated_input_tokens) ?? 0,
        maxOutputTokens: numberFrom(row.max_output_tokens) ?? 0,
        cacheReadTokens: numberFrom(row.cache_read_tokens) ?? 0,
        cacheCreationTokens: numberFrom(row.cache_creation_tokens) ?? 0,
        sourceFile: file,
      };
      let classification = classifyBudgetAuditRow(row);
      const quarantineReason = quarantine.get(budgetAuditRowFingerprint(row));
      if (quarantineReason) {
        classification = { kind: 'test_or_simulated', reason: quarantineReason };
      }
      if (classification.kind === 'provider_billed_candidate') {
        billed.push(record);
      } else if (classification.kind === 'estimate_or_reservation') {
        const item = { record, reason: classification.reason, kind: classification.kind };
        estimates.push(item);
        excluded.push(item);
      } else if (classification.kind === 'fallback_or_error') {
        const item = { record, reason: classification.reason, kind: classification.kind };
        fallbackError.push(item);
        excluded.push(item);
      } else if (classification.kind === 'test_or_simulated') {
        const item = { record, reason: classification.reason, kind: classification.kind };
        testSimulated.push(item);
        excluded.push(item);
      }
    }
  }

  return { billed, estimates, fallbackError, testSimulated, excluded };
}

function readExternalReceiptRecords(
  path: string,
  since: Date,
  until: Date,
  provider: BudgetProviderFilter,
): SpendRecord[] {
  const fullPath = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(fullPath)) throw new Error(`External receipt file not found: ${fullPath}`);
  const records: SpendRecord[] = [];
  for (const row of readJsonRecords(fullPath)) {
    const ts = timestampInWindow(row.ts ?? row.timestamp ?? row.created_at ?? row.date ?? row.time, since, until);
    if (!ts) continue;
    const model = stringFrom(row.model ?? row.model_id ?? row.modelId);
    const explicitProvider = stringFrom(row.provider ?? row.provider_id ?? row.providerId);
    const rowProvider = explicitProvider ?? (model ? providerForMonthlyBudget(model) : null);
    if (!providerMatches(rowProvider, provider, true)) continue;
    const costUsd = firstNumber(row.actual_cost_usd, row.cost_usd, row.amount_usd, row.total_usd, row.usd, row.amount);
    if (costUsd === null) continue;
    records.push({
      ts,
      event: stringFrom(row.event),
      model,
      provider: rowProvider,
      label: stringFrom(row.label ?? row.operation ?? row.event),
      subLabel: stringFrom(row.sub_label ?? row.subLabel),
      costUsd,
      projectedCostUsd: 0,
      inputTokens: firstNumber(row.input_tokens, row.inputTokens) ?? 0,
      outputTokens: firstNumber(row.output_tokens, row.outputTokens) ?? 0,
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      cacheReadTokens: firstNumber(row.cache_read_tokens, row.cacheReadTokens, row.cache_read_input_tokens) ?? 0,
      cacheCreationTokens: firstNumber(row.cache_creation_tokens, row.cacheCreationTokens, row.cache_creation_input_tokens) ?? 0,
      sourceFile: fullPath,
    });
  }
  return records;
}

function readJsonRecords(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, 'utf-8').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isObjectRecord) : [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isObjectRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore malformed receipt lines; the readback is best-effort.
    }
  }
  return rows;
}

function summarizeRecords(records: SpendRecord[]): BudgetSpendSummary {
  const modelMap = new Map<string, { records: number; cost_usd: number }>();
  const labelMap = new Map<string, { records: number; cost_usd: number }>();
  let cost = 0;
  let projectedCost = 0;
  let input = 0;
  let output = 0;
  let estimatedInput = 0;
  let maxOutput = 0;
  let cacheRead = 0;
  let cacheCreate = 0;

  for (const r of records) {
    cost += r.costUsd;
    projectedCost += r.projectedCostUsd;
    input += r.inputTokens;
    output += r.outputTokens;
    estimatedInput += r.estimatedInputTokens;
    maxOutput += r.maxOutputTokens;
    cacheRead += r.cacheReadTokens;
    cacheCreate += r.cacheCreationTokens;
    bump(modelMap, r.model ?? '(unknown)', r.costUsd);
    bump(labelMap, r.label ?? '(unlabeled)', r.costUsd);
  }

  return {
    records: records.length,
    cost_usd: roundUsd(cost),
    projected_cost_usd: roundUsd(projectedCost),
    input_tokens: input,
    output_tokens: output,
    estimated_input_tokens: estimatedInput,
    max_output_tokens: maxOutput,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    by_model: sortedModelBreakdown(modelMap),
    by_label: sortedLabelBreakdown(labelMap),
  };
}

function summarizeExcludedRecords(
  records: Array<{ record: SpendRecord; reason: string; kind: BudgetAuditAccountingKind }>,
): BudgetExcludedSpendSummary {
  const summary = summarizeRecords(records.map((r) => r.record));
  const reasonMap = new Map<string, { records: number; cost_usd: number }>();
  const kindMap = new Map<BudgetAuditAccountingKind, { records: number; cost_usd: number; projected_cost_usd: number }>();
  for (const { record, reason, kind } of records) {
    bump(reasonMap, reason, record.costUsd, record.projectedCostUsd);
    bumpKind(kindMap, kind, record.costUsd, record.projectedCostUsd);
  }
  return {
    ...summary,
    by_kind: sortedKindBreakdown(kindMap),
    by_reason: sortedReasonBreakdown(reasonMap),
  };
}

function formatBudgetReconcileText(report: BudgetReconcileReport): string {
  const lines: string[] = [];
  lines.push(`Budget readback (${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)} UTC)`);
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Provider-billed candidate usage: ${formatUsd(report.internal.cost_usd)} across ${report.internal.records} chat record(s)`);
  lines.push(`Not counted as provider spend: ${formatUsd(report.excluded_internal.cost_usd)} accounted / ${formatUsd(report.excluded_internal.projected_cost_usd)} projected across ${report.excluded_internal.records} audit row(s)`);
  lines.push(`Audit dir: ${report.internal.audit_dir}`);
  lines.push(`Audit files: ${report.internal.files_read.length > 0 ? report.internal.files_read.join(', ') : '(none with matching records)'}`);
  lines.push(`Tokens: input=${report.internal.input_tokens}, output=${report.internal.output_tokens}, cache_read=${report.internal.cache_read_tokens}, cache_create=${report.internal.cache_creation_tokens}`);
  lines.push('');
  lines.push('Top internal models:');
  for (const row of report.internal.by_model.slice(0, 5)) {
    lines.push(`  ${row.model}: ${formatUsd(row.cost_usd)} (${row.records})`);
  }
  if (report.internal.by_model.length === 0) lines.push('  (none)');
  lines.push('');
  lines.push('Top internal labels:');
  for (const row of report.internal.by_label.slice(0, 5)) {
    lines.push(`  ${row.label}: ${formatUsd(row.cost_usd)} (${row.records})`);
  }
  if (report.internal.by_label.length === 0) lines.push('  (none)');

  if (report.excluded_internal.records > 0) {
    lines.push('');
    lines.push('Not counted as provider spend:');
    lines.push(`  estimates/reservations: ${formatUsd(report.non_billed_internal.estimates.projected_cost_usd)} projected (${report.non_billed_internal.estimates.records})`);
    lines.push(`  fallback/error accounting: ${formatUsd(report.non_billed_internal.fallback_error.cost_usd)} accounted (${report.non_billed_internal.fallback_error.records})`);
    lines.push(`  test/simulated rows: ${formatUsd(report.non_billed_internal.test_simulated.cost_usd)} simulated (${report.non_billed_internal.test_simulated.records})`);
  }

  if (report.external) {
    lines.push('');
    lines.push(`External receipts: ${formatUsd(report.external.cost_usd)} across ${report.external.records} record(s)`);
    lines.push(`External path: ${report.external.path}`);
    lines.push(`Delta (billed candidates - external): ${formatUsd(report.comparison.delta_usd ?? 0)}`);
    lines.push(`Within one cent: ${report.comparison.within_one_cent ? 'yes' : 'no'}`);
    if (report.comparison.max_delta_usd !== null) {
      lines.push(`Gate: ${report.comparison.gate_passed ? 'PASS' : 'FAIL'} (max delta ${formatUsd(report.comparison.max_delta_usd)})`);
    }
  } else {
    lines.push('');
    lines.push('External receipts: not provided');
    lines.push('Compare only the provider-billed candidate total above with the Anthropic Console/API export for the same UTC window.');
    if (report.comparison.max_delta_usd !== null) {
      lines.push(`Gate: not evaluated (max delta ${formatUsd(report.comparison.max_delta_usd)} requires --external-receipts)`);
    }
  }
  return lines.join('\n') + '\n';
}

function providerMatches(rowProvider: string | null, filter: BudgetProviderFilter, allowUnknownExternal: boolean): boolean {
  if (filter === 'all') return true;
  if (rowProvider === filter) return true;
  return allowUnknownExternal && rowProvider === null;
}

function timestampInWindow(value: unknown, since: Date, until: Date): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (d < since || d > until) return null;
  return d.toISOString();
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    const n = numberFrom(v);
    if (n !== null) return n;
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^\$/, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function bump(
  map: Map<string, { records: number; cost_usd: number; projected_cost_usd?: number }>,
  key: string,
  cost: number,
  projectedCost = 0,
): void {
  const prev = map.get(key) ?? { records: 0, cost_usd: 0, projected_cost_usd: 0 };
  prev.records++;
  prev.cost_usd += cost;
  prev.projected_cost_usd = (prev.projected_cost_usd ?? 0) + projectedCost;
  map.set(key, prev);
}

function bumpKind(
  map: Map<BudgetAuditAccountingKind, { records: number; cost_usd: number; projected_cost_usd: number }>,
  key: BudgetAuditAccountingKind,
  cost: number,
  projectedCost: number,
): void {
  const prev = map.get(key) ?? { records: 0, cost_usd: 0, projected_cost_usd: 0 };
  prev.records++;
  prev.cost_usd += cost;
  prev.projected_cost_usd += projectedCost;
  map.set(key, prev);
}

function sortedModelBreakdown(
  map: Map<string, { records: number; cost_usd: number }>,
): Array<{ model: string; records: number; cost_usd: number }> {
  return Array.from(map.entries())
    .map(([model, value]) => ({ model, records: value.records, cost_usd: roundUsd(value.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.model.localeCompare(b.model));
}

function sortedLabelBreakdown(
  map: Map<string, { records: number; cost_usd: number }>,
): Array<{ label: string; records: number; cost_usd: number }> {
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, records: value.records, cost_usd: roundUsd(value.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.label.localeCompare(b.label));
}

function sortedReasonBreakdown(
  map: Map<string, { records: number; cost_usd: number; projected_cost_usd?: number }>,
): Array<{ reason: string; records: number; cost_usd: number; projected_cost_usd: number }> {
  return Array.from(map.entries())
    .map(([reason, value]) => ({
      reason,
      records: value.records,
      cost_usd: roundUsd(value.cost_usd),
      projected_cost_usd: roundUsd(value.projected_cost_usd ?? 0),
    }))
    .sort((a, b) => (b.cost_usd + b.projected_cost_usd) - (a.cost_usd + a.projected_cost_usd) || a.reason.localeCompare(b.reason));
}

function sortedKindBreakdown(
  map: Map<BudgetAuditAccountingKind, { records: number; cost_usd: number; projected_cost_usd: number }>,
): Array<{ kind: BudgetAuditAccountingKind; records: number; cost_usd: number; projected_cost_usd: number }> {
  return Array.from(map.entries())
    .map(([kind, value]) => ({
      kind,
      records: value.records,
      cost_usd: roundUsd(value.cost_usd),
      projected_cost_usd: roundUsd(value.projected_cost_usd),
    }))
    .sort((a, b) => (b.cost_usd + b.projected_cost_usd) - (a.cost_usd + a.projected_cost_usd) || a.kind.localeCompare(b.kind));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
