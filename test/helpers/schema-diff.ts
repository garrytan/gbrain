/**
 * Schema parity helpers for the v0.26.3 drift gate (issue #588).
 *
 * Strategy: snapshot `information_schema.columns` from a freshly-initialised
 * engine (PGLite or Postgres), then diff. The original v0.26.3 plan compared
 * raw `src/schema.sql` against raw `src/core/pglite-schema.ts`; codex review
 * showed those files are intentionally divergent today (PGLite reaches its
 * end-state via PGLITE_SCHEMA_SQL + migrations, not the raw blob alone).
 * Comparing post-`initSchema()` end-states is what production actually runs,
 * so it's what we test.
 *
 * The pure functions in this file have no engine dependency. The E2E test at
 * `test/e2e/schema-drift.test.ts` wires them up to real engines; the unit
 * tests in `test/helpers/schema-diff.test.ts` exercise them with synthetic
 * snapshots (including the D3 negative case for the v0.26.1 token_ttl bug).
 */

export interface ColumnInfo {
  dataType: string;
  udtName: string;
  isNullable: boolean;
  columnDefault: string | null;
}

export type SchemaSnapshot = Map<string, Map<string, ColumnInfo>>;

export interface SchemaDiff {
  tablesMissingInPGLite: string[];
  tablesUnexpectedlyInPGLite: string[];
  columnsMissingInPGLite: Array<{ table: string; columns: string[] }>;
  columnsMissingInPostgres: Array<{ table: string; columns: string[] }>;
  typeMismatches: Array<{
    table: string;
    column: string;
    pg: ColumnInfo;
    pglite: ColumnInfo;
    reason: 'udt_name' | 'is_nullable' | 'column_default';
  }>;
}

export interface SnapshotQueryRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

export type SnapshotQueryFn = (sql: string) => Promise<SnapshotQueryRow[]>;

const SNAPSHOT_SQL = `
  SELECT
    table_name,
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`;

// ─── v0.34 D7 — index parity ──────────────────────────────────────────
// snapshotIndexes captures index name + table + column-list + uniqueness +
// partial-predicate so the schema-drift E2E test catches missing or
// shape-mismatched indexes between Postgres and PGLite. Without this,
// hot-path indexes (e.g. v0.34 W4-5's partial composite + composite) can
// silently degrade from index-only-scan to Cartesian on 96K-chunk brains
// while the column-level drift test stays green.

export interface IndexInfo {
  indexName: string;
  tableName: string;
  /** Column list as comma-joined names (case-preserved). */
  columns: string;
  isUnique: boolean;
  isPartial: boolean;
}

export type IndexSnapshot = Map<string, IndexInfo>; // keyed by indexName

export interface IndexSnapshotRow {
  index_name: string;
  table_name: string;
  columns: string;
  is_unique: boolean;
  is_partial: boolean;
}

export type IndexSnapshotQueryFn = (sql: string) => Promise<IndexSnapshotRow[]>;

// pg_index + pg_class + pg_attribute + pg_namespace — covers both Postgres
// and PGLite (both expose the standard pg_catalog views).
const INDEX_SNAPSHOT_SQL = `
  SELECT
    i.relname AS index_name,
    t.relname AS table_name,
    pg_get_indexdef(idx.indexrelid) AS columns,
    idx.indisunique AS is_unique,
    (pg_get_indexdef(idx.indexrelid) ILIKE '%WHERE%') AS is_partial
  FROM pg_index idx
  JOIN pg_class i ON i.oid = idx.indexrelid
  JOIN pg_class t ON t.oid = idx.indrelid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname = 'public'
    AND NOT idx.indisprimary
  ORDER BY t.relname, i.relname
`;

/**
 * v0.34 D7 — Pull an IndexSnapshot from any engine that exposes a SQL
 * query callback. Caller adapts the native shape to `IndexSnapshotQueryFn`.
 */
export async function snapshotIndexes(query: IndexSnapshotQueryFn): Promise<IndexSnapshot> {
  const rows = await query(INDEX_SNAPSHOT_SQL);
  const snap: IndexSnapshot = new Map();
  for (const row of rows) {
    snap.set(row.index_name, {
      indexName: row.index_name,
      tableName: row.table_name,
      columns: row.columns,
      isUnique: row.is_unique === true || (row.is_unique as unknown) === 'true' || (row.is_unique as unknown) === 't',
      isPartial: row.is_partial === true || (row.is_partial as unknown) === 'true' || (row.is_partial as unknown) === 't',
    });
  }
  return snap;
}

export interface IndexDiff {
  /** Indexes present in Postgres but missing from PGLite. */
  pgOnly: IndexInfo[];
  /** Indexes present in PGLite but missing from Postgres. */
  pgliteOnly: IndexInfo[];
  /** Indexes present on both sides with mismatched shape. */
  mismatched: Array<{ pg: IndexInfo; pglite: IndexInfo; reason: string }>;
}

