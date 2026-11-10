import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCliError } from '../src/cli/cli-error.ts';
import { agentContractLogPath } from '../src/core/agent-contract-log.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

test('source CLI audit correlates the known verb and bounded cause without recording input', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-sources-audit-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, () => {
      const argv = ['--brain', 'private-brain', 'sources', 'status', 'private-source', '--json'];
      const error = Object.assign(new TypeError('synthetic private diagnostic'), { code: 'EIO' });
      let envelope = '';
      expect(writeCliError(error, 'sources', { argv, stderr: false, emit: value => { envelope = value; } })).toBe(1);
      expect(JSON.parse(envelope)).toMatchObject({ code: 'internal_error' });

      writeCliError(Object.assign(new Error('another private diagnostic'), { code: 'PRIVATE_CODE' }), 'sources', {
        argv: ['sources', 'private-verb', '--json'], stderr: false, emit: () => {},
      });
      writeCliError(new Error('unrelated diagnostic'), 'get', {
        argv: ['get', 'sources', 'status', '--json'], stderr: false, emit: () => {},
      });

      const raw = readFileSync(agentContractLogPath(), 'utf8');
      const [known, unknown, unrelated] = raw.trim().split('\n').map(line => JSON.parse(line));
      expect(known).toMatchObject({ command: 'sources', code: 'internal_error', cli_failure: {
        pid: process.pid, subcommand: 'status', error_kind: 'type_error', cause_code: 'EIO',
      } });
      expect(unknown.cli_failure).toEqual({ pid: process.pid, subcommand: 'unknown', error_kind: 'error' });
      expect(unrelated.cli_failure).toBeUndefined();
      for (const value of ['private-brain', 'private-source', 'private-verb', 'private diagnostic', 'PRIVATE_CODE']) {
        expect(raw).not.toContain(value);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed leading brain flag does not persist its value as the command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-sources-fatal-audit-'));
  try {
    const value = 'PRIVATE_INVALID_BRAIN';
    const result = await runCli(['--brain', value, 'sources', 'status', '--json'], { home, cwd: home });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'internal_error' });
    const audit = readFileSync(join(home, '.gbrain', 'agent-contract', 'events.jsonl'), 'utf8');
    expect(JSON.parse(audit)).toMatchObject({ command: 'unknown', code: 'internal_error' });
    expect(audit).not.toContain(value);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
