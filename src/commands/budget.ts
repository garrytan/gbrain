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

export type BudgetProviderFilter = 'anthropic' | 'deepseek' | 'all';

export interface BudgetReconcileArgs {
  days: number;
  provider: BudgetProviderFilter;
  json: boolean;
  externalReceiptsPath: string | null;
  outPath: string | null;
  now: Date;
}

interface SpendRecord {
  ts: string;
  model: string | null;
  provider: string | null;
  label: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sourceFile: string;
}

export interface BudgetSpendSummary {
  records: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  by_model: Array<{ model: string; records: number; cost_usd: number }>;
  by_label: Array<{ label: string; records: number; cost_usd: number }>;
}

export interface BudgetReconcileReport {
  schema_version: 1;
  window: { since: string; until: string; days: number };
  provider: BudgetProviderFilter;
  internal: BudgetSpendSummary & { audit_dir: string; files_read: string[] };
  external: (BudgetSpendSummary & { path: string }) | null;
  comparison: {
    external_provided: boolean;
    delta_usd: number | null;
    within_one_cent: boolean | null;
  };
}

const HELP = `gbrain budget reconcile - local budget ledger readback

USAGE
  gbrain budget reconcile [--days N] [--provider anthropic|deepseek|all]
                           [--external-receipts PATH] [--out PATH] [--json]

WHAT IT DOES
  Reads ~/.gbrain/audit/budget-*.jsonl (or GBRAIN_AUDIT_DIR) and totals recent
  paid-provider chat records. With --external-receipts, compares against a local
  JSON/JSONL provider receipt export. It never calls Anthropic or any provider.

EXAMPLES
  gbrain budget reconcile --days 7
  gbrain budget reconcile --days 7 --external-receipts ~/Downloads/anthropic-usage.jsonl
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
  return 0;
}

export function parseBudgetReconcileArgs(args: string[], now = new Date()): BudgetReconcileArgs {
  let days = 7;
  let provider: BudgetProviderFilter = 'anthropic';
  let json = false;
  let externalReceiptsPath: string | null = null;
  let outPath: string | null = null;

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
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`Unknown budget reconcile flag: ${a}`);
    }
  }

  return { days, provider, json, externalReceiptsPath, outPath, now };
}

export function buildBudgetReconcileReport(args: BudgetReconcileArgs): BudgetReconcileReport {
  const until = args.now;
  const since = new Date(until.getTime() - args.days * 24 * 60 * 60 * 1000);
  const auditDir = resolveAuditDir();
  const internalRecords = readInternalBudgetRecords(auditDir, since, until, args.provider);
  const externalRecords = args.externalReceiptsPath
    ? readExternalReceiptRecords(args.externalReceiptsPath, since, until, args.provider)
    : null;
  const internalSummary = summarizeRecords(internalRecords);
  const externalSummary = externalRecords ? summarizeRecords(externalRecords) : null;
  const filesRead = Array.from(new Set(internalRecords.map((r) => r.sourceFile))).sort();

  const delta = externalSummary ? internalSummary.cost_usd - externalSummary.cost_usd : null;
  return {
    schema_version: 1,
    window: { since: since.toISOString(), until: until.toISOString(), days: args.days },
    provider: args.provider,
    internal: { ...internalSummary, audit_dir: auditDir, files_read: filesRead },
    external: externalSummary && args.externalReceiptsPath
      ? { ...externalSummary, path: resolve(args.externalReceiptsPath) }
      : null,
    comparison: {
      external_provided: !!externalSummary,
      delta_usd: delta,
      within_one_cent: delta === null ? null : Math.abs(delta) <= 0.01,
    },
  };
}

function readInternalBudgetRecords(
  auditDir: string,
  since: Date,
  until: Date,
  provider: BudgetProviderFilter,
): SpendRecord[] {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir)
    .filter((name) => name.endsWith('.jsonl') && (name.startsWith('budget-') || name === 'budget.jsonl'))
    .map((name) => join(auditDir, name));
  const records: SpendRecord[] = [];

  for (const file of files) {
    for (const row of readJsonRecords(file)) {
      if (row.event !== 'record' || row.kind !== 'chat') continue;
      const ts = timestampInWindow(row.ts, since, until);
      if (!ts) continue;
      const model = typeof row.model === 'string' ? row.model : null;
      const rowProvider = model ? providerForBudgetModel(model) : null;
      if (!providerMatches(rowProvider, provider, false)) continue;
      const costUsd = numberFrom(row.actual_cost_usd);
      if (costUsd === null) continue;
      records.push({
        ts,
        model,
        provider: rowProvider,
        label: typeof row.label === 'string' ? row.label : null,
        costUsd,
        inputTokens: numberFrom(row.input_tokens) ?? 0,
        outputTokens: numberFrom(row.output_tokens) ?? 0,
        cacheReadTokens: numberFrom(row.cache_read_tokens) ?? 0,
        cacheCreationTokens: numberFrom(row.cache_creation_tokens) ?? 0,
        sourceFile: file,
      });
    }
  }

  return records;
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
    const rowProvider = explicitProvider ?? (model ? providerForBudgetModel(model) : null);
    if (!providerMatches(rowProvider, provider, true)) continue;
    const costUsd = firstNumber(row.actual_cost_usd, row.cost_usd, row.amount_usd, row.total_usd, row.usd, row.amount);
    if (costUsd === null) continue;
    records.push({
      ts,
      model,
      provider: rowProvider,
      label: stringFrom(row.label ?? row.operation ?? row.event),
      costUsd,
      inputTokens: firstNumber(row.input_tokens, row.inputTokens) ?? 0,
      outputTokens: firstNumber(row.output_tokens, row.outputTokens) ?? 0,
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
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;

  for (const r of records) {
    cost += r.costUsd;
    input += r.inputTokens;
    output += r.outputTokens;
    cacheRead += r.cacheReadTokens;
    cacheCreate += r.cacheCreationTokens;
    bump(modelMap, r.model ?? '(unknown)', r.costUsd);
    bump(labelMap, r.label ?? '(unlabeled)', r.costUsd);
  }

  return {
    records: records.length,
    cost_usd: roundUsd(cost),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    by_model: sortedModelBreakdown(modelMap),
    by_label: sortedLabelBreakdown(labelMap),
  };
}

function formatBudgetReconcileText(report: BudgetReconcileReport): string {
  const lines: string[] = [];
  lines.push(`Budget readback (${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)} UTC)`);
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Internal ledger: ${formatUsd(report.internal.cost_usd)} across ${report.internal.records} chat record(s)`);
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

  if (report.external) {
    lines.push('');
    lines.push(`External receipts: ${formatUsd(report.external.cost_usd)} across ${report.external.records} record(s)`);
    lines.push(`External path: ${report.external.path}`);
    lines.push(`Delta (internal - external): ${formatUsd(report.comparison.delta_usd ?? 0)}`);
    lines.push(`Within one cent: ${report.comparison.within_one_cent ? 'yes' : 'no'}`);
  } else {
    lines.push('');
    lines.push('External receipts: not provided');
    lines.push('Compare the internal total above with the Anthropic Console/API export for the same UTC window.');
  }
  return lines.join('\n') + '\n';
}

function providerMatches(rowProvider: string | null, filter: BudgetProviderFilter, allowUnknownExternal: boolean): boolean {
  if (filter === 'all') return true;
  if (rowProvider === filter) return true;
  return allowUnknownExternal && rowProvider === null;
}

function providerForBudgetModel(model: string): BudgetProviderFilter | null {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('anthropic:') || normalized.startsWith('claude-')) return 'anthropic';
  if (normalized.startsWith('deepseek:') || normalized.startsWith('deepseek-')) return 'deepseek';
  return null;
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

function bump(map: Map<string, { records: number; cost_usd: number }>, key: string, cost: number): void {
  const prev = map.get(key) ?? { records: 0, cost_usd: 0 };
  prev.records++;
  prev.cost_usd += cost;
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

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
