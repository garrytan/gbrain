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

import { createHash } from 'node:crypto';

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
    lines.push(`Indexes in Postgres but MISSING in PGLite (the PGLite bootstrap is generated from src/schema.sql by bun run build:schema; check the PGLite rules in scripts/build-schema.ts):`);
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
 * into src/schema.sql / a TS schema fragment (then `bun run build:schema`), a
 * PGLite capability rule in scripts/build-schema.ts, or a migration sqlFor.pglite branch.
 */
export function formatDiffForFailure(diff: SchemaDiff): string {
  const lines: string[] = [];

  if (diff.tablesMissingInPGLite.length > 0) {
    lines.push('Tables present on Postgres but missing from PGLite end-state:');
    for (const t of diff.tablesMissingInPGLite) {
      lines.push(`  - ${t}`);
      lines.push(`    Hint: add CREATE TABLE for "${t}" to src/schema.sql (or its TS schema fragment) and run bun run build:schema; if it is dropped for PGLite by a rule in scripts/build-schema.ts, fix the rule, or add it to the allowlist if intentionally Postgres-only.`);
    }
  }

  if (diff.columnsMissingInPGLite.length > 0) {
    lines.push('Columns missing from PGLite end-state:');
    for (const { table, columns } of diff.columnsMissingInPGLite) {
      for (const col of columns) {
        lines.push(`  - ${table}.${col}`);
        lines.push(`    Hint: add "${col}" to the ${table} CREATE TABLE in src/schema.sql (or its TS schema fragment) and run bun run build:schema (check the PGLite rules in scripts/build-schema.ts), or add a sqlFor.pglite branch in the relevant migration.`);
      }
    }
  }

  if (diff.columnsMissingInPostgres.length > 0) {
    lines.push('Columns present on PGLite but missing from Postgres:');
    for (const { table, columns } of diff.columnsMissingInPostgres) {
      for (const col of columns) {
        lines.push(`  - ${table}.${col}`);
        lines.push(`    Hint: either add "${col}" to ${table} in src/schema.sql + the migrations chain, or drop it for PGLite with a rule in scripts/build-schema.ts (then bun run build:schema).`);
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

// ─── Refactor wave 1 E4 — catalog-level snapshot ──────────────────────
// snapshotSchema/snapshotIndexes above answer "do both engines have the same
// columns and index names?". The catalog snapshot below answers "is the
// schema end state byte-identical to the one master produced?": it pins
// column ordinals, defaults, full index definitions, constraints (incl. CHECK
// text), triggers, function signatures + body hashes, views, RLS policies,
// grants, RLS flags, sequences and extensions. It is engine-agnostic: the
// caller adapts PGLite (`{rows}`) or postgres.js (array) to CatalogQueryFn,
// and the result is plain sorted data suitable for a golden file.
//
// Extension-owned objects (pgvector / pg_trgm / pgcrypto functions installed
// into `public`) are excluded via pg_depend deptype 'e': they belong to the
// extension version, not to gbrain's schema.
//
// Role names are environment-dependent (the connecting superuser is
// `postgres` locally but may differ elsewhere), so the connecting role is
// replaced with CATALOG_CURRENT_ROLE in grants and policies.

export const CATALOG_CURRENT_ROLE = '<current_role>';

export interface CatalogColumn {
  name: string;
  ordinal: number;
  dataType: string;
  udtName: string;
  isNullable: boolean;
  columnDefault: string | null;
}

export interface CatalogTable {
  name: string;
  /** pg_class.relkind: r = table, p = partitioned table. */
  relkind: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  /** Ordered by ordinal position. */
  columns: CatalogColumn[];
}

export interface CatalogIndex { name: string; table: string; definition: string }
export interface CatalogConstraint { name: string; table: string; type: string; definition: string }
export interface CatalogTrigger { name: string; table: string; definition: string }
export interface CatalogFunction {
  name: string;
  identityArguments: string;
  result: string;
  kind: string;
  language: string;
  volatility: string;
  securityDefiner: boolean;
  config: string[];
  bodySha256: string;
}
export interface CatalogView { name: string; kind: string; definitionSha256: string }
export interface CatalogPolicy {
  table: string;
  name: string;
  permissive: string;
  roles: string[];
  command: string;
  using: string | null;
  withCheck: string | null;
}
/** Privileges of one (table, grantor, grantee, grantable) tuple, sorted. */
export interface CatalogGrant { table: string; grantor: string; grantee: string; grantable: boolean; privileges: string[] }
export interface CatalogSequence {
  name: string;
  dataType: string;
  start: string;
  min: string;
  max: string;
  increment: string;
  cycle: boolean;
  cache: string;
  ownedBy: string | null;
}

export interface CatalogSnapshot {
  tables: CatalogTable[];
  /** Columns of views (information_schema.columns covers both). */
  viewColumns: Array<{ view: string; columns: CatalogColumn[] }>;
  indexes: CatalogIndex[];
  constraints: CatalogConstraint[];
  triggers: CatalogTrigger[];
  functions: CatalogFunction[];
  views: CatalogView[];
  policies: CatalogPolicy[];
  grants: CatalogGrant[];
  sequences: CatalogSequence[];
  extensions: string[];
}

export type CatalogQueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

const NOT_EXTENSION_MEMBER = (classid: string, objid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classid}'::regclass AND d.objid = ${objid} AND d.deptype = 'e')`;

/** One SQL statement per catalog section. Exported so fakes can route on it. */
export const CATALOG_QUERIES = {
  currentRole: `SELECT current_user::text AS role`,
  relations: `
    SELECT c.relname::text AS name, c.relkind::text AS relkind,
           c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
    ORDER BY c.relname`,
  columns: `
    SELECT table_name::text AS table_name, column_name::text AS column_name,
           ordinal_position::int AS ordinal_position, data_type::text AS data_type,
           udt_name::text AS udt_name, is_nullable::text AS is_nullable,
           column_default::text AS column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`,
  indexes: `
    SELECT i.relname::text AS name, t.relname::text AS table_name,
           pg_get_indexdef(idx.indexrelid) AS definition
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_class t ON t.oid = idx.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER('pg_class', 't.oid')}
    ORDER BY t.relname, i.relname`,
  constraints: `
    SELECT con.conname::text AS name, COALESCE(t.relname::text, '') AS table_name,
           con.contype::text AS type, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    LEFT JOIN pg_class t ON t.oid = con.conrelid
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER('pg_constraint', 'con.oid')}
    ORDER BY 2, 1`,
  triggers: `
    SELECT tg.tgname::text AS name, t.relname::text AS table_name,
           pg_get_triggerdef(tg.oid) AS definition
    FROM pg_trigger tg
    JOIN pg_class t ON t.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
    ORDER BY t.relname, tg.tgname`,
  functions: `
    SELECT p.proname::text AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments,
           COALESCE(pg_get_function_result(p.oid), '') AS result,
           p.prokind::text AS kind, l.lanname::text AS language,
           p.provolatile::text AS volatility, p.prosecdef AS security_definer,
           COALESCE(array_to_string(p.proconfig, E'\\n'), '') AS config,
           COALESCE(p.prosrc, '') AS body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}
    ORDER BY 1, 2`,
  views: `
    SELECT c.relname::text AS name, c.relkind::text AS kind,
           pg_get_viewdef(c.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
    ORDER BY 1`,
  policies: `
    SELECT tablename::text AS table_name, policyname::text AS name,
           permissive::text AS permissive, array_to_string(roles, E'\\n') AS roles,
           cmd::text AS command, qual::text AS using_expr, with_check::text AS with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY 1, 2`,
  grants: `
    SELECT table_name::text AS table_name, grantor::text AS grantor, grantee::text AS grantee,
           privilege_type::text AS privilege, is_grantable::text AS is_grantable
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
    ORDER BY 1, 3, 4, 2`,
  sequences: `
    SELECT s.sequencename::text AS name, s.data_type::text AS data_type,
           s.start_value::text AS start_value, s.min_value::text AS min_value,
           s.max_value::text AS max_value, s.increment_by::text AS increment_by,
           s.cycle AS cycle, s.cache_size::text AS cache_size,
           (SELECT t.relname::text || '.' || a.attname::text
              FROM pg_depend d
              JOIN pg_class t ON t.oid = d.refobjid
              JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
               AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
             LIMIT 1) AS owned_by
    FROM pg_sequences s
    JOIN pg_namespace n ON n.nspname = s.schemaname
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
    WHERE s.schemaname = 'public'
    ORDER BY 1`,
  extensions: `SELECT extname::text AS name FROM pg_extension ORDER BY 1`,
} as const;

export type CatalogSection = keyof typeof CATALOG_QUERIES;
export type RawCatalogRows = Record<CatalogSection, Array<Record<string, unknown>>>;

function catalogBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true' || v === 'YES';
}

function catalogText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function catalogNullableText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function catalogLines(v: unknown): string[] {
  const s = catalogText(v);
  return s === '' ? [] : s.split('\n');
}

function catalogSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function byKeys<T>(...keys: Array<(x: T) => string>) {
  return (a: T, b: T) => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

function groupCatalogGrants(rows: Array<Record<string, unknown>>, role: (name: string) => string): CatalogGrant[] {
  const groups = new Map<string, CatalogGrant>();
  for (const r of rows) {
    const g = {
      table: catalogText(r.table_name),
      grantor: role(catalogText(r.grantor)),
      grantee: role(catalogText(r.grantee)),
      grantable: catalogBool(r.is_grantable),
    };
    const key = JSON.stringify(g);
    const entry = groups.get(key) ?? { ...g, privileges: [] };
    entry.privileges.push(catalogText(r.privilege));
    groups.set(key, entry);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, privileges: [...g.privileges].sort() }))
    .sort(byKeys((g) => g.table, (g) => g.grantee, (g) => g.grantor, (g) => String(g.grantable)));
}

/**
 * Pure: turn raw catalog rows (one array per CATALOG_QUERIES section) into a
 * sorted, role-normalized CatalogSnapshot. Sorting happens here with a
 * byte-order comparator, so the result does not depend on the server's
 * collation or on the order rows came back in.
 */
export function buildCatalogSnapshot(raw: RawCatalogRows): CatalogSnapshot {
  const currentRole = catalogText(raw.currentRole[0]?.role);
  const role = (name: string) => (currentRole !== '' && name === currentRole ? CATALOG_CURRENT_ROLE : name);

  const relkinds = new Map<string, Record<string, unknown>>();
  for (const r of raw.relations) relkinds.set(catalogText(r.name), r);

  const columnsByRelation = new Map<string, CatalogColumn[]>();
  for (const r of raw.columns) {
    const table = catalogText(r.table_name);
    const list = columnsByRelation.get(table) ?? [];
    list.push({
      name: catalogText(r.column_name),
      ordinal: Number(r.ordinal_position),
      dataType: catalogText(r.data_type),
      udtName: catalogText(r.udt_name),
      isNullable: catalogBool(r.is_nullable),
      columnDefault: catalogNullableText(r.column_default),
    });
    columnsByRelation.set(table, list);
  }
  const orderedColumns = (name: string) =>
    [...(columnsByRelation.get(name) ?? [])].sort((a, b) => a.ordinal - b.ordinal);

  const tables: CatalogTable[] = [];
  const viewColumns: CatalogSnapshot['viewColumns'] = [];
  for (const [name, r] of relkinds) {
    const relkind = catalogText(r.relkind);
    if (relkind === 'v' || relkind === 'm') {
      viewColumns.push({ view: name, columns: orderedColumns(name) });
      continue;
    }
    tables.push({
      name,
      relkind,
      rowSecurity: catalogBool(r.row_security),
      forceRowSecurity: catalogBool(r.force_row_security),
      columns: orderedColumns(name),
    });
  }
  tables.sort(byKeys((t) => t.name));
  viewColumns.sort(byKeys((v) => v.view));

  return {
    tables,
    viewColumns,
    indexes: raw.indexes
      .map((r) => ({ name: catalogText(r.name), table: catalogText(r.table_name), definition: catalogText(r.definition) }))
      .sort(byKeys((i) => i.table, (i) => i.name)),
    constraints: raw.constraints
      .map((r) => ({
        name: catalogText(r.name),
        table: catalogText(r.table_name),
        type: catalogText(r.type),
        definition: catalogText(r.definition),
      }))
      .sort(byKeys((c) => c.table, (c) => c.name, (c) => c.definition)),
    triggers: raw.triggers
      .map((r) => ({ name: catalogText(r.name), table: catalogText(r.table_name), definition: catalogText(r.definition) }))
      .sort(byKeys((t) => t.table, (t) => t.name)),
    functions: raw.functions
      .map((r) => ({
        name: catalogText(r.name),
        identityArguments: catalogText(r.identity_arguments),
        result: catalogText(r.result),
        kind: catalogText(r.kind),
        language: catalogText(r.language),
        volatility: catalogText(r.volatility),
        securityDefiner: catalogBool(r.security_definer),
        config: catalogLines(r.config),
        bodySha256: catalogSha256(catalogText(r.body)),
      }))
      .sort(byKeys((f) => f.name, (f) => f.identityArguments)),
    views: raw.views
      .map((r) => ({ name: catalogText(r.name), kind: catalogText(r.kind), definitionSha256: catalogSha256(catalogText(r.definition)) }))
      .sort(byKeys((v) => v.name)),
    policies: raw.policies
      .map((r) => ({
        table: catalogText(r.table_name),
        name: catalogText(r.name),
        permissive: catalogText(r.permissive),
        roles: catalogLines(r.roles).map(role).sort(),
        command: catalogText(r.command),
        using: catalogNullableText(r.using_expr),
        withCheck: catalogNullableText(r.with_check),
      }))
      .sort(byKeys((p) => p.table, (p) => p.name)),
    grants: groupCatalogGrants(raw.grants, role),
    sequences: raw.sequences
      .map((r) => ({
        name: catalogText(r.name),
        dataType: catalogText(r.data_type),
        start: catalogText(r.start_value),
        min: catalogText(r.min_value),
        max: catalogText(r.max_value),
        increment: catalogText(r.increment_by),
        cycle: catalogBool(r.cycle),
        cache: catalogText(r.cache_size),
        ownedBy: catalogNullableText(r.owned_by),
      }))
      .sort(byKeys((s) => s.name)),
    extensions: raw.extensions.map((r) => catalogText(r.name)).sort(),
  };
}

/** Run every CATALOG_QUERIES section through `query` and build the snapshot. */
export async function snapshotCatalog(query: CatalogQueryFn): Promise<CatalogSnapshot> {
  const raw = {} as RawCatalogRows;
  for (const section of Object.keys(CATALOG_QUERIES) as CatalogSection[]) {
    raw[section] = await query(CATALOG_QUERIES[section]);
  }
  return buildCatalogSnapshot(raw);
}

export interface CatalogDiffEntry {
  section: keyof CatalogSnapshot;
  key: string;
  kind: 'missing_in_actual' | 'unexpected_in_actual' | 'changed';
  expected?: unknown;
  actual?: unknown;
}

function catalogEntries(snap: CatalogSnapshot, section: keyof CatalogSnapshot, compareOrdinals: boolean): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const put = (key: string, value: unknown) => out.set(key, value);
  switch (section) {
    case 'tables':
      for (const t of snap.tables) {
        put(`${t.name}`, { relkind: t.relkind, rowSecurity: t.rowSecurity, forceRowSecurity: t.forceRowSecurity });
        for (const c of t.columns) {
          const { ordinal, ...rest } = c;
          put(`${t.name}.${c.name}`, compareOrdinals ? c : rest);
        }
      }
      return out;
    case 'viewColumns':
      for (const v of snap.viewColumns) {
        for (const c of v.columns) {
          const { ordinal, ...rest } = c;
          put(`${v.view}.${c.name}`, compareOrdinals ? c : rest);
        }
      }
      return out;
    case 'indexes': for (const x of snap.indexes) put(x.name, x); return out;
    case 'constraints': for (const x of snap.constraints) put(`${x.table}.${x.name}`, x); return out;
    case 'triggers': for (const x of snap.triggers) put(`${x.table}.${x.name}`, x); return out;
    case 'functions': for (const x of snap.functions) put(`${x.name}(${x.identityArguments})`, x); return out;
    case 'views': for (const x of snap.views) put(x.name, x); return out;
    case 'policies': for (const x of snap.policies) put(`${x.table}.${x.name}`, x); return out;
    case 'grants': for (const x of snap.grants) put(`${x.table}:${x.grantee}:${x.grantor}:${x.grantable}`, x); return out;
    case 'sequences': for (const x of snap.sequences) put(x.name, x); return out;
    case 'extensions': for (const x of snap.extensions) put(x, x); return out;
  }
}

/**
 * Structured diff of two catalog snapshots. Columns are keyed by name; with
 * `compareOrdinals: true` (PGLite master-vs-branch, T-G13) a column whose
 * ordinal position moved is reported as changed. Cross-engine comparisons
 * leave it false, matching the name-based diffSnapshots contract.
 */
export function diffCatalogSnapshots(
  expected: CatalogSnapshot,
  actual: CatalogSnapshot,
  opts: { compareOrdinals?: boolean } = {},
): CatalogDiffEntry[] {
  const compareOrdinals = opts.compareOrdinals ?? false;
  const out: CatalogDiffEntry[] = [];
  const sections = Object.keys(expected) as Array<keyof CatalogSnapshot>;
  for (const section of sections) {
    const e = catalogEntries(expected, section, compareOrdinals);
    const a = catalogEntries(actual, section, compareOrdinals);
    for (const [key, value] of e) {
      if (!a.has(key)) out.push({ section, key, kind: 'missing_in_actual', expected: value });
      else if (JSON.stringify(value) !== JSON.stringify(a.get(key))) {
        out.push({ section, key, kind: 'changed', expected: value, actual: a.get(key) });
      }
    }
    for (const [key, value] of a) {
      if (!e.has(key)) out.push({ section, key, kind: 'unexpected_in_actual', actual: value });
    }
  }
  return out;
}

export function formatCatalogDiffForFailure(diff: CatalogDiffEntry[]): string {
  if (diff.length === 0) return 'no diff';
  return diff
    .map((d) => {
      if (d.kind === 'changed') {
        return `  - [${d.section}] ${d.key} changed\n      expected: ${JSON.stringify(d.expected)}\n      actual:   ${JSON.stringify(d.actual)}`;
      }
      return `  - [${d.section}] ${d.key} ${d.kind === 'missing_in_actual' ? 'MISSING' : 'UNEXPECTED'}`;
    })
    .join('\n');
}
