/**
 * The transaction-pooler banner (#7147), shown once per database target.
 *
 * A CLI behind a transaction-mode pooler connects once per call, so printing
 * the banner on every connect repeated the same stderr paragraph on every
 * `foresights entity` an agent ran. The first connect from this foresights home to a
 * database prints it and records a marker; later connects to that database
 * stay quiet. The marker's name is a digest of the credential-free target
 * (host, port, database, user) and the banner text, so a reworded banner or a
 * different database shows it again, and no URL or password is ever written.
 * A home that cannot be written prints the banner every time, as before.
 * `foresights engine status` (`prepare=false`) and doctor's `pgbouncer_prepare`
 * check keep reporting the setting on demand.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGbrainHome } from './gbrain-home.ts';
import { typeCacheTarget } from './pg-type-cache.ts';

export const POOLER_PREPARE_OFF_BANNER =
  '[foresights] Prepared statements and statement pipelining disabled (transaction-mode pooler convention: port 6543, ?prepare=false or GBRAIN_PREPARE=0). If your pooler runs in session mode, connect on its session port (Supabase: 5432); GBRAIN_PREPARE=true re-enables prepared statements only, and ?max_pipeline= or PGMAX_PIPELINE sets the pipeline depth. Shown once per database; `foresights engine status` reports it.';

/** Prints the banner unless this foresights home already showed it for the database `url` names. */
export function warnPoolerPrepareOffOnce(url: string): void {
  const digest = createHash('sha256').update(`${typeCacheTarget(url)}\n${POOLER_PREPARE_OFF_BANNER}`).digest('hex').slice(0, 32);
  const dir = join(resolveGbrainHome(), 'notices', 'pooler-prepare-off');
  const marker = join(dir, digest);
  if (existsSync(marker)) return;
  console.warn(POOLER_PREPARE_OFF_BANNER);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* an unwritable home shows the banner again next time */ }
}
