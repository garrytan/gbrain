/**
 * #9918: an inline boolean value other than true or false is refused, never
 * read as true. Before the fix the `--flag=<value>` branch of parseOpArgs read
 * a boolean as `raw !== 'false'`, so `delete <slug> --purge=0` ran the
 * irreversible hard delete and `get <slug> --include-deleted=0` printed a
 * soft-deleted page. The space-separated form already took only true/false.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpArgs } from '../src/cli/main.ts';
import { OperationError, operations, operationsByName } from '../src/core/operations.ts';
import { runCli } from './helpers/cli-spawn.ts';

const notBoolean = ['0', '1', 'no', 'off', 'yes', 'on', '', 'FALSE', 'True', ' false'];

function refusal(run: () => unknown): OperationError {
  try { run(); } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected an invalid_params refusal; the value was accepted');
}

describe('#9918 inline boolean values on op commands', () => {
  test('every op boolean refuses a non-boolean inline value, naming the flag and the accepted values', () => {
    let checked = 0;
    for (const op of operations) {
      for (const [key, def] of Object.entries(op.params)) {
        if (def.type !== 'boolean') continue;
        const flag = `--${key.replace(/_/g, '-')}`;
        for (const value of notBoolean) {
          const e = refusal(() => parseOpArgs(op, [`${flag}=${value}`]));
          expect(e.code).toBe('invalid_params');
          expect(e.message).toContain(flag);
          expect(e.message).toContain('true or false');
        }
        expect(parseOpArgs(op, [`${flag}=true`])[key]).toBe(true);
        expect(parseOpArgs(op, [`${flag}=false`])[key]).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('delete --purge=0 and get --include-deleted=0 refuse instead of turning the flag on', () => {
    expect(refusal(() => parseOpArgs(operationsByName.delete_page, ['people/x-example', '--purge=0'])).message).toContain('--purge');
    expect(refusal(() => parseOpArgs(operationsByName.get_page, ['people/x-example', '--include-deleted=0'])).message).toContain('--include-deleted');
    expect(parseOpArgs(operationsByName.delete_page, ['people/x-example', '--purge=false'])).toEqual({ slug: 'people/x-example', purge: false });
  });

  test('CLI-local --json=<v> and --dry-run=<v> take only true or false and keep positionals', () => {
    const op = operationsByName.add_link;
    for (const flag of ['--json', '--dry-run']) {
      const key = flag.slice(2).replace(/-/g, '_');
      for (const value of notBoolean) {
        const e = refusal(() => parseOpArgs(op, ['page-a', `${flag}=${value}`, 'page-b']));
        expect(e.code).toBe('invalid_params');
        expect(e.message).toContain(flag);
      }
      for (const literal of ['true', 'false']) {
        expect(parseOpArgs(op, ['page-a', `${flag}=${literal}`, 'page-b'])).toEqual({ from: 'page-a', to: 'page-b', [key]: literal === 'true' });
      }
    }
  });

  test('after a bare --, an =-token stays a positional', () => {
    expect(parseOpArgs(operationsByName.get_page, ['--', '--include-deleted=0'])).toEqual({ slug: '--include-deleted=0' });
  });
});

describe('#9918 real CLI on PGLite: --purge=0 never hard-deletes', () => {
  let home: string;
  const cli = (args: string[]) => runCli(args, { home, cwd: home, timeoutMs: 120_000 });
  const body = 'Synthetic page for the inline boolean probe.';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-inline-bool-'));
    const init = await cli(['init', '--pglite', '--no-embedding']);
    expect(init.exitCode, init.stderr).toBe(0);
    const put = await cli(['put', 'people/x-example', '--content', `---\ntitle: X\n---\n${body}\n`]);
    expect(put.exitCode, put.stderr).toBe(0);
  }, 180_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('--purge=0 refuses and the page survives; --include-deleted=0 refuses and shows nothing; the soft delete stays recoverable', async () => {
    for (const flag of ['--purge=0', '--purge=no', '--dry-run=0']) {
      const denied = await cli(['delete', 'people/x-example', '--force', flag, '--json']);
      expect(denied.exitCode, denied.stderr).toBe(2);
      expect(JSON.parse(denied.stdout).code).toBe('invalid_params');
      const live = await cli(['get', 'people/x-example']);
      expect(live.exitCode, live.stderr).toBe(0);
      expect(live.stdout).toContain(body);
    }

    const soft = await cli(['delete', 'people/x-example', '--force', '--purge=false']);
    expect(soft.exitCode, soft.stderr).toBe(0);
    const hidden = await cli(['get', 'people/x-example', '--include-deleted=false']);
    expect(hidden.exitCode).not.toBe(0);
    for (const value of ['0', 'no', 'off']) {
      const denied = await cli(['get', 'people/x-example', `--include-deleted=${value}`, '--json']);
      expect(denied.exitCode, denied.stderr).toBe(2);
      expect(JSON.parse(denied.stdout).code).toBe('invalid_params');
      expect(denied.stdout + denied.stderr).not.toContain(body);
    }
    const kept = await cli(['get', 'people/x-example', '--include-deleted=true']);
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(kept.stdout).toContain(body);
  }, 300_000);
});
