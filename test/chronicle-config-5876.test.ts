/**
 * #5876 (T10): auto_chronicle defaults on and the chronicle.* rails are validated.
 *
 * Protects: unset auto_chronicle reads as on; true/false words parse; any other word reads as off
 * and is reported as invalid; a malformed stored chronicle.* value falls back to its default;
 * `gbrain config set` refuses out-of-range chronicle.* values, unknown chronicle.* leaves and
 * non-boolean auto_chronicle values, and an explicit set records the operator's answer.
 * Fails when: the default reverts to off, a typo silently becomes a cap, or `config set
 * auto_chronicle` stops clearing the default-on notice.
 * Seams: none; in-memory PGLite, console/process.exit spies around runConfig.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConfig } from '../src/commands/config.ts';
import {
  CHRONICLE_ACK_KEY, autoChronicleNeedsAcknowledgement, isAutoChronicleEnabled, autoChronicleSetting, chronicleSettings,
  validateChronicleConfigValue,
} from '../src/core/chronicle/config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

let engine: PGLiteEngine;
const KEYS = ['auto_chronicle', CHRONICLE_ACK_KEY, 'chronicle.auto_daily_limit', 'chronicle.job_budget_usd',
  'chronicle.auto_recent_days', 'chronicle.auto_settle_seconds', 'chronicle.judge_max_tokens'];

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { for (const k of KEYS) await engine.unsetConfig(k); });

async function runConfigCapture(args: string[]) {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, args); }
  catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
  finally { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
  return { out: logs.join('\n'), err: errs.join('\n'), exit: exit as number | null };
}

describe('auto_chronicle parsing', () => {
  test('unset is on by default; true/false words parse; anything else reads as off and invalid', async () => {
    expect(await isAutoChronicleEnabled(engine)).toBe(true);
    expect(autoChronicleSetting(null)).toBe('on');
    for (const v of ['true', 'YES', ' on ', '1']) expect(autoChronicleSetting(v)).toBe('on');
    for (const v of ['false', 'No', 'off', '0']) expect(autoChronicleSetting(v)).toBe('off');
    expect(autoChronicleSetting('flase')).toBe('invalid');
    await engine.setConfig('auto_chronicle', 'flase');
    expect(await isAutoChronicleEnabled(engine)).toBe(false);
    await engine.setConfig('auto_chronicle', 'false');
    expect(await isAutoChronicleEnabled(engine)).toBe(false);
  });

  test('chronicle.* rails: defaults, explicit budget flag, malformed rows fall back', async () => {
    expect(await chronicleSettings(engine)).toMatchObject({ jobBudgetUsd: 0.25, explicitBudget: false, dailyLimit: 200,
      recentDays: 30, settleSeconds: 180, judgeMaxTokens: 4000, maxEventsPerPage: 25, invalid: [] });
    await engine.setConfig('chronicle.job_budget_usd', '0.4');
    await engine.setConfig('chronicle.auto_daily_limit', 'lots');
    const s = await chronicleSettings(engine);
    expect(s).toMatchObject({ jobBudgetUsd: 0.4, explicitBudget: true, dailyLimit: 200 });
    expect(s.invalid).toEqual([{ key: 'chronicle.auto_daily_limit', raw: 'lots', fallback: 200 }]);
  });

  test('the new keys are registered', () => {
    for (const k of ['auto_chronicle', 'chronicle.job_budget_usd', 'chronicle.auto_daily_limit', 'chronicle.auto_recent_days', 'chronicle.auto_settle_seconds']) {
      expect(KNOWN_CONFIG_KEYS).toContain(k);
    }
    expect(validateChronicleConfigValue('chronicle.auto_settle_seconds', '0')).toBeNull();
    expect(validateChronicleConfigValue('chronicle.job_budget_usd', '0')).toContain('from 0.01 to 10');
  });
});

describe('gbrain config set', () => {
  test('refuses chronicle.auto_daily_limit 0 with the valid range and writes nothing', async () => {
    const r = await runConfigCapture(['set', 'chronicle.auto_daily_limit', '0']);
    expect(r.exit).toBe(1);
    expect(r.err).toContain('chronicle.auto_daily_limit must be a whole number from 1 to 10000');
    expect(r.err).toContain('auto_chronicle false');
    expect(await engine.getConfig('chronicle.auto_daily_limit')).toBeNull();
  });

  test('refuses an unknown chronicle.* leaf with a suggestion', async () => {
    const r = await runConfigCapture(['set', 'chronicle.auto_daily_limt', '50']);
    expect(r.exit).toBe(1);
    expect(r.err).toContain('Did you mean "chronicle.auto_daily_limit"?');
    expect(await engine.getConfig('chronicle.auto_daily_limt')).toBeNull();
  });

  test('refuses auto_chronicle flase and names the opt-out', async () => {
    const r = await runConfigCapture(['set', 'auto_chronicle', 'flase']);
    expect(r.exit).toBe(1);
    expect(r.err).toContain('gbrain config set auto_chronicle false');
    expect(await engine.getConfig('auto_chronicle')).toBeNull();
  });

  test('an explicit set acknowledges the default-on change; true names the cost and the opt-out', async () => {
    await engine.setConfig('auto_chronicle', 'true'); // written before this release: still unanswered
    expect(await autoChronicleNeedsAcknowledgement(engine)).toBe(true);
    const r = await runConfigCapture(['set', 'auto_chronicle', 'true']);
    expect(r.exit).toBeNull();
    expect(r.out).toContain('gbrain config set auto_chronicle false');
    expect(await engine.getConfig(CHRONICLE_ACK_KEY)).not.toBeNull();
    expect(await autoChronicleNeedsAcknowledgement(engine)).toBe(false);
  });

  test('unset explains the default is on and names the set-false opt-out', async () => {
    await engine.setConfig('auto_chronicle', 'false');
    const r = await runConfigCapture(['unset', 'auto_chronicle']);
    expect(r.out).toContain('default, which is ON');
    expect(r.out).toContain('gbrain config set auto_chronicle false');
  });
});
