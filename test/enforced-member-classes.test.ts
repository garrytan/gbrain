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
import { CLI_COMMAND_CLASSES, OPERATION_CLASSES, OPERATION_SUBCOMMANDS, enforcedClassOf } from '../src/cli/enforced-member-classes.ts';

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

  test('an unknown command or operation resolves to refused', () => {
    expect(enforcedClassOf('no-such-command-example', [], undefined)).toBe('refused');
    expect(enforcedClassOf('no-such-command-example', [], 'no_such_op_example')).toBe('refused');
    expect(enforcedClassOf('search', ['modes'], 'search')).toBe('refused');
    expect(enforcedClassOf('sync', ['status'], undefined)).toBe('refused');
    expect(enforcedClassOf('git', ['commit-push'], undefined)).toBe('write');
  });
});
