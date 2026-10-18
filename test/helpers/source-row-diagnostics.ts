import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';

/**
 * #6427 and the managed-atoms connector flake: a source that setup just wrote is reported
 * missing or archived. On a `source_changed` failure this appends what each reader saw (the
 * engine's own connection, a fresh client on the same database, every sources row and the
 * database's sessions), then rethrows the original error unchanged otherwise.
 */
export async function withSourceRowDiagnostics<T>(engine: BrainEngine, sourceId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string }).code === 'source_changed' && error instanceof Error) {
      error.message += `\n[source-row diagnostics]\n${await sourceRowDiagnostics(engine, sourceId)}`;
    }
    throw error;
  }
}

export async function sourceRowDiagnostics(engine: BrainEngine, sourceId: string): Promise<string> {
  const lines: string[] = [];
  const read = async (label: string, query: () => Promise<unknown>) => {
    try { lines.push(`${label}: ${JSON.stringify(await query())}`); } catch (error) { lines.push(`${label}: (query failed: ${(error as Error).message})`); }
  };
  await read('engine row', () => engine.executeRaw('SELECT to_jsonb(s) AS row FROM sources s WHERE id=$1', [sourceId]));
  await read('all sources', () => engine.executeRaw('SELECT id,archived,archived_at,incarnation::text,local_path,config FROM sources ORDER BY id'));
  if (engine.kind !== 'postgres') return lines.join('\n');
  await read('engine session', () => engine.executeRaw(`SELECT current_database() AS database,pg_backend_pid() AS pid,current_user AS role,session_user AS session_role,
    current_setting('search_path') AS search_path,current_setting('row_security') AS row_security,current_setting('transaction_isolation') AS isolation,
    txid_current_if_assigned()::text AS xid,pg_current_snapshot()::text AS snapshot`));
  const [{ database }] = await engine.executeRaw<{ database: string }>('SELECT current_database() AS database');
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  const fresh = postgres(url.toString(), { max: 1, prepare: false });
  try {
    await read('fresh client row', () => fresh.unsafe('SELECT to_jsonb(s) AS row FROM sources s WHERE id=$1', [sourceId]));
    await read('fresh client session', () => fresh.unsafe('SELECT current_database() AS database,pg_backend_pid() AS pid,current_user AS role'));
    await read('pg_stat_activity', () => fresh.unsafe(`SELECT pid,usename,application_name,state,xact_start::text,backend_xid::text,backend_xmin::text,left(query,200) AS query
      FROM pg_stat_activity WHERE datname=$1 ORDER BY pid`, [database]));
  } finally { await fresh.end(); }
  return lines.join('\n');
}
