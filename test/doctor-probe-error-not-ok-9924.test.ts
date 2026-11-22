/**
 * #9924: quarantined_pages and flagged_pages reported ok ("Skipped (...)") whenever their probe threw,
 * so a dropped connection or a statement timeout read as a clean "No quarantined pages".
 *
 * 1. Protects: a probe failure other than a missing pages table is a warn through checkError.
 * 2. Fails when: either catch goes back to an unconditional status: 'ok'.
 * 3. Real seams: the quarantineEntry doctor runner with an engine whose executeRaw rejects.
 */
import { describe, expect, test } from 'bun:test';
import { quarantineEntry } from '../src/commands/doctor/checks/content-quality.ts';
import type { Check } from '../src/commands/doctor.ts';

async function run(err: Error): Promise<Check[]> {
  const engine = { kind: 'postgres', executeRaw: async () => { throw err; } };
  return await quarantineEntry.run({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as never) as Check[];
}

describe('quarantined_pages / flagged_pages when the probe throws (#9924)', () => {
  test('a connection failure is a warn naming the error, not ok', async () => {
    const checks = await run(new Error('connection terminated'));
    for (const name of ['quarantined_pages', 'flagged_pages']) {
      const check = checks.find(c => c.name === name);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('connection terminated');
    }
  });

  test('a missing pages table still skips as ok', async () => {
    const checks = await run(Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' }));
    for (const name of ['quarantined_pages', 'flagged_pages']) {
      expect(checks.find(c => c.name === name)?.status).toBe('ok');
    }
  });
});
