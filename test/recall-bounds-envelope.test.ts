/**
 * `gbrain recall --since` / `--session` are filters that narrow the result.
 * A malformed or missing value must refuse with invalid_params (exit 2), like
 * `gbrain delta --since` and `recall --limit`, instead of silently dropping the
 * bound and recalling every time window or every session. The flags are parsed
 * before any engine call, so no brain is opened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runRecall, recallNeedsLocalEngine } from '../src/commands/recall.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const originalExit = process.exit;
afterEach(() => { process.exit = originalExit; });

/** The refusal recall throws; an engine stub of `{}` means any later I/O fails the test instead. */
async function refusal(args: string[]): Promise<OperationError> {
  process.exit = ((code?: number) => { throw new Error(`process.exit(${code}) instead of an invalid_params error`); }) as typeof process.exit;
  const error = await runRecall({} as never, args).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
}

describe('recall --since invalid-input envelope', () => {
  test.each([
    ['unparseable', ['--since', 'not-a-date', '--json']],
    ['missing at the end', ['--json', '--since']],
    ['followed by another flag', ['--since', '--json']],
    ['empty', ['--since', '', '--json']],
  ])('%s value refuses before any engine call', async (_label, args) => {
    const r = renderCliError(await refusal(args), { json: true, command: 'recall', tty: false });
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout!);
    expect(env.code).toBe('invalid_params');
    expect(env.message).toContain('--since');
    expect(env.why).toContain('time bound');
  });

  test('a missing value says so; a bad value is echoed with the accepted grammar', async () => {
    expect((await refusal(['--since'])).message).toBe('--since requires a date or duration.');
    const bad = await refusal(['--since', 'not-a-date']);
    expect(bad.message).toBe('--since is not a date or duration (got "not-a-date").');
    const env = JSON.parse(renderCliError(bad, { json: true, command: 'recall', tty: false }).stdout!);
    expect(JSON.stringify(env)).toContain('8 hours ago');
  });

  test('human output names the flag and the fix on stderr', async () => {
    const r = renderCliError(await refusal(['--since', 'yesterday-ish']), { json: false, command: 'recall', tty: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--since is not a date or duration (got "yesterday-ish")');
    expect(r.stderr).toContain('6 weeks ago');
    expect(r.stderr).toContain('Fix: gbrain recall --help');
  });
});

describe('recall --session invalid-input envelope', () => {
  test.each([
    ['--session', 'missing at the end', ['--json', '--session']],
    ['--session', 'followed by another flag', ['--session', '--today']],
    ['--session-id', 'blank', ['--session-id', '  ', '--json']],
    ['--session-id', 'missing at the end', ['--session-id']],
  ])('%s %s refuses before any engine call', async (flag, _label, args) => {
    const e = await refusal(args);
    expect(e.message).toBe(`${flag} requires a session ID.`);
    const env = JSON.parse(renderCliError(e, { json: true, command: 'recall', tty: false }).stdout!);
    expect(env.code).toBe('invalid_params');
    expect(env.why).toContain('every session');
  });
});

describe('the thin-client dispatch probe', () => {
  test('refuses malformed bounds the same way', () => {
    process.exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as typeof process.exit;
    expect(() => recallNeedsLocalEngine(['--since', 'x'])).toThrow(OperationError);
    expect(() => recallNeedsLocalEngine(['--session'])).toThrow(OperationError);
  });

  test('still accepts valid ISO, relative, classic and --today bounds', () => {
    for (const args of [
      ['--since', '2026-09-01', '--session-id', 'session-example'],
      ['--since', '48 hours ago'],
      ['--since', '1h', '--grep', 'needle'],
      ['--since', 'last week'],
      ['--today', '--session', 'session-example'],
    ]) expect(recallNeedsLocalEngine(args)).toBe(false);
    expect(recallNeedsLocalEngine(['--session-id', 'session-example', '--query', 'what changed'])).toBe(true);
  });
});
