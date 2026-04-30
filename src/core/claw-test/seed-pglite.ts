/**
 * seed-pglite — replay a SQL dump into a fresh PGLite database, then let
 * gbrain's migration chain walk forward.
 *
 * Codex caught (eng review pass 2) that existing migration helpers
 * (test/e2e/helpers.ts:204) are Postgres-only — they rewind schema_version
 * and replay against real Postgres. PGLite has no equivalent. This helper
 * fills that gap so the `upgrade-from-v0.18` claw-test scenario is
 * reproducible.
 *
 * Usage:
 *   const dbPath = await seedPglite('/tmp/run-x/.gbrain/brain.pglite', seedSql);
 *   // Then run `gbrain init --pglite --path <dbPath>` — the migration chain
 *   // detects the seeded schema_version and migrates forward to LATEST.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { PGLiteEngine } from '../pglite-engine.ts';

export interface SeedOpts {
  /** Absolute path to the .pglite file to create. */
  dbPath: string;
  /** Raw SQL dump to replay. */
  sql: string;
}

/**
 * Open a fresh PGLite at `dbPath`, execute the SQL dump, disconnect.
 * Throws on SQL errors with a structured message that names the failing
 * statement (helpful for debugging seed drift).
 */
export async function seedPglite(opts: SeedOpts): Promise<void> {
  const dir = dirname(opts.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: opts.dbPath });
    // Execute statements one at a time so an error names the offending
    // statement. The seed file is committed to source so we can normalize
    // its line endings; we rely on `;\n` as the statement terminator.
    const statements = splitStatements(opts.sql);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        await (engine as any).db.exec(trimmed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const preview = trimmed.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`seedPglite: SQL execution failed at "${preview}…": ${msg}`);
      }
    }
  } finally {
    await engine.disconnect();
  }
}

/** Read seed SQL from disk and replay into `dbPath`. */
export async function seedPgliteFromFile(opts: { dbPath: string; sqlPath: string }): Promise<void> {
  if (!existsSync(opts.sqlPath)) {
    throw new Error(`seedPglite: seed SQL not found at ${opts.sqlPath}`);
  }
  const sql = readFileSync(opts.sqlPath, 'utf-8');
  return seedPglite({ dbPath: opts.dbPath, sql });
}

/**
 * Split a SQL dump into individual statements. Naïve `;` split that respects
 * single-quoted strings and `--` line comments. Sufficient for canonical
 * pg_dump output; intentionally NOT a full SQL parser.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inLineComment = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      buf += c;
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'" && next === "'") { buf += next; i += 2; continue; }
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      inLineComment = true;
      buf += c;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      i++;
      continue;
    }
    if (c === ';') {
      buf += c;
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** Exposed for tests. */
export const _internal = { splitStatements };
