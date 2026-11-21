import { describe, test, expect } from 'bun:test';
import { quarantineEntry } from '../src/commands/doctor/checks/content-quality.ts';

function ctxFor(err: Error) {
  const engine = {
    kind: 'postgres',
    executeRaw: async () => { throw err; },
  } as any;
  return { engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as any;
}

async function run(err: Error) {
  try {
    return await quarantineEntry.run(ctxFor(err));
  } catch (e) {
    return [] as any[];
  }
}

describe('quarantined_pages / flagged_pages when the probe throws (#9924)', () => {
  test('a connection failure is not reported as ok', async () => {
    const checks = await run(new Error('connection terminated'));
    for (const name of ['quarantined_pages', 'flagged_pages']) {
      const c = checks.find((x: any) => x.name === name);
      expect(c?.status).toBe('warn');
      expect(c?.message).toContain('connection terminated');
    }
  });

  test('a missing pages table still skips as ok', async () => {
    const checks = await run(Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' }));
    const c = checks.find((x: any) => x.name === 'quarantined_pages');
    expect(c?.status).toBe('ok');
  });
});
