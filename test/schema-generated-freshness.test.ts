import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('generated PostgreSQL schema blob exactly matches src/schema.sql', () => {
  const schema = readFileSync('src/schema.sql', 'utf8');
  const generated = readFileSync('src/core/schema-embedded.generated.ts', 'utf8');
  const expected = [
    '// AUTO-GENERATED — do not edit. Run: bun run build:schema',
    '// Source: src/schema.sql',
    '',
    'export const SCHEMA_SQL = `',
    schema.replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/\n$/, ''),
    '`;',
    '',
  ].join('\n');
  expect(generated).toBe(expected);
});
