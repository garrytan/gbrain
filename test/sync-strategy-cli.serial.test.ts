/** CLI validation contract for invocation-scoped sync strategy overrides. */
import { describe, expect, spyOn, test } from 'bun:test';
import { runSync } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const engine = {} as BrainEngine;

async function capture(args: string[]): Promise<{
  errors: string[];
  logs: string[];
  exit: number | null;
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  let exit: number | null = null;
  const errorSpy = spyOn(console, 'error').mockImplementation(
    (...values: unknown[]) => {
      errors.push(values.join(' '));
    },
  );
  const logSpy = spyOn(console, 'log').mockImplementation(
    (...values: unknown[]) => {
      logs.push(values.join(' '));
    },
  );
  const exitSpy = spyOn(process, 'exit').mockImplementation(((
    code?: number,
  ) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never);
  try {
    await runSync(engine, args);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('EXIT:'))
      throw error;
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { errors, logs, exit };
}

describe('gbrain sync --strategy validation', () => {
  test('rejects unknown and missing enum values before engine access', async () => {
    const unknown = await capture(['--strategy', 'everything']);
    expect(unknown.exit).toBe(2);
    expect(unknown.errors.join('\n')).toContain('markdown | code | auto');

    const missing = await capture(['--strategy']);
    expect(missing.exit).toBe(2);
    expect(missing.errors.join('\n')).toContain('Invalid --strategy value');
  });

  test('rejects --all override and points to the persistent per-source setter', async () => {
    const result = await capture(['--all', '--strategy', 'code']);
    expect(result.exit).toBe(2);
    const errors = result.errors.join('\n');
    expect(errors).toContain('cannot be combined with --all');
    expect(errors).toContain('gbrain sources set-sync-strategy');
    expect(errors).toContain('gbrain sources list --json');
  });

  test('--help documents stored policy behavior and observability', async () => {
    const result = await capture(['--help']);
    expect(result.exit).toBeNull();
    const help = result.logs.join('\n');
    expect(help).toContain('--strategy');
    expect(help).toContain('Invocation-only');
    expect(help).toContain('sources set-sync-strategy');
  });
});
