/**
 * Refactor wave 1 W0 (A16b membership, EO5 / T-G6 phase, EO13 / T-G7 baseline).
 *
 * Protects: which commands exist, which answer --help themselves, which
 * refuse or route on a thin client, which skip startup hooks, which run
 * before the connectEngine() terminator (engine-free) and which after, every
 * explicit subcommand routing rule, and that every handleCliOnly case loads
 * its module through a string-literal import().
 * Fails when: W4's command table derives a set that differs from master's,
 * drops a record's phase or thin-client mode, reorders a routing rule, or a
 * load uses a computed specifier (bun --compile would omit the module).
 * Why new: no test pins dispatch phase; the sets are hand-synced today (the
 * documented `pages` drift class). Seam: none. Master is read by AST
 * (test/helpers/cli-dispatch-extract.ts); W4 re-points the extraction at the
 * table and must reproduce these goldens byte for byte.
 *
 * Master's known membership inconsistencies are recorded (not fixed) in the
 * membership golden under `inconsistencies`; W4 must preserve each one.
 *
 * Normalizer `cli-ast-v1`: extraction already collapses whitespace in branch
 * conditions and sorts set members; nothing else is volatile. Proven stable
 * by extracting twice. Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { describe, expect, test } from 'bun:test';
import { CLI_ONLY, THIN_CLIENT_REFUSED_COMMANDS, cliAliases } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';
import { extractCliDispatch, thinClientRoutes, type CliDispatchShape } from './helpers/cli-dispatch-extract.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';

const astNormalizer = defineNormalizer('cli-ast-v1', (v: unknown) => v);

function membership(shape: CliDispatchShape) {
  const { sets, commands } = shape;
  const cliOnly = new Set(sets.CLI_ONLY);
  const selfHelp = new Set(sets.CLI_ONLY_SELF_HELP);
  const refused = new Set(sets.THIN_CLIENT_REFUSED_COMMANDS);
  const mainRefusals = shape.mainRules.filter((r) => r.refusesThinClient).flatMap((r) => r.commands);
  const refusesSomewhere = (c: string) =>
    refused.has(c) || (commands[c]?.thinClient ?? 'none') !== 'none' || mainRefusals.includes(c);
  const unreachable = (c: string) => {
    const rules = commands[c]?.preConnectRules ?? [];
    const decisive = rules.findIndex((r) => r.unconditionalFor.includes(c) && r.terminates);
    return decisive < 0 ? [] : rules.slice(decisive + 1).map((r) => r.condition);
  };
  return {
    sets,
    aliases: Object.fromEntries([...cliAliases].map(([alias, op]) => [alias, op.name]).sort()),
    mainCommandRewrites: shape.mainCommandRewrites,
    inconsistencies: {
      selfHelpNotInCliOnly: sets.CLI_ONLY_SELF_HELP.filter((c) => !cliOnly.has(c)),
      selfHelpWithoutEngineNotInSelfHelp: sets.SELF_HELP_WITHOUT_ENGINE.filter((c) => !selfHelp.has(c)),
      refusedNotInCliOnly: sets.THIN_CLIENT_REFUSED_COMMANDS.filter((c) => !cliOnly.has(c)),
      refusedWithoutHint: sets.THIN_CLIENT_REFUSED_COMMANDS.filter((c) => !sets.THIN_CLIENT_REFUSE_HINTS.includes(c)),
      refuseHintNeverReached: sets.THIN_CLIENT_REFUSE_HINTS.filter((c) => !refusesSomewhere(c)),
      startupHookSkipNotInCliOnly: sets.STARTUP_HOOK_SKIP_COMMANDS.filter((c) => !cliOnly.has(c)),
      cliOnlyWithoutHandler: sets.CLI_ONLY.filter((c) => commands[c]?.phase === 'unhandled'),
      handlerNotInCliOnly: Object.keys(commands).filter((c) => !cliOnly.has(c)),
      cliOnlyNameAlsoAnOp: Object.fromEntries(
        operations
          .map((o) => [o.cliHints?.name ?? o.name, o] as const)
          .filter(([name]) => cliOnly.has(name))
          .map(([name, o]) => [name, { op: o.name, cliHintsHidden: o.cliHints?.hidden === true }])
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      branchesAfterTerminatingBranch: Object.fromEntries(
        Object.keys(commands).map((c) => [c, unreachable(c)] as const).filter(([, d]) => d.length > 0),
      ),
      thinClientBranchShadowedByRefusal: Object.fromEntries(
        Object.entries(commands)
          .filter(([c, d]) => refused.has(c) && d.preConnectRules.some((r) => r.thinClientCheck))
          .map(([c, d]) => [c, d.preConnectRules.filter((r) => r.thinClientCheck).map((r) => r.condition)]),
      ),
    },
  };
}

function dispatchPhase(shape: CliDispatchShape) {
  return {
    mainRules: shape.mainRules,
    thinClientGuard: shape.thinClientGuard,
    thinClientRoutes: thinClientRoutes(),
    commandAgnosticConnectBranches: shape.commandAgnosticConnectBranches,
    commands: shape.commands,
  };
}

describe('CLI dispatch shape (master AST)', () => {
  test('extraction is stable and agrees with the runtime exports', async () => {
    const shape = await expectNormalizerStable(extractCliDispatch, astNormalizer);
    expect(shape.sets.CLI_ONLY).toEqual([...CLI_ONLY].sort());
    expect(shape.sets.THIN_CLIENT_REFUSED_COMMANDS).toEqual([...THIN_CLIENT_REFUSED_COMMANDS].sort());
    expect(shape.switchCases.length).toBe(66);
    expect(Object.keys(shape.commands).length).toBeGreaterThanOrEqual(shape.sets.CLI_ONLY.length);
  });

  test('membership sets, alias table and known inconsistencies match the golden', () => {
    expectGolden('cli/membership-sets', membership(extractCliDispatch()), astNormalizer);
  });

  test('per-command phase, thin-client mode and subcommand routing rules match the golden', () => {
    expectGolden('cli/dispatch-phase', dispatchPhase(extractCliDispatch()), astNormalizer);
  });

  test('every handleCliOnly case loads through a string-literal import() (EO13 baseline)', () => {
    const shape = extractCliDispatch();
    expect(shape.computedImports).toEqual([]);
    expectGolden('cli/literal-imports', { switchCaseImports: shape.switchCaseImports }, astNormalizer);
  });
});
