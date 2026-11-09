/**
 * Postgres arm of the TLS default (src/core/pg-tls.ts), against real servers.
 *
 *   - DATABASE_URL (the CI lane: a loopback server without TLS) still connects
 *     in plaintext, and the doctor finding reads ok.
 *   - GBRAIN_TEST_PG_TLS_REMOTE_URL: a TLS-enabled server reached through a
 *     non-loopback address, with no sslmode in the URL. Both pool kinds connect
 *     encrypted (pg_stat_ssl.ssl = true).
 *   - GBRAIN_TEST_PG_PLAIN_REMOTE_URL: a server with ssl=off reached through a
 *     non-loopback address, no sslmode. connect() refuses with
 *     postgres_tls_required; the same URL plus sslmode=disable connects and the
 *     doctor finding warns.
 *
 * The two remote URLs need a container reached through its bridge address, so
 * they are opt-in (they skip when unset); see the PR for the docker commands.
 */

import { describe, test, expect } from 'bun:test';
import * as db from '../../src/core/db.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { postgresTlsCheck } from '../../src/commands/doctor/checks/postgres-tls.ts';

const LOCAL = process.env.DATABASE_URL;
const TLS_REMOTE = process.env.GBRAIN_TEST_PG_TLS_REMOTE_URL;
const PLAIN_REMOTE = process.env.GBRAIN_TEST_PG_PLAIN_REMOTE_URL;
const SESSION_SSL = 'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()';

async function moduleSessionTls(url: string): Promise<{ ssl: boolean; version: string | null }> {
  await db.connect({ database_url: url } as never);
  try {
    const [row] = await db.getConnection().unsafe(SESSION_SSL);
    return { ssl: row.ssl === true, version: row.version ?? null };
  } finally { await db.disconnect(); }
}

function withParam(url: string, param: string): string {
  return url + (url.includes('?') ? '&' : '?') + param;
}

describe.skipIf(!LOCAL)('loopback Postgres without TLS', () => {
  test('still connects in plaintext, and doctor reads ok', async () => {
    const session = await moduleSessionTls(LOCAL!);
    if (/@(localhost|127\.|\[::1\])/.test(LOCAL!)) {
      expect(postgresTlsCheck(LOCAL!, session)!.status).toBe('ok');
    }
  }, 60_000);
});

describe.skipIf(!TLS_REMOTE)('non-loopback Postgres with TLS, no sslmode in the URL', () => {
  test('the module pool connects encrypted', async () => {
    const session = await moduleSessionTls(TLS_REMOTE!);
    expect(session.ssl).toBe(true);
    expect(postgresTlsCheck(TLS_REMOTE!, session)!.status).toBe('ok');
  }, 60_000);

  test('a worker instance pool connects encrypted', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: TLS_REMOTE!, poolSize: 2 } as never);
    try {
      const [row] = await engine.executeRaw<{ ssl: boolean }>(SESSION_SSL);
      expect(row.ssl).toBe(true);
    } finally { await engine.disconnect(); }
  }, 60_000);
});

describe.skipIf(!PLAIN_REMOTE)('non-loopback Postgres with ssl=off', () => {
  test('connect() refuses with postgres_tls_required instead of falling back to plaintext', async () => {
    let error: unknown;
    try { await db.connect({ database_url: PLAIN_REMOTE! } as never); } catch (e) { error = e; } finally { await db.disconnect(); }
    expect((error as { canonicalCode?: string } | undefined)?.canonicalCode).toBe('postgres_tls_required');
    expect(String((error as Error).message)).toContain('TLS was required by default for a non-local Postgres host');
  }, 60_000);

  test('a worker instance pool refuses the same way', async () => {
    const engine = new PostgresEngine();
    let error: unknown;
    try { await engine.connect({ database_url: PLAIN_REMOTE!, poolSize: 2 } as never); } catch (e) { error = e; } finally { await engine.disconnect().catch(() => {}); }
    expect((error as { canonicalCode?: string } | undefined)?.canonicalCode).toBe('postgres_tls_required');
  }, 60_000);

  test('sslmode=disable opts out: it connects in plaintext and doctor warns', async () => {
    const url = withParam(PLAIN_REMOTE!, 'sslmode=disable');
    const session = await moduleSessionTls(url);
    expect(session.ssl).toBe(false);
    const check = postgresTlsCheck(url, session)!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('sslmode=disable');
  }, 60_000);
});
