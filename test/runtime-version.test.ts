/**
 * The Bun floor: every entrypoint refuses an older runtime with one actionable
 * message, doctor reports it, and every place that states the floor agrees.
 *
 * Protects: the refusal text users on an old Bun see (found + required
 * versions, `bun upgrade`, restart, `gbrain post-upgrade`), the CLI gate
 * (exit 1 everywhere, `--version` still answering, autopilot's log copy), the
 * `bun_runtime` doctor row, and the floor stated by package.json and the
 * cloud setup script.
 * Regression: a floor bump that misses one of those places, or a message
 * edit that drops the fix command. Existing guarded-http coverage only checks
 * that a refusal throws, not what it tells the user.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MINIMUM_BUN_VERSION, assertSupportedBun, exitOnUnsupportedBun, unsupportedBunMessage } from '../src/core/runtime-version.ts';
import { checkBunRuntime } from '../src/commands/doctor/checks/upgrade-health.ts';

const root = join(import.meta.dir, '..');
const OLD_BUN_REFUSAL = 'GBrain requires Bun 1.4.0 or newer (found Bun 1.3.14).\n'
  + 'Fix: run `bun upgrade`, then restart GBrain. If a `gbrain upgrade` stopped here, finish it with `gbrain post-upgrade`.';

describe('Bun runtime floor', () => {
  test('an older Bun is refused with the found version, the floor and the fix', () => {
    expect(MINIMUM_BUN_VERSION).toBe('1.4.0');
    expect(unsupportedBunMessage('1.3.14')).toBe(OLD_BUN_REFUSAL);
    let error: unknown;
    try { assertSupportedBun('1.3.14'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(OLD_BUN_REFUSAL);
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_RUNTIME');
  });

  test('every release below the floor, prereleases and a missing runtime are refused', () => {
    for (const version of ['1.3.11', '1.3.13', '1.3.14', '1.2.99', '1.4.0-canary.1', '']) {
      expect(unsupportedBunMessage(version)).toContain('Fix: run `bun upgrade`');
    }
    expect(unsupportedBunMessage('')).toStartWith('GBrain requires Bun 1.4.0 or newer (found no Bun runtime).');
  });

  test('the floor and newer releases start', () => {
    for (const version of ['1.4.0', '1.4.2', '1.5.0', '2.0.0', '1.4.2+abc123']) {
      expect(unsupportedBunMessage(version)).toBeNull();
      expect(() => assertSupportedBun(version)).not.toThrow();
    }
  });

  test('doctor reports the running Bun against the floor, with the fix on failure', () => {
    expect(checkBunRuntime('1.4.2')).toEqual({ name: 'bun_runtime', status: 'ok', message: 'Bun 1.4.2 (minimum 1.4.0)' });
    expect(checkBunRuntime('1.3.14')).toEqual({ name: 'bun_runtime', status: 'fail', message: OLD_BUN_REFUSAL.replace('\n', ' ') });
    expect(checkBunRuntime().status).toBe('ok');
  });
});

function runGate(command: string | undefined, version: string) {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw { exitCode: code }; }) as never);
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  let exitCode: number | undefined;
  try { exitOnUnsupportedBun(command, '9.9.9.9', version); } catch (caught) { exitCode = (caught as { exitCode: number }).exitCode; }
  const result = { exitCode, stderr: stderr.mock.calls.map(c => String(c[0])), stdout: stdout.mock.calls.map(c => String(c[0])) };
  exit.mockRestore(); stderr.mockRestore(); stdout.mockRestore();
  return result;
}

describe('CLI entrypoint gate', () => {
  test('every command on an older Bun exits 1 with the refusal on stderr', () => {
    for (const command of ['doctor', 'serve', 'jobs', 'hook', 'upgrade', 'post-upgrade', undefined]) {
      expect(runGate(command, '1.3.14')).toEqual({ exitCode: 1, stderr: [OLD_BUN_REFUSAL], stdout: [] });
    }
  });

  test('--version still answers on an older Bun so an older upgrade can verify the swap', () => {
    for (const command of ['--version', 'version']) {
      expect(runGate(command, '1.3.14')).toEqual({ exitCode: 0, stderr: [OLD_BUN_REFUSAL], stdout: ['gbrain 9.9.9.9'] });
    }
  });

  test('autopilot also writes the refusal to stdout, its service log', () => {
    const { exitCode, stderr, stdout } = runGate('autopilot', '1.3.14');
    expect(exitCode).toBe(1);
    expect(stderr).toEqual([OLD_BUN_REFUSAL]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[autopilot\] GBrain requires Bun 1\.4\.0 or newer \(found Bun 1\.3\.14\)\./);
  });

  test('a supported Bun passes through silently', () => {
    expect(runGate('doctor', '1.4.0')).toEqual({ exitCode: undefined, stderr: [], stdout: [] });
  });
});

describe('stated Bun floor', () => {
  test('package engines and the cloud setup script state the same floor', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(`>=${MINIMUM_BUN_VERSION}`);
    const cloud = readFileSync(join(root, 'templates/bootstrap/cloud-setup-script.sh'), 'utf8');
    expect(/Bun\.semver\.satisfies\(Bun\.version, ">=([\d.]+)"\)/.exec(cloud)?.[1]).toBe(MINIMUM_BUN_VERSION);
  });
});
