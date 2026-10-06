/**
 * D19: one shared cost-cap flag parser. `--max-usd N|off` is canonical; the
 * legacy spellings (`--max-cost`, `--max-cost-usd`, `--no-max-cost`) parse
 * through the same module, so the off words, the 0 rule, conflicts and the
 * error text are the same in every command. Each command is driven through
 * its real parser: numeric, each off spelling, missing, invalid, conflicting.
 * (skillopt's parser is covered in test/skillopt/preflight-pricing-5563.test.ts.)
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CAP_OFF_WORDS, CapFlagError, capNotice, mergeCapFlag, parseCapFlag } from '../../src/core/budget/cap-flag.ts';
import { parseBrainstormArgs } from '../../src/commands/brainstorm.ts';
import { parseArgs as parseEnrichArgs } from '../../src/commands/enrich.ts';
import { parseMaxUsd } from '../../src/eval/longmemeval/judge-lane.ts';
import { runOnboard } from '../../src/commands/onboard.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

describe('parseCapFlag / mergeCapFlag', () => {
  test('a positive amount is a cap; every off word is off, case-insensitive', () => {
    expect(parseCapFlag('--max-usd', '2.5')).toEqual({ flag: '--max-usd', usd: 2.5 });
    for (const w of [...CAP_OFF_WORDS, 'OFF', ' Unlimited ']) expect(parseCapFlag('--max-usd', w).usd).toBeNull();
  });

  test('0 is refused by default, means off or a $0 cap only where the command says so', () => {
    expect(() => parseCapFlag('--max-usd', '0')).toThrow(CapFlagError);
    expect(parseCapFlag('--max-cost-usd', '0', { zero: 'off' }).usd).toBeNull();
    expect(parseCapFlag('--max-usd', '0', { zero: 'cap' }).usd).toBe(0);
  });

  test('missing, flag-shaped, negative and non-numeric values are refused naming the flag', () => {
    expect(() => parseCapFlag('--max-usd', undefined)).toThrow('--max-usd needs a positive USD amount or "off" (got nothing).');
    expect(() => parseCapFlag('--max-usd', '--json')).toThrow('--max-usd needs');
    expect(() => parseCapFlag('--max-usd', '-1')).toThrow('--max-usd must be a positive USD amount or "off" (got "-1").');
    expect(() => parseCapFlag('--max-usd', '5usd')).toThrow('(got "5usd")');
  });

  test('a repeated identical cap merges; disagreeing caps are refused', () => {
    const a = parseCapFlag('--max-usd', '3');
    expect(mergeCapFlag(a, parseCapFlag('--max-cost', '3'))).toEqual(a);
    expect(() => mergeCapFlag(a, parseCapFlag('--max-cost', 'off'))).toThrow('--max-usd 3 conflicts with --max-cost off; pass one cost cap.');
  });

  test('capNotice names the cap, its source and how to remove it', () => {
    expect(capNotice({ usd: 5, source: 'default' })).toBe('cap: $5.00 (default; change it with --max-usd <usd>, remove it with --max-usd off)');
    expect(capNotice({ usd: 2, source: 'user', flag: '--max-cost' })).toBe('cap: $2.00 (--max-cost; remove it with --max-usd off)');
    expect(capNotice({ usd: null, source: 'user' })).toBe('cap: off (--max-usd off; spend is still ledgered, runtime bounds still apply)');
  });
});

describe('brainstorm / lsd (parseBrainstormArgs)', () => {
  test('--max-usd and legacy --max-cost parse numbers and off', () => {
    expect(parseBrainstormArgs(['q', '--max-usd', '2']).maxCost).toBe(2);
    expect(parseBrainstormArgs(['q', '--max-cost', '2.5']).maxCost).toBe(2.5);
    for (const w of CAP_OFF_WORDS) expect(parseBrainstormArgs(['q', '--max-usd', w]).maxCost).toBeNull();
    expect(parseBrainstormArgs(['q']).maxCost).toBeUndefined();
  });
  test('missing, invalid, 0 and conflicting values set an error', () => {
    expect(parseBrainstormArgs(['q', '--max-usd']).error).toMatch(/--max-usd needs/);
    expect(parseBrainstormArgs(['q', '--max-usd', 'abc']).error).toMatch(/--max-usd must be a positive USD amount/);
    expect(parseBrainstormArgs(['q', '--max-cost', '0']).error).toMatch(/--max-cost 0 is ambiguous/);
    expect(parseBrainstormArgs(['q', '--max-usd', '1', '--max-cost', '2']).error).toMatch(/conflicts/);
  });
});

describe('enrich (parseArgs)', () => {
  test('--max-usd and --max-cost-usd parse numbers; off is the Infinity sentinel', () => {
    expect(parseEnrichArgs(['--max-usd', '3']).maxCostUsd).toBe(3);
    expect(parseEnrichArgs(['--max-cost-usd', '1.5']).maxCostUsd).toBe(1.5);
    for (const w of CAP_OFF_WORDS) expect(parseEnrichArgs(['--max-usd', w]).maxCostUsd).toBe(Infinity);
  });
  test('a malformed, 0 or conflicting cap is refused instead of silently ignored', () => {
    expect(parseEnrichArgs(['--max-usd', 'lots']).error).toMatch(/--max-usd must be a positive USD amount/);
    expect(parseEnrichArgs(['--max-usd']).error).toMatch(/--max-usd needs/);
    expect(parseEnrichArgs(['--max-usd', '0']).error).toMatch(/ambiguous/);
    expect(parseEnrichArgs(['--max-usd', '2', '--max-cost-usd', 'off']).error).toMatch(/conflicts/);
  });
});

describe('eval longmemeval (parseMaxUsd)', () => {
  test('numbers, off words, and 0 as a $0 judge cap', () => {
    expect(parseMaxUsd('--max-usd', '5')).toBe(5);
    expect(parseMaxUsd('--max-usd', '0')).toBe(0);
    for (const w of CAP_OFF_WORDS) expect(parseMaxUsd('--max-usd', w)).toBeNull();
    expect(() => parseMaxUsd('--max-usd', 'abc')).toThrow(/non-negative/);
    expect(() => parseMaxUsd('--max-usd', '')).toThrow(/--max-usd needs/);
  });
});

describe('onboard (runOnboard)', () => {
  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  afterEach(() => {
    process.exit = origExit;
    process.stderr.write = origErr;
  });
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

  async function exitOf(args: string[]): Promise<{ code: number | null; stderr: string }> {
    let stderr = '';
    process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true; }) as typeof process.stderr.write;
    process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit;
    const engine = new Proxy({}, { get: () => { throw new Error('engine touched before the cap flag was validated'); } }) as BrainEngine;
    try {
      await runOnboard(engine, args);
      return { code: null, stderr };
    } catch (e) {
      if (e instanceof Exit) return { code: e.code, stderr };
      throw e;
    }
  }

  test('a malformed, 0 or conflicting --max-usd exits 2 before touching the brain', async () => {
    for (const [args, msg] of [
      [['--auto', '--max-usd', 'lots'], /--max-usd must be a positive USD amount/],
      [['--auto', '--max-usd'], /--max-usd needs/],
      [['--auto', '--max-usd', '0'], /ambiguous/],
      [['--auto', '--max-usd', '2', '--max-usd', 'off'], /conflicts/],
    ] as const) {
      const r = await exitOf([...args]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(msg);
    }
  });
});
