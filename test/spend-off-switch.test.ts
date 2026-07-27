/**
 * v0.42.42.0 (#2139) — `--max-usd off` / `--max-cost off` uncapped-switch pins
 * across enrich / onboard / reindex (the T6 secondary cost gates).
 *
 * The enrich arg parser carries the real logic (off → Infinity sentinel, mapped
 * to "no BudgetTracker ceiling" in runEnrichCore), so it gets a direct unit test.
 * reindex + onboard detect `off` inline at the CLI dispatch and proceed past the
 * confirmation / missing-cap refusal; those are pinned as source-level regression
 * guards (the codex pre-landing review found all three half-built — these keep
 * them from silently regressing without standing up full CLI+gateway harnesses).
 */
import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../src/commands/enrich.ts';

describe('enrich parseArgs — --max-usd off → uncapped (Infinity sentinel)', () => {
  test('off / unlimited / none (case-insensitive) → Infinity', () => {
    for (const v of ['off', 'OFF', 'unlimited', 'none', 'None']) {
      expect(parseArgs(['--max-usd', v]).maxCostUsd).toBe(Infinity);
    }
    // --max-cost-usd alias too.
    expect(parseArgs(['--max-cost-usd', 'off']).maxCostUsd).toBe(Infinity);
  });
  test('finite positive number passes through; absent → undefined; garbage → undefined', () => {
    expect(parseArgs(['--max-usd', '5']).maxCostUsd).toBe(5);
    expect(parseArgs([]).maxCostUsd).toBeUndefined();
    expect(parseArgs(['--max-usd', 'abc']).maxCostUsd).toBeUndefined();
    expect(parseArgs(['--max-usd', '0']).maxCostUsd).toBeUndefined(); // non-positive ignored
  });
});

describe('reindex / onboard off-switch dispatch (regression guards)', () => {
  test('reindex-code: --max-cost off proceeds past the confirmation gate', async () => {
    const src = await Bun.file(new URL('../src/commands/reindex-code.ts', import.meta.url)).text();
    // off sets maxCostOff and the gate proceeds when (tokenmax || maxCostOff).
    expect(src).toMatch(/maxCostOff\s*=\s*true/);
    expect(src).toMatch(/posture === 'tokenmax' \|\| maxCostOff/);
  });

  test('onboard: --max-usd off lifts the --auto missing-cap refusal', async () => {
    const src = await Bun.file(new URL('../src/commands/onboard.ts', import.meta.url)).text();
    expect(src).toMatch(/maxUsdOff\s*=/);
    // refusal skipped when (maxUsdOff || tokenmax).
    expect(src).toMatch(/maxUsdOff \|\| tokenmax/);
  });

  test('enrich: uncapped path maps the Infinity sentinel to no BudgetTracker ceiling', async () => {
    const src = await Bun.file(new URL('../src/commands/enrich.ts', import.meta.url)).text();
    // The sentinel must become `undefined` at the tracker (never raw Infinity,
    // which serializes to null in audit rows).
    expect(src).toMatch(/opts\.maxCostUsd === Infinity \? undefined/);
    expect(src).toMatch(/uncapped \? Infinity : parsed\.maxCostUsd/);
  });
});
