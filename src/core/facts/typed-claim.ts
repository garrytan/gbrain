/**
 * Typed claims on saved facts (GBRA-216 PR B): the four optional claim
 * columns (claim_metric, claim_value, claim_unit, claim_period) a remember
 * call may set, validated by the facts-fence parser itself, and the as-of
 * bucket two claims share when they state the same figure.
 *
 * Validation is the fence codec as the oracle (the adoptableClaim pattern): a
 * value is accepted only when a fence row carrying it renders and parses back
 * to the same value, so a claim saved through remember reads back identically
 * from the entity page's facts fence on every brain. The period string is
 * free-form there, so no period list is enforced here.
 *
 * As-of bucket: a claim's valid_from day in UTC, or its ISO week, month,
 * quarter or year when claim_period names that cadence. Two values in one
 * bucket disagree; values in different buckets are history.
 */
import type { NewFact } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { parseFactsFence, parseNumericCell, renderFactsTable, type ParsedFact } from '../facts-fence.ts';

export const CLAIM_PARAM_KEYS = ['claim_metric', 'claim_value', 'claim_unit', 'claim_period'] as const;
export type ClaimParamKey = typeof CLAIM_PARAM_KEYS[number];

export interface TypedClaim { claim_metric: string; claim_value: number | null; claim_unit: string | null; claim_period: string | null }
type ClaimColumns = Pick<NewFact, ClaimParamKey>;
interface ClaimRow { claim_metric?: string | null; claim_value?: number | string | null; claim_unit?: string | null; claim_period?: string | null }

const STRING_COLUMNS = { claim_metric: 'claimMetric', claim_unit: 'claimUnit', claim_period: 'claimPeriod' } as const;

