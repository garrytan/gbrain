/**
 * Canonical, engine-independent table digests for engine graduation. Every
 * value is read as text under fixed session settings, ordered by primary key
 * with COLLATE "C", read in keyset batches and hashed client-side (sha256 per
 * batch plus a root over every row, independent of batch size), so identical
 * content on PGLite and on a Postgres database with another collation gives
 * identical digests.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { BatchDigest, ColumnMeta, InventoryEntry, TableReceipt } from './engine-graduation.types.ts';

export const DEFAULT_DIGEST_BATCH_ROWS = 1000;

export const DIGEST_SESSION_SETTINGS = "SELECT set_config('TimeZone','UTC',true), set_config('DateStyle','ISO',true), "
  + "set_config('extra_float_digits','3',true), set_config('bytea_output','hex',true), set_config('IntervalStyle','postgres',true)";

/** Always-quoted identifier; names come from the catalog. Equivalent to format('%I') for every name. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const TIMESTAMP_TZ = 'timestamp with time zone';
const ISO_TS = /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)?( BC)?$/;

function isoTimestamp(text: string): string {
  const m = ISO_TS.exec(text);
  if (!m) return text;
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z', bc = ''] = m;
  if (zone !== 'Z' && !/^[+-]00(?::?00)?$/.test(zone)) {
    const parsed = new Date(text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? text : isoTimestamp(parsed.toISOString());
  }
  const fraction = frac.replace(/0+$/, '');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${fraction ? `.${fraction}` : ''}Z${bc}`;
}

function jsonbKeyOrder(a: string, b: string): number {
  const la = Buffer.byteLength(a), lb = Buffer.byteLength(b);
  return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** jsonb's own text output for a parsed value: keys by byte length then bytes, ", " and ": " separators. */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort(jsonbKeyOrder).map(k => `${JSON.stringify(k)}: ${jsonbText(obj[k])}`).join(', ')}}`;
  }
  return typeof value === 'bigint' ? String(value) : JSON.stringify(value);
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const text = value instanceof Date ? isoTimestamp(value.toISOString()) : String(value);
  return text === '' || /^null$/i.test(text) || /[{}",\\\s]/.test(text) ? `"${text.replace(/[\\"]/g, c => `\\${c}`)}"` : text;
}

function canonicalValue(value: unknown, column: ColumnMeta): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return column.type === TIMESTAMP_TZ ? isoTimestamp(value) : value;
  if (value instanceof Date) return isoTimestamp(value.toISOString());
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (column.type === 'jsonb' || column.type === 'json') return jsonbText(value);
  if (Array.isArray(value)) return `{${value.map(arrayElement).join(',')}}`;
  return jsonbText(value);
}

/** One row as canonical text: a JSON array of each column's canonical rendering, in the given column order. */
export function canonicalRowText(row: Record<string, unknown>, columns: readonly ColumnMeta[]): string {
  return JSON.stringify(columns.map(c => canonicalValue(row[c.name], c)));
}

const COLUMN_META_SQL = `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typcategory::text AS category,
    (t.typcollation <> 0) AS collatable, (a.attgenerated::text = 's') AS generated
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
  WHERE n.nspname=current_schema() AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped`;

function toMeta(r: { name: string; type: string; category: string; collatable: unknown; generated: unknown }): ColumnMeta {
  return { name: r.name, type: r.type, category: r.category, collatable: r.collatable === true || r.collatable === 't', generated: r.generated === true || r.generated === 't' };
}

/** Every column of the relation, sorted by name (C order), so physical column order never changes a digest. */
export async function tableColumns(engine: BrainEngine, relation: string): Promise<readonly ColumnMeta[]> {
  const rows = await engine.executeRaw<Parameters<typeof toMeta>[0]>(`${COLUMN_META_SQL} ORDER BY a.attname COLLATE "C"`, [relation]);
  return rows.map(toMeta);
}

