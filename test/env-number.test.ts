/**
 * Direct coverage for the shared numeric env-var resolver.
 *
 * This module exists so doctor.ts and source-health.ts share ONE warn-once
 * memo (a duplicate helper would warn once per module — "warn exactly once"
 * quietly becoming "warn twice"). It backs the staleness-ceiling resolution
 * that closed the 71-day false-green, so its garbage-handling is load-bearing:
 * an env typo that silently produced NaN here would resurface the incident.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  resolveEnvNumber,
  resolveHoursEnv,
  warnOnceForEnv,
  _resetEnvNumberWarnedForTests,
} from '../src/core/env-number.ts';

const VAR = 'GBRAIN_ENV_NUMBER_TEST_VAR';

function captureWarns(fn: () => void): string[] {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warns;
}

beforeEach(() => _resetEnvNumberWarnedForTests());

describe('resolveEnvNumber', () => {
  test('unset and empty both mean fallback, with no warning', async () => {
    await withEnv({ [VAR]: undefined }, () => {
      const warns = captureWarns(() => {
        expect(resolveEnvNumber(VAR, 72)).toBe(72);
      });
      expect(warns).toEqual([]);
    });
    await withEnv({ [VAR]: '' }, () => {
      expect(resolveEnvNumber(VAR, 72)).toBe(72);
    });
  });

  test('a valid positive number wins, including fractional', async () => {
    await withEnv({ [VAR]: '36' }, () => {
      expect(resolveEnvNumber(VAR, 72)).toBe(36);
    });
    await withEnv({ [VAR]: '0.5' }, () => {
      expect(resolveEnvNumber(VAR, 72)).toBe(0.5);
    });
  });

  test('garbage, zero, and negatives fall back — zero is an unset accident, not a disable', async () => {
    for (const bad of ['garbage', 'NaN', 'Infinity', '-5', '0']) {
      _resetEnvNumberWarnedForTests();
      await withEnv({ [VAR]: bad }, () => {
        expect(resolveEnvNumber(VAR, 72)).toBe(72);
      });
    }
  });

  test('warns exactly once per var per process, unit string included', async () => {
    await withEnv({ [VAR]: 'garbage' }, () => {
      const warns = captureWarns(() => {
        resolveEnvNumber(VAR, 72, { unit: 'h' });
        resolveEnvNumber(VAR, 72, { unit: 'h' });
        resolveEnvNumber(VAR, 72, { unit: 'h' });
      });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(VAR);
      expect(warns[0]).toContain('72h');
    });
  });
});

describe('resolveHoursEnv', () => {
  test('is resolveEnvNumber with the hours unit pre-applied', async () => {
    await withEnv({ [VAR]: 'bogus' }, () => {
      const warns = captureWarns(() => {
        expect(resolveHoursEnv(VAR, 24)).toBe(24);
      });
      expect(warns[0]).toContain('24h');
    });
  });
});

describe('warnOnceForEnv', () => {
  test('shares the SAME memo as resolveEnvNumber — the whole reason this module exists', async () => {
    await withEnv({ [VAR]: 'garbage' }, () => {
      const warns = captureWarns(() => {
        resolveEnvNumber(VAR, 72); // seeds the memo for VAR
        warnOnceForEnv(VAR, 'should be suppressed');
        warnOnceForEnv(VAR, 'should be suppressed');
      });
      expect(warns).toHaveLength(1);
      expect(warns[0]).not.toBe('should be suppressed');
    });
  });

  test('fires its message once for a var resolveEnvNumber never touched', () => {
    const warns = captureWarns(() => {
      warnOnceForEnv('GBRAIN_ENV_NUMBER_OTHER_VAR', 'custom disabled-unless-set warning');
      warnOnceForEnv('GBRAIN_ENV_NUMBER_OTHER_VAR', 'custom disabled-unless-set warning');
    });
    expect(warns).toEqual(['custom disabled-unless-set warning']);
  });
});
