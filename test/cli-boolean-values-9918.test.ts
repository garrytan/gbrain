/** #9918: an explicit non-boolean value must never enable a boolean operation. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpArgs } from '../src/cli/main.ts';
import { operations, operationsByName, OperationError } from '../src/core/operations.ts';
import { runCli } from './helpers/cli-spawn.ts';

const invalid = ['0', '1', 'no', 'off', 'yes', '', 'FALSE', ' false ', 'false=extra', '--force'];
function refusal(run: () => unknown): OperationError {
  try { run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected invalid_params, not an enabled flag');
}

describe('explicit boolean operation values', () => {
  test('every contract boolean refuses invalid inline values instead of coercing them to true', () => {
    for (const op of operations) for (const [key, def] of Object.entries(op.params)) {
      if (def.type !== 'boolean') continue;
      const flag = `--${key.replace(/_/g, '-')}`;
      for (const value of invalid) {
        const error = refusal(() => parseOpArgs(op, [`${flag}=${value}`]));
        expect(error.code).toBe('invalid_params');
        expect(error.message).toContain(flag);
        expect(error.suggestion).toContain('false');
      }
      for (const literal of ['true', 'false']) {
        expect(parseOpArgs(op, [`${flag}=${literal}`])[key]).toBe(literal === 'true');
        expect(parseOpArgs(op, [flag, literal])[key]).toBe(literal === 'true');
      }
    }
  });

  test('CLI-local booleans use the same strict values without swallowing positionals', () => {
    for (const flag of ['--json', '--dry-run']) {
      for (const value of invalid) expect(refusal(() => parseOpArgs(operationsByName.add_link, ['page-a', `${flag}=${value}`, 'page-b'])).code).toBe('invalid_params');
      for (const literal of ['true', 'false']) expect(parseOpArgs(operationsByName.add_link, ['page-a', `${flag}=${literal}`, 'page-b']))
        .toEqual({ from: 'page-a', to: 'page-b', [flag.slice(2).replaceAll('-', '_')]: literal === 'true' });
    }
    expect(parseOpArgs(operationsByName.get_page, ['--', '--include-deleted=0'])).toEqual({ slug: '--include-deleted=0' });
  });
});

describe('real CLI refuses ambiguous destructive intent', () => {
  let home: string;
  const cli = (args: string[]) => runCli(args, { home, cwd: home, timeoutMs: 90_000 });
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-boolean-values-'));
    const init = await cli(['init', '--pglite', '--no-embedding']);
    expect(init.exitCode, init.stderr).toBe(0);
    const put = await cli(['put', 'notes/boolean-probe', '--content', '# Boolean probe\n\nKeep this synthetic evidence.']);
    expect(put.exitCode, put.stderr).toBe(0);
  }, 120_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('purge=0 and malformed dry-run refuse before changing a live page', async () => {
    for (const flag of ['--purge=0', '--dry-run=no']) {
      const denied = await cli(['delete', 'notes/boolean-probe', '--force', flag, '--json']);
      expect(denied.exitCode, denied.stderr).toBe(2);
      expect(JSON.parse(denied.stdout)).toMatchObject({ code: 'invalid_params', contract_version: 1 });
      const read = await cli(['get', 'notes/boolean-probe', '--json']);
      expect(read.exitCode, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout).compiled_truth).toContain('Keep this synthetic evidence.');
    }
  }, 120_000);

  test('soft deletion still works; include-deleted=0 refuses rather than exposing deleted content', async () => {
    const slug = 'notes/deleted-boolean-probe';
    const put = await cli(['put', slug, '--content', '# Deleted probe\n\nKeep this synthetic evidence.']);
    expect(put.exitCode, put.stderr).toBe(0);
    const deleted = await cli(['delete', slug, '--force', '--purge=false', '--json']);
    expect(deleted.exitCode, deleted.stderr).toBe(0);
    const hidden = await cli(['get', slug, '--include-deleted=false', '--json']);
    expect(hidden.exitCode).not.toBe(0);
    for (const value of ['0', 'no', 'off']) {
      const denied = await cli(['get', slug, `--include-deleted=${value}`, '--json']);
      expect(denied.exitCode, denied.stderr).toBe(2);
      expect(JSON.parse(denied.stdout).code).toBe('invalid_params');
      expect(denied.stdout).not.toContain('Keep this synthetic evidence.');
    }
    const retained = await cli(['get', slug, '--include-deleted=true', '--json']);
    expect(retained.exitCode, retained.stderr).toBe(0);
    expect(JSON.parse(retained.stdout).compiled_truth).toContain('Keep this synthetic evidence.');
  }, 120_000);
});
