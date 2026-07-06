import { Database } from 'bun:sqlite';

export type SqliteVectorBackend = 'sqlite-vec' | 'js-fallback';

/**
 * Point Bun at a custom SQLite library before any Database is opened.
 * Apple's system SQLite refuses loadable extensions, so on macOS the
 * sqlite-vec backend only activates when MBRAIN_CUSTOM_SQLITE names an
 * extension-capable libsqlite3 (e.g. from Homebrew). Failures are
 * silent by design: the JS fallback keeps vector search working.
 */
export function maybeUseCustomSqlite(): void {
  const customPath = process.env.MBRAIN_CUSTOM_SQLITE;
  if (!customPath) return;
  try {
    Database.setCustomSQLite(customPath);
  } catch {
    // Fall back to the default library; extension loading will no-op.
  }
}

/**
 * Try to load the sqlite-vec loadable extension into an open database.
 * Returns the backend actually available; never throws — environments
 * without the native asset (macOS default, compiled binaries) keep the
 * brute-force JS scoring path.
 */
export async function tryLoadSqliteVec(database: Database): Promise<SqliteVectorBackend> {
  try {
    const sqliteVec = await import('sqlite-vec');
    database.loadExtension(sqliteVec.getLoadablePath());
    database.query('SELECT vec_version()').get();
    return 'sqlite-vec';
  } catch {
    return 'js-fallback';
  }
}
