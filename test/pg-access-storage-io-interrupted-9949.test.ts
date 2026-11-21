/**
 * #9949: an interrupted relation-file open/read (EINTR) is a host storage problem, not data corruption.
 */
import { expect, test } from 'bun:test';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });

test.each([
  ['58030', 'could not open file "base/16384/16385": Interrupted system call'],
  ['XX001', 'could not read block 7 in file "base/16384/16385": Interrupted system call'],
])('%s %s → storage_io_interrupted with a storage and receipt step', (code, message) => {
  const d = classifyPgAccessError(pgErr(code, message));
  expect(d.reason).toBe('storage_io_interrupted');
  expect(d.remediation).toContain('database-host storage');
  expect(d.remediation).toContain('receipt');
  expect(d.fix?.kind).toBe('manual');
});

test('a genuine block-read failure is still storage damage', () => {
  const d = classifyPgAccessError(pgErr('XX001', 'could not read block 7 in file "base/1/2": read only 0 of 8192 bytes'));
  expect(d.reason).toBe('storage_corrupt');
});
