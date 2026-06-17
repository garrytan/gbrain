/**
 * Post-migration schema verification with self-healing.
 *
 * PgBouncer transaction-mode poolers can silently swallow ALTER TABLE
 * statements: the SQL doesn't error, but the column never gets created.
 * The migration system increments the schema version counter anyway, so
 * gbrain thinks it's on v29 but the actual table is missing columns.
 *
 * This module parses the canonical CREATE TABLE definitions in
 * schema-embedded.ts and diffs them against information_schema.columns.
 * Missing columns are self-healed via ALTER TABLE ADD COLUMN IF NOT EXISTS.
 *
 * Called at the end of initSchema(), after all migrations complete.
 */

import { SCHEMA_SQL } from './schema-embedded.ts';
import type { BrainEngine } from './engine.ts';

/** A column expected to exist in the database. */
export interface ExpectedColumn {
  table: string;
  column: string;
  /** The full column definition (type + constraints) from the CREATE TABLE. */
  definition: string;
}

/**
 * Parse CREATE TABLE statements from SCHEMA_SQL to extract expected columns.
 *
 * This is a best-effort parser that handles the gbrain schema conventions:
 * - Standard column definitions with types and constraints
 * - Skips CONSTRAINT lines, CHECK lines, and UNIQUE lines
 * - Handles multi-line definitions
 *
 * Returns only tables and columns — not constraints, indexes, or triggers.
 */
