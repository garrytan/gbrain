import { describe, expect, test } from 'bun:test';
import {
  decodeJsonColumn,
  encodeJsonColumn,
} from '../src/core/storage/json-column.ts';

describe('JSON column helpers', () => {
  test('encodes objects and arrays exactly once for storage', () => {
    expect(encodeJsonColumn({ a: 1 })).toBe('{"a":1}');
    expect(encodeJsonColumn(['x', 'y'])).toBe('["x","y"]');
    expect(encodeJsonColumn('{"already":"json"}')).toBe('{"already":"json"}');
  });

  test('decodes sqlite text and postgres jsonb values without double parsing callers', () => {
    expect(decodeJsonColumn('{"a":1}', {})).toEqual({ a: 1 });
    expect(decodeJsonColumn({ a: 1 }, {})).toEqual({ a: 1 });
    expect(decodeJsonColumn(null, { fallback: true })).toEqual({ fallback: true });
  });

  test('decodes legacy double-encoded JSON strings', () => {
    expect(decodeJsonColumn(JSON.stringify(JSON.stringify({ a: 1 })), {})).toEqual({ a: 1 });
  });
});
