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

  test('sslmode=disable warns even when the server reports the session encrypted (a pooler with TLS upstream)', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=disable', { ssl: true, version: 'TLSv1.3' }, {})!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('sslmode=disable');
  });

  test('a TLS client behind a pooler is ok: pg_stat_ssl describes the pooler hop, not this connection', () => {
    const pooler = 'postgres://u:p@aws-0-example.pooler.example.com:6543/postgres';
    const c = postgresTlsCheck(pooler, { ssl: false, version: null }, {})!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain('pooler');
    expect(c.message).toContain('cannot be checked from this machine');
    expect(c.fix).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain('plaintext');
  });

  test('a required mode is judged from the client side even when pg_stat_ssl is unreadable', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=verify-full', null, {})!;
    expect(c.status).toBe('ok');
    expect(c.details?.client_tls).toBe(true);
  });

  test('sslmode=prefer that fell back to plaintext is described as exactly that', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=prefer', { ssl: false, version: null }, {}, 'N')!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('fell back to plaintext');
    expect(c.message).not.toContain('pooler');
    expect(c.fix).toBeDefined();
  });

  test('sslmode=prefer against a server that offers TLS is ok and says require would refuse a fallback', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=prefer', { ssl: true, version: 'TLSv1.3' }, {}, 'S')!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain('sslmode=require');
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

  test('sslmode=prefer with a session the server reports unencrypted warns, whatever a fresh probe answers', () => {
    for (const answer of ['S', null] as const) {
      const c = postgresTlsCheck(REMOTE + '?sslmode=prefer', { ssl: false, version: null }, {}, answer)!;
      expect(c.status).toBe('warn');
      expect(c.message).toContain('plaintext');
      expect(c.details?.client_tls).not.toBe(true);
    }
  });

  test('sslmode=prefer never certifies the client hop: a fresh probe is not the engine socket', () => {
    const c = postgresTlsCheck(REMOTE + '?sslmode=prefer', { ssl: true, version: 'TLSv1.3' }, {}, 'S')!;
    expect(c.details?.client_tls).toBeNull();
  });

  test('PGSSL=disable is TLS for the driver (only URL values turn it off), so doctor does not warn', () => {
    const c = postgresTlsCheck(REMOTE, { ssl: true, version: 'TLSv1.3' }, { PGSSL: 'disable' })!;
    expect(c.status).toBe('ok');
  });

  test('sslmode=prefer with no answer from the server emits nothing', () => {
    expect(postgresTlsCheck(REMOTE + '?sslmode=prefer', null, {}, null)).toBeNull();
  });

  test('the entry is registered and emits nothing on PGLite', async () => {
    expect(DOCTOR_CHECK_REGISTRY).toContain(postgresTlsEntry);
    expect(await postgresTlsEntry.run({ engine } as never)).toEqual([]);
  });
});
