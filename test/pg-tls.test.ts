/**
 * Postgres TLS default (src/core/pg-tls.ts): every postgres() pool requires
 * TLS for a host that is not on this machine unless the URL, the call site or
 * the driver's PGSSL variable names a mode. PGLite has no network connection,
 * so nothing here applies to it.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import { isLoopbackPgHost, pgConnectHosts, resolvePgTls, withPgTls } from '../src/core/pg-tls.ts';

const NO_ENV = {};

function driverSsl(url: string, opts: Record<string, unknown> = {}, env: Record<string, string | undefined> = NO_ENV): unknown {
  const sql = postgres(url, withPgTls(url, opts, env));
  return (sql as unknown as { options: { ssl: unknown } }).options.ssl;
}

describe('isLoopbackPgHost', () => {
  test.each([
    'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1',
    '/var/run/postgresql', '/tmp/.s.PGSQL.5432',
  ])('%s is loopback', host => {
    expect(isLoopbackPgHost(host)).toBe(true);
  });

  test.each([
    'db.example.com', '10.0.0.5', '192.168.1.20', '172.17.0.2', 'postgres-1', 'pgbouncer', 'localhost.example.com',
    '128.0.0.1', '::2', 'fe80::1', '', 'localhost-db',
  ])('%s is not loopback', host => {
    expect(isLoopbackPgHost(host)).toBe(false);
  });
});

describe('pgConnectHosts', () => {
  test('reads the URL host, a multi-host list, an IPv6 literal and the driver fallbacks', () => {
    expect(pgConnectHosts('postgres://u:p@db.example.com:5432/x', {}, NO_ENV)).toEqual(['db.example.com']);
    expect(pgConnectHosts('postgres://u:p@localhost:5432,db.example.com:5433/x', {}, NO_ENV)).toEqual(['localhost', 'db.example.com']);
    expect(pgConnectHosts('postgres://u:p@[::1]:5432/x', {}, NO_ENV)).toEqual(['::1']);
    expect(pgConnectHosts('postgres:///x', {}, NO_ENV)).toEqual(['localhost']);
    expect(pgConnectHosts('postgres:///x', {}, { PGHOST: '/var/run/postgresql' })).toEqual(['/var/run/postgresql']);
    expect(pgConnectHosts('postgres://u@db.example.com/x', { host: '127.0.0.1' }, NO_ENV)).toEqual(['127.0.0.1']);
    expect(pgConnectHosts('postgres://u@db.example.com/x', { path: '/tmp/.s.PGSQL.5432' }, NO_ENV)).toEqual(['/tmp/.s.PGSQL.5432']);
  });
});

describe('resolvePgTls', () => {
  test('a loopback host keeps the driver default (no TLS required)', () => {
    for (const url of ['postgres://u:p@localhost:5432/x', 'postgres://u:p@127.0.0.1:5432/x', 'postgres://u:p@[::1]:5432/x', 'postgresql://u@localhost/x']) {
      expect(resolvePgTls(url, {}, NO_ENV).source).toBe('loopback');
      expect(driverSsl(url)).toBe(false);
    }
  });

  test('a Unix socket keeps the driver default', () => {
    expect(resolvePgTls('postgres:///x', { path: '/tmp/.s.PGSQL.5432' }, NO_ENV).source).toBe('loopback');
    expect(resolvePgTls('postgres:///x', {}, { PGHOST: '/var/run/postgresql' }).source).toBe('loopback');
  });

  test('any other host requires TLS by default: a public name, a private IP, a Docker service name', () => {
    for (const url of [
      'postgres://u:p@db.example.com:5432/x',
      'postgresql://postgres.ref:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      'postgres://u:p@10.0.0.5:5432/x',
      'postgres://u:p@postgres-1:5432/x',
      'postgres://u:p@localhost:5432,db.example.com:5432/x',
    ]) {
      const r = resolvePgTls(url, {}, NO_ENV);
      expect(r.source).toBe('default');
      expect(r.mode).toBe('require');
      expect(driverSsl(url)).toBe('require');
    }
  });

  test('sslmode in the URL is honored, including the disable opt-out', () => {
    const base = 'postgres://u:p@db.example.com:5432/x';
    expect(resolvePgTls(base + '?sslmode=disable', {}, NO_ENV)).toMatchObject({ source: 'url', mode: 'disable' });
    expect(driverSsl(base + '?sslmode=disable')).toBe(false);
    expect(driverSsl(base + '?sslmode=require')).toBe('require');
    expect(driverSsl(base + '?sslmode=verify-full')).toBe('verify-full');
    expect(driverSsl(base + '?sslmode=prefer')).toBe('prefer');
    expect(driverSsl(base + '?prepare=false&sslmode=disable')).toBe(false);
  });

  test('the ssl parameter and sslrootcert=system count as explicit', () => {
    const base = 'postgres://u:p@db.example.com:5432/x';
    expect(resolvePgTls(base + '?ssl=false', {}, NO_ENV).source).toBe('url');
    expect(driverSsl(base + '?ssl=false')).toBe(false);
    expect(resolvePgTls(base + '?sslrootcert=system', {}, NO_ENV).source).toBe('url');
    expect(driverSsl(base + '?sslrootcert=system')).toBe('verify-full');
  });

  test('an empty ssl or sslmode value is no choice: the TLS default still applies', () => {
    const base = 'postgres://u:p@db.example.com:5432/x';
    expect(resolvePgTls(base + '?ssl=', {}, NO_ENV).source).toBe('default');
    expect(driverSsl(base + '?ssl=')).toBe('require');
    expect(resolvePgTls(base + '?sslmode=', {}, NO_ENV).source).toBe('default');
  });

  test('a repeated parameter is read the way the driver reads it: the last value wins', () => {
    const base = 'postgres://u:p@db.example.com:5432/x';
    expect(resolvePgTls(base + '?sslmode=&sslmode=verify-full', {}, NO_ENV)).toEqual({ source: 'url', mode: 'verify-full' });
    expect(driverSsl(base + '?sslmode=&sslmode=verify-full')).toBe('verify-full');
    expect(resolvePgTls(base + '?ssl=require&ssl=', {}, NO_ENV).source).toBe('default');
    expect(driverSsl(base + '?ssl=', {}, { PGSSL: 'verify-full' })).toBe('require');
  });

  test('a query string inside the URL fragment is not a choice the driver sees', () => {
    const url = 'postgres://u:p@db.example.com:5432/x#?sslmode=require';
    expect(resolvePgTls(url, {}, NO_ENV).source).toBe('default');
    expect(driverSsl(url)).toBe('require');
  });

  test('an explicit mode on a loopback URL is never weakened', () => {
    expect(driverSsl('postgres://u:p@localhost:5432/x?sslmode=verify-full')).toBe('verify-full');
  });

  test('a call site ssl option wins and is passed through unchanged', () => {
    const tlsObject = { rejectUnauthorized: true, ca: 'PEM' };
    expect(resolvePgTls('postgres://u@db.example.com/x', { ssl: tlsObject }, NO_ENV).source).toBe('option');
    expect(withPgTls('postgres://u@db.example.com/x', { ssl: tlsObject }, NO_ENV).ssl).toBe(tlsObject);
  });

  test('the driver PGSSL variable is an explicit setting the resolver leaves alone', () => {
    const r = resolvePgTls('postgres://u@db.example.com/x', {}, { PGSSL: 'verify-full' });
    expect(r.source).toBe('env');
    expect('ssl' in withPgTls('postgres://u@db.example.com/x', {}, { PGSSL: 'verify-full' })).toBe(false);
  });

  test('withPgTls never mutates the options it is given', () => {
    const opts = { max: 1 };
    const out = withPgTls('postgres://u@db.example.com/x', opts, NO_ENV);
    expect(out as Record<string, unknown>).toEqual({ max: 1, ssl: 'require' });
    expect(opts).toEqual({ max: 1 });
  });
});

describe('every postgres() pool in src/ goes through withPgTls', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  test('no call site builds a pool with bare options', () => {
    const root = join(import.meta.dir, '..', 'src');
    const offenders: string[] = [];
    let sites = 0;
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      if (!/^import postgres from '#postgres'/m.test(text)) continue;
      for (const [i, line] of text.split('\n').entries()) {
        const t = line.trimStart();
        if (t.startsWith('*') || t.startsWith('//') || !/(?:=|return|\(|,)\s*postgres\(/.test(line)) continue;
        sites++;
        if (!line.includes('withPgTls(')) offenders.push(file.slice(root.length + 1) + ':' + (i + 1));
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(6);
  });
});
