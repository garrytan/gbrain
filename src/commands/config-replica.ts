/**
 * `gbrain config set replica_database_url <url>`: the read replica is a
 * connection key like database_url, so it lives in the file plane
 * (loadConfig never reads it from the database). An empty value removes it.
 */
import { loadConfigFileOnly, saveConfig } from '../core/config.ts';
import { redactPgUrl } from '../core/url-redact.ts';

/** Sets or removes the file-plane replica URL; returns true once handled (exits 1 on a refused value). */
export function setReplicaDatabaseUrl(value: string): boolean {
  const cfg = (loadConfigFileOnly() ?? {}) as Parameters<typeof saveConfig>[0];
  if (value === '') {
    delete cfg.replica_database_url;
    saveConfig(cfg);
    console.log('Removed replica_database_url (file plane: ~/.gbrain/config.json); every read uses the primary.');
    return true;
  }
  if (!/^postgres(ql)?:\/\//.test(value)) {
    console.error('[config] replica_database_url must be a postgres:// or postgresql:// connection string.');
    process.exit(1);
  }
  if (cfg.engine !== 'postgres' || !cfg.database_url) {
    console.error('[config] replica_database_url needs a Postgres brain: set database_url first (a PGLite brain has no replica).');
    process.exit(1);
  }
  cfg.replica_database_url = value;
  saveConfig(cfg);
  console.log(`Set replica_database_url = ${redactPgUrl(value)} (file plane: ~/.gbrain/config.json). Check it with: gbrain doctor`);
  return true;
}
