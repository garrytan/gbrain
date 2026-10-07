/**
 * Help gate part 1 of 4 (#6114): `--help`, `-h` and a bare `help` on every
 * self-help command and every router subcommand print usage, exit 0 and
 * change nothing (brain rows, HOME/cwd files, no fetch, no spawn); strict
 * refusals change nothing and their fixes are read-only. The case list and
 * harness live in test/helpers/cli-help-gate.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { buildFixture, gateCasesForPart, runGate, type GateFixture } from './helpers/cli-help-gate.ts';

let fx: GateFixture;
beforeAll(async () => { fx = await buildFixture(); }, 120_000);
afterAll(() => { if (fx) rmSync(fx.template, { recursive: true, force: true }); });

test('help never acts (part 1 of 4)', async () => {
  expect(await runGate(fx, gateCasesForPart(0))).toEqual([]);
}, 280_000);
