/**
 * Doctor's model-picker warning (src/commands/doctor/checks/skill-resolver.ts routerProblem).
 *
 * 1. Protects: the daily_cap warning only while today's spend is near a cap
 *    above 0, a raise that config set accepts (at most 100), setup warnings
 *    only from the newest picker turn, and fixes a user can run on defaults.
 * 2. Fails when: doctor warns about yesterday's cap or a deliberate cap of 0,
 *    proposes a cap past the maximum, or keeps warning after a setup fix.
 * 3. Pure: builds the doctor view by hand; no files, no network.
 */
import { describe, expect, test } from 'bun:test';
import { skillResolverCheck, type SkillResolverRouterView } from '../src/commands/doctor/checks/skill-resolver.ts';

const check = (router: Partial<SkillResolverRouterView>) => skillResolverCheck({ config: 'ok', harnesses: [], recent: { turns: 0, outcomes: {}, errors: {} },
  router: { turns: 1, picker: 0, fallbacks: {}, last: null, last_day: '2026-11-22', spent_usd: 0, cap_usd: 0.5, day: '2026-11-23', ...router } })!;

describe('doctor and the model picker', () => {
  test('a daily_cap fallback warns only while today\'s spend is near a cap above 0', () => {
    expect(check({ fallbacks: { daily_cap: 1 }, last: 'daily_cap', spent_usd: 0 }).status).toBe('ok');
    expect(check({ fallbacks: { daily_cap: 30 }, last: 'daily_cap', turns: 30, cap_usd: 0 }).status).toBe('ok');
    const c = check({ fallbacks: { daily_cap: 1 }, last: 'daily_cap', spent_usd: 0.45 });
    expect(c.status).toBe('warn');
    expect((c.details as any).code).toBe('skill_router_daily_cap');
    expect(c.fix?.argv).toEqual(['gbrain', 'config', 'set', 'skills.resolver.router_max_usd_per_day', '1']);
  });

  test('a cap below one call\'s largest cost warns while today\'s newest turn was refused, even with nothing spent', () => {
    const c = check({ turns: 20, fallbacks: { daily_cap: 20 }, last: 'daily_cap', last_day: '2026-11-23', spent_usd: 0, cap_usd: 0.1 });
    expect(c.status).toBe('warn');
    expect((c.details as any).code).toBe('skill_router_daily_cap');
    expect(c.message).toContain('largest cost');
  });

  test('the cap raise never passes the 100 USD maximum, and at the maximum there is nothing to run', () => {
    expect(check({ fallbacks: { daily_cap: 1 }, spent_usd: 80, cap_usd: 80 }).fix?.argv?.at(-1)).toBe('100');
    const top = check({ fallbacks: { daily_cap: 1 }, spent_usd: 100, cap_usd: 100 });
    expect(top.status).toBe('warn');
    expect(top.fix?.argv).toBeUndefined();
    expect(top.fix?.actor).toBe('user');
  });

  test('a setup fallback warns only while the newest picker turn still has it', () => {
    expect(check({ fallbacks: { missing_key: 1 }, last: null, turns: 2, picker: 1 }).status).toBe('ok');
    const c = check({ fallbacks: { missing_key: 1 }, last: 'missing_key' });
    expect((c.details as any).code).toBe('skill_router_missing_key');
    expect(c.fix?.argv).toBeUndefined();
    expect(c.fix?.user_message).toContain('router_fallback-missing_key');
  });

  test('the fallback rate leaves daily_cap out and names a fix with no command', () => {
    expect(check({ turns: 20, picker: 0, fallbacks: { daily_cap: 20 }, cap_usd: 0 }).status).toBe('ok');
    const c = check({ turns: 20, picker: 10, fallbacks: { timeout: 10 }, last: 'timeout' });
    expect((c.details as any).code).toBe('skill_router_timeout');
    expect(c.fix?.argv).toBeUndefined();
  });
});
