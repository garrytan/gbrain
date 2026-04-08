import { describe, test, expect } from 'bun:test';
import { toFts5Query } from '../src/core/sqlite-engine.ts';

describe('toFts5Query', () => {
  test('empty string returns empty', () => {
    expect(toFts5Query('')).toBe('');
    expect(toFts5Query('   ')).toBe('');
  });

  test('simple terms pass through', () => {
    expect(toFts5Query('hello world')).toBe('hello world');
  });

  test('negation converts -term to NOT', () => {
    const result = toFts5Query('quantum -classical');
    expect(result).toContain('quantum');
    expect(result).toContain('NOT classical');
  });

  test('bare negation (all negative) returns plain terms', () => {
    // Should not produce bare NOT (FTS5 syntax error)
    const result = toFts5Query('-foo -bar');
    expect(result).not.toMatch(/^NOT/);
  });

  test('quoted phrases pass through', () => {
    expect(toFts5Query('"exact match"')).toBe('"exact match"');
  });

  test('OR passes through', () => {
    expect(toFts5Query('cats OR dogs')).toBe('cats OR dogs');
  });

  test('NOT passes through', () => {
    expect(toFts5Query('cats NOT dogs')).toBe('cats NOT dogs');
  });

  test('single word with no operators', () => {
    expect(toFts5Query('quantum')).toBe('quantum');
  });

  test('lone hyphen is not negation', () => {
    const result = toFts5Query('-');
    // '-' alone has length 1, so it should pass through as-is
    expect(result).toBe('-');
  });
});
