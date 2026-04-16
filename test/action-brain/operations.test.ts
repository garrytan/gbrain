import { describe, expect, test } from 'bun:test';
import { mergeOperationSets, operations } from '../../src/core/operations.ts';
import type { Operation } from '../../src/core/operations.ts';

function makeOperation(name: string, cliName?: string): Operation {
  return {
    name,
    description: `Operation ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    cliHints: cliName ? { name: cliName } : undefined,
  };
}

describe('Action Brain operation integration', () => {
  test('#22 registers Action Brain operations in the shared contract', () => {
    const names = new Set(operations.map((op) => op.name));
    expect(names.has('action_list')).toBe(true);
    expect(names.has('action_brief')).toBe(true);
    expect(names.has('action_resolve')).toBe(true);
    expect(names.has('action_mark_fp')).toBe(true);
    expect(names.has('action_ingest')).toBe(true);
  });

  test('#23 mergeOperationSets fails fast on operation and CLI collisions', () => {
    expect(() =>
      mergeOperationSets([makeOperation('alpha', 'alpha-cmd')], [makeOperation('alpha', 'beta-cmd')])
    ).toThrow(/Duplicate operation name/);

    expect(() =>
      mergeOperationSets([makeOperation('alpha', 'shared-cmd')], [makeOperation('beta', 'shared-cmd')])
    ).toThrow(/Duplicate CLI command name/);
  });

  test('#24 supports grouped action CLI commands via "gbrain action <subcommand>"', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'action', 'list', '--help'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: gbrain action list');
  });
});
