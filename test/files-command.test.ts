import { describe, expect, test } from 'bun:test';
import { formatFileSizeKb } from '../src/commands/files.ts';

describe('formatFileSizeKb', () => {
  test('formats numeric file sizes', () => {
    expect(formatFileSizeKb(35 * 1024)).toBe('35KB');
    expect(formatFileSizeKb(512)).toBe('1KB');
    expect(formatFileSizeKb(0)).toBe('0KB');
  });

  test('formats bigint file sizes returned by Postgres', () => {
    expect(formatFileSizeKb(35n * 1024n)).toBe('35KB');
  });

  test('formats string file sizes from drivers that stringify bigint values', () => {
    expect(formatFileSizeKb('35840')).toBe('35KB');
  });

  test('prints unknown for missing or invalid sizes', () => {
    expect(formatFileSizeKb(null)).toBe('?');
    expect(formatFileSizeKb('not-a-number')).toBe('?');
  });
});
