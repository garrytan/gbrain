import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { connectionFailureDetail } from '../src/core/connection-failure.ts';

describe('connectionFailureDetail', () => {
  test('uses the error message when present', () => {
    expect(connectionFailureDetail(new Error('ECONNREFUSED 127.0.0.1:5435')))
      .toBe('ECONNREFUSED 127.0.0.1:5435');
  });

  test('falls back to the error code when the message is empty', () => {
    const err = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(connectionFailureDetail(err)).toContain('ECONNREFUSED');
  });

  test('falls back to errno when message and code are missing', () => {
    const err = Object.assign(new Error(''), { errno: -61 });
    expect(connectionFailureDetail(err)).toContain('-61');
  });

  test('never returns an empty string for an empty Error', () => {
    const detail = connectionFailureDetail(new Error(''));
    expect(detail.length).toBeGreaterThan(0);
  });

  test('includes the error name when only the name is informative', () => {
    const err = new Error('');
    err.name = 'CONNECT_TIMEOUT';
    expect(connectionFailureDetail(err)).toContain('CONNECT_TIMEOUT');
  });

  test('stringifies non-Error values', () => {
    expect(connectionFailureDetail('socket hang up')).toBe('socket hang up');
  });

  test('never returns an empty string for empty non-Error values', () => {
    expect(connectionFailureDetail('').length).toBeGreaterThan(0);
    expect(connectionFailureDetail(null).length).toBeGreaterThan(0);
    expect(connectionFailureDetail(undefined).length).toBeGreaterThan(0);
  });
});

describe('postgres engine connection error wrapping', () => {
  test('postgres-engine preserves the failure cause via connectionFailureDetail', () => {
    const source = readFileSync(
      new URL('../src/core/postgres-engine.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('connectionFailureDetail');
  });
});
