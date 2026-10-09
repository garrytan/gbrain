/**
 * #6278 (plan item 1.4): doctor `persistence_session_timeouts`. Protects: the
 * check warns `session_timeouts_not_applied` when `SHOW statement_timeout`
 * through the configured URL reads `0` while gbrain configured one (a
 * transaction-mode pooler dropped the startup parameter), naming the pooler,
 * that `GBRAIN_STATEMENT_TIMEOUT` is ignored there, that the preparation
 * budget covers preparation reads, and the role-level fix; it is `ok` when the
 * server applied the timeout, when no timeout is configured
 * (`GBRAIN_STATEMENT_TIMEOUT=0`) and on PGLite. Fails when the pooler case
 * reads as healthy.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { sessionTimeoutsCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { withEnv } from './helpers/with-env.ts';

const postgres = (applied: string) => ({ kind: 'postgres', executeRaw: async (sql: string) => sql === 'SHOW statement_timeout' ? [{ statement_timeout: applied }] : [] }) as unknown as BrainEngine;

test('a pooler that drops the startup parameter is reported as session_timeouts_not_applied with the fix', async () => withEnv({ GBRAIN_STATEMENT_TIMEOUT: undefined }, async () => {
  const check = await sessionTimeoutsCheck(postgres('0'));
  expect(check).toMatchObject({ name: 'persistence_session_timeouts', status: 'warn', details: { configured: '5min', applied: '0', reason: 'session_timeouts_not_applied' } });
  for (const text of ['session_timeouts_not_applied', 'transaction-mode pooler', 'GBRAIN_STATEMENT_TIMEOUT is ignored', 'preparation budget covers the gap', "ALTER ROLE <gbrain role> SET statement_timeout = '5min'"]) {
    expect(check.message).toContain(text);
  }
}));

test('an applied timeout, a disabled one and PGLite are ok', async () => {
  await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '90s' }, async () => {
    expect(await sessionTimeoutsCheck(postgres('1min 30s'))).toMatchObject({ status: 'ok', details: { configured: '90s', applied: '1min 30s' } });
  });
  await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '0' }, async () => {
    expect(await sessionTimeoutsCheck(postgres('0'))).toMatchObject({ status: 'ok', details: { configured: null } });
  });
  expect(await sessionTimeoutsCheck({ kind: 'pglite' } as BrainEngine)).toMatchObject({ status: 'ok', details: { configured: '5min', applied: null } });
});

test('#6278: a transaction-mode pooler URL is named even when the timeout reaches the server, with the client-side settle and the session-mode URL', async () => {
  await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '10min', GBRAIN_DATABASE_URL: 'postgresql://user:pw@db.example.supabase.co:6543/postgres', DATABASE_URL: undefined, GBRAIN_PREPARE: undefined }, async () => {
    const check = await sessionTimeoutsCheck(postgres('10min'));
    expect(check).toMatchObject({ status: 'warn', details: { applied: '10min', pooler: 'transaction_mode', reason: 'transaction_mode_pooler' } });
    for (const text of ['transaction-mode pooler', 'GBRAIN_CANCEL_SETTLE_MS', 'port 5432']) expect(check.message).toContain(text);
  });
  await withEnv({ GBRAIN_STATEMENT_TIMEOUT: '10min', GBRAIN_DATABASE_URL: 'postgresql://user:pw@db.example.supabase.co:5432/postgres', DATABASE_URL: undefined, GBRAIN_PREPARE: undefined }, async () => {
    expect(await sessionTimeoutsCheck(postgres('10min'))).toMatchObject({ status: 'ok' });
  });
});
