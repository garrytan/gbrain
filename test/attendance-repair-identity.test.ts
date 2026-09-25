import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { EngineConfig } from '../src/core/types.ts';
import { attendanceRepairConnectionIdentity } from '../src/commands/extract-attendance-repair.ts';
import { attendanceRepairHash } from '../src/core/attendance-repair.ts';

function connection(target = 'postgresql://db.example.invalid:5432/brain_example', rotation = false): EngineConfig {
  const url = new URL(target);
  url.username = rotation ? 'rotated_example' : 'operator_example';
  url.password = rotation ? 'synthetic-rotation' : 'synthetic-original';
  url.searchParams.set('sslpassword', rotation ? 'synthetic-query-rotation' : 'synthetic-query-original');
  url.searchParams.set('application_name', rotation ? 'second_example' : 'first_example');
  return { engine: 'postgres', database_url: url.toString() };
}

describe('attendance repair credential-free connection identity', () => {
  test('credential rotation and irrelevant query/config fields do not change the PostgreSQL target', () => {
    const original = attendanceRepairConnectionIdentity('host', connection());
    expect(attendanceRepairConnectionIdentity('host', connection(undefined, true))).toBe(original);
    expect(attendanceRepairConnectionIdentity('host', Object.assign(connection(), {
      database_path: '/ignored/example', poolSize: 42, auth_token: 'synthetic-unused',
    }))).toBe(original);
    expect(original).toBe(attendanceRepairHash(['host', { engine: 'postgres', scheme: 'postgresql:',
      hosts: [['db.example.invalid', 5432]], database: 'brain_example' }]));
  });

  test('host, port, database, scheme and brain selection remain pinned', () => {
    const original = attendanceRepairConnectionIdentity('host', connection());
    for (const target of ['postgresql://other.example.invalid:5432/brain_example',
      'postgresql://db.example.invalid:6543/brain_example', 'postgresql://db.example.invalid:5432/other_example',
      'postgres://db.example.invalid:5432/brain_example']) {
      expect(attendanceRepairConnectionIdentity('host', connection(target))).not.toBe(original);
    }
    expect(attendanceRepairConnectionIdentity('other-brain', connection())).not.toBe(original);
  });

  test('PGLite pins only its resolved path and selected brain, not unused connection settings', () => {
    const original = attendanceRepairConnectionIdentity('host', { engine: 'pglite', database_path: './example/../brain.pglite' });
    expect(attendanceRepairConnectionIdentity('host', { ...connection(undefined, true), engine: 'pglite',
      database_path: resolve('brain.pglite') })).toBe(original);
    expect(original).toBe(attendanceRepairHash(['host', { engine: 'pglite', path: resolve('brain.pglite') }]));
    expect(attendanceRepairConnectionIdentity('host', { engine: 'pglite', database_path: './other.pglite' })).not.toBe(original);
    expect(attendanceRepairConnectionIdentity('other-brain', { engine: 'pglite', database_path: './brain.pglite' })).not.toBe(original);
  });

  test('multihost and IPv6 targets have distinct normalized identities without credential input', () => {
    const url = 'postgresql://first.example.invalid:5433,[2001:db8::1]:5434/brain_example';
    const original = attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url: url });
    const withCredentials = url.replace('://', '://operator_example:synthetic-rotation@') + '?sslpassword=synthetic-query';
    expect(attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url: withCredentials })).toBe(original);
    expect(original).toBe(attendanceRepairHash(['host', { engine: 'postgres', scheme: 'postgresql:',
      hosts: [['first.example.invalid', 5433], ['[2001:db8::1]', 5434]], database: 'brain_example' }]));
    const targets = [url, url.replace('first.example', 'second.example'), url.replace('::1', '::2'),
      url.replace(':5434', ':5435'), url.replace('brain_example', 'other_example'),
      'postgresql://[2001:db8::1]:5434/brain_example', 'postgresql://[2001:db8::2]:5434/brain_example'];
    expect(new Set(targets.map(database_url => attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url }))).size)
      .toBe(targets.length);
  });

  test('a missing multihost port follows the driver first-host default', () => {
    expect(attendanceRepairConnectionIdentity('host', { engine: 'postgres',
      database_url: 'postgresql://first.example.invalid:5433,second.example.invalid/brain_example' }))
      .toBe(attendanceRepairConnectionIdentity('host', { engine: 'postgres',
        database_url: 'postgresql://first.example.invalid:5433,second.example.invalid:5433/brain_example' }));
  });

  test.each(['not-a-url', 'https://db.example.invalid/brain_example', 'postgresql:///brain_example',
    'postgresql://db.example.invalid', 'postgresql://db.example.invalid/', 'postgresql://db.example.invalid:99999/brain_example',
    'postgresql://[invalid-ipv6]/brain_example', 'postgresql://first.example.invalid,,second.example.invalid/brain_example',
    'postgresql://%2Fvar%2Frun/brain_example', 'postgresql://db.example.invalid/brain_example?database=other_example',
    'postgresql://db.example.invalid/brain_example#fragment'])('malformed or unsupported targets refuse: %s', database_url => {
    expect(() => attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url }))
      .toThrow('Attendance repair requires a supported explicit PostgreSQL endpoint and database');
  });

  test('refusal messages never echo credential-bearing input', () => {
    const database_url = 'postgresql://operator_example:synthetic-secret@bad.example.invalid:99999/brain_example?sslpassword=synthetic-query';
    try {
      attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url });
      throw new Error('expected refusal');
    } catch (error) {
      expect((error as Error).message).toBe('Attendance repair requires a supported explicit PostgreSQL endpoint and database');
    }
    expect(() => attendanceRepairConnectionIdentity('host', { engine: 'pglite' })).toThrow('explicit PGLite path');
  });
});
