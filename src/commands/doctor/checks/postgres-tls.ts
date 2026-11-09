/**
 * postgres_tls: is this Postgres brain's connection encrypted? A brain on a
 * non-loopback host connected without TLS (the session's own pg_stat_ssl row)
 * is a warning that names the fix; an encrypted one is ok, with a note when
 * sslmode=require encrypts without verifying the server certificate. PGLite
 * opens no network connection and emits nothing. The TLS default itself is
 * src/core/pg-tls.ts.
 *
 * Behind a pooler (PgBouncer, Supavisor) pg_stat_ssl describes the pooler's
 * link to the database, not this client's link to the pooler; the message
 * says so when the URL asked for TLS but the session reads unencrypted.
 */

import { loadConfig } from '../../../core/config.ts';
import type { Action } from '../../../core/agent-output.ts';
import { pgConnectHosts, isLoopbackPgHost, resolvePgTls } from '../../../core/pg-tls.ts';
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

/** Pure: the finding for a connected Postgres brain, from its URL and its session's pg_stat_ssl row (null when unreadable). */
export function postgresTlsCheck(url: string, session: SessionTls | null, env: Record<string, string | undefined> = process.env): Check | null {
  const hosts = pgConnectHosts(url, {}, env);
  if (hosts.length > 0 && hosts.every(isLoopbackPgHost)) {
    return { name: 'postgres_tls', status: 'ok', message: 'The Postgres host is on this machine; TLS is not required.' };
  }
  if (!session) return null;
  const tls = resolvePgTls(url, {}, env);
  if (session.ssl) {
    const unverified = tls.mode === 'require' || tls.mode === 'prefer' || tls.mode === 'allow';
    return {
      name: 'postgres_tls', status: 'ok',
      message: `The connection to the non-local Postgres host is encrypted (${session.version ?? 'TLS'}).${unverified ? ' sslmode=' + tls.mode + ' does not verify the server certificate; sslmode=verify-full with the server CA also verifies it.' : ''}`,
      details: { ssl: true, version: session.version, sslmode: tls.mode },
    };
  }
  const optedOut = tls.mode === 'disable';
  return {
    name: 'postgres_tls', status: 'warn',
    message: optedOut
      ? 'Connected to a non-local Postgres host without TLS (sslmode=disable in the database URL): the password and page contents cross the network in plaintext. Turn TLS on at the server and use sslmode=require or sslmode=verify-full.'
      : `The non-local Postgres server reports this session as unencrypted although the URL asks for sslmode=${tls.mode}. Behind a pooler, this is the pooler's own link to the database; make sure that link is encrypted too.`,
    details: { ssl: false, sslmode: tls.mode },
    fix: TLS_FIX,
  };
}

async function runPostgresTls(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  if (engine.kind !== 'postgres') return checks;
  const url = loadConfig()?.database_url;
  if (!url) return checks;
  let session: SessionTls | null = null;
  try {
    const rows = await engine.executeRaw<{ ssl: boolean; version: string | null }>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    if (rows[0]) session = { ssl: rows[0].ssl === true, version: rows[0].version ?? null };
  } catch { /* pg_stat_ssl unreadable: no finding */ }
  const check = postgresTlsCheck(url, session);
  if (check) checks.push({ name: 'postgres_tls', status: check.status, message: check.message, ...(check.details ? { details: check.details } : {}), ...(check.fix ? { fix: check.fix } : {}) });
  return checks;
}

export const postgresTlsEntry: DoctorEntry = { name: 'postgres_tls', emits: ['postgres_tls'], run: runPostgresTls };