/** Primary-key columns in index order; graduation requires one on every copied table. */
export async function primaryKey(engine: BrainEngine, relation: string): Promise<readonly ColumnMeta[]> {
  const rows = await engine.executeRaw<Parameters<typeof toMeta>[0]>(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      t.typcategory::text AS category, (t.typcollation <> 0) AS collatable, (a.attgenerated::text = 's') AS generated
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum JOIN pg_type t ON t.oid=a.atttypid
    WHERE n.nspname=current_schema() AND c.relname=$1 AND i.indisprimary ORDER BY k.ord`, [relation]);
  if (!rows.length) throw new Error(`Table ${relation} has no primary key; graduation digests and copies need one.`);
  return rows.map(toMeta);
}

export interface DigestPlan {
  relation: string;
  columns: readonly ColumnMeta[];
  key: readonly ColumnMeta[];
  /** SELECT list and FROM; `filter` is the inventory row filter (empty when none). */
  select: string;
  filter: string;
}

/** The ordered, keyset-paged SELECT shared by digests and verify's first-difference search. */
export async function digestPlan(engine: BrainEngine, entry: InventoryEntry, applyTransforms: boolean): Promise<DigestPlan> {
  const [columns, key] = await Promise.all([tableColumns(engine, entry.relation), primaryKey(engine, entry.relation)]);
  const transforms = new Map(applyTransforms ? entry.transforms.map(t => {
    if (!t.expression) throw new Error(`Transform on ${entry.relation}.${t.column} has no SQL expression.`);
    return [t.column, t.expression] as const;
  }) : []);
  for (const column of transforms.keys()) {
    if (!columns.some(c => c.name === column)) throw new Error(`Transform names ${entry.relation}.${column}, which does not exist.`);
    if (key.some(k => k.name === column)) throw new Error(`Transform on primary-key column ${entry.relation}.${column} is not permitted.`);
  }
  const keyCols = key.map((k, i) => `t.${quoteIdent(k.name)}::text AS ${quoteIdent(`k${i}`)}`);
  const valueCols = columns.map((c, i) => `(${transforms.get(c.name) ?? quoteIdent(c.name)})::text AS ${quoteIdent(`c${i}`)}`);
  return { relation: entry.relation, columns, key, select: `SELECT ${[...keyCols, ...valueCols].join(', ')} FROM ${quoteIdent(entry.relation)} AS t`, filter: entry.rowFilter ?? '' };
}

export interface DigestRow { key: readonly string[]; text: string }

const collate = (c: ColumnMeta, expr: string) => c.collatable ? `${expr} COLLATE "C"` : expr;

export interface KeysetRow { key: readonly string[]; values: Record<string, string | null> }

/** Up to `limit` rows strictly after `afterKey` (raw key texts), in COLLATE "C" primary-key order, each value as its `::text`. Run inside a digest transaction. */
export async function readKeysetRows(tx: BrainEngine, plan: DigestPlan, afterKey: readonly string[] | null, limit: number): Promise<KeysetRow[]> {
  const order = plan.key.map(k => collate(k, `t.${quoteIdent(k.name)}`)).join(', ');
  const where = [
    plan.filter ? `(${plan.filter})` : '',
    afterKey ? `(${order}) > (${plan.key.map((k, i) => collate(k, `$${i + 1}::${k.type}`)).join(', ')})` : '',
  ].filter(Boolean);
  const rows = await tx.executeRaw<Record<string, string | null>>(
    `${plan.select}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${Math.max(1, Math.floor(limit))}`, afterKey ? [...afterKey] : []);
  return rows.map(r => {
    const values: Record<string, string | null> = {};
    plan.columns.forEach((c, i) => { values[c.name] = r[`c${i}`] ?? null; });
    return { key: plan.key.map((_, i) => r[`k${i}`] as string), values };
  });
}

/** Up to `limit` rows strictly after `afterKey` as canonical row text, in key order. Run inside a digest transaction. */
export async function readDigestRows(tx: BrainEngine, plan: DigestPlan, afterKey: readonly string[] | null, limit: number): Promise<DigestRow[]> {
  const rows = await readKeysetRows(tx, plan, afterKey, limit);
  return rows.map(r => ({ key: r.key, text: canonicalRowText(r.values, plan.columns) }));
}

/** One read through `tx`, for callers that take a query function (the shadow seed's snapshot reads). */
export function digestQuery(tx: BrainEngine): (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> {
  return (sql, params) => tx.executeRaw<Record<string, unknown>>(sql, params ?? []);
}

/** Runs fn inside one transaction with the fixed digest session settings. */
export async function withDigestSession<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw(DIGEST_SESSION_SETTINGS);
    return fn(tx);
  });
}

export function digestHeader(plan: DigestPlan): string {
  return `${JSON.stringify(plan.columns.map(c => c.name))}\n`;
}

export async function digestTable(engine: BrainEngine, entry: InventoryEntry,
  opts: { batchRows?: number; applyTransforms?: boolean } = {}): Promise<TableReceipt> {
  const batchRows = opts.batchRows ?? DEFAULT_DIGEST_BATCH_ROWS;
  const plan = await digestPlan(engine, entry, opts.applyTransforms === true);
  return withDigestSession(engine, async tx => {
    const root = createHash('sha256').update(digestHeader(plan));
    const batches: BatchDigest[] = [];
    let after: readonly string[] | null = null;
    let total = 0;
    for (;;) {
      const rows = await readDigestRows(tx, plan, after, batchRows);
      if (!rows.length) break;
      const batch = createHash('sha256');
      for (const row of rows) { batch.update(`${row.text}\n`); root.update(`${row.text}\n`); }
      after = rows[rows.length - 1]!.key;
      total += rows.length;
      batches.push({ lastKey: JSON.stringify(after), rows: rows.length, sha256: batch.digest('hex') });
      if (rows.length < batchRows) break;
    }
    return { relation: entry.relation, rows: total, rootSha256: root.digest('hex'), batches };
  });
}
