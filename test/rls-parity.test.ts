import { describe, test, expect } from 'bun:test';

describe('RLS parity', () => {
  test('every CREATE TABLE in schema.sql has a matching ENABLE ROW LEVEL SECURITY', async () => {
    const source = await Bun.file(new URL('../src/schema.sql', import.meta.url)).text();

    const tableNames = [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)]
      .map(m => m[1]);

    const rlsTables = [...source.matchAll(/ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/g)]
      .map(m => m[1]);

    const missing = tableNames.filter(t => !rlsTables.includes(t));
    expect(missing).toEqual([]);
  });

  test('schema-embedded.ts RLS list matches schema.sql', async () => {
    const schema = await Bun.file(new URL('../src/schema.sql', import.meta.url)).text();
    const embedded = await Bun.file(new URL('../src/core/schema-embedded.ts', import.meta.url)).text();

    const rlsFromSchema = [...schema.matchAll(/ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/g)]
      .map(m => m[1]).sort();

    const rlsFromEmbedded = [...embedded.matchAll(/ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/g)]
      .map(m => m[1]).sort();

    expect(rlsFromEmbedded).toEqual(rlsFromSchema);
  });
});
