/**
 * postgres_tls: is this Postgres brain's own connection encrypted? The verdict
 * comes from the client side: the TLS mode the driver used for the URL the
 * engine connected with (sslmode=require, verify-ca and verify-full make the
 * driver refuse a server without TLS). Behind a pooler (PgBouncer, Supavisor)
 * pg_stat_ssl describes the pooler's hop to the database, so it is reported as
 * detail and never turns a TLS client into a warning. sslmode=disable warns, and
 * so does sslmode=prefer when the server's SSLRequest answer shows the driver
 * fell back to plaintext. PGLite opens no network connection and emits nothing.
 * The TLS default itself is src/core/pg-tls.ts.
 */

import { loadConfig } from '../../../core/config.ts';
import type { Action } from '../../../core/agent-output.ts';
import { pgConnectHosts, pgFirstHostPort, isLoopbackPgHost, probeServerTls, resolvePgTls } from '../../../core/pg-tls.ts';
import { doctorVerify } from '../check-fix.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export interface SessionTls { ssl: boolean; version: string | null }

const TLS_FIX: Action = {
  ask_user: true,
  argv: ['gbrain', 'engine', 'status', '--probe', '--json'],
  consent: [], actor: 'agent', requires_exclusive: false,
  why: 'Read-only: shows where the database URL comes from (an environment variable or the config file), which is where the sslmode setting goes.',
  user_message: 'This brain talks to a database server that is not on this machine without encryption, so the password and page contents cross the network in plaintext. Turn TLS on at the server and use sslmode=require (or sslmode=verify-full with the server CA, which also verifies the certificate) in the database URL; keep sslmode=disable only on a network you trust.',
  verify: doctorVerify('postgres_tls'),
  docs: 'docs/guides/error-codes.md#postgres_tls_required',
};

/**
 * Pure: the finding for a connected Postgres brain, judged from this machine's side: the TLS mode the
 * driver used for the URL the engine connected with. pg_stat_ssl (null when unreadable) is detail only,
 * since behind a pooler it describes the pooler's hop. preferAnswer is the server's SSLRequest answer,
 * read only for sslmode=prefer, the one mode whose driver falls back to plaintext.
 */
export function postgresTlsCheck(
  url: string,
  session: SessionTls | null,
  env: Record<string, string | undefined> = process.env,
  preferAnswer: 'S' | 'N' | null = null,
): Check | null {
  const hosts = pgConnectHosts(url, {}, env);
  if (hosts.length > 0 && hosts.every(isLoopbackPgHost)) {
    return { name: 'postgres_tls', status: 'ok', message: 'The Postgres host is on this machine; TLS is not required.' };
  }
  const { source, mode } = resolvePgTls(url, {}, env);
  const serverView = session ? { server_reports_ssl: session.ssl, server_ssl_version: session.version } : {};
  const optedOut = mode === 'disable' && source !== 'env';
  const prefer = mode === 'prefer';
  if (optedOut || (prefer && (preferAnswer === 'N' || session?.ssl === false))) {
    return {
      name: 'postgres_tls', status: 'warn',
      message: optedOut
        ? 'Connected to a non-local Postgres host without TLS (sslmode=disable in the database URL): the password and page contents cross the network in plaintext. Turn TLS on at the server and use sslmode=require or sslmode=verify-full.'
        : preferAnswer === 'N'
          ? 'sslmode=prefer fell back to plaintext: the non-local Postgres server does not offer TLS, so the password and page contents cross the network unencrypted. Turn TLS on at the server and use sslmode=require, which refuses to fall back.'
          : 'sslmode=prefer may have fallen back to plaintext: the server reports this session unencrypted, and prefer lets the driver connect without TLS whenever a server does not offer it. Use sslmode=require, which refuses to fall back.',
      details: { client_tls: optedOut || preferAnswer === 'N' ? false : null, sslmode: mode, ...serverView },
      fix: TLS_FIX,
    };
  }
  if (prefer && preferAnswer !== 'S' && !session?.ssl) return null;
  const unverified = mode === 'require' || prefer || mode === 'allow';
  const notes = [
    unverified ? 'sslmode=' + mode + ' does not verify the server certificate; sslmode=verify-full with the server CA also verifies it.' : '',
    !prefer && session && !session.ssl ? 'The server reports this session unencrypted: behind a pooler that is the pooler\'s own hop to the database, which cannot be checked from this machine.' : '',
  ].filter(Boolean).join(' ');
  return {
    name: 'postgres_tls', status: 'ok',
    message: (prefer
      ? 'sslmode=prefer: the non-local Postgres server ' + (session?.ssl ? 'reports this session encrypted' : 'offers TLS') + ', but prefer lets the driver fall back to plaintext without saying so, and that cannot be confirmed from this machine; sslmode=require refuses to fall back.'
      : 'This connection to the non-local Postgres host uses TLS' + (session?.ssl && session.version ? ' (' + session.version + ')' : '') + '.') + (notes ? ' ' + notes : ''),
    details: { client_tls: prefer ? null : true, sslmode: mode, ...serverView },
  };
}

async function runPostgresTls(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  if (engine.kind !== 'postgres') return checks;
  const url = (engine as { connectedDatabaseUrl?: string }).connectedDatabaseUrl ?? loadConfig()?.database_url;
  if (!url) return checks;
  let session: SessionTls | null = null;
  try {
    const rows = await engine.executeRaw<{ ssl: boolean; version: string | null }>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    if (rows[0]) session = { ssl: rows[0].ssl === true, version: rows[0].version ?? null };
  } catch { /* pg_stat_ssl unreadable: the client-side verdict stands */ }
  let preferAnswer: 'S' | 'N' | null = null;
  if (resolvePgTls(url).mode === 'prefer') {
    const target = pgFirstHostPort(url);
    if (target) preferAnswer = await probeServerTls(target.host, target.port);
  }
  const check = postgresTlsCheck(url, session, process.env, preferAnswer);
  if (check) checks.push({ name: 'postgres_tls', status: check.status, message: check.message, ...(check.details ? { details: check.details } : {}), ...(check.fix ? { fix: check.fix } : {}) });
  return checks;
}

export const postgresTlsEntry: DoctorEntry = { name: 'postgres_tls', emits: ['postgres_tls'], run: runPostgresTls };
