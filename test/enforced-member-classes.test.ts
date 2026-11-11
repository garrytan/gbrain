/**
 * GST-2476 G2: the enforced member allow-list (src/cli/enforced-member-classes.ts) classifies every CLI command and every
 * operation exactly once.
 *
 * 1. Protects: a new CLI command or operation cannot ship unclassified under GBRAIN_ENFORCED_MEMBER, and the table
 *    names nothing that no longer exists.
 * 2. Fails when: a command in CLI_COMMANDS or an operation in OPERATION_MANIFEST has no class, a classified name is
 *    stale or listed twice, or an unknown command stops resolving to refused.
 * 3. Existing coverage: test/enforced-member.serial.test.ts (behaviour of each class as real subprocesses).
 * 4. Real seams: the command table and operation manifest the CLI dispatches from.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { OPERATION_MANIFEST } from '../src/cli/op-manifest.ts';
import { ROUTERS } from '../src/cli/subcommands.ts';
import { CLI_COMMAND_CLASSES, OPERATION_CLASSES, OPERATION_SUBCOMMANDS, enforcedClassOf } from '../src/cli/enforced-member-classes.ts';

// test-reads-source-ok[structural]: a name listed twice in the READ/WRITE/REFUSED_OPS arrays collapses in the runtime maps, so only the source text shows the duplicate.
const CLASSES_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'enforced-member-classes.ts'), 'utf8');

describe('enforced member allow-list', () => {
  test('every CLI-only command has exactly one class, and no class names a missing command', () => {
    const commands = CLI_COMMANDS.map(c => c.name).sort();
    expect(Object.keys(CLI_COMMAND_CLASSES).sort()).toEqual(commands);
  });

  test('every operation has exactly one class, and no class names a missing operation', () => {
    const ops = OPERATION_MANIFEST.map(o => o.name).sort();
    expect(Object.keys(OPERATION_CLASSES).sort()).toEqual(ops);
    const listed = [...CLASSES_SRC.matchAll(/^const (READ|WRITE|REFUSED)_OPS = \[([\s\S]*?)\] as const;/gm)]
      .flatMap(m => [...m[2]!.matchAll(/'([a-z_]+)'/g)].map(x => x[1]!));
    expect(listed.length).toBe(new Set(listed).size);
  });

  test('subcommand overrides sit on commands the operation path dispatches', () => {
    const cliOnly = new Set(CLI_COMMANDS.map(c => c.name));
    const opNames = new Set(OPERATION_MANIFEST.flatMap(o => [o.cliHints?.name ?? o.name, ...(o.cliHints?.aliases ?? [])]));
    for (const name of Object.keys(OPERATION_SUBCOMMANDS)) expect({ name, op: opNames.has(name), cliOnly: cliOnly.has(name) }).toEqual({ name, op: true, cliOnly: false });
  });

  test('every router subcommand in the live registry has a class, and a refused command refuses every subcommand', () => {
    const opByCli = new Map(OPERATION_MANIFEST.flatMap(o => [o.cliHints?.name ?? o.name, ...(o.cliHints?.aliases ?? [])].map(n => [n, o.name] as const)));
    const classes = new Set(['read', 'write', 'allowed', 'silent', 'refused']);
    for (const [command, router] of Object.entries(ROUTERS)) {
      const known = CLI_COMMAND_CLASSES[command] !== undefined || opByCli.has(command);
      expect({ command, known }).toEqual({ command, known: true });
      const whole = enforcedClassOf(command, [], opByCli.get(command));
      for (const sub of router.subcommands) {
        const cls = enforcedClassOf(command, [sub], opByCli.get(command));
        expect({ command, sub, classified: classes.has(cls), refusedWithParent: whole !== 'refused' || cls === 'refused' }).toEqual({ command, sub, classified: true, refusedWithParent: true });
      }
    }
  });

  test('the commands and flags added since the mode landed are refused', () => {
    for (const [command, args] of [
      ['access', ['rule', 'add', '--slug', 'notes/x-example', '--readers', 'alice-example']], ['access', ['owner', 'reads-restricted', 'on']],
      ['access', ['owner', 'reads-restricted', 'off']], ['repair', ['visibility', '--slug', 'notes/x-example']], ['trust', ['backfill', '--label-lowerings']],
    ] as const) expect({ command, args: args.join(' '), cls: enforcedClassOf(command, args, undefined) }).toEqual({ command, args: args.join(' '), cls: 'refused' });
  });

  test('an unknown command or operation resolves to refused', () => {
    expect(enforcedClassOf('no-such-command-example', [], undefined)).toBe('refused');
    expect(enforcedClassOf('no-such-command-example', [], 'no_such_op_example')).toBe('refused');
    expect(enforcedClassOf('search', ['modes'], 'search')).toBe('refused');
    expect(enforcedClassOf('sync', ['status'], undefined)).toBe('refused');
    expect(enforcedClassOf('git', ['commit-push'], undefined)).toBe('write');
  });
});
