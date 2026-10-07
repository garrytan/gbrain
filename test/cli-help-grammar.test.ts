/**
 * The help grammar, router inventories and strict-argument table (#6114),
 * checked in-process. The subprocess gate (cli-help-no-side-effects*.serial)
 * proves the behaviour end to end; this file pins the rules cheaply.
 */
import { describe, expect, test } from 'bun:test';
import { ROUTERS, cliHelpRequested, helpFlagRequested, subcommandHelpRequested } from '../src/cli/subcommands.ts';
import { ROUTER_MODULES } from '../src/cli/router-help.ts';
import { STRICT_SUBCOMMANDS, strictArgsProblem, strictArgsRefusal } from '../src/cli/strict-args.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';

describe('help grammar', () => {
  test.each([
    [['pages', '--help'], true],
    [['pages', 'purge-deleted', '-h'], true],
    [['pages', 'purge-deleted', '--older-than', '--help'], true],
    [['pages', 'help'], true],
    [['pages', 'purge-deleted', 'help'], true],
    [['pages', 'purge-deleted', '--older-than', 'help'], false],
    [['pages', 'purge-deleted', '--', '--help'], false],
    [['search', 'help'], false],
    [['search', 'modes', 'help'], true],
    [['search', '--help'], true],
    [['think', 'help'], false],
    [['think', '-h'], true],
    [['agent', 'run', '--', '--help'], false],
    [['schema', 'use', 'help'], true],
    [['schema', 'explain', 'people', 'help'], false],
  ])('%p asks for help: %p', (argv, want) => {
    const [command, ...args] = argv as string[];
    expect(cliHelpRequested(command!, args)).toBe(want);
  });

  test('flags stop at the -- terminator', () => {
    expect(helpFlagRequested(['a', '-h'])).toBe(true);
    expect(helpFlagRequested(['--', '-h'])).toBe(false);
    expect(subcommandHelpRequested(['help'])).toBe(false);
  });
});

describe('router inventories', () => {
  test('every router is a self-help command with a module exporting the same SUBCOMMANDS and a printUsage', async () => {
    expect(Object.keys(ROUTER_MODULES).sort()).toEqual(Object.keys(ROUTERS).sort());
    for (const [command, router] of Object.entries(ROUTERS)) {
      const mod = await ROUTER_MODULES[command]!();
      expect([...mod.SUBCOMMANDS], command).toEqual([...router.subcommands]);
      expect(typeof mod.printUsage, command).toBe('function');
      if (command !== 'search') expect(CLI_COMMANDS.find(c => c.name === command)?.selfHelp, command).toBe(true);
    }
  });

  test('every strict subcommand belongs to a router inventory', () => {
    for (const key of Object.keys(STRICT_SUBCOMMANDS)) {
      const [command, sub] = key.split(' ');
      expect(ROUTERS[command!]?.subcommands, key).toContain(sub);
    }
  });
});

describe('strict arguments', () => {
  test('each refusal fix is a read-only command that parses under the same table, or an ask_user fix', () => {
    for (const [key, spec] of Object.entries(STRICT_SUBCOMMANDS)) {
      const [command, sub] = key.split(' ');
      const refusal = strictArgsRefusal(command!, [sub!, '--not-a-flag']);
      if (spec.when && !spec.when(['--not-a-flag'])) continue;
      expect(refusal?.code, key).toBe('invalid_params');
      expect(refusal?.why, key).toContain('Nothing was changed');
      const fix = refusal!.fix!;
      if ('ask_user' in spec.fix) {
        expect(fix.consent, key).toEqual(['destructive']);
        expect(fix.user_message, key).toBeTruthy();
        continue;
      }
      expect(fix.consent, key).toEqual([]);
      const [, fixCommand, fixSub, ...fixRest] = fix.argv!;
      expect(strictArgsRefusal(fixCommand!, [fixSub!, ...fixRest]), `${key} fix ${fix.argv!.join(' ')}`).toBeNull();
    }
  });

  test('search modes is strict only with --reset; its --source preview stays accepted', () => {
    expect(strictArgsRefusal('search', ['modes', '--whatever'])).toBeNull();
    expect(strictArgsRefusal('search', ['modes', '--reset', '--source', 'balanced'])).toBeNull();
    expect(strictArgsRefusal('search', ['modes', '--reset', 'extra'])?.message).toContain('`extra`');
  });

  test('value flags: both forms, missing value, repeated, wrong shape', () => {
    const spec = STRICT_SUBCOMMANDS['pages purge-deleted']!;
    expect(strictArgsProblem(spec, ['--older-than', '3d'])).toBeNull();
    expect(strictArgsProblem(spec, ['--older-than=72h'])).toBeNull();
    expect(strictArgsProblem(spec, ['--older-than'])?.problem).toContain('needs a value');
    expect(strictArgsProblem(spec, ['--older-than', '--json'])?.problem).toContain('needs a value');
    expect(strictArgsProblem(spec, ['--older-than', '1', '--older-than=2'])?.problem).toContain('more than once');
    expect(strictArgsProblem(spec, ['--older-than', 'soon'])).toMatchObject({ token: 'soon' });
    expect(strictArgsProblem(spec, ['--json=1'])?.problem).toContain('takes no value');
  });

  test('a missing positional is left to the handler usage; an extra one is refused', () => {
    expect(strictArgsRefusal('schema', ['use'])).toBeNull();
    expect(strictArgsRefusal('schema', ['use', 'a', 'b'])?.message).toContain('`b`');
    expect(strictArgsRefusal('schema', ['remove-type', '--pack', 'mine', 'people'])).toBeNull();
  });

  test('a --flag=value form the handler would not read is refused, not ignored (security review)', () => {
    // These handlers read only `--flag value`: `cache clear --source=x --yes` cleared every source.
    expect(strictArgsRefusal('cache', ['clear', '--source=other', '--yes'])?.message).toContain('`--source=other`');
    expect(strictArgsRefusal('search', ['modes', '--reset', '--source=conservative'])?.message).toContain('`--source=conservative`');
    expect(strictArgsRefusal('schema', ['downgrade', '--to=my-pack'])?.message).toContain('`--to=my-pack`');
    expect(strictArgsRefusal('cache', ['clear', '--source', 'other', '--yes'])).toBeNull();
    expect(strictArgsRefusal('schema', ['downgrade', '--to', 'my-pack'])).toBeNull();
    expect(strictArgsRefusal('schema', ['remove-type', '--pack=mine', 'people'])).toBeNull();
  });
});