export function diffIndexSnapshots(
  pg: IndexSnapshot,
  pglite: IndexSnapshot,
  opts: { allowlist?: string[] } = {},
): IndexDiff {
  const allow = new Set(opts.allowlist ?? []);
  const out: IndexDiff = { pgOnly: [], pgliteOnly: [], mismatched: [] };

  for (const [name, info] of pg) {
    if (allow.has(name)) continue;
    const other = pglite.get(name);
    if (!other) {
      out.pgOnly.push(info);
      continue;
    }
    // Shape compare. Index definitions render slightly differently across
    // engines for the WHERE clause; normalize whitespace before comparing.
    const normPg = info.columns.replace(/\s+/g, ' ').trim().toLowerCase();
    const normPl = other.columns.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normPg !== normPl) {
      out.mismatched.push({ pg: info, pglite: other, reason: 'definition_mismatch' });
      continue;
    }
    if (info.isUnique !== other.isUnique) {
      out.mismatched.push({ pg: info, pglite: other, reason: 'uniqueness_mismatch' });
    }
    if (info.isPartial !== other.isPartial) {
      out.mismatched.push({ pg: info, pglite: other, reason: 'partial_mismatch' });
    }
  }
  for (const [name, info] of pglite) {
    if (allow.has(name)) continue;
    if (!pg.has(name)) out.pgliteOnly.push(info);
  }
  return out;
}

export function isCleanIndexDiff(diff: IndexDiff): boolean {
  return diff.pgOnly.length === 0 && diff.pgliteOnly.length === 0 && diff.mismatched.length === 0;
}

export function formatIndexDiffForFailure(diff: IndexDiff): string {
  const lines: string[] = [];
  if (diff.pgOnly.length > 0) {
    lines.push(`Indexes in Postgres but MISSING in PGLite (mirror in src/core/pglite-schema.ts):`);
    for (const i of diff.pgOnly) {
      lines.push(`  - ${i.indexName} on ${i.tableName}: ${i.columns}`);
    }
  }
  if (diff.pgliteOnly.length > 0) {
    lines.push(`Indexes in PGLite but MISSING in Postgres (mirror in src/schema.sql or migrate.ts):`);
    for (const i of diff.pgliteOnly) {
      lines.push(`  - ${i.indexName} on ${i.tableName}: ${i.columns}`);
    }
  }
  if (diff.mismatched.length > 0) {
    lines.push(`Indexes present on both sides but with shape drift:`);
    for (const m of diff.mismatched) {
      lines.push(`  - ${m.pg.indexName} (${m.reason}):`);
      lines.push(`      PG:     ${m.pg.columns}`);
      lines.push(`      PGLite: ${m.pglite.columns}`);
    }
  }
  return lines.join('\n');
}

/**
 * Pull a SchemaSnapshot from any engine that exposes a SQL query callback.
 * Caller adapts the engine's native query shape to `SnapshotQueryFn` (PGLite
 * returns `{rows}`, postgres.js returns the array directly).
 */
export async function snapshotSchema(query: SnapshotQueryFn): Promise<SchemaSnapshot> {
  const rows = await query(SNAPSHOT_SQL);
  const snap: SchemaSnapshot = new Map();
  for (const row of rows) {
    let cols = snap.get(row.table_name);
    if (!cols) {
      cols = new Map();
      snap.set(row.table_name, cols);
    }
    cols.set(row.column_name, {
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default ?? null,
    });
  }
  return snap;
}

/**
 * Defaults to be normalised before comparison. Postgres and PGLite render
 * `gen_random_uuid()` consistently as of pgvector pgvector:pg16 + PGLite ≥0.2,
 * but they sometimes differ on NULL representation and on type-cast
 * formatting (`'value'::text` vs `'value'`). We collapse the obvious ones.
 */
function normaliseDefault(d: string | null): string | null {
  if (d === null) return null;
  // Order matters: collapse whitespace FIRST so the trailing-type-cast strip
  // matches at end-of-string regardless of trailing spaces.
  let normalised = d.trim().replace(/\s+/g, ' ');
  // Strip trailing type casts like ::text, ::jsonb, ::uuid — PGLite sometimes
  // omits them and Postgres sometimes includes them for string defaults.
  normalised = normalised.replace(/::[a-z_][a-z0-9_]*(\[\])?$/i, '');
  return normalised;
}

/**
 * Compare two snapshots and produce a structured diff. Tables on the
 * allowlist are excluded entirely from the comparison (intentional
 * Postgres-only tables).
 */
