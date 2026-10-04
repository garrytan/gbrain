import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnectorSyncCmd } from '../src/commands/connectors/sync.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

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
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (...values: unknown[]) => errors.push(values.join(' '));
        try {
          await runConnectorSyncCmd({ getConfig: async () => 'configured-source' } as never, args);
        } finally {
          console.error = originalError;
        }

        expect(errors.join('\n')).toContain('Usage: gbrain connectors sync');
        expect(currentExitCode()).toBe(1);
      });
    });
  }
});
