/**
 * postgres_tls doctor finding (src/commands/doctor/checks/postgres-tls.ts): a
 * Postgres brain on a non-loopback host connected without TLS warns and names
 * the fix. The live pg_stat_ssl read is covered by test/e2e/pg-tls-postgres.test.ts;
 * PGLite has no network connection, so the entry emits nothing there.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { postgresTlsCheck, postgresTlsEntry } from '../src/commands/doctor/checks/postgres-tls.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

const REMOTE = 'postgres://u:p@db.example.com:5432/brain';

describe('postgres_tls doctor check', () => {
  test('a non-loopback brain connected without TLS warns and names the fix', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=disable', { ssl: false, version: null }, {})!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('without TLS');
    expect(c.message).toContain('sslmode=require');
    expect((c.fix as { ask_user?: boolean } | undefined)?.ask_user).toBe(true);
    expect(c.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'postgres_tls', '--json']);
    expect(categorizeCheck('postgres_tls')).toBe('ops');
  });

  test('a session the server reports unencrypted warns even when the URL asked for TLS (a pooler hop)', () => {
    const c = postgresTlsCheck(REMOTE, { ssl: false, version: null }, {})!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('pooler');
  });

  test('an encrypted non-loopback session is ok and says require does not verify the certificate', () => {
    const c = postgresTlsCheck(REMOTE, { ssl: true, version: 'TLSv1.3' }, {})!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain('TLSv1.3');
    expect(c.message).toContain('verify-full');
    const verified = postgresTlsCheck(REMOTE + '?sslmode=verify-full', { ssl: true, version: 'TLSv1.3' }, {})!;
    expect(verified.message).not.toContain('does not verify');
  });

  test('a loopback host is ok without TLS', () => {
    expect(postgresTlsCheck('postgres://u@127.0.0.1:5432/brain', { ssl: false, version: null }, {})!.status).toBe('ok');
  });

  test('an unreadable pg_stat_ssl on a remote host emits nothing', () => {
    expect(postgresTlsCheck(REMOTE, null, {})).toBeNull();
  });

  test('the entry is registered and emits nothing on PGLite', async () => {
    expect(DOCTOR_CHECK_REGISTRY).toContain(postgresTlsEntry);
    expect(await postgresTlsEntry.run({ engine } as never)).toEqual([]);
  });
});