export function diffSnapshots(
  pg: SchemaSnapshot,
  pglite: SchemaSnapshot,
  opts: { allowlistPgOnlyTables: string[] },
): SchemaDiff {
  const allowlist = new Set(opts.allowlistPgOnlyTables);
  const diff: SchemaDiff = {
    tablesMissingInPGLite: [],
    tablesUnexpectedlyInPGLite: [],
    columnsMissingInPGLite: [],
    columnsMissingInPostgres: [],
    typeMismatches: [],
  };

  for (const [table, pgCols] of pg) {
    if (allowlist.has(table)) continue;
    const pgliteCols = pglite.get(table);
    if (!pgliteCols) {
      diff.tablesMissingInPGLite.push(table);
      continue;
    }
    const missingInPGLite: string[] = [];
    for (const [col, pgInfo] of pgCols) {
      const pgliteInfo = pgliteCols.get(col);
      if (!pgliteInfo) {
        missingInPGLite.push(col);
        continue;
      }
      // udt_name is the canonical type identity (catches `_text` vs `_int4`,
      // vector dimensions, etc.). data_type is the human-readable category.
      if (pgInfo.udtName !== pgliteInfo.udtName) {
        diff.typeMismatches.push({ table, column: col, pg: pgInfo, pglite: pgliteInfo, reason: 'udt_name' });
        continue;
      }
      if (pgInfo.isNullable !== pgliteInfo.isNullable) {
        diff.typeMismatches.push({ table, column: col, pg: pgInfo, pglite: pgliteInfo, reason: 'is_nullable' });
        continue;
      }
      if (normaliseDefault(pgInfo.columnDefault) !== normaliseDefault(pgliteInfo.columnDefault)) {
        diff.typeMismatches.push({ table, column: col, pg: pgInfo, pglite: pgliteInfo, reason: 'column_default' });
      }
    }
    if (missingInPGLite.length > 0) {
      diff.columnsMissingInPGLite.push({ table, columns: missingInPGLite });
    }
  }

  // PGLite-only tables are suspicious but not auto-fail. Surface them so a
  // reviewer can decide.
  for (const [table, pgliteCols] of pglite) {
    if (!pg.has(table)) {
      diff.tablesUnexpectedlyInPGLite.push(table);
      continue;
    }
    if (allowlist.has(table)) continue;
    const pgCols = pg.get(table)!;
    const missingInPostgres: string[] = [];
    for (const col of pgliteCols.keys()) {
      if (!pgCols.has(col)) missingInPostgres.push(col);
    }
    if (missingInPostgres.length > 0) {
      diff.columnsMissingInPostgres.push({ table, columns: missingInPostgres });
    }
  }

  return diff;
}

/**
 * Build the failure message used in test assertions. Names every issue with
 * a copy-paste-ready hint so a future contributor can paste the fix straight
 * into pglite-schema.ts (or into a migration sqlFor.pglite branch).
 */
export function formatDiffForFailure(diff: SchemaDiff): string {
  const lines: string[] = [];

  if (diff.tablesMissingInPGLite.length > 0) {
    lines.push('Tables present on Postgres but missing from PGLite end-state:');
    for (const t of diff.tablesMissingInPGLite) {
      lines.push(`  - ${t}`);
      lines.push(`    Hint: add CREATE TABLE for "${t}" to src/core/pglite-schema.ts, or add it to the allowlist if intentionally Postgres-only.`);
    }
  }

  if (diff.columnsMissingInPGLite.length > 0) {
    lines.push('Columns missing from PGLite end-state:');
    for (const { table, columns } of diff.columnsMissingInPGLite) {
      for (const col of columns) {
        lines.push(`  - ${table}.${col}`);
        lines.push(`    Hint: add "${col}" to the ${table} CREATE TABLE in src/core/pglite-schema.ts, or add a sqlFor.pglite branch in the relevant migration.`);
      }
    }
  }

  if (diff.columnsMissingInPostgres.length > 0) {
    lines.push('Columns present on PGLite but missing from Postgres:');
    for (const { table, columns } of diff.columnsMissingInPostgres) {
      for (const col of columns) {
        lines.push(`  - ${table}.${col}`);
        lines.push(`    Hint: either add "${col}" to ${table} in src/schema.sql + the migrations chain, or remove it from src/core/pglite-schema.ts.`);
      }
    }
  }

  if (diff.typeMismatches.length > 0) {
    lines.push('Type / nullability / default mismatches:');
    for (const m of diff.typeMismatches) {
      lines.push(`  - ${m.table}.${m.column} (${m.reason})`);
      if (m.reason === 'udt_name') {
        lines.push(`      pg=${m.pg.dataType}/${m.pg.udtName}  pglite=${m.pglite.dataType}/${m.pglite.udtName}`);
      } else if (m.reason === 'is_nullable') {
        lines.push(`      pg.isNullable=${m.pg.isNullable}  pglite.isNullable=${m.pglite.isNullable}`);
      } else {
        lines.push(`      pg.default=${JSON.stringify(m.pg.columnDefault)}  pglite.default=${JSON.stringify(m.pglite.columnDefault)}`);
      }
    }
  }

  if (diff.tablesUnexpectedlyInPGLite.length > 0) {
    lines.push('Tables in PGLite that have no Postgres counterpart (suspicious — verify intentional):');
    for (const t of diff.tablesUnexpectedlyInPGLite) {
      lines.push(`  - ${t}`);
    }
  }

  if (lines.length === 0) return 'no diff';
  return lines.join('\n');
}

/**
 * Returns true when the diff has zero issues.
 */
export function isCleanDiff(diff: SchemaDiff): boolean {
  return diff.tablesMissingInPGLite.length === 0
    && diff.columnsMissingInPGLite.length === 0
    && diff.columnsMissingInPostgres.length === 0
    && diff.typeMismatches.length === 0
    && diff.tablesUnexpectedlyInPGLite.length === 0;
}
