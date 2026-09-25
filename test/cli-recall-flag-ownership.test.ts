import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';
import { validateCommandFlags } from '../src/cli.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { runCli } from './helpers/cli-spawn.ts';

const serveFlags = ['--port', '--bind', '--print-admin-token', '--public-url', '--enable-dcr',
  '--token-ttl', '--source-guard', '--stdio-idle-timeout', '--suppress-bootstrap-token', '--log-full-params'];

describe('recall and degraded serve flag ownership', () => {
  test('fresh and committed recall registries reject serve-only flags', () => {
    const fresh = buildFlagRegistry();
    for (const flag of serveFlags) {
      expect(fresh.recall).not.toContain(flag);
      expect(CLI_FLAG_REGISTRY.recall).not.toContain(flag);
      expect(validateCommandFlags('recall', [flag])).toBe(flag);
      expect(fresh.serve).toContain(flag);
      expect(validateCommandFlags('serve', [flag])).toBeNull();
    }
  });

  test('recall retains budget policy and source selectors', () => {
    for (const args of [
      ['query', '--budget-policy', 'query_first', '--source-id', 'team-b'],
      ['query', '--budget-policy=facts_first', '--source-id=default'],
      ['query', '--budget-policy', 'query_first', '--source', 'team-b', '--budget-tokens', '1024', '--json'],
    ]) expect(validateCommandFlags('recall', args)).toBeNull();
  });

  test('think retains valid flags without acquiring serve-only flags', () => {
    expect(validateCommandFlags('think', ['query', '--with-calibration', '--rounds', '2', '--json'])).toBeNull();
    for (const flag of serveFlags) expect(validateCommandFlags('think', [flag])).toBe(flag);
  });

  test.each(['--port', '--print-admin-token'])('real recall rejects %s before opening a brain', async flag => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-recall-flags-'));
    try {
      const result = await runCli(['recall', '--query', 'example', flag, '--json'], { home, cwd: home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`unknown flag ${flag} for 'gbrain recall'`);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', reason: 'invalid_flag' });
      expect(result.stderr).not.toContain('database_url is missing');
      expect(result.stdout + result.stderr).not.toContain('Setting up brain schema');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