function parsedRow(cells: Partial<Pick<ParsedFact, 'claimMetric' | 'claimValue' | 'claimUnit' | 'claimPeriod'>>): ParsedFact | null {
  const row: ParsedFact = { rowNum: 1, claim: 'claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true, ...cells };
  const parsed = parseFactsFence(renderFactsTable([row]));
  return parsed.warnings.length || parsed.facts.length !== 1 ? null : parsed.facts[0]!;
}

/** The string a fence cell stores for value, or null when the cell would not read back as it. */
function fenceString(key: keyof typeof STRING_COLUMNS, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parsedRow({ [STRING_COLUMNS[key]]: trimmed })?.[STRING_COLUMNS[key]] === trimmed ? trimmed : null;
}

function fenceNumber(value: number): boolean {
  return Number.isFinite(value) && parsedRow({ claimValue: value })?.claimValue === value;
}

/**
 * The claim a call sets, or null when it sets none. Throws invalid_params
 * naming every bad key, with the corrected call (bad keys fixed where the
 * fence parser would read them, removed otherwise) as its fix.
 */
export function parseClaimParams(p: Record<string, unknown>, tool = 'remember'): TypedClaim | null {
  if (CLAIM_PARAM_KEYS.every(key => p[key] === undefined || p[key] === null)) return null;
  const problems: string[] = [];
  const corrected: Record<string, unknown> = {};
  for (const key of ['claim_metric', 'claim_unit', 'claim_period'] as const) {
    const raw = p[key];
    if (raw === undefined || raw === null) continue;
    const ok = typeof raw === 'string' ? fenceString(key, raw) : null;
    if (ok !== null) { corrected[key] = ok; continue; }
    problems.push(key + ' must be a non-empty string');
    const fixed = typeof raw === 'string' || typeof raw === 'number' ? fenceString(key, String(raw).replace(/<br\s*\/?>|\s+/gi, ' ')) : null;
    if (fixed !== null) corrected[key] = fixed;
  }
  const value = p.claim_value;
  if (value !== undefined && value !== null) {
    if (typeof value === 'number' && fenceNumber(value)) corrected.claim_value = value;
    else {
      problems.push('claim_value must be a finite number');
      const fixed = typeof value === 'string' ? parseNumericCell(value) : null;
      if (typeof fixed === 'number' && fenceNumber(fixed)) corrected.claim_value = fixed;
    }
  }
  if (p.claim_metric === undefined || p.claim_metric === null) problems.push('claim_metric is required with claim_value, claim_unit or claim_period');
  if (problems.length) throw claimParamsError(p, problems, corrected, tool);
  return { claim_metric: corrected.claim_metric as string, claim_value: (corrected.claim_value as number | undefined) ?? null,
    claim_unit: (corrected.claim_unit as string | undefined) ?? null, claim_period: (corrected.claim_period as string | undefined) ?? null };
}

function claimParamsError(p: Record<string, unknown>, problems: string[], corrected: Record<string, unknown>, tool: string): OperationError {
  const args: Record<string, unknown> = { ...p };
  delete args.request_id;
  for (const key of CLAIM_PARAM_KEYS) delete args[key];
  const kept = typeof corrected.claim_metric === 'string';
  if (kept) Object.assign(args, corrected);
  return opError('invalid_params', 'Invalid typed claim: ' + problems.join('; ') + '. Nothing was saved.',
    'Pass claim_metric as a short label (e.g. "mrr"), claim_value as a number (e.g. 50000), and optionally claim_unit (e.g. "USD") and claim_period (e.g. "monthly"); or omit all four to save the fact without a typed claim.',
    { fix: { mcp: { tool, arguments: args }, consent: [], actor: 'agent', requires_exclusive: false,
      why: kept ? 'The same call with the claim fields corrected to what the facts fence stores (a field that cannot be corrected is left out).'
        : 'The same call without the typed claim (a claim needs claim_metric); add claim_metric to keep the claim.' } });
}

/** The claim columns a stored row or payload carries, each only when set. */
export function claimColumns(row: ClaimRow | null | undefined): Partial<ClaimColumns> {
  if (!row?.claim_metric) return {};
  return { claim_metric: row.claim_metric,
    ...(row.claim_value !== null && row.claim_value !== undefined ? { claim_value: Number(row.claim_value) } : {}),
    ...(row.claim_unit ? { claim_unit: row.claim_unit } : {}), ...(row.claim_period ? { claim_period: row.claim_period } : {}) };
}

/** The claim a stored row carries, or null. */
export function storedClaim(row: ClaimRow | null | undefined): TypedClaim | null {
  const c = claimColumns(row);
  return c.claim_metric ? { claim_metric: c.claim_metric, claim_value: c.claim_value ?? null, claim_unit: c.claim_unit ?? null, claim_period: c.claim_period ?? null } : null;
}

const CADENCE: Record<string, 'week' | 'month' | 'quarter' | 'year'> = {
  weekly: 'week', monthly: 'month', quarterly: 'quarter', annual: 'year', annually: 'year', yearly: 'year',
};
const SQL_FORMAT = { year: 'YYYY', quarter: 'YYYY-"Q"Q', month: 'YYYY-MM', week: 'IYYY-"W"IW' } as const;
const pad = (n: number): string => String(n).padStart(2, '0');

/** The as-of bucket of a claim: its valid_from UTC day, or the ISO week, month, quarter or year its period names. */
export function claimBucket(period: string | null | undefined, validFrom: Date | string): string {
  const at = validFrom instanceof Date ? validFrom : new Date(validFrom);
  const y = at.getUTCFullYear(), m = at.getUTCMonth();
  switch (CADENCE[(period ?? '').trim().toLowerCase()]) {
    case 'year': return String(y);
    case 'quarter': return y + '-Q' + (Math.floor(m / 3) + 1);
    case 'month': return y + '-' + pad(m + 1);
    case 'week': {
      const day = new Date(Date.UTC(y, m, at.getUTCDate()));
      day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
      const isoYear = day.getUTCFullYear();
      return isoYear + '-W' + pad(Math.ceil(((day.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7));
    }
    default: return y + '-' + pad(m + 1) + '-' + pad(at.getUTCDate());
  }
}

/** claimBucket in SQL over a facts alias (both engines). */
export function claimBucketSql(alias: string): string {
  const period = "lower(btrim(COALESCE(" + alias + ".claim_period, '')))";
  const at = "(" + alias + ".valid_from AT TIME ZONE 'UTC')";
  const whens = (Object.keys(SQL_FORMAT) as Array<keyof typeof SQL_FORMAT>).map(c =>
    "WHEN " + period + " IN (" + Object.keys(CADENCE).filter(k => CADENCE[k] === c).map(k => "'" + k + "'").join(', ') + ") THEN to_char(" + at + ", '" + SQL_FORMAT[c] + "')");
  return "(CASE " + whens.join(' ') + " ELSE to_char(" + at + ", 'YYYY-MM-DD') END)";
}

interface SlotRow { claim_metric?: string | null; claim_unit?: string | null; claim_period?: string | null; valid_from: Date | string }

/**
 * Whether two facts state a claim for the same slot: both untyped, or the same
 * metric, unit and period (null-safe) in the same as-of bucket. Write-time
 * supersession never crosses slots, so a typed history point is never retired
 * by another metric's or another date's fact.
 */
export function sameClaimSlot(a: SlotRow, b: SlotRow): boolean {
  if (!a.claim_metric && !b.claim_metric) return true;
  return a.claim_metric === b.claim_metric && (a.claim_unit ?? null) === (b.claim_unit ?? null)
    && (a.claim_period ?? null) === (b.claim_period ?? null) && claimBucket(a.claim_period, a.valid_from) === claimBucket(b.claim_period, b.valid_from);
}
