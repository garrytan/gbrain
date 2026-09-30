/**
 * SQL-text normalizer for the refactor-wave-1 EO8 goldens
 * (`test/fixtures/goldens/sql-text/<domain>.json`).
 *
 * Contract a W1 conversion must satisfy, per engine method and variant: the
 * ordered trace (statements + transaction events) reproduces byte-for-byte
 * after this normalizer. For each statement that means
 *   - `textSha256`: sha256 of the EXACT text postgres.js sends, after only
 *     renumbering `$N` placeholders by occurrence (tagged `${a}..${a}` binds
 *     `$1,$2` while a positional rewrite may bind `$1,$1`; both become
 *     `$1,$2`). Whitespace, casts, comments and inlined literals are pinned.
 *   - `sql`: the same text with whitespace runs collapsed, for a readable diff
 *     when the hash moves.
 *   - `params`: the shape bound at each placeholder occurrence (never values).
 *   - `lane`: pool / tx / savepoint / reserved, so no conversion can add or drop
 *     a transaction or pool hold (#1794).
 * Driver details that a conversion is ALLOWED to change (tagged -> runUnsafe,
 * EO2) live in the separate `sql-text/_driver.json` golden.
 */

import { defineNormalizer, sha256 } from './golden.ts';
import { paramShape, type RecordedStatement, type TraceEntry } from './fake-postgres-sql.ts';

const PLACEHOLDER = /(?<![\w$])\$(\d+)(?!\d)/g;

/** Renumber `$N` by occurrence; `refs[k]` is the original N of occurrence k+1. */
export function renumberPlaceholders(text: string): { text: string; refs: number[] } {
  const refs: number[] = [];
  const out = text.replace(PLACEHOLDER, (_m, n: string) => {
    refs.push(Number(n));
    return `$${refs.length}`;
  });
  return { text: out, refs };
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The comparison key later lanes use: occurrence-renumbered, whitespace-collapsed text. */
export function normalizeSqlText(text: string): string {
  return collapseWhitespace(renumberPlaceholders(text).text);
}

export interface NormalizedStatement {
  lane: string;
  sql: string;
  params: string[];
  textSha256: string;
}

export interface NormalizedEvent {
  lane: string;
  event: string;
}

export function normalizeStatement(stmt: RecordedStatement): NormalizedStatement {
  const { text, refs } = renumberPlaceholders(stmt.text);
  return {
    lane: stmt.lane,
    sql: collapseWhitespace(text),
    params: refs.map((n) => (n >= 1 && n <= stmt.params.length ? paramShape(stmt.params[n - 1], stmt.types[n - 1]) : `missing:$${n}`)),
    textSha256: sha256(text),
  };
}

export function normalizeTrace(trace: TraceEntry[]): Array<NormalizedStatement | NormalizedEvent> {
  return trace.map((t) => (t.kind === 'query' ? normalizeStatement(t) : { lane: t.lane, event: t.event }));
}

/** Driver-level facts per statement (the part EO2 conversions may change). */
export function driverFacts(trace: TraceEntry[]): Array<Record<string, unknown>> {
  return trace
    .filter((t): t is RecordedStatement => t.kind === 'query')
    .map((s) => ({ via: s.via, paramCount: s.params.length, ...(s.unsafeOptions ? { unsafeOptions: s.unsafeOptions } : {}) }));
}

export interface MethodCapture {
  method: string;
  variant: string;
  trace: TraceEntry[];
  error?: string;
}

export interface DomainCapture {
  domain: string;
  cases: MethodCapture[];
}

function byMethod<T>(cases: MethodCapture[], fn: (c: MethodCapture) => T): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const c of cases) {
    (out[c.method] ??= {})[c.variant] = fn(c);
  }
  return out;
}

/** Normalizer recorded in every `sql-text/<domain>.json` header. */
export const SQL_TEXT_NORMALIZER = defineNormalizer<DomainCapture>('sql-text-v1', (capture) => ({
  domain: capture.domain,
  methods: byMethod(capture.cases, (c) => (c.error ? { error: c.error } : normalizeTrace(c.trace))),
}));

/** Normalizer for `sql-text/_driver.json` (via / paramCount / unsafe options per statement). */
export const SQL_DRIVER_NORMALIZER = defineNormalizer<DomainCapture[]>('sql-driver-v1', (captures) =>
  Object.fromEntries(captures.map((d) => [d.domain, byMethod(d.cases, (c) => driverFacts(c.trace))])));
