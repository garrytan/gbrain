import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnectorSyncCmd } from '../src/commands/connectors/sync.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { renderCliError } from '../src/core/agent-output.ts';

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('connectors sync --source CLI validation', () => {
  for (const args of [
    ['claude', '--source'],
    ['claude', '--source', '--dry-run'],
  ]) {
    test(`rejects a missing source value: ${args.join(' ')}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-connectors-sync-cli-'));
      tempHomes.push(home);
      await withEnv({
        GBRAIN_HOME: home,
        GBRAIN_CONNECTOR_CLAUDE_COOKIE: undefined,
        GBRAIN_CONNECTOR_CLAUDE_TOKEN: undefined,
      }, async () => {
        const error = await runConnectorSyncCmd({ getConfig: async () => 'configured-source' } as never, args).then(() => null, (e: unknown) => e);
        // Agent contract v1: invalid_params (exit 2 through renderCliError) with a fix that names the missing input.
        expect(error).toBeInstanceOf(OperationError);
        const e = error as OperationError;
        expect(e.code).toBe('invalid_params');
        expect(e.message).toContain('--source requires a value');
        expect(e.suggestion).toContain('Usage: gbrain connectors sync');
        expect(e.why).toBeTruthy();
        expect(e.fix?.argv).toEqual(['gbrain', 'connectors', 'sync', 'claude', '--source', '<SOURCE_ID>', ...args.slice(2)]);
        expect(e.fix?.inputs?.[0]?.name).toBe('SOURCE_ID');
        const rendered = renderCliError(e, { json: true, command: 'connectors', tty: false });
        expect(rendered.exitCode).toBe(2);
        expect(JSON.parse(rendered.stdout!)).toMatchObject({ code: 'invalid_params', fix: { next: 'run' } });
        expect(currentExitCode()).toBe(0);
      });
    });
  }
});

describe('connectors sync provider usage errors', () => {
  for (const [args, message] of [
    [[], 'Name a connector provider'],
    [['bogus', '--full'], "Unknown connector provider 'bogus'"],
  ] as const) {
    test(`exit 2 invalid_params: ${args.join(' ') || '(no provider)'}`, async () => {
      const error = await runConnectorSyncCmd({ getConfig: async () => null } as never, [...args]).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(OperationError);
      const e = error as OperationError;
      expect(e.code).toBe('invalid_params');
      expect(e.message).toContain(message);
      expect(e.fix?.argv).toEqual(['gbrain', 'connectors', 'sync', '<PROVIDER>', ...args.filter(a => a !== 'bogus')]);
      expect(renderCliError(e, { json: false, command: 'connectors', tty: false }).exitCode).toBe(2);
      expect(currentExitCode()).toBe(0);
    });
  }

  test('--help prints the usage and succeeds', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => lines.push(values.join(' '));
    try { await runConnectorSyncCmd({ getConfig: async () => null } as never, ['--help']); } finally { console.log = log; }
    expect(lines.join('\n')).toContain('Usage: gbrain connectors sync');
    expect(currentExitCode()).toBe(0);
  });
});
