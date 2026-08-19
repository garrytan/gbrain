import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveCycleDate } from '../src/core/cycle/cycle-date.ts';

function configEngine(timeZone: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => key === 'cycle.timezone' ? timeZone : null,
  } as unknown as BrainEngine;
}

describe('dream cycle date policy', () => {
  test('configured timezone owns the calendar day across the UTC-midnight boundary', async () => {
    const date = await resolveCycleDate(configEngine('Asia/Kolkata'), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'UTC',
    });

    expect(date).toBe('2026-08-20');
  });

  test('explicit date is stable across reruns and bypasses clock projection', async () => {
    const engine = configEngine('Asia/Kolkata');
    const first = await resolveCycleDate(engine, {
      explicitDate: '2026-07-11',
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'UTC',
    });
    const rerun = await resolveCycleDate(engine, {
      explicitDate: '2026-07-11',
      now: () => new Date('2026-08-20T21:30:00.000Z'),
      systemTimeZone: () => 'America/Los_Angeles',
    });

    expect(first).toBe('2026-07-11');
    expect(rerun).toBe(first);
  });

  test('host timezone is the fallback when no cycle timezone is configured', async () => {
    const date = await resolveCycleDate(configEngine(null), {
      now: () => new Date('2026-08-20T02:30:00.000Z'),
      systemTimeZone: () => 'America/Los_Angeles',
    });

    expect(date).toBe('2026-08-19');
  });

  test('invalid configured timezone falls back loudly instead of killing the cycle', async () => {
    const warnings: string[] = [];
    const date = await resolveCycleDate(configEngine('Mars/Olympus_Mons'), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'Asia/Kolkata',
      warn: message => warnings.push(message),
    });

    expect(date).toBe('2026-08-20');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cycle.timezone');
    expect(warnings[0]).toContain('Mars/Olympus_Mons');
    expect(warnings[0]).toContain('Asia/Kolkata');
  });
});
