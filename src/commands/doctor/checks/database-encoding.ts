/**
 * database_encoding doctor check: a Postgres brain whose server_encoding is not UTF8 is reported as a warning (never a
 * refusal). On such a database, SQL-side whitespace trimming in the privacy and trust checks covers ASCII only, and
 * non-ASCII text is not handled reliably. PGLite is always UTF8, so the check is skipped there. Read-only.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';

async function runDatabaseEncoding(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('database_encoding');
  if (engine.kind === 'pglite') {
    checks.push({ name: 'database_encoding', status: 'ok', message: 'Skipped (PGLite is always UTF8)' });
    return checks;
  }
  try {
    const [row] = await engine.executeRaw<{ server_encoding: string }>('SHOW server_encoding');
    const encoding = row?.server_encoding ?? 'unknown';
    if (encoding === 'UTF8') {
      checks.push({ name: 'database_encoding', status: 'ok', message: 'The database encoding is UTF8' });
    } else {
      checks.push({
        name: 'database_encoding',
        status: 'warn',
        message: `The database encoding is ${encoding}, not UTF8. SQL-side whitespace trimming in the privacy and trust checks covers ASCII only, `
          + 'and text with non-ASCII characters is not handled reliably. gbrain keeps running; to remove this warning, move the brain to a database created with UTF8 encoding.',
        details: { server_encoding: encoding },
      });
    }
  } catch (e) {
    checks.push(checkError('database_encoding', 'read the database encoding', e));
  }
  return checks;
}

export const databaseEncodingEntry: DoctorEntry = { name: 'database_encoding', emits: ['database_encoding'], run: runDatabaseEncoding };
