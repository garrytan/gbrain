import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSyntheticHouseholdBrain } from '../scripts/synthetic-household.ts';

const dir = mkdtempSync(join(tmpdir(), 'gb-household-seed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('synthetic household seed script', () => {
  test('refuses a directory that holds a brain when the path has trailing whitespace (W1a follow-up)', async () => {
    mkdirSync(join(dir, '.gbrain'));
    writeFileSync(join(dir, '.gbrain', 'config.json'), '{"engine":"pglite","marker":"kept"}\n');
    await expect(seedSyntheticHouseholdBrain(dir + ' ')).rejects.toThrow('already exists');
    expect(readFileSync(join(dir, '.gbrain', 'config.json'), 'utf8')).toContain('"marker":"kept"');
    expect(existsSync(join(dir, '.gbrain', 'brain.pglite'))).toBe(false);
  });
});
