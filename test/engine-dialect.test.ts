import { describe, expect, test } from 'bun:test';
import { postgresDialect, sqliteDialect } from '../src/core/engine-dialect.ts';

describe('postgresDialect', () => {
  test('renders 1-based positional placeholders', () => {
    expect(postgresDialect.placeholder(1)).toBe('$1');
    expect(postgresDialect.placeholder(12)).toBe('$12');
  });

  test('renders jsonb-cast placeholders for JSON parameters', () => {
    expect(postgresDialect.jsonPlaceholder(6)).toBe('$6::jsonb');
  });

  test('reads rows back via RETURNING with server-managed timestamps', () => {
    expect(postgresDialect.name).toBe('postgres');
    expect(postgresDialect.supportsReturning).toBe(true);
    expect(postgresDialect.serverNow).toBe('now()');
  });
});

describe('sqliteDialect', () => {
  test('renders anonymous positional placeholders regardless of index', () => {
    expect(sqliteDialect.placeholder(1)).toBe('?');
    expect(sqliteDialect.placeholder(12)).toBe('?');
  });

  test('renders plain placeholders for JSON parameters (TEXT columns)', () => {
    expect(sqliteDialect.jsonPlaceholder(6)).toBe('?');
  });

  test('writes then reads back with client-managed timestamps', () => {
    expect(sqliteDialect.name).toBe('sqlite');
    expect(sqliteDialect.supportsReturning).toBe(false);
    expect(sqliteDialect.serverNow).toBeNull();
  });
});
