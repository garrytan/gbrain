import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSyntheticHouseholdBrain } from '../scripts/synthetic-household.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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

  test('removes a half-written brain when seeding fails, so the next run can start over (W1a follow-up)', async () => {
    const fresh = join(dir, 'fresh');
    const spy = spyOn(PGLiteEngine.prototype, 'setConfig').mockRejectedValue(new Error('seed failed on purpose'));
    try {
      await expect(seedSyntheticHouseholdBrain(fresh)).rejects.toThrow('seed failed on purpose');
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(fresh, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(existsSync(join(fresh, '.gbrain'))).toBe(false);
  });
});
