import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/import.ts'), 'utf-8');

describe('import --workers auto wiring', () => {
  test('accepts --workers auto and routes through shared autoConcurrency policy', () => {
    expect(SRC).toContain("workersArg === 'auto'");
    expect(SRC).toContain('autoConcurrency(engine, files.length, undefined)');
    expect(SRC).toContain('workerCount ?? 1');
  });
});