export function parseExpectedColumns(): ExpectedColumn[] {
  const results: ExpectedColumn[] = [];

  // Match CREATE TABLE IF NOT EXISTS <name> ( ... );
  const tableRegex = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;

  const SQL_KEYWORDS = new Set(['constraint', 'unique', 'check', 'primary', 'foreign', 'exclude']);

  function processLine(tableName: string, line: string) {
    line = line.trim().replace(/,\s*$/, '');
    if (!line) return;

    // Skip CONSTRAINT, UNIQUE, CHECK, PRIMARY KEY lines
    if (/^\s*(CONSTRAINT|UNIQUE|CHECK|PRIMARY\s+KEY)/i.test(line)) return;

    const colMatch = line.match(/^\s*(\w+)\s+(.+)$/);
    if (colMatch) {
      const colName = colMatch[1].toLowerCase();
      if (SQL_KEYWORDS.has(colName)) return;

      results.push({
        table: tableName,
        column: colName,
        definition: colMatch[2].trim(),
      });
    }
  }

  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(SCHEMA_SQL)) !== null) {
    const tableName = match[1];
    const body = match[2];

    const lines = body.split('\n');
    let currentLine = '';

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('--')) {
        // If we have accumulated content and hit a blank/comment line,
        // the accumulated content is a complete line
        if (currentLine.trim()) {
          processLine(tableName, currentLine);
          currentLine = '';
        }
        continue;
      }

      currentLine += ' ' + trimmed;

      // If line ends with comma, it's a complete column definition
      if (trimmed.endsWith(',')) {
        processLine(tableName, currentLine);
        currentLine = '';
      }
    }

    // Handle any remaining accumulated line (last column before closing paren)
    if (currentLine.trim()) {
      processLine(tableName, currentLine);
    }
  }

  // Also parse ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements.
  // These are used for columns added outside CREATE TABLE blocks
  // (e.g., pages.search_vector, files.source_id).
  const alterRegex = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+([^;,]+)/gi;
  let alterMatch: RegExpExecArray | null;
  const seen = new Set(results.map(r => `${r.table}.${r.column}`));
  while ((alterMatch = alterRegex.exec(SCHEMA_SQL)) !== null) {
    const table = alterMatch[1];
    const column = alterMatch[2].toLowerCase();
    const definition = alterMatch[3].trim().replace(/,\s*$/, '');
    const key = `${table}.${column}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ table, column, definition });
    }
  }

  return results;
}

/**
 * Build a simplified type expression suitable for ALTER TABLE ADD COLUMN.
 *
 * Strips inline REFERENCES, CHECK, UNIQUE, and complex constraints that
 * can't be used in ADD COLUMN IF NOT EXISTS. Preserves NOT NULL, DEFAULT,
 * and the base type.
 */
export function simplifyColumnDef(definition: string): string {
  let def = definition;

  // Remove REFERENCES ... (with optional ON DELETE/UPDATE clauses)
  def = def.replace(/REFERENCES\s+\w+\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+\w+(\s+\w+)?)*\s*/gi, '');

  // Remove CHECK constraints (handle nested parens)
  def = def.replace(/CHECK\s*\((?:[^()]*|\([^()]*\))*\)/gi, '');

  // Remove inline UNIQUE
  def = def.replace(/\bUNIQUE\b/gi, '');

  // Remove trailing commas and whitespace
  def = def.replace(/,\s*$/, '').trim();

  // Collapse multiple spaces
  def = def.replace(/\s+/g, ' ').trim();

  return def;
}

/**
 * Query the database for actual columns in the public schema.
 * Returns a Set of "table.column" strings for fast lookup.
 */
async function getActualColumns(engine: BrainEngine): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const set = new Set<string>();
  for (const row of rows) {
    set.add(`${row.table_name}.${row.column_name}`);
  }
  return set;
}

/**
 * Get the set of tables that actually exist in the database.
 */
async function getActualTables(engine: BrainEngine): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return new Set(rows.map(r => r.table_name));
}

export interface VerifyResult {
  /** Total columns checked */
  checked: number;
  /** Columns that were missing */
  missing: Array<{ table: string; column: string }>;
  /** Columns successfully self-healed */
  healed: Array<{ table: string; column: string }>;
  /** Columns that failed to self-heal */
  failed: Array<{ table: string; column: string; error: string }>;
}

/**
 * Verify that every column defined in schema-embedded.ts actually exists
 * in the database. Self-heals missing columns via ALTER TABLE ADD COLUMN.
 *
 * Should be called after initSchema() + runMigrations() complete.
 *
 * @returns VerifyResult with details of what was checked and fixed.
 * @throws Error if any columns could not be healed (after attempting all).
 */
export async function verifySchema(engine: BrainEngine): Promise<VerifyResult> {
  const expected = parseExpectedColumns();
  const actualColumns = await getActualColumns(engine);
  const actualTables = await getActualTables(engine);

  const result: VerifyResult = {
    checked: 0,
    missing: [],
    healed: [],
    failed: [],
  };

  // Group expected columns by table for cleaner logging
  for (const col of expected) {
    // Skip tables that don't exist yet — they'll be created by schema.sql
    // on the next initSchema() call. We only verify columns on tables that
    // DO exist (the failure mode is: table exists, migration ran, but ALTER
    // TABLE silently failed).
    if (!actualTables.has(col.table)) {
      continue;
    }

    result.checked++;

    const key = `${col.table}.${col.column}`;
    if (!actualColumns.has(key)) {
      result.missing.push({ table: col.table, column: col.column });
    }
  }

  if (result.missing.length === 0) {
    return result;
  }

  // Log missing columns
  console.warn(`\n⚠️  Schema verification found ${result.missing.length} missing column(s):`);
  for (const m of result.missing) {
    console.warn(`  ${m.table}.${m.column}`);
  }
  console.warn('  Attempting self-heal via ALTER TABLE ADD COLUMN...\n');

  // Build a map from table.column -> definition for self-healing
  const defMap = new Map<string, string>();
  for (const col of expected) {
    defMap.set(`${col.table}.${col.column}`, col.definition);
  }

  // Attempt to add each missing column
  for (const m of result.missing) {
    const rawDef = defMap.get(`${m.table}.${m.column}`);
    if (!rawDef) {
      result.failed.push({ ...m, error: 'No definition found in schema' });
      continue;
    }

    const simpleDef = simplifyColumnDef(rawDef);

    try {
      const sql = `ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${simpleDef}`;
      await engine.runMigration(0, sql);
      result.healed.push({ table: m.table, column: m.column });
      console.log(`  ✓ Added ${m.table}.${m.column}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ ...m, error: msg });
      console.error(`  ✗ Failed to add ${m.table}.${m.column}: ${msg}`);
    }
  }

  if (result.healed.length > 0) {
    console.log(`\n  Schema self-heal: ${result.healed.length}/${result.missing.length} column(s) recovered.`);
  }

  if (result.failed.length > 0) {
    const failList = result.failed.map(f => `${f.table}.${f.column}: ${f.error}`).join('\n  ');
    throw new Error(
      `Schema verification failed: ${result.failed.length} column(s) could not be added:\n  ${failList}\n` +
      'This usually means PgBouncer transaction-mode silently dropped ALTER TABLE statements.\n' +
      'Fix: connect directly to Postgres (not through PgBouncer) and run: gbrain apply-migrations --yes'
    );
  }

  return result;
}
