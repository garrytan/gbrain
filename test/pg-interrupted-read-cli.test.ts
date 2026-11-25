import { expect, test } from 'bun:test';
import { renderCliError, toAgentError } from '../src/core/agent-output.ts';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

const interruptedOpen = 'could not open file "base/42/83_fsm": Interrupted system call';
const interruptedRead = 'could not read block 3 in file "global/pg_filenode.map": Interrupted system call';
const interruptedTargetOpen = 'could not open file "pg_tblspc/42/64/83" (target block 3): Interrupted system call';
const interruptedRangeRead = 'could not read blocks 3..4 in file "base/42/83": Interrupted system call';
const pgError = (message: string, code = 'XX000') => Object.assign(new Error(message), { code });

test.each([interruptedOpen, interruptedRead, interruptedTargetOpen, interruptedRangeRead])('CLI reports the recovery step for an interrupted PostgreSQL data-file read: %s', message => {
  const error = pgError(message);
  const json = renderCliError(error, { json: true, command: 'jobs submit', tty: false });
  expect(json.exitCode).toBe(1);
  const errorJson = JSON.parse(json.stdout!);
  expect(errorJson).toMatchObject({
    code: 'database_error',
    reason: 'storage_read_interrupted',
    retryable: false,
    suggestion: expect.stringContaining('original job or write receipt'),
    fix: { next: 'report', actor: 'host_admin' },
  });
  expect(errorJson.fix.argv).toBeUndefined();
  const text = renderCliError(error, { json: false, command: 'jobs submit', tty: false });
  expect(text.stderr).toContain('PostgreSQL log');
  expect(text.stderr).toContain('original job or write receipt');
  expect(isRetryableConnError(error)).toBe(false);
});

test('CLI leaves unrelated errors and the shared database decisions unchanged', () => {
  const open = pgError(interruptedOpen);
  const read = pgError(interruptedRead);
  expect(classifyPgAccessError(open).reason).toBe('unknown');
  expect(classifyPgAccessError(read).reason).toBe('storage_corrupt');
  for (const error of [pgError(interruptedOpen, 'EINTR'), pgError('could not open file "report.md": Interrupted system call')]) {
    const out = renderCliError(error, { json: true, command: 'jobs', tty: false });
    expect(JSON.parse(out.stdout!).code).toBe('internal_error');
  }
  const http = toAgentError(open, { transport: 'http', render: { transport: 'http', isCallable: () => false, preapproved: () => false } });
  expect(http.code).toBe('internal_error');
  const corrupt = pgError('unexpected chunk number 6 for toast value 42');
  const cli = renderCliError(corrupt, { json: true, command: 'jobs', tty: false });
  expect(JSON.parse(cli.stdout!)).toMatchObject({ code: 'database_error', reason: 'storage_corrupt' });
  const io = pgError(interruptedRangeRead.replace('Interrupted system call', 'Input/output error'));
  const unrelated = renderCliError(io, { json: true, command: 'jobs', tty: false });
  expect(JSON.parse(unrelated.stdout!).reason).not.toBe('storage_read_interrupted');
});
