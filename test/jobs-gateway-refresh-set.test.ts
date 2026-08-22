/**
 * #3387 — GATEWAY_REFRESH_JOB_NAMES drift guard.
 *
 * `registerBuiltinJob` wraps a handler with `refreshGatewayForJob` ONLY when
 * its name is in GATEWAY_REFRESH_JOB_NAMES. Two silent drift modes exist:
 *
 *   1. A gateway-using handler registered via bare `worker.register(...)`
 *      never refreshes — a worker booted before `gbrain config set` ran with
 *      a stale gateway. chronicle_extract hit exactly this: the DB-plane chat
 *      model never reached the judge, so every extraction silently returned
 *      no_events (#3387).
 *   2. A `registerBuiltinJob(...)` call whose name is missing from the set
 *      LOOKS wrapped at the call site but silently registers bare.
 *
 * This test pins set ⇔ call-site equality by scanning the source text, so
 * both drift modes fail loudly in CI.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const JOBS_SRC = fs.readFileSync(
  path.join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'),
  'utf8',
);

/** Extract the string entries of the GATEWAY_REFRESH_JOB_NAMES set literal. */
function parseRefreshSet(src: string): string[] {
  const m = src.match(/const GATEWAY_REFRESH_JOB_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('GATEWAY_REFRESH_JOB_NAMES set literal not found in jobs.ts');
  // Strip // comments first — apostrophes inside comment prose would otherwise
  // corrupt the quote matcher.
  const body = m[1]!.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** Extract every job name passed to registerBuiltinJob(worker, engine, '<name>', ...). */
function parseBuiltinRegistrations(src: string): string[] {
  return [...src.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*'([^']+)'/g)].map((x) => x[1]!);
}

describe('#3387 — GATEWAY_REFRESH_JOB_NAMES ⇔ registerBuiltinJob call sites', () => {
  const setNames = parseRefreshSet(JOBS_SRC);
  const registered = parseBuiltinRegistrations(JOBS_SRC);

  test('chronicle_extract is in the refresh set (the #3387 regression)', () => {
    expect(setNames).toContain('chronicle_extract');
  });

  test('chronicle_extract is registered via registerBuiltinJob, not bare worker.register', () => {
    expect(registered).toContain('chronicle_extract');
    expect(JOBS_SRC).not.toMatch(/worker\.register\(\s*'chronicle_extract'/);
  });

  test('every set entry has a registerBuiltinJob call site (no dead entries)', () => {
    const missing = setNames.filter((n) => !registered.includes(n));
    expect(missing).toEqual([]);
  });

  test('every registerBuiltinJob name is in the set (no silently-unwrapped registrations)', () => {
    const unwrapped = registered.filter((n) => !setNames.includes(n));
    expect(unwrapped).toEqual([]);
  });

  test('set entries are unique', () => {
    expect(new Set(setNames).size).toBe(setNames.length);
  });
});
