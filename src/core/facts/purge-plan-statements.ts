/**
 * The statements a fact purge's request finders (persistence/intent-redaction.ts) and its verification probes
 * (facts/purge-verify.ts) read. Each is the text its caller ran through `executeRaw`, byte for byte, built once at
 * module load so the engine-sql functions (src/core/engine-sql/facts-purge-plan.ts) pass whole static texts. The
 * inventory probes are built per call from the deletion inventory's own table and column names (`purgeProbeSelect`):
 * no caller text reaches them. The plan's other reads live in src/core/engine-sql/facts-purge.ts.
 */
import { DELETION_INVENTORY_BY_TABLE } from '../deletion-inventory.ts';

const carries = (column: string) => `(${column} IS NOT NULL AND (strpos(lower(${column}::text),$2)>0 OR strpos(lower(${column}::text),$3)>0 OR strpos(lower(${column}::text),$4)>0))`;

/** Requests whose intent, outcome or error text carries the claim ($2 lowered, $3 JSON-escaped, $4 the escaped reason), up to $5. */
export const REQUESTS_CARRYING_SQL = `SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND (${carries('intent')} OR ${carries('outcome')} OR ${carries('error_detail')} OR ${carries('error_message')})
    ORDER BY sequence LIMIT $5`;

/** Unfinished requests whose intent publishes one of the stagings $2. */
export const REQUESTS_HOLDING_STAGINGS_SQL = `SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND state IN ('queued','deferred','running','recovering') AND intent->'body_ref'->>'staging_id'=ANY($2::text[]) ORDER BY sequence`;

const textMatch = (column: string, at: number) => `(strpos(lower(${column}::text),$${at})>0 OR strpos(lower(${column}::text),$${at + 1})>0)`;
/** Vector and lexeme columns carry no probe-able text. */
const PROBE_SKIP = /embedding|search_vector/;
/** Stores whose probe columns are bytea; their bytes are matched exactly (case-sensitive) against the UTF-8 needle. */
const BINARY_PROBE_TABLES: ReadonlySet<string> = new Set(['minion_attachments', 'page_segment_texts', 'page_body_staging_parts']);

/**
 * W1 prerequisite (BELIEF_LEDGER.md 6.5): link context, timeline detail and raw data are reported, not swept, so their
 * receipt names the rows that still carry the claim (scoped to the source through their page), not only a count.
 */
export const NAMED_ROW_PROBES = {
  links: { columns: ['l.context'], select: `SELECT 'link:' || l.id || ' ' || f.slug || ' -> ' || t.slug AS item FROM links l JOIN pages f ON f.id = l.from_page_id
    JOIN pages t ON t.id = l.to_page_id WHERE (f.source_id = $1 OR t.source_id = $1)` },
  timeline_entries: { columns: ['x.summary', 'x.detail'], select: `SELECT 'timeline:' || x.id || ' ' || p.slug || ' ' || x.date::text AS item FROM timeline_entries x
    JOIN pages p ON p.id = x.page_id WHERE p.source_id = $1` },
  raw_data: { columns: ['r.data'], select: `SELECT 'raw_data:' || r.id || ' ' || p.slug || ' ' || r.source AS item FROM raw_data r JOIN pages p ON p.id = r.page_id WHERE p.source_id = $1` },
} as const satisfies Record<string, { select: string; columns: readonly string[] }>;

export type NamedProbeTable = keyof typeof NAMED_ROW_PROBES;

/**
 * One bounded inventory probe of a purge verification: an inventory `table` searched for `needles` (exact,
 * case-insensitive; JSON also in its escaped form; bytea stores byte-exact), scoped to the source when the table has
 * one. `probe` narrows the probed columns to some of the entry's own columns. `named` probes list the carrying rows.
 */
export type PurgeProbe =
  | { kind: 'table'; table: string; sourceId: string; needles: readonly string[]; probe?: readonly string[] }
  | { kind: 'named'; table: NamedProbeTable; sourceId: string; needles: readonly string[] };

/**
 * What one probe searches: the table, the probed columns (as the select names them, and bare), whether the table is
 * scoped by its own source_id, whether its columns are bytea, and the needles (at most 32, empty ones dropped). Null when
 * it has nothing to search. The Rust engine reads this shape; purgeProbeSelect builds the SQL from it.
 */
export interface PurgeProbeShape {
  kind: PurgeProbe['kind'];
  table: string;
  sourceId: string;
  /** The probed columns as the select names them (`l.context` for a named probe). */
  columns: readonly string[];
  /** The same columns without a table alias. */
  bare: readonly string[];
  scoped: boolean;
  binary: boolean;
  needles: readonly string[];
}

export function purgeProbeShape(probe: PurgeProbe): PurgeProbeShape | null {
  const list = probe.needles.filter(Boolean).slice(0, 32);
  const bare = (columns: readonly string[]) => columns.map(col => col.slice(col.indexOf('.') + 1));
  if (probe.kind === 'named') {
    const named = NAMED_ROW_PROBES[probe.table];
    if (!named) throw new Error(`purge probe: ${String(probe.table)} has no named-row probe`);
    if (!list.length) return null;
    return { kind: 'named', table: probe.table, sourceId: probe.sourceId, columns: named.columns, bare: bare(named.columns),
      scoped: true, binary: false, needles: list };
  }
  const entry = DELETION_INVENTORY_BY_TABLE.get(probe.table);
  if (!entry) throw new Error(`purge probe: ${probe.table} is not an inventory table`);
  const own = probe.probe ?? entry.probe ?? entry.columns;
  for (const col of own) if (!entry.columns.includes(col)) throw new Error(`purge probe: ${probe.table} has no column ${col}`);
  const columns = own.filter(col => !PROBE_SKIP.test(col));
  if (!columns.length || !list.length) return null;
  return { kind: 'table', table: entry.table, sourceId: probe.sourceId, columns, bare: bare(columns),
    scoped: entry.columns.includes('source_id'), binary: BINARY_PROBE_TABLES.has(entry.table), needles: list };
}

/** The probe's row select (no LIMIT) and its parameters; null when it has nothing to search. */
export function purgeProbeSelect(probe: PurgeProbe): { sql: string; params: unknown[] } | null {
  const shape = purgeProbeShape(probe);
  if (!shape) return null;
  const params: unknown[] = [shape.sourceId];
  const ors: string[] = [];
  for (const needle of shape.needles) {
    if (shape.binary) { params.push(needle); ors.push(...shape.columns.map(col => `position(convert_to($${params.length}::text,'UTF8') in ${col})>0`)); continue; }
    params.push(needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase());
    ors.push(...shape.columns.map(col => textMatch(col, params.length - 1)));
  }
  if (shape.kind === 'named') return { sql: `${NAMED_ROW_PROBES[shape.table as NamedProbeTable].select} AND (${ors.join(' OR ')})`, params };
  return { sql: `SELECT 1 FROM ${shape.table} WHERE ${shape.scoped ? 'source_id=$1 AND' : '$1::text IS NOT NULL AND'} (${ors.join(' OR ')})`, params };
}

/** The bounded count of a row select: at most `rows + 1` rows are counted. */
export function boundedCountSql(select: string, rows: number): string {
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('purge probe: the row bound must be a non-negative integer');
  return `SELECT count(*)::int AS n FROM (${select} LIMIT ${rows + 1}) bounded`;
}

/** The first 20 items a named probe lists, in byte order (the collation every engine agrees on). */
export function probeItemsSql(select: string): string {
  return `SELECT * FROM (${select}) q ORDER BY item COLLATE "C" LIMIT 20`;
}
