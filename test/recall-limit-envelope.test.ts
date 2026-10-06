/**
 * Agent contract v1: `gbrain recall --limit` usage errors are invalid_params
 * (exit 2 through renderCliError): under `--json` one envelope carrying
 * `code`, `why` and a runnable `fix`; on a terminal the Error/Fix/Why lines.
 * The flag is parsed before any engine call, so no brain is opened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runRecall, recallNeedsLocalEngine } from '../src/commands/recall.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const originalExit = process.exit;
afterEach(() => { process.exit = originalExit; });

/** The refusal recall throws; a pre-contract `process.exit` fails the test instead of killing the runner. */
async function refusal(args: string[]): Promise<OperationError> {
  process.exit = ((code?: number) => { throw new Error(`process.exit(${code}) instead of an invalid_params error`); }) as typeof process.exit;
  const error = await runRecall({} as never, args).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
}

describe('recall --limit invalid-input envelope', () => {
  test('--json renders one invalid_params envelope (exit 2) with why and a corrected command', async () => {
    const e = await refusal(['--limit', '0', '--json']);
    const r = renderCliError(e, { json: true, command: 'recall', tty: false });
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout!);
    expect(env.code).toBe('invalid_params');
    expect(env.message).toContain('got "0"');
    expect(env.why).toContain('--limit');
    expect(env.fix.argv.slice(0, 5)).toEqual(['gbrain', 'recall', '--limit', '50', '--json']);
    expect(env.fix.next).toBe('run');
  });

  test('a missing value inserts the example instead of dropping the next flag', async () => {
    const e = await refusal(['--json', '--limit', '--today']);
    expect(e.fix?.argv).toEqual(['gbrain', 'recall', '--json', '--limit', '50', '--today']);
  });

  test('human output names the bad value and the fix on stderr', async () => {
    const r = renderCliError(await refusal(['--limit', '3x']), { json: false, command: 'recall', tty: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('got "3x"');
    expect(r.stderr).toContain('Fix: gbrain recall --limit 50');
  });

  test('the thin-client dispatch probe refuses the same way', () => {
    process.exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as typeof process.exit;
    expect(() => recallNeedsLocalEngine(['--limit', 'x'])).toThrow(OperationError);
  });
});
